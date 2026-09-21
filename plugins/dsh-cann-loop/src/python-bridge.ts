/**
 * python 侧桥接：manifest 聚合 / 事件流 / 检查点（经 cann-tools 的 forward 白名单转发）。
 * python 缺席时全部降级（null / warn），编排不中断——现场以 run 目录落盘为准。
 */
import { allowlistedEnv, forward } from '@cannagent/dsh-cann-tools'
import type { ManifestPayload, LoopDeps } from './orchestrator.js'
import type { SessionLauncher } from './launcher.js'
import { composePrompt } from './prompts.js'

export interface BridgeConfig {
  python?: string
  module?: string
}

function baseOpts(cfg: BridgeConfig, rid: string, timeoutMs = 30_000): {
  python?: string
  module?: string
  env: NodeJS.ProcessEnv
  timeoutMs: number
} {
  return {
    ...(cfg.python === undefined ? {} : { python: cfg.python }),
    ...(cfg.module === undefined ? {} : { module: cfg.module }),
    env: allowlistedEnv({ CANNAGENT_RUN_ID: rid }),
    timeoutMs,
  }
}

export class ForwardBridge {
  constructor(private readonly cfg: BridgeConfig = {}) {}

  async fetchManifest(rid: string, elapsedMin: number): Promise<ManifestPayload | null> {
    const res = await forward(
      'manifest',
      { run_id: rid, wall_elapsed_min: elapsedMin, markdown: false },
      baseOpts(this.cfg, rid, 30_000),
    )
    if (!res.ok) {
      console.warn(`[cann-loop] manifest 聚合失败：${res.error?.message ?? 'unknown'}`)
      return null
    }
    const manifest = (res as { manifest?: ManifestPayload }).manifest ?? null
    return manifest
  }

  async appendEvent(rid: string, payload: Record<string, unknown>): Promise<void> {
    const res = await forward(
      'events',
      { run_id: rid, ...payload },
      { ...baseOpts(this.cfg, rid), extraArgs: ['append', '--payload-stdin'] },
    )
    if (!res.ok) {
      console.warn(`[cann-loop] 事件写入失败：${res.error?.message ?? 'unknown'}`)
    }
  }

  async writeCheckpoint(
    rid: string,
    stage: string,
    iter: string,
    state: Record<string, unknown>,
  ): Promise<void> {
    const res = await forward('checkpoint', { run_id: rid, stage, iter, state }, baseOpts(this.cfg, rid))
    if (!res.ok) {
      console.warn(`[cann-loop] 检查点写入失败：${res.error?.message ?? 'unknown'}`)
    }
  }

  async readLatestCheckpoint(rid: string): Promise<Record<string, unknown> | null> {
    const res = await forward(
      'checkpoint-read',
      { run_id: rid, latest: true },
      baseOpts(this.cfg, rid),
    )
    if (!res.ok) return null
    const state = (res as { state?: Record<string, unknown> }).state
    return state ?? null
  }

  /** 组装 LoopDeps（bin 入口用） */
  deps(launcher: SessionLauncher): LoopDeps {
    return {
      launcher,
      fetchManifest: (rid, elapsed) => this.fetchManifest(rid, elapsed),
      appendEvent: (rid, payload) => this.appendEvent(rid, payload),
      writeCheckpoint: (rid, stage, iter, state) => this.writeCheckpoint(rid, stage, iter, state),
      readLatestCheckpoint: (rid) => this.readLatestCheckpoint(rid),
      stagePrompt: async (stage, manifestMd, rid) => composePrompt(stage, manifestMd, rid),
      now: () => Date.now(),
    }
  }
}
