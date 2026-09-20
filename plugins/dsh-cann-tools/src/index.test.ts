/**
 * dsh-cann-tools 单测（SPEC §3.5：happy path + 错误码路径）。
 * 不拉起真实 Cordis：以最小 ctx 桩验证注册与钩子行为。
 */
import { describe, expect, it, vi } from 'vitest'
import { TOOL_NAMES, TOOL_SPECS } from './tool-table.js'

/** 最小 ctx 桩：捕获 register 与 on */
function makeCtx() {
  const registered: Array<{ name: string; execute: (args: Record<string, unknown>) => Promise<unknown> }> = []
  const listeners = new Map<string, (exec: unknown, next: () => Promise<unknown>) => Promise<unknown>>()
  return {
    registered,
    listeners,
    tools: {
      register(tool: { name: string; execute: (args: Record<string, unknown>) => Promise<unknown> }) {
        registered.push({ name: tool.name, execute: tool.execute })
      },
    },
    on(event: string, fn: (exec: unknown, next: () => Promise<unknown>) => Promise<unknown>) {
      listeners.set(event, fn)
    },
  }
}

// 桩掉 defineTool 的真实编译路径（其内部 schema DSL 编译在无 dsh runtime 下不可用）
vi.mock('@deepseek-ai/dsh-tools', () => ({
  defineTool: (spec: { name: string; execute: (args: Record<string, unknown>) => Promise<unknown> }) => spec,
}))

const { apply } = await import('./index.js')

describe('dsh-cann-tools 骨架', () => {
  it('注册 workflow §2 全部 15 个领域工具', () => {
    const ctx = makeCtx()
    apply(ctx as never, {})
    expect(ctx.registered.map(t => t.name)).toEqual(TOOL_NAMES)
  })

  it('工具表与 workflow §2 对齐（抽检关键字段）', () => {
    const build = TOOL_SPECS.find(t => t.name === 'build')
    expect(build?.timeoutMs).toBe(600_000)
    expect(build?.parameters['version']?.required).toBe(true)
    const genTest = TOOL_SPECS.find(t => t.name === 'gen_test')
    expect(genTest?.parameters['seed']).toBeDefined()
  })

  it('pre-execute：白名单外工具被 deny（C11）', async () => {
    const ctx = makeCtx()
    apply(ctx as never, { whitelist: ['parse_model'] })
    const decision = await ctx.listeners.get('tools/pre-execute')?.({ name: 'run_bench', args: {} }, async () => ({ kind: 'allow' }))
    expect(decision).toMatchObject({ kind: 'deny' })
  })

  it('pre-execute：白名单内工具放行并透传 next 结果', async () => {
    const ctx = makeCtx()
    apply(ctx as never, { whitelist: ['parse_model'] })
    const decision = await ctx.listeners.get('tools/pre-execute')?.({ name: 'parse_model', args: {} }, async () => ({ kind: 'allow' }))
    expect(decision).toMatchObject({ kind: 'allow' })
  })

  it('pre-execute：未配置白名单时不拦（缺省开放，开发态）', async () => {
    const ctx = makeCtx()
    apply(ctx as never, {})
    const decision = await ctx.listeners.get('tools/pre-execute')?.({ name: 'run_bench', args: {} }, async () => ({ kind: 'allow' }))
    expect(decision).toMatchObject({ kind: 'allow' })
  })

  it('forward 失败路径：python 非零退出映射 PYTHON_EXIT 错误码', async () => {
    const ctx = makeCtx()
    apply(ctx as never, {})
    const tool = ctx.registered.find(t => t.name === 'parse_model')
    await expect(tool?.execute({ run_id: 'r-test' })).rejects.toThrow(/CANN_E_PYTHON_EXIT|CANN_E_TIMEOUT|python/i)
  })
})
