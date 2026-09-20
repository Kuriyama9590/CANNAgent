/**
 * @cannagent/dsh-cann-tools — 领域工具插件（plugin-dev.md §1/§3/§4）。
 * 零业务逻辑：注册工具表 → pre-execute 白名单闸门（C11）→ python CLI 转发（D3）
 * → 工具边界事件拦截（C2 定案：pre-execute + result 双钩子，经 python events append）。
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export declare const name = "cann-tools";
export declare const inject: string[];
export interface PluginConfig {
    /** 命令白名单（C11）：不在名单内的工具调用被 deny；undefined = 不启用闸门 */
    whitelist?: string[];
    /** python 可执行文件（默认 python） */
    python?: string;
    /** python 模块名（默认 cannagent） */
    module?: string;
    /** run 目录根（工具 cwd 基准；缺省 process.cwd()） */
    runsRoot?: string;
}
export declare const Config: z<PluginConfig>;
/** 观测事件负载（observability §2 的插件侧投影；完整 schema 由 python 校验） */
export interface ToolEventPayload {
    run_id: string;
    kind: 'tool_started' | 'tool_completed' | 'tool_failed';
    tool: {
        name: string;
        input?: unknown;
        output?: unknown;
        duration_ms?: number;
    };
    severity: 'info' | 'success' | 'warning' | 'error';
}
export declare function apply(ctx: Context, config: PluginConfig): void;
//# sourceMappingURL=index.d.ts.map