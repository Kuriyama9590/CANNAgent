/**
 * @cannagent/dsh-cann-knowledge — 知识工具插件（rag.md §6 检索契约的 TS 投影）。
 * retrieve：检索经验库与文档库（默认 approved + 双语料）；失败返回空集 + warning（不阻塞 run）。
 * experience_write：summarize 阶段经验回流（schema 由 python pydantic 强制）。
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export declare const name = "cann-knowledge";
export declare const inject: string[];
export interface PluginConfig {
    python?: string;
    module?: string;
}
export declare const Config: z<PluginConfig>;
export declare function apply(ctx: Context, config: PluginConfig): void;
//# sourceMappingURL=index.d.ts.map