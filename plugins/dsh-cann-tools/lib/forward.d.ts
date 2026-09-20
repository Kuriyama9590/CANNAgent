export interface ForwardResult {
    ok: boolean;
    value?: unknown;
    /** 结构化错误（CannToolError 形状）或 undefined */
    error?: {
        code: string;
        message: string;
        hint: string;
    };
}
export interface ForwardOptions {
    /** python 可执行文件（默认 python） */
    python?: string;
    /** 模块名（默认 cannagent） */
    module?: string;
    /** 额外 CLI 参数 */
    extraArgs?: readonly string[];
    /** 超时 ms（工具自声明） */
    timeoutMs: number;
    /** cwd（run 目录） */
    cwd?: string;
    /** 转发给子进程的环境（白名单变量；C11：禁止整包继承） */
    env?: NodeJS.ProcessEnv;
}
export declare function allowlistedEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
/**
 * 转发一次工具调用。JSON 参数走 stdin（避免命令行长度与转义问题）；
 * stdout 期望单 JSON 对象；stderr 进错误 message（官方错误码原样保留）。
 */
export declare function forward(subcommand: string, argsJson: unknown, options: ForwardOptions): Promise<ForwardResult>;
/**
 * 追加一条事件到 events.jsonl（经 python events append；observability §5）。
 * contained：失败只记录 stderr 摘要，不影响调用方主流程。
 */
export declare function appendEvent(payload: unknown, options: {
    python?: string;
    module?: string;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
}): Promise<void>;
//# sourceMappingURL=forward.d.ts.map