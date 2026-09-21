/**
 * 编排器单测（假 launcher + 假 python 桥；真边集/滚转/墙钟/兜底语义）。
 */
import { describe, expect, it } from 'vitest'
import { runLoop, type LoopDeps, type ManifestPayload } from './orchestrator.js'
import type { LaunchOptions, SessionLauncher, SessionResult } from './launcher.js'
import { composePrompt } from './prompts.js'

type Stages = Record<string, boolean>

interface Harness {
  deps: LoopDeps
  launches: LaunchOptions[]
  events: Array<Record<string, unknown>>
  checkpoints: Array<{ stage: string; iter: string; state: Record<string, unknown> }>
  /** routing 判定会话结束后 readLatestCheckpoint 返回的 next（null = 判定缺失） */
  routedNext: string | null
  /** 每次推进 now() 的步长（ms） */
  stepMs: number
  stages: Stages
  tokensUsed: number | null
}

function makeHarness(initial: Stages): Harness {
  const h: Harness = {
    launches: [],
    events: [],
    checkpoints: [],
    routedNext: null,
    stepMs: 1_000,
    stages: { ...initial },
    tokensUsed: null,
  }
  let clock = 0
  const launcher: SessionLauncher = {
    async launch(opts: LaunchOptions): Promise<SessionResult> {
      h.launches.push(opts)
      return { ok: true, output: 'done', tokensUsed: h.tokensUsed }
    },
  }
  h.deps = {
    launcher,
    async fetchManifest() {
      return {
        stages: h.stages as ManifestPayload['stages'],
        budget: { maxWallMin: 90, maxTokens: 1_000_000, wallElapsedMin: 0, wallRemainingMin: 90 },
        stagnation: false,
      }
    },
    async appendEvent(_rid, payload) {
      h.events.push(payload)
    },
    async writeCheckpoint(_rid, stage, iter, state) {
      h.checkpoints.push({ stage, iter, state })
    },
    async readLatestCheckpoint() {
      return h.routedNext === null ? null : { next: h.routedNext }
    },
    async stagePrompt(stage, manifestMd, rid) {
      return composePrompt(stage, manifestMd, rid)
    },
    now: () => {
      clock += h.stepMs
      return clock
    },
  }
  return h
}

const ALL_TRUE: Stages = {
  identify: true, strategy: true, implement: true, verify: true,
  bench: true, summarize: true, deliver: true,
}

describe('runLoop（workflow §2 编排语义）', () => {
  it('全直通：七阶段依序推进到 deliver 完成', async () => {
    const h = makeHarness(ALL_TRUE)
    const result = await runLoop(h.deps, { rid: 'r-test' })
    expect(result.status).toBe('completed')
    expect(result.finalStage).toBe('deliver')
    const stageLaunches = h.launches.filter((l) => l.purpose === 'stage').map((l) => l.stage)
    expect(stageLaunches).toEqual([
      'identify', 'strategy', 'implement', 'verify', 'bench', 'summarize', 'deliver',
    ])
    expect(h.launches.some((l) => l.purpose === 'routing')).toBe(false)
    expect(h.events.filter((e) => e.kind === 'stage_completed')).toHaveLength(7)
  })

  it('verify 未达标 → routing 判定会话在边集内选 implement 重修', async () => {
    const h = makeHarness({ ...ALL_TRUE, verify: false })
    h.routedNext = 'implement'
    // 第一次 verify 会话后把 verify 翻成达标（模拟重修后产物变化）
    let verifySessions = 0
    const origLaunch = h.deps.launcher.launch.bind(h.deps.launcher)
    h.deps.launcher = {
      async launch(opts) {
        if (opts.stage === 'verify') {
          verifySessions += 1
          if (verifySessions >= 2) h.stages.verify = true
        }
        return origLaunch(opts)
      },
    }
    const result = await runLoop(h.deps, { rid: 'r-test' })
    expect(result.status).toBe('completed')
    const routing = h.launches.filter((l) => l.purpose === 'routing')
    expect(routing).toHaveLength(1)
    const stageLaunches = h.launches.filter((l) => l.purpose === 'stage').map((l) => l.stage)
    // verify 失败 → routing(implement) → implement → verify(达标) → bench...
    expect(stageLaunches).toEqual([
      'identify', 'strategy', 'implement', 'verify', 'implement', 'verify',
      'bench', 'summarize', 'deliver',
    ])
  })

  it('routing 判定缺失 → 兜底默认边 implement + warning 事件', async () => {
    const h = makeHarness({ ...ALL_TRUE, verify: false })
    h.routedNext = null
    let verifySessions = 0
    const origLaunch = h.deps.launcher.launch.bind(h.deps.launcher)
    h.deps.launcher = {
      async launch(opts) {
        if (opts.stage === 'verify') {
          verifySessions += 1
          if (verifySessions >= 2) h.stages.verify = true
        }
        return origLaunch(opts)
      },
    }
    await runLoop(h.deps, { rid: 'r-test' })
    const warn = h.events.find((e) => e.kind === 'note' && String(e.title).includes('回落默认边'))
    expect(warn).toBeDefined()
    expect(warn?.severity).toBe('warning')
  })

  it('墙钟耗尽 → degrade（插件直判，唯一硬终止）', async () => {
    const h = makeHarness({ ...ALL_TRUE, identify: false })
    h.stepMs = 30 * 60_000 // 每次读时钟 +30min → 第三次循环即超 90min
    const result = await runLoop(h.deps, { rid: 'r-test', budgets: { maxWallMin: 1 } })
    expect(result.status).toBe('degraded')
    expect(h.events.some((e) => e.kind === 'degrade')).toBe(true)
  })

  it('80% 墙钟软提醒（不打断）', async () => {
    const h = makeHarness(ALL_TRUE)
    // 每迭代恰好 2 次 now()（elapsed + exhausted），7 迭代 = 14 次 × 6min = 84min：
    // 穿过 80%（72min）但不达 90min——软提醒触发且不打断
    let clock = 0
    h.deps.now = () => {
      clock += 6 * 60_000
      return clock
    }
    await runLoop(h.deps, { rid: 'r-test' })
    expect(h.events.some((e) => e.kind === 'note' && String(e.title).includes('80%'))).toBe(true)
    // 软提醒不打断：仍然跑完
    expect(h.launches.filter((l) => l.purpose === 'stage')).toHaveLength(7)
  })

  it('session token 满 → 滚转新 session 续跑（run 不中断）', async () => {
    const h = makeHarness({ ...ALL_TRUE, implement: false })
    h.tokensUsed = 2_000 // ≥ maxTokens=1000 → 每个阶段 session 后都滚转一次
    // 第二次 implement session 后达标
    let implementSessions = 0
    const origLaunch = h.deps.launcher.launch.bind(h.deps.launcher)
    h.deps.launcher = {
      async launch(opts) {
        if (opts.stage === 'implement') {
          implementSessions += 1
          if (implementSessions >= 2) h.stages.implement = true
        }
        const r = await origLaunch(opts)
        return r
      },
    }
    const result = await runLoop(h.deps, {
      rid: 'r-test',
      budgets: { maxTokens: 1_000 },
      maxSessionsPerStage: 4,
    })
    expect(result.status).toBe('completed')
    expect(result.rollovers).toBeGreaterThan(0)
    expect(h.events.some((e) => e.kind === 'note' && String(e.title).includes('滚转'))).toBe(true)
  })

  it('prompt 注入含 manifest 判据与阶段契约', async () => {
    const md = '趋势表占位'
    const p = composePrompt('verify', md, 'r-x')
    expect(p).toContain('# 阶段任务：verify')
    expect(p).toContain(md)
    expect(p).toContain('r-x')
    const routing = composePrompt('routing', md, 'r-x')
    expect(routing).toContain('route(next, reason, evidence, confidence)')
  })
})
