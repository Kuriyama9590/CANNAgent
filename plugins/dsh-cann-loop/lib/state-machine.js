/**
 * 七阶段状态机（workflow.md §2 的显式状态表——「轨道与闸门在插件」）。
 * 纯逻辑、无 IO：边集判定 / 直通判定 / 兜底默认边 / 预算缺省。
 * 分叉点的选择由 routing 判定会话在边集内做出（route 工具），本模块只做结构校验。
 */
export const STAGES = ['identify', 'strategy', 'implement', 'verify', 'bench', 'summarize', 'deliver'];
/** 唯一硬性终止（插件直判，不经判定会话） */
export const WALL_CLOCK_TERMINAL = 'degraded';
/** 预算缺省（workflow §3；task.yaml budgets 可覆盖） */
export const BUDGET_DEFAULTS = {
    /** 整 run 墙钟上限（分钟）——唯一硬性终止条件 */
    maxWallMin: 90,
    /** 单 session token 上限（满额滚转新 session，不终止 run） */
    maxTokens: 1_000_000,
};
/** 兜底默认边（workflow §2.3：判定失效时取最保守的「再修一轮」） */
export const DEFAULT_EDGE = 'implement';
/**
 * 合法边集（workflow §2 转移规则表）。
 * 单元素 = 直通边（不判）；多元素 = 分叉点（routing 判定会话在集内选边）。
 */
export function legalEdges(trigger) {
    switch (trigger.stage) {
        case 'verify':
            return trigger.pass ? ['bench'] : ['implement', 'strategy'];
        case 'bench':
            return trigger.gainOk ? ['summarize'] : ['implement', 'strategy'];
        case 'implement':
            return trigger.buildOk ? ['verify'] : ['implement', 'strategy'];
        case 'identify':
        case 'strategy':
        case 'summarize':
        case 'deliver':
            return trigger.pass ? [nextLinear(trigger.stage)] : [trigger.stage];
    }
}
/** 直通推进的相邻阶段 */
function nextLinear(stage) {
    const order = STAGES;
    const idx = order.indexOf(stage);
    const next = order[idx + 1];
    if (next === undefined)
        throw new Error(`stage ${stage} has no linear successor`);
    return next;
}
/** 是否分叉点（需要 routing 判定会话） */
export function isBranchPoint(trigger) {
    return legalEdges(trigger).length > 1;
}
/**
 * 校验判定会话的路由结果（workflow §2.3 结构校验与兜底）。
 * 非法（不在边集 / 缺 reason）→ 默认边 implement + invalid 标记（上层发 warning 事件）。
 */
export function validateRoute(trigger, decision) {
    const edges = legalEdges(trigger);
    if (typeof decision.next !== 'string' || !edges.includes(decision.next)) {
        return {
            effective: DEFAULT_EDGE,
            valid: false,
            invalidReason: `next ${JSON.stringify(decision.next)} 不在边集 [${edges.join(', ')}]`,
        };
    }
    if (!decision.reason || decision.reason.trim() === '') {
        return { effective: DEFAULT_EDGE, valid: false, invalidReason: 'reason 必填（可审计要求）' };
    }
    if (decision.evidence === null || typeof decision.evidence !== 'object'
        || Object.keys(decision.evidence).length === 0) {
        return { effective: DEFAULT_EDGE, valid: false, invalidReason: 'evidence 必填且非空（数值判据）' };
    }
    return { effective: decision.next, valid: true };
}
/** 墙钟判定（插件直判；workflow §3） */
export function wallClockExhausted(startedAtMs, nowMs, maxWallMin) {
    return nowMs - startedAtMs >= maxWallMin * 60_000;
}
/** 单 session token 滚转判定（收尾当前 session 新开续跑，不终止 run；workflow §3） */
export function tokenRollsOver(cumulativeTokens, maxTokens) {
    return cumulativeTokens >= maxTokens;
}
//# sourceMappingURL=state-machine.js.map