/**
 * session 启动器（workflow §1：每个阶段 = 一次受控 loop 运行）。
 *
 * 真实现 DshHeadlessLauncher：spawn `dsh --profile <p> "<prompt>"`（headless one-shot：
 * 全新持久化 session、打印最终回答、退出——dsh README §命令表）。
 * 编排器（orchestrator.ts）经 SessionLauncher 接口驱动，测试注入假启动器。
 */
import { spawn } from 'node:child_process';
/** chars/4 的保守 token 估算（headless 无 usage 时的滚转判据，标注为估算） */
export function estimateTokens(text) {
    return Math.ceil(text.length / 4);
}
export class DshHeadlessLauncher {
    cfg;
    constructor(cfg = {}) {
        this.cfg = { profile: cfg.profile ?? 'cann', timeoutMs: cfg.timeoutMs ?? 600_000, ...cfg };
    }
    async launch(opts) {
        const bin = this.cfg.bin ?? 'dsh';
        const args = ['--profile', this.cfg.profile, opts.prompt];
        return await new Promise((resolve) => {
            const child = spawn(bin, args, {
                cwd: this.cfg.cwd,
                env: { ...process.env, ...opts.env },
                shell: process.platform === 'win32',
            });
            let out = '';
            let err = '';
            const timer = setTimeout(() => child.kill(), this.cfg.timeoutMs);
            child.stdout.on('data', (d) => { out += d.toString('utf-8'); });
            child.stderr.on('data', (d) => { err += d.toString('utf-8'); });
            child.on('error', (e) => {
                clearTimeout(timer);
                resolve({ ok: false, output: `${out}${err}\n[launcher] ${String(e)}`, tokensUsed: null });
            });
            child.on('close', (code) => {
                clearTimeout(timer);
                const text = out || err;
                resolve({
                    ok: code === 0,
                    output: text,
                    tokensUsed: estimateTokens(opts.prompt + text),
                });
            });
        });
    }
}
//# sourceMappingURL=launcher.js.map