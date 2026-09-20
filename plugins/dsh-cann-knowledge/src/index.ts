/**
 * @cannagent/dsh-cann-knowledge — 知识工具插件（rag.md §6 检索契约的 TS 投影）。
 * retrieve：检索经验库与文档库（默认 approved + 双语料）；失败返回空集 + warning（不阻塞 run）。
 * experience_write：summarize 阶段经验回流（schema 由 python pydantic 强制）。
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'cann-knowledge'
export const inject = ['tools']

export interface PluginConfig {
  python?: string
  module?: string
}

export const Config: z<PluginConfig> = z.object({
  python: z.string(),
  module: z.string(),
})

/** 与 dsh-cann-tools 相同的受控转发（骨架期局部复制；稳定后上移共享包） */
async function forwardSubcommand(
  subcommand: string,
  payload: unknown,
  config: PluginConfig,
  timeoutMs: number,
): Promise<{ ok: boolean; value?: unknown; error?: string }> {
  const { spawn } = await import('node:child_process')
  const python = config.python ?? 'python'
  const module = config.module ?? 'cannagent'
  return new Promise(resolve => {
    const child = spawn(python, ['-m', module, subcommand], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => { child.kill() }, timeoutMs)
    child.stdout.on('data', c => { stdout += c })
    child.stderr.on('data', c => { stderr += c })
    child.on('close', code => {
      clearTimeout(timer)
      if (code !== 0) {
        resolve({ ok: false, error: stderr.trim() || `python exited ${code}` })
        return
      }
      try {
        resolve({ ok: true, value: JSON.parse(stdout) })
      } catch {
        resolve({ ok: false, error: `bad json output: ${stdout.slice(0, 200)}` })
      }
    })
    child.stdin.write(JSON.stringify(payload ?? {}))
    child.stdin.end()
  })
}

export function apply(ctx: Context, config: PluginConfig): void {
  ctx.tools.register(defineTool({
    name: 'retrieve',
    description:
      '检索经验库与 CANN 文档库（rag.md §6）。默认只搜 approved 经验；返回 [{ref, score, summary}]，'
      + '失败时返回空结果集并附 warning note（检索不可用不阻塞 run）。',
    parameters: {
      query: { type: 'string', required: true, description: '检索词（算子模式 / 问题 / 关键词）' },
      top_k: { type: 'integer', description: '返回条数（默认 5）' },
      filter: { type: 'object', additionalProperties: true, description: 'context 面精确过滤（dtype/device/cann 等）' },
      corpora: { type: 'array', description: '语料域（默认 ["experience","docs"]）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          results: { type: 'array', required: true },
          warning: { type: 'string' },
        },
      },
      render: (_args: unknown, value: unknown) => [{
        type: 'text',
        text: `retrieve -> ${JSON.stringify(value)}`,
      }],
    },
    async execute(args: Record<string, unknown>) {
      const result = await forwardSubcommand('knowledge', { op: 'retrieve', ...args }, config, 120_000)
      if (!result.ok) {
        return { results: [], warning: `检索不可用：${result.error ?? 'unknown'}` } as never
      }
      return result.value as never
    },
  }))

  ctx.tools.register(defineTool({
    name: 'experience_write',
    description:
      '写入经验条目（summarize 阶段自动回流；schema 见 rag.md §3，python 侧强制校验）。'
      + 'root_cause 在失败条目必填；自动回流条目 status=draft。',
    parameters: {
      run_id: { type: 'string', required: true },
      problem: { type: 'string', required: true },
      context: { type: 'object', required: true, additionalProperties: true, description: '复用条件（dtype/device/cann/pattern）' },
      root_cause: { type: 'string', description: '根因（失败条目必填）' },
      solution: { type: 'string', required: true },
      outcome: { type: 'object', required: true, additionalProperties: true, description: '结果（status/gain_pct/max_rel_err/atc_coverage）' },
      reuse_when: { type: 'string', required: true },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { id: { type: 'string', required: true }, status: { type: 'string', required: true } },
      },
      render: (_args: unknown, value: unknown) => [{
        type: 'text',
        text: `experience_write -> ${JSON.stringify(value)}`,
      }],
    },
    async execute(args: Record<string, unknown>) {
      const result = await forwardSubcommand('knowledge', { op: 'experience_write', ...args }, config, 60_000)
      if (!result.ok) {
        throw new Error(JSON.stringify({
          code: 'CANN_E_PYTHON_EXIT',
          message: result.error ?? 'experience_write failed',
          hint: 'schema 违反时 python 侧返回校验错误明细',
        }))
      }
      return result.value as never
    },
  }))
}
