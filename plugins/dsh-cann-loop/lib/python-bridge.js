/**
 * python 侧桥接：manifest 聚合 / 事件流 / 检查点（经 cann-tools 的 forward 白名单转发）。
 * python 缺席时全部降级（null / warn），编排不中断——现场以 run 目录落盘为准。
 */
import { allowlistedEnv, forward } from '@cannagent/dsh-cann-tools';
import { composePrompt } from './prompts.js';
function baseOpts(cfg, rid, timeoutMs = 30_000) {
    return {
        ...(cfg.python === undefined ? {} : { python: cfg.python }),
        ...(cfg.module === undefined ? {} : { module: cfg.module }),
        env: allowlistedEnv({ CANNAGENT_RUN_ID: rid }),
        timeoutMs,
    };
}
export class ForwardBridge {
    cfg;
    constructor(cfg = {}) {
        this.cfg = cfg;
    }
    async fetchManifest(rid, elapsedMin) {
        const res = await forward('manifest', { run_id: rid, wall_elapsed_min: elapsedMin, markdown: false }, baseOpts(this.cfg, rid, 30_000));
        if (!res.ok) {
            console.warn(`[cann-loop] manifest 聚合失败：${res.error?.message ?? 'unknown'}`);
            return null;
        }
        const manifest = res.manifest ?? null;
        return manifest;
    }
    async appendEvent(rid, payload) {
        const res = await forward('events', { run_id: rid, ...payload }, { ...baseOpts(this.cfg, rid), extraArgs: ['append', '--payload-stdin'] });
        if (!res.ok) {
            console.warn(`[cann-loop] 事件写入失败：${res.error?.message ?? 'unknown'}`);
        }
    }
    async writeCheckpoint(rid, stage, iter, state) {
        const res = await forward('checkpoint', { run_id: rid, stage, iter, state }, baseOpts(this.cfg, rid));
        if (!res.ok) {
            console.warn(`[cann-loop] 检查点写入失败：${res.error?.message ?? 'unknown'}`);
        }
    }
    async readLatestCheckpoint(rid) {
        const res = await forward('checkpoint-read', { run_id: rid, latest: true }, baseOpts(this.cfg, rid));
        if (!res.ok)
            return null;
        const state = res.state;
        return state ?? null;
    }
    /** 组装 LoopDeps（bin 入口用） */
    deps(launcher) {
        return {
            launcher,
            fetchManifest: (rid, elapsed) => this.fetchManifest(rid, elapsed),
            appendEvent: (rid, payload) => this.appendEvent(rid, payload),
            writeCheckpoint: (rid, stage, iter, state) => this.writeCheckpoint(rid, stage, iter, state),
            readLatestCheckpoint: (rid) => this.readLatestCheckpoint(rid),
            stagePrompt: async (stage, manifestMd, rid) => composePrompt(stage, manifestMd, rid),
            now: () => Date.now(),
        };
    }
}
//# sourceMappingURL=python-bridge.js.map