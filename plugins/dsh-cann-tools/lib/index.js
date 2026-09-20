import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { TOOL_SPECS } from './tool-table.js';
import { appendEvent, forward, allowlistedEnv } from './forward.js';
import { ERROR_CODES } from './invariant.js';
export const name = 'cann-tools';
export const inject = ['tools'];
export const Config = z.object({
    whitelist: z.array(z.string()),
    python: z.string(),
    module: z.string(),
    runsRoot: z.string(),
});
function emit(config, payload) {
    return appendEvent(payload, { python: config.python, module: config.module });
}
export function apply(ctx, config) {
    const whitelist = config.whitelist && config.whitelist.length > 0 ? new Set(config.whitelist) : undefined;
    const starts = new Map();
    // C11 白名单闸门 + tool_started（C2 F3：deny 场景只发一条 tool_failed）
    ctx.on('tools/pre-execute', (exec, next) => {
        if (whitelist !== undefined && !whitelist.has(exec.name)) {
            void emit(config, {
                run_id: process.env.CANNAGENT_RUN_ID ?? 'unknown',
                kind: 'tool_failed',
                tool: { name: exec.name, input: exec.args },
                severity: 'warning',
            });
            return Promise.resolve({ kind: 'deny', reason: `cann-tools: ${exec.name} 不在命令白名单（C11）` });
        }
        starts.set(exec, Date.now());
        void emit(config, {
            run_id: process.env.CANNAGENT_RUN_ID ?? 'unknown',
            kind: 'tool_started',
            tool: { name: exec.name, input: exec.args },
            severity: 'info',
        });
        return next();
    });
    // 终态观察 → tool_completed / tool_failed（失败 contained：不影响结果）
    ctx.on('tools/result', (exec, result) => {
        const started = starts.get(exec);
        starts.delete(exec);
        const failed = result.isError === true;
        void emit(config, {
            run_id: process.env.CANNAGENT_RUN_ID ?? 'unknown',
            kind: failed ? 'tool_failed' : 'tool_completed',
            tool: {
                name: exec.name,
                duration_ms: started === undefined ? undefined : Date.now() - started,
                output: failed ? { error: result.error?.message ?? 'error' } : { ok: true },
            },
            severity: failed ? 'error' : 'success',
        });
    });
    // 工具表注册（D3：全部转发 python CLI）
    for (const spec of TOOL_SPECS) {
        ctx.tools.register(defineTool({
            name: spec.name,
            description: spec.description,
            parameters: spec.parameters,
            output: {
                schema: { type: 'object', additionalProperties: false, properties: spec.outputProperties },
                render: (args, value) => [{
                        type: 'text',
                        text: `${spec.name} -> ${JSON.stringify(value)}`,
                    }],
            },
            async execute(args) {
                const result = await forward(spec.subcommand, args, {
                    ...(config.python === undefined ? {} : { python: config.python }),
                    ...(config.module === undefined ? {} : { module: config.module }),
                    ...(config.runsRoot === undefined ? {} : { cwd: config.runsRoot }),
                    timeoutMs: spec.timeoutMs,
                    env: allowlistedEnv({ CANNAGENT_RUN_ID: String(args['run_id'] ?? '') }),
                });
                if (!result.ok) {
                    throw new Error(JSON.stringify({
                        code: result.error?.code ?? ERROR_CODES.PYTHON_EXIT,
                        message: result.error?.message ?? 'forward failed',
                        hint: result.error?.hint ?? '',
                    }));
                }
                // 输出 schema 宽松（骨架级）：python 侧 pydantic 是权威校验
                return result.value;
            },
        }));
    }
}
//# sourceMappingURL=index.js.map