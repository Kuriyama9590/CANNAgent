/**
 * @cannagent/dsh-cann-tools — 领域工具插件（plugin-dev.md §1/§3/§4）。
 * 零业务逻辑：注册工具表 → pre-execute 白名单闸门（C11）→ python CLI 转发（D3）
 * → 工具边界事件拦截（C2 定案：pre-execute + result 双钩子，经 python events append）。
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
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

/** dsh-tools 的 ToolExecution 形状（仅取本插件用到的字段） */
interface ToolExecLike {
  name: string
  args?: unknown
}

/** ToolExecutionResult 的判别（isError 侧） */
interface ToolResultLike {
  isError?: boolean
  error?: { message?: string }
}

export function apply(ctx: Context, config: PluginConfig): void {
  const whitelist = config.whitelist && config.whitelist.length > 0 ? new Set(config.whitelist) : undefined
  const starts = new Map<ToolExecLike, number>()

  // C11 白名单闸门 + tool_started（C2 F3：deny 场景只发一条 tool_failed）
  ctx.on('tools/pre-execute', (exec: ToolExecLike, next: () => Promise<PreToolDecision>): Promise<PreToolDecision> => {
    if (whitelist !== undefined && !whitelist.has(exec.name)) {
      void emit(config, {
        run_id: process.env.CANNAGENT_RUN_ID ?? 'unknown',
        kind: 'tool_failed',
        tool: { name: exec.name, input: exec.args },
        severity: 'warning',
      })
      return Promise.resolve({ kind: 'deny' as const, reason: `cann-tools: ${exec.name} 不在命令白名单（C11）` })
    }
    starts.set(exec, Date.now())
    void emit(config, {
      run_id: process.env.CANNAGENT_RUN_ID ?? 'unknown',
      kind: 'tool_started',
      tool: { name: exec.name, input: exec.args },
      severity: 'info',
    })
    return next()
  })

  // 终态观察 → tool_completed / tool_failed（失败 contained：不影响结果）
  ctx.on('tools/result', (exec: ToolExecLike, result: ToolResultLike) => {
    const started = starts.get(exec)
    starts.delete(exec)
    const failed = result.isError === true
    void emit(config, {
      run_id: process.env.CANNAGENT_RUN_ID ?? 'unknown',
      kind: failed ? 'tool_failed' : 'tool_completed',
      tool: {
        name: exec.name,
        duration_ms: started === undefined ? undefined : Date.now() - started,
        output: failed ? { error: result.error?.message ?? 'error' } : { ok: true },
      },
      severity: failed ? 'error' : 'success',
    })
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
