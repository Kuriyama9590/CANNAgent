/**
 * @cannagent/dsh-cann-tools — 领域工具插件（plugin-dev.md §1/§3/§4）。
 * 零业务逻辑：注册工具表 → pre-execute 白名单闸门（C11）→ python CLI 转发（D3）
 * → 工具边界事件拦截（C2 定案：pre-execute + result 双钩子，经 python events append）。
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { PreToolDecision, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { TOOL_SPECS } from './tool-table.js'
import { appendEvent, forward, allowlistedEnv } from './forward.js'
import { ERROR_CODES } from './invariant.js'

export const name = 'cann-tools'
export const inject = ['tools']

export interface PluginConfig {
  /** 命令白名单（C11）：不在名单内的工具调用被 deny；undefined = 不启用闸门 */
  whitelist?: string[]
  /** python 可执行文件（默认 python） */
  python?: string
  /** python 模块名（默认 cannagent） */
  module?: string
  /** run 目录根（工具 cwd 基准；缺省 process.cwd()） */
  runsRoot?: string
}

export const Config: z<PluginConfig> = z.object({
  whitelist: z.array(z.string()),
  python: z.string(),
  module: z.string(),
  runsRoot: z.string(),
})

/** 观测事件负载（observability §2 的插件侧投影；完整 schema 由 python 校验） */
export interface ToolEventPayload {
  run_id: string
  kind: 'tool_started' | 'tool_completed' | 'tool_failed'
  tool: {
    name: string
    input?: unknown
    output?: unknown
    duration_ms?: number
  }
  severity: 'info' | 'success' | 'warning' | 'error'
}

function emit(
  config: PluginConfig,
  payload: ToolEventPayload,
): Promise<void> {
  return appendEvent(payload, { python: config.python, module: config.module })
}

/** 事件归属的 run_id：优先取工具入参（领域工具契约首参），回落进程环境 */
function ridOf(exec: ToolExecLike): string {
  const args = exec.arguments
  if (args !== null && typeof args === 'object' && 'run_id' in args) {
    const rid = (args as { run_id?: unknown }).run_id
    if (typeof rid === 'string' && rid !== '') return rid
  }
  return process.env.CANNAGENT_RUN_ID ?? 'unknown'
}

/** dsh-tools 的 ToolExecution 形状（仅取本插件用到的字段） */
/** dsh-tools ToolExecution 的结构子集（字段名 arguments——C4 冒烟实测确认） */
interface ToolExecLike {
  name: string
  arguments?: unknown
}

export function apply(ctx: Context, config: PluginConfig): void {
  const whitelist = config.whitelist && config.whitelist.length > 0 ? new Set(config.whitelist) : undefined

  // C11 白名单闸门（C2 F3：deny 场景只发一条 tool_failed；await 保证持久化）
  ctx.on('tools/pre-execute', (exec: ToolExecLike, next: () => Promise<PreToolDecision>): Promise<PreToolDecision> => {
    if (whitelist !== undefined && !whitelist.has(exec.name)) {
      return emit(config, {
        run_id: ridOf(exec),
        kind: 'tool_failed',
        tool: { name: exec.name, input: exec.arguments },
        severity: 'warning',
      }).then(() =>
        ({ kind: 'deny' as const, reason: `cann-tools: ${exec.name} 不在命令白名单（C11）` }))
    }
    return next()
  })

  // 工具边界事件（C2 定案钩子；挂 execute around-waterfall——registry 会 await，
  // 事件在工具调用自身时间线内持久化，不依赖进程存活到 loop 排空）
  ctx.on('tools/execute', (exec: ToolExecLike, next: () => Promise<ToolExecutionResult>): Promise<ToolExecutionResult> => {
    const started = Date.now()
    return emit(config, {
      run_id: ridOf(exec),
      kind: 'tool_started',
      tool: { name: exec.name, input: exec.arguments },
      severity: 'info',
    }).then(() => next()).then(
      value => {
        void emitCompleted(false)
        return value
      },
      (error: unknown) => {
        void emitCompleted(true, error)
        throw error
      },
    )
    function emitCompleted(failed: boolean, error?: unknown): Promise<void> {
      const message = error instanceof Error ? error.message : error === undefined ? 'error' : String(error)
      return emit(config, {
        run_id: ridOf(exec),
        kind: failed ? 'tool_failed' : 'tool_completed',
        tool: {
          name: exec.name,
          duration_ms: Date.now() - started,
          output: failed ? { error: message } : { ok: true },
        },
        severity: failed ? 'error' : 'success',
      })
    }
  })

  // 工具表注册（D3：全部转发 python CLI）
  for (const spec of TOOL_SPECS) {
    ctx.tools.register(defineTool({
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters,
      output: {
        schema: { type: 'object', additionalProperties: false, properties: spec.outputProperties },
        render: (args: unknown, value: unknown) => [{
          type: 'text',
          text: `${spec.name} -> ${JSON.stringify(value)}`,
        }],
      },
      async execute(args: Record<string, unknown>) {
        const result = await forward(spec.subcommand, args, {
          ...(config.python === undefined ? {} : { python: config.python }),
          ...(config.module === undefined ? {} : { module: config.module }),
          ...(config.runsRoot === undefined ? {} : { cwd: config.runsRoot }),
          timeoutMs: spec.timeoutMs,
          env: allowlistedEnv({ CANNAGENT_RUN_ID: String(args['run_id'] ?? '') }),
        })
        if (!result.ok) {
          throw new Error(JSON.stringify({
            code: result.error?.code ?? ERROR_CODES.PYTHON_EXIT,
            message: result.error?.message ?? 'forward failed',
            hint: result.error?.hint ?? '',
          }))
        }
        // 输出 schema 宽松（骨架级）：python 侧 pydantic 是权威校验
        return result.value as never
      },
    }))
  }
}
