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
/** 事件归属的 run_id：优先取工具入参（领域工具契约首参），回落进程环境 */
function ridOf(exec) {
    const args = exec.arguments;
    if (args !== null && typeof args === 'object' && 'run_id' in args) {
        const rid = args.run_id;
        if (typeof rid === 'string' && rid !== '')
            return rid;
    }
    return process.env.CANNAGENT_RUN_ID ?? 'unknown';
}
export function apply(ctx, config) {
    const whitelist = config.whitelist && config.whitelist.length > 0 ? new Set(config.whitelist) : undefined;
    // C11 白名单闸门（C2 F3：deny 场景只发一条 tool_failed；await 保证持久化）
    ctx.on('tools/pre-execute', (exec, next) => {
        if (whitelist !== undefined && !whitelist.has(exec.name)) {
            return emit(config, {
                run_id: ridOf(exec),
                kind: 'tool_failed',
                tool: { name: exec.name, input: exec.arguments },
                severity: 'warning',
            }).then(() => ({ kind: 'deny', reason: `cann-tools: ${exec.name} 不在命令白名单（C11）` }));
        }
        return next();
    });
    // 工具边界事件（C2 定案钩子；挂 execute around-waterfall——registry 会 await，
    // 事件在工具调用自身时间线内持久化，不依赖进程存活到 loop 排空）
    ctx.on('tools/execute', (exec, next) => {
        const started = Date.now();
        return emit(config, {
            run_id: ridOf(exec),
            kind: 'tool_started',
            tool: { name: exec.name, input: exec.arguments },
            severity: 'info',
        }).then(() => next()).then(value => {
            void emitCompleted(false);
            return value;
        }, (error) => {
            void emitCompleted(true, error);
            throw error;
        });
        function emitCompleted(failed, error) {
            const message = error instanceof Error ? error.message : error === undefined ? 'error' : String(error);
            return emit(config, {
                run_id: ridOf(exec),
                kind: failed ? 'tool_failed' : 'tool_completed',
                tool: {
                    name: exec.name,
                    duration_ms: Date.now() - started,
                    output: failed ? { error: message } : { ok: true },
                },
                severity: failed ? 'error' : 'success',
            });
        }
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