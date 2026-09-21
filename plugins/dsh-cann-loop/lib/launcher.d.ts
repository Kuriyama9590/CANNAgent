import type { Stage } from './state-machine.js';
export interface SessionResult {
    /** dsh 退出码 === 0 */
    ok: boolean;
    /** headless 打印的最终回答 */
    output: string;
    /** session 累计 token（headless 输出不含 usage 时为 null——滚转判定退化为估算） */
    tokensUsed: number | null;
}
export interface LaunchOptions {
    /** stage 会话（带阶段工具集）或 routing 判定会话（唯一工具 route） */
    purpose: 'stage' | 'routing';
    stage: Stage | 'routing';
    /** 组装完成的完整 prompt（阶段 prompt 文件 + manifest 注入） */
    prompt: string;
    /** 附加环境变量（CANNAGENT_* 经白名单转发的部分） */
    env?: Record<string, string>;
}
export interface SessionLauncher {
    launch(opts: LaunchOptions): Promise<SessionResult>;
}
export interface DshLauncherConfig {
    /** dsh 可执行文件（缺省 PATH 上的 dsh；Windows 下 npm 全局 bin） */
    bin?: string;
    /** dsh profile（缺省 cann：项目 profiles/ 组合层） */
    profile?: string;
    cwd?: string;
    /** 单 session 超时（缺省 10min，workflow §3 单工具上限之外的整体护栏） */
    timeoutMs?: number;
}
/** chars/4 的保守 token 估算（headless 无 usage 时的滚转判据，标注为估算） */
export declare function estimateTokens(text: string): number;
export declare class DshHeadlessLauncher implements SessionLauncher {
    private readonly cfg;
    constructor(cfg?: DshLauncherConfig);
    launch(opts: LaunchOptions): Promise<SessionResult>;
}
//# sourceMappingURL=launcher.d.ts.map