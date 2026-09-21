/**
 * 七阶段 session 编排（workflow.md 权威行为的执行面）。
 *
 * 轨道与闸门在本模块；道岔在 routing 判定会话：
 * - 每阶段 = 一次 headless one-shot session（launcher 注入），prompt = prompts/<stage>.md + manifest
 * - 直通判定 = manifest.stages 落盘现场读数（判据是证据不是判决）
 * - 分叉点开 routing 判定会话（route 工具持久化 decision + 检查点；本模块读回最新检查点取去向）
 * - 墙钟耗尽 → degrade（插件直判，唯一硬终止）；80% 发软提醒 note
 * - 单 session token 满 → 收尾滚转新 session 续跑（manifest 重新注入，run 不中断）
 */
import {
  BUDGET_DEFAULTS,
  DEFAULT_EDGE,
  isBranchPoint,
  legalEdges,
  tokenRollsOver,
  wallClockExhausted,
  type Stage,
  type StageTrigger,
} from './state-machine.js'
import type { SessionLauncher } from './launcher.js'

export interface ManifestPayload {
  stages: Record<Stage, boolean>
  budget: { maxWallMin: number; maxTokens: number; wallElapsedMin: number; wallRemainingMin: number }
  stagnation: boolean
  [key: string]: unknown
}

export interface LoopDeps {
  launcher: SessionLauncher
  /** python 侧 manifest 聚合（判据注入源） */
  fetchManifest(rid: string, elapsedMin: number): Promise<ManifestPayload | null>
  /** 事件流（decision/degrade/note/stage_*） */
  appendEvent(rid: string, payload: Record<string, unknown>): Promise<void>
  /** 检查点写入（阶段 completed / 迭代开始）与读回（routing 判定结果） */
  writeCheckpoint(rid: string, stage: string, iter: string, state: Record<string, unknown>): Promise<void>
  readLatestCheckpoint(rid: string): Promise<Record<string, unknown> | null>
  /** 阶段 prompt 组装（读 prompts/<stage>.md + manifest 注入） */
  stagePrompt(stage: Stage | 'routing', manifestMd: string, rid: string): Promise<string>
  now(): number
}

export interface LoopOptions {
  rid: string
  budgets?: { maxWallMin?: number; maxTokens?: number }
  /** 测试护栏：单阶段最大 session 数（防假启动器死循环；缺省 ∞ 由墙钟兜底） */
  maxSessionsPerStage?: number
}

export interface LoopResult {
  status: 'completed' | 'degraded'
  finalStage: Stage | 'degraded'
  sessions: number
  rollovers: number
  history: Array<{ stage: Stage | 'routing'; ok: boolean }>
}

const BUDGET_WARN_RATIO = 0.8

export async function runLoop(deps: LoopDeps, opts: LoopOptions): Promise<LoopResult> {
  const maxWallMin = opts.budgets?.maxWallMin ?? BUDGET_DEFAULTS.maxWallMin
  const maxTokens = opts.budgets?.maxTokens ?? BUDGET_DEFAULTS.maxTokens
  const startedAt = deps.now()
  let wallWarned = false
  let sessions = 0
  let rollovers = 0
  const history: LoopResult['history'] = []

  let stage: Stage = 'identify'
  while (true) {
    const elapsedMin = (deps.now() - startedAt) / 60_000

    // 硬闸门：墙钟耗尽 → degrade（插件直判；workflow §2.5/§3）
    if (wallClockExhausted(startedAt, deps.now(), maxWallMin)) {
      await deps.appendEvent(opts.rid, {
        kind: 'degrade',
        stage,
        title: '墙钟耗尽，run 降级',
        detail: `max_wall_min=${maxWallMin} 耗尽于 ${stage}；现场完整保留，等待人工重试/放弃`,
        severity: 'warning',
      })
      return { status: 'degraded', finalStage: 'degraded', sessions, rollovers, history }
    }
    // 软提醒：80% 墙钟（不打断）
    if (!wallWarned && elapsedMin >= maxWallMin * BUDGET_WARN_RATIO) {
      wallWarned = true
      await deps.appendEvent(opts.rid, {
        kind: 'note',
        stage,
        title: '墙钟预算 80%',
        detail: `elapsed=${elapsedMin.toFixed(1)}min / ${maxWallMin}min`,
        severity: 'warning',
      })
    }

    const manifest = await deps.fetchManifest(opts.rid, elapsedMin)
    const manifestMd = JSON.stringify(manifest ?? { note: 'manifest 不可用（降级为空注入）' })
    const prompt = await deps.stagePrompt(stage, manifestMd, opts.rid)
    await deps.appendEvent(opts.rid, {
      kind: 'stage_started',
      stage,
      title: `阶段会话启动：${stage}`,
    })

    // 单阶段 session 循环（含 token 滚转：收尾当前 session，manifest 重新注入续跑）
    let stageSessions = 0
    let sessionOk = false
    let output = ''
    while (true) {
      stageSessions += 1
      sessions += 1
      const result = await deps.launcher.launch({
        purpose: 'stage',
        stage,
        prompt,
        env: stageEnv(opts.rid, stage),
      })
      sessionOk = result.ok
      output = result.output
      history.push({ stage, ok: sessionOk })
      const used = result.tokensUsed
      if (used !== null && tokenRollsOver(used, maxTokens)) {
        rollovers += 1
        await deps.appendEvent(opts.rid, {
          kind: 'note',
          stage,
          title: 'session token 滚转',
          detail: `累计 ${used} ≥ ${maxTokens}（估算口径）；manifest 重新注入开新 session 续跑`,
          severity: 'info',
        })
        if (opts.maxSessionsPerStage !== undefined && stageSessions >= opts.maxSessionsPerStage) break
        continue
      }
      break
    }
    if (opts.maxSessionsPerStage !== undefined && stageSessions > opts.maxSessionsPerStage) {
      // 测试护栏触发：视为该阶段失败（生产路径无此护栏，由墙钟兜底）
      stage = await route(deps, opts, triggerOf(stage, false), manifest)
      continue
    }

    // 直通判定：manifest.stages 落盘读数（判据是证据）
    const fresh = await deps.fetchManifest(opts.rid, elapsedMin)
    const pass = fresh?.stages?.[stage] ?? false
    await deps.appendEvent(opts.rid, {
      kind: pass ? 'stage_completed' : 'stage_failed',
      stage,
      title: `阶段会话结束：${stage}（${pass ? '直通判定满足' : '未满足'}）`,
      detail: sessionOk ? undefined : 'session 非零退出',
    })
    await deps.writeCheckpoint(opts.rid, stage, `s${sessions}`, {
      stage,
      pass,
      sessions,
      outputTail: output.slice(-500),
    })

    const trigger = triggerOf(stage, pass)
    if (trigger.stage === 'deliver' && pass) {
      return { status: 'completed', finalStage: 'deliver', sessions, rollovers, history }
    }

    stage = await route(deps, opts, trigger, fresh)
  }
}

/** 分叉点 = routing 判定会话；直通边直接推进（workflow §2） */
async function route(
  deps: LoopDeps,
  opts: LoopOptions,
  trigger: StageTrigger,
  manifest: ManifestPayload | null,
): Promise<Stage> {
  if (!isBranchPoint(trigger)) {
    return legalEdges(trigger)[0] as Stage
  }

  // 判定会话：无业务工具，唯一工具 route（插件注册；execute 持久化 decision + 检查点）
  const manifestMd = JSON.stringify(manifest ?? {})
  const prompt = await deps.stagePrompt('routing', manifestMd, opts.rid)
  await deps.appendEvent(opts.rid, {
    kind: 'stage_started',
    stage: trigger.stage,
    title: 'routing 判定会话启动',
    detail: `触发：${JSON.stringify(trigger)}`,
  })
  // 判定会话的输出本身不消费（廉价幂等）；判定结果以下方检查点读回为准
  await deps.launcher.launch({
    purpose: 'routing',
    stage: 'routing',
    prompt,
    env: stageEnv(opts.rid, 'routing'),
  })

  // 判定结果读回：route 工具写入了 cp-<effective>/route-<trigger.stage> 检查点
  const cp = await deps.readLatestCheckpoint(opts.rid)
  const routed = typeof cp?.next === 'string' ? (cp.next as Stage) : undefined
  const edges = legalEdges(trigger).filter((e): e is Stage => e !== 'degraded')
  if (routed !== undefined && (edges as string[]).includes(routed)) {
    return routed
  }
  // 兜底（workflow §2.3）：判定失效取默认边 + warning（不是常态路径）
  await deps.appendEvent(opts.rid, {
    kind: 'note',
    stage: trigger.stage,
    title: 'routing 判定失效，回落默认边',
    detail: `判定会话输出未含合法 next（${routed ?? '缺失'}）；默认边 = ${DEFAULT_EDGE}`,
    severity: 'warning',
  })
  return DEFAULT_EDGE
}

/** 触发器构造：verify/bench/implement 用各自的判定布尔（state-machine 权威形状） */
function triggerOf(stage: Stage, pass: boolean): StageTrigger {
  switch (stage) {
    case 'verify':
      return { stage: 'verify', pass }
    case 'bench':
      return { stage: 'bench', gainOk: pass }
    case 'implement':
      return { stage: 'implement', buildOk: pass }
    default:
      return { stage, pass }
  }
}

function stageEnv(rid: string, stage: Stage | 'routing'): Record<string, string> {
  return { CANNAGENT_RUN_ID: rid, CANNAGENT_STAGE: stage }
}
