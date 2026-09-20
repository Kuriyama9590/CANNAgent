/** dsh-cann-loop 单测：边集与 workflow §2 表一致性 / 兜底默认边 / 预算缺省（SPEC §3.5） */
import { describe, expect, it, vi } from 'vitest'
import {
  BUDGET_DEFAULTS,
  DEFAULT_EDGE,
  STAGES,
  isBranchPoint,
  legalEdges,
  tokenRollsOver,
  validateRoute,
  wallClockExhausted,
} from './state-machine.js'

vi.mock('@deepseek-ai/dsh-tools', () => ({
  defineTool: (spec: { name: string; execute: (args: Record<string, unknown>) => Promise<unknown> }) => spec,
}))

function makeCtx() {
  const registered: Array<{ name: string; execute: (args: Record<string, unknown>) => Promise<unknown> }> = []
  return {
    registered,
    services: new Map<string, unknown>(),
    tools: {
      register(tool: { name: string; execute: (args: Record<string, unknown>) => Promise<unknown> }) {
        registered.push({ name: tool.name, execute: tool.execute })
      },
    },
    on() { /* loop 插件骨架不挂钩子 */ },
    provide(key: string, value: unknown) { this.services.set(key, value) },
  }
}

const { apply } = await import('./index.js')

describe('状态机边集（workflow §2 转移规则表）', () => {
  it('verify 达标 → bench 唯一边（直通不判）', () => {
    expect(legalEdges({ stage: 'verify', pass: true })).toEqual(['bench'])
  })
  it('verify 未达标 → implement|strategy 分叉', () => {
    expect(legalEdges({ stage: 'verify', pass: false })).toEqual(['implement', 'strategy'])
    expect(isBranchPoint({ stage: 'verify', pass: false })).toBe(true)
  })
  it('bench 达标 → summarize；未达标（含 ≤0）→ 分叉', () => {
    expect(legalEdges({ stage: 'bench', gainOk: true })).toEqual(['summarize'])
    expect(legalEdges({ stage: 'bench', gainOk: false })).toEqual(['implement', 'strategy'])
  })
  it('implement build 通过 → verify；未通过 → 分叉', () => {
    expect(legalEdges({ stage: 'implement', buildOk: true })).toEqual(['verify'])
    expect(legalEdges({ stage: 'implement', buildOk: false })).toEqual(['implement', 'strategy'])
  })
  it('identify/strategy/summarize/deliver：直通或同阶段重开（唯一去向）', () => {
    expect(legalEdges({ stage: 'identify', pass: true })).toEqual(['strategy'])
    expect(legalEdges({ stage: 'strategy', pass: true })).toEqual(['implement'])
    expect(legalEdges({ stage: 'summarize', pass: true })).toEqual(['deliver'])
    expect(legalEdges({ stage: 'identify', pass: false })).toEqual(['identify'])
    expect(legalEdges({ stage: 'deliver', pass: false })).toEqual(['deliver'])
  })
})

describe('route 校验与兜底（workflow §2.3）', () => {
  const trigger = { stage: 'verify' as const, pass: false }

  it('边集内选择 + reason/evidence 齐备 → 采纳', () => {
    const outcome = validateRoute(trigger, {
      next: 'strategy', reason: 'err 停滞两轮', evidence: { err_best: 3e-2, stagnant: true }, confidence: 0.8,
    })
    expect(outcome).toMatchObject({ effective: 'strategy', valid: true })
  })
  it('边集外的 next → 默认边 implement', () => {
    const outcome = validateRoute(trigger, {
      next: 'deliver', reason: 'x', evidence: { a: 1 }, confidence: 0.5,
    })
    expect(outcome.effective).toBe(DEFAULT_EDGE)
    expect(outcome.valid).toBe(false)
  })
  it('缺 reason → 默认边', () => {
    const outcome = validateRoute(trigger, { next: 'implement', reason: '', evidence: { a: 1 }, confidence: 0.5 })
    expect(outcome.valid).toBe(false)
  })
  it('空 evidence → 默认边（数值判据强制）', () => {
    const outcome = validateRoute(trigger, { next: 'implement', reason: 'r', evidence: {}, confidence: 0.5 })
    expect(outcome.valid).toBe(false)
  })
})

describe('预算（workflow §3 缺省）', () => {
  it('缺省值：90min 墙钟 / 1M token / 无次数上限', () => {
    expect(BUDGET_DEFAULTS.maxWallMin).toBe(90)
    expect(BUDGET_DEFAULTS.maxTokens).toBe(1_000_000)
  })
  it('墙钟判定', () => {
    expect(wallClockExhausted(0, 89 * 60_000, 90)).toBe(false)
    expect(wallClockExhausted(0, 91 * 60_000, 90)).toBe(true)
  })
  it('token 滚转判定（不终止，新 session 续跑）', () => {
    expect(tokenRollsOver(999_999, 1_000_000)).toBe(false)
    expect(tokenRollsOver(1_000_000, 1_000_000)).toBe(true)
  })
})

describe('插件注册面', () => {
  it('注册唯一 route 工具 + 暴露预算缺省服务', () => {
    const ctx = makeCtx()
    apply(ctx as never, {})
    expect(ctx.registered.map(t => t.name)).toEqual(['route'])
    expect(ctx.services.get('cannBudgetDefaults')).toEqual(BUDGET_DEFAULTS)
  })
  it('route execute：bench 触发器归一 + 非法 next 回落默认边', async () => {
    const ctx = makeCtx()
    apply(ctx as never, {})
    const route = ctx.registered.find(t => t.name === 'route')
    const out = (await route?.execute({
      current_trigger: { stage: 'bench', gainOk: false },
      next: 'summarize',
      reason: 'r',
      evidence: { gain_pct: -2 },
      confidence: 0.4,
    })) as { effective: string; valid: boolean }
    expect(out.valid).toBe(false)
    expect(out.effective).toBe('implement')
  })
  it('STAGES 覆盖七个阶段且顺序正确', () => {
    expect(STAGES).toEqual(['identify', 'strategy', 'implement', 'verify', 'bench', 'summarize', 'deliver'])
  })
})
