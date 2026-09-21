import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { allowlistedEnv, forward } from '@cannagent/dsh-cann-tools';
import { BUDGET_DEFAULTS, STAGES, validateRoute, } from './state-machine.js';
export const name = 'cann-loop';
export const inject = ['tools'];
export * from './state-machine.js';
export const Config = z.object({
    python: z.string(),
    module: z.string(),
});
/** 判定持久化（workflow §2.2/§2.3）：decision 事件 + 检查点写入；失败仅告警不阻断 */
async function persistDecision(config, rid, trigger, decision, outcome) {
    const base = {
        ...(config.python === undefined ? {} : { python: config.python }),
        ...(config.module === undefined ? {} : { module: config.module }),
        env: allowlistedEnv({ CANNAGENT_RUN_ID: rid }),
    };
    const event = await forward('events', {
        run_id: rid,
        kind: 'decision',
        stage: trigger.stage,
        title: `route → ${outcome.effective}`,
        detail: decision.reason,
        severity: outcome.valid ? 'info' : 'warning',
        tool: {
            invocation_id: `route-${Date.now()}`,
            name: 'route',
            input: { next: decision.next, confidence: decision.confidence },
            output: { effective: outcome.effective, valid: outcome.valid },
        },
    }, { ...base, timeoutMs: 30_000, extraArgs: ['append', '--payload-stdin'] });
    if (!event.ok) {
        console.warn(`[cann-loop] decision 事件写入失败：${event.error?.code} ${event.error?.message ?? 'unknown'}`);
    }
    const cp = await forward('checkpoint', {
        run_id: rid,
        stage: outcome.effective,
        iter: `route-${trigger.stage}`,
        state: {
            stage: trigger.stage,
            next: outcome.effective,
            valid: outcome.valid,
            reason: decision.reason,
            evidence: decision.evidence,
            confidence: decision.confidence,
        },
    }, { ...base, timeoutMs: 30_000 });
    if (!cp.ok) {
        console.warn(`[cann-loop] 检查点写入失败：${cp.error?.message ?? 'unknown'}`);
    }
}
export function apply(ctx, config) {
    ctx.tools.register(defineTool({
        name: 'route',
        description: 'routing 判定会话唯一工具（workflow §2.2）：在当前分叉点的合法边集内选择下一站。'
            + 'reason 与数值 evidence 必填（分流可审计）；next 不在边集内时回落默认边 implement。',
        parameters: {
            run_id: { type: 'string', required: true, description: 'run id（事件归属与检查点写入）' },
            current_trigger: {
                type: 'object',
                required: true,
                additionalProperties: true,
                description: '当前会话结束触发器（stage + 判定布尔）',
            },
            next: {
                type: 'string',
                required: true,
                description: `下一站（${STAGES.join('|')}|degraded）`,
            },
            reason: { type: 'string', required: true, description: '分流理由（必填，进 decision 事件）' },
            evidence: { type: 'object', required: true, additionalProperties: true, description: '数值判据（趋势表 / 失败明细引用）' },
            confidence: { type: 'number', required: true, description: '置信度 0-1' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    effective: { type: 'string', required: true },
                    valid: { type: 'boolean', required: true },
                    invalid_reason: { type: 'string' },
                },
            },
            render: (_args, value) => [{
                    type: 'text',
                    text: `route -> ${JSON.stringify(value)}`,
                }],
        },
        async execute(args) {
            const trigger = args['current_trigger'];
            const decision = {
                next: String(args['next']),
                reason: String(args['reason'] ?? ''),
                evidence: (args['evidence'] ?? {}),
                confidence: Number(args['confidence'] ?? 0),
            };
            // 触发器形状归一（bench 的 gainOk / implement 的 buildOk 在 JSON 里同名传入）
            const normalized = trigger.stage === 'bench'
                ? { stage: 'bench', gainOk: Boolean(trigger.gainOk) }
                : trigger.stage === 'implement'
                    ? { stage: 'implement', buildOk: Boolean(trigger.buildOk) }
                    : { stage: trigger.stage, pass: Boolean(trigger.pass) };
            const outcome = validateRoute(normalized, decision);
            // workflow §2.2：判定结果持久化——decision 事件 + 检查点（经 python；contained）
            const rid = String(args['run_id'] ?? process.env.CANNAGENT_RUN_ID ?? 'unknown');
            await persistDecision(config, rid, normalized, decision, outcome); // 决策留痕是硬要求（workflow §2.2），不与进程退出赛跑
            return {
                effective: outcome.effective,
                valid: outcome.valid,
                ...(outcome.invalidReason === undefined ? {} : { invalid_reason: outcome.invalidReason }),
            };
        },
    }));
    // 预算缺省随插件可查询（task.yaml 覆盖由 python 侧配置回填）
    ctx.provide('cannBudgetDefaults', BUDGET_DEFAULTS);
}
//# sourceMappingURL=index.js.map