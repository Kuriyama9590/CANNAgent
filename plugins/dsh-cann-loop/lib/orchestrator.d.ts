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
import { type Stage } from './state-machine.js';
import type { SessionLauncher } from './launcher.js';
export interface ManifestPayload {
    stages: Record<Stage, boolean>;
    budget: {
        maxWallMin: number;
        maxTokens: number;
        wallElapsedMin: number;
        wallRemainingMin: number;
    };
    stagnation: boolean;
    [key: string]: unknown;
}
export interface LoopDeps {
    launcher: SessionLauncher;
    /** python 侧 manifest 聚合（判据注入源） */
    fetchManifest(rid: string, elapsedMin: number): Promise<ManifestPayload | null>;
    /** 事件流（decision/degrade/note/stage_*） */
    appendEvent(rid: string, payload: Record<string, unknown>): Promise<void>;
    /** 检查点写入（阶段 completed / 迭代开始）与读回（routing 判定结果） */
    writeCheckpoint(rid: string, stage: string, iter: string, state: Record<string, unknown>): Promise<void>;
    readLatestCheckpoint(rid: string): Promise<Record<string, unknown> | null>;
    /** 阶段 prompt 组装（读 prompts/<stage>.md + manifest 注入） */
    stagePrompt(stage: Stage | 'routing', manifestMd: string, rid: string): Promise<string>;
    now(): number;
}
export interface LoopOptions {
    rid: string;
    budgets?: {
        maxWallMin?: number;
        maxTokens?: number;
    };
    /** 测试护栏：单阶段最大 session 数（防假启动器死循环；缺省 ∞ 由墙钟兜底） */
    maxSessionsPerStage?: number;
}
export interface LoopResult {
    status: 'completed' | 'degraded';
    finalStage: Stage | 'degraded';
    sessions: number;
    rollovers: number;
    history: Array<{
        stage: Stage | 'routing';
        ok: boolean;
    }>;
}
export declare function runLoop(deps: LoopDeps, opts: LoopOptions): Promise<LoopResult>;
//# sourceMappingURL=orchestrator.d.ts.map