/** dsh-cann-knowledge 单测：注册面 + retrieve 容错语义（rag.md §6：失败不阻塞） */
import { describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-tools', () => ({
  defineTool: (spec: { name: string; execute: (args: Record<string, unknown>) => Promise<unknown> }) => spec,
}))

function makeCtx() {
  const registered: Array<{ name: string; execute: (args: Record<string, unknown>) => Promise<unknown> }> = []
  return {
    registered,
    tools: {
      register(tool: { name: string; execute: (args: Record<string, unknown>) => Promise<unknown> }) {
        registered.push({ name: tool.name, execute: tool.execute })
      },
    },
    on() { /* 知识插件不挂钩子 */ },
  }
}

const { apply } = await import('./index.js')

describe('dsh-cann-knowledge 骨架', () => {
  it('注册 retrieve 与 experience_write 两个工具', () => {
    const ctx = makeCtx()
    apply(ctx as never, {})
    expect(ctx.registered.map(t => t.name)).toEqual(['retrieve', 'experience_write'])
  })

  it('retrieve：不抛错且结果恒为数组（C6 起为真实检索；空库/异常均空集，run 不阻塞）', async () => {
    const ctx = makeCtx()
    apply(ctx as never, {})
    const retrieve = ctx.registered.find(t => t.name === 'retrieve')
    const result = (await retrieve?.execute({ query: 'Conv+BN+ReLU' })) as {
      results: unknown[]
      warning?: string
      note?: string
    }
    expect(Array.isArray(result.results)).toBe(true)
    // rag.md §6：检索不可用 → warning；正常空库 → 纯空集
    expect(result.warning === undefined || typeof result.warning === 'string').toBe(true)
  })

  it('experience_write：失败路径抛结构化错误码', async () => {
    const ctx = makeCtx()
    apply(ctx as never, {})
    const write = ctx.registered.find(t => t.name === 'experience_write')
    await expect(write?.execute({ run_id: 'r', problem: 'p', context: {}, solution: 's', outcome: {}, reuse_when: 'r' }))
      .rejects.toThrow(/CANN_E_PYTHON_EXIT|python/i)
  })
})
