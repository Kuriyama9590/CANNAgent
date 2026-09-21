import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { allowlistedEnv, forward } from '@cannagent/dsh-cann-tools';
export const name = 'cann-knowledge';
export const inject = ['tools'];
export const Config = z.object({
    python: z.string(),
    module: z.string(),
});
export function apply(ctx, config) {
    ctx.tools.register(defineTool({
        name: 'retrieve',
        description: '检索经验库与 CANN 文档库（rag.md §6）。默认只搜 approved 经验；返回 [{ref, score, summary}]，'
            + '失败时返回空结果集并附 warning note（检索不可用不阻塞 run）。',
        parameters: {
            query: { type: 'string', required: true, description: '检索词（算子模式 / 问题 / 关键词）' },
            top_k: { type: 'integer', description: '返回条数（默认 5）' },
            filter: { type: 'object', additionalProperties: true, description: 'context 面精确过滤（dtype/device/cann 等）' },
            corpora: { type: 'array', description: '语料域（默认 ["experience","docs"]）' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    results: { type: 'array', required: true },
                    warning: { type: 'string' },
                    note: { type: 'string' },
                },
            },
            render: (_args, value) => [{
                    type: 'text',
                    text: `retrieve -> ${JSON.stringify(value)}`,
                }],
        },
        async execute(args) {
            const result = await forward('knowledge', { op: 'retrieve', ...args }, {
                ...(config.python === undefined ? {} : { python: config.python }),
                ...(config.module === undefined ? {} : { module: config.module }),
                timeoutMs: 120_000,
                env: allowlistedEnv(),
            });
            if (!result.ok) {
                return { results: [], warning: `检索不可用：${result.error ?? 'unknown'}` };
            }
            return result.value;
        },
    }));
    ctx.tools.register(defineTool({
        name: 'experience_write',
        description: '写入经验条目（summarize 阶段自动回流；schema 见 rag.md §3，python 侧强制校验）。'
            + 'root_cause 在失败条目必填；自动回流条目 status=draft。',
        parameters: {
            run_id: { type: 'string', required: true },
            problem: { type: 'string', required: true },
            context: { type: 'object', required: true, additionalProperties: true, description: '复用条件（dtype/device/cann/pattern）' },
            root_cause: { type: 'string', description: '根因（失败条目必填）' },
            solution: { type: 'string', required: true },
            outcome: { type: 'object', required: true, additionalProperties: true, description: '结果（status/gain_pct/max_rel_err/atc_coverage）' },
            reuse_when: { type: 'string', required: true },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: { id: { type: 'string', required: true }, status: { type: 'string', required: true } },
            },
            render: (_args, value) => [{
                    type: 'text',
                    text: `experience_write -> ${JSON.stringify(value)}`,
                }],
        },
        async execute(args) {
            const result = await forward('knowledge', { op: 'experience_write', ...args }, {
                ...(config.python === undefined ? {} : { python: config.python }),
                ...(config.module === undefined ? {} : { module: config.module }),
                timeoutMs: 60_000,
                env: allowlistedEnv({ CANNAGENT_RUN_ID: String(args['run_id'] ?? '') }),
            });
            if (!result.ok) {
                throw new Error(JSON.stringify({
                    code: 'CANN_E_PYTHON_EXIT',
                    message: result.error ?? 'experience_write failed',
                    hint: 'schema 违反时 python 侧返回校验错误明细',
                }));
            }
            return result.value;
        },
    }));
}
//# sourceMappingURL=index.js.map