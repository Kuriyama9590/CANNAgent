/**
 * 七阶段状态机（workflow.md §2 的显式状态表——「轨道与闸门在插件」）。
 * 纯逻辑、无 IO：边集判定 / 直通判定 / 兜底默认边 / 预算缺省。
 * 分叉点的选择由 routing 判定会话在边集内做出（route 工具），本模块只做结构校验。
 */
export declare const STAGES: readonly ["identify", "strategy", "implement", "verify", "bench", "summarize", "deliver"];
export type Stage = (typeof STAGES)[number];
export type Terminal = 'degraded';
/** 会话结束时的阶段触发器（workflow §2 转移规则的输入） */
export type StageTrigger = {
    stage: 'verify';
    pass: boolean;
} | {
    stage: 'bench';
    gainOk: boolean;
} | {
    stage: 'implement';
    buildOk: boolean;
} | {
    stage: 'identify' | 'strategy' | 'summarize' | 'deliver';
    pass: boolean;
};
/** 唯一硬性终止（插件直判，不经判定会话） */
export declare const WALL_CLOCK_TERMINAL: Terminal;
/** 预算缺省（workflow §3；task.yaml budgets 可覆盖） */
export declare const BUDGET_DEFAULTS: {
    /** 整 run 墙钟上限（分钟）——唯一硬性终止条件 */
    readonly maxWallMin: 90;
    /** 单 session token 上限（满额滚转新 session，不终止 run） */
    readonly maxTokens: 1000000;
};
/** 兜底默认边（workflow §2.3：判定失效时取最保守的「再修一轮」） */
export declare const DEFAULT_EDGE: Stage;
/**
 * 合法边集（workflow §2 转移规则表）。
 * 单元素 = 直通边（不判）；多元素 = 分叉点（routing 判定会话在集内选边）。
 */
export declare function legalEdges(trigger: StageTrigger): readonly (Stage | Terminal)[];
/** 是否分叉点（需要 routing 判定会话） */
export declare function isBranchPoint(trigger: StageTrigger): boolean;
export interface RouteDecision {
    /** 判定会话给出的下一站 */
    next: Stage | Terminal;
    reason: string;
    evidence: Record<string, unknown>;
    confidence: number;
}
export interface RouteOutcome {
    /** 实际生效的下一站（非法输入时回落 DEFAULT_EDGE） */
    effective: Stage | Terminal;
    /** 判定是否合法（结构校验） */
    valid: boolean;
    /** 非法原因（valid=false 时） */
    invalidReason?: string;
}
/**
 * 校验判定会话的路由结果（workflow §2.3 结构校验与兜底）。
 * 非法（不在边集 / 缺 reason）→ 默认边 implement + invalid 标记（上层发 warning 事件）。
 */
export declare function validateRoute(trigger: StageTrigger, decision: RouteDecision): RouteOutcome;
/** 墙钟判定（插件直判；workflow §3） */
export declare function wallClockExhausted(startedAtMs: number, nowMs: number, maxWallMin: number): boolean;
/** 单 session token 滚转判定（收尾当前 session 新开续跑，不终止 run；workflow §3） */
export declare function tokenRollsOver(cumulativeTokens: number, maxTokens: number): boolean;
//# sourceMappingURL=state-machine.d.ts.map