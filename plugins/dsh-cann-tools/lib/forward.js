/**
 * python CLI 转发器（D3）：spawn `python -m cannagent <subcommand>`，stdin 传 JSON 参数。
 * 事件写入走同一路径（observability §5：python events.py 是唯一写入函数）。
 */
import { spawn } from 'node:child_process';
/** 子进程环境白名单（C11 骨架；凭据类由 python 侧 .env 自取，不经过本层） */
// 运行定位变量（非凭据）：workspace 根 / run 归属 / 阶段 / dsh home
const ENV_ALLOWLIST = ['CANNAGENT_WORKSPACE', 'CANNAGENT_RUN_ID', 'CANNAGENT_STAGE', 'DSH_HOME'];
export function allowlistedEnv(extra = {}) {
    const out = {};
    for (const key of ENV_ALLOWLIST) {
        if (process.env[key] !== undefined)
            out[key] = process.env[key];
    }
    // 编码钉死（行为变量，非凭据）：Windows 最小 env 下 python 默认按本地代码页（GBK）
    // 解码 stdin，中文/箭头等会变孤立代理对，UTF-8 写回即崩溃——实测于 C 审查修复冒烟
    out.PYTHONUTF8 = '1';
    out.PYTHONIOENCODING = 'utf-8';
    return { ...out, ...extra };
}
/**
 * 转发一次工具调用。JSON 参数走 stdin（避免命令行长度与转义问题）；
 * stdout 期望单 JSON 对象；stderr 进错误 message（官方错误码原样保留）。
 */
export function forward(subcommand, argsJson, options) {
    const python = options.python ?? 'python';
    const module = options.module ?? 'cannagent';
    return new Promise(resolve => {
        const child = spawn(python, ['-m', module, subcommand, ...(options.extraArgs ?? [])], {
            cwd: options.cwd ?? process.cwd(),
            env: allowlistedEnv(options.env),
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        let settled = false;
        const timer = setTimeout(() => {
            child.kill();
            settle({
                ok: false,
                error: {
                    code: 'CANN_E_TIMEOUT',
                    message: `${subcommand} 超过 ${options.timeoutMs}ms`,
                    hint: '检查工具超时声明或任务包执行端状态',
                },
            });
        }, options.timeoutMs);
        function settle(result) {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolve(result);
        }
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.on('error', err => {
            settle({
                ok: false,
                error: { code: 'CANN_E_PYTHON_EXIT', message: String(err), hint: 'python 不可用或 cannagent 未安装' },
            });
        });
        child.on('close', code => {
            if (code !== 0) {
                settle({
                    ok: false,
                    error: {
                        code: 'CANN_E_PYTHON_EXIT',
                        message: stderr.trim() || `python exited ${code}`,
                        hint: '官方错误码（E1xx 等）见 message 原文',
                    },
                });
                return;
            }
            try {
                settle({ ok: true, value: JSON.parse(stdout) });
            }
            catch {
                settle({
                    ok: false,
                    error: { code: 'CANN_E_BAD_OUTPUT', message: stdout.slice(0, 400), hint: 'python 侧应输出单 JSON 对象' },
                });
            }
        });
        child.stdin.write(JSON.stringify(argsJson ?? {}));
        child.stdin.end();
    });
}
/**
 * 追加一条事件到 events.jsonl（经 python events append；observability §5）。
 * contained：失败只记录 stderr 摘要，不影响调用方主流程。
 */
export async function appendEvent(payload, options) {
    const result = await forward('events', payload, {
        ...options,
        // 事件写入不设长超时：python 侧 append 是毫秒级
        timeoutMs: 30_000,
        extraArgs: ['append', '--payload-stdin'],
    }).catch(() => undefined);
    if (result && !result.ok) {
        // contained：事件失败不得影响工具执行
        console.warn(`[cann-tools] event append failed: ${result.error?.code} ${result.error?.message}`);
    }
}
//# sourceMappingURL=forward.js.map