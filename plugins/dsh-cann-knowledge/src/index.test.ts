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

  it('retrieve：永远返回空集不抛错——python 缺席带 warning，在场带 note（run 不阻塞）', async () => {
    const ctx = makeCtx()
    apply(ctx as never, {})
    const retrieve = ctx.registered.find(t => t.name === 'retrieve')
    const result = (await retrieve?.execute({ query: 'Conv+BN+ReLU' })) as {
      results: unknown[]
      warning?: string
      note?: string
    }
    expect(result.results).toEqual([])
    // rag.md §6：检索不可用不阻塞 run——warning（python 缺席）或 note（骨架空库）二选一
    expect(result.warning !== undefined || result.note !== undefined).toBe(true)
  })

  it('experience_write：失败路径抛结构化错误码', async () => {
    const ctx = makeCtx()
    apply(ctx as never, {})
    const write = ctx.registered.find(t => t.name === 'experience_write')
    await expect(write?.execute({ run_id: 'r', problem: 'p', context: {}, solution: 's', outcome: {}, reuse_when: 'r' }))
      .rejects.toThrow(/CANN_E_PYTHON_EXIT|python/i)
  })
})
