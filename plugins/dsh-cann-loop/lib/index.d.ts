/**
 * @cannagent/dsh-cann-loop — 状态机插件（workflow.md 权威行为）。
 * v0.1 骨架：注册 routing 判定会话唯一工具 `route`，边集校验 + 兜底默认边。
 * session 编排 / 预算强制 / 检查点 / NPU 队列转发随 C4 对接补齐。
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export declare const name = "cann-loop";
export declare const inject: string[];
export * from './state-machine.js';
export interface PluginConfig {
    /** 判定会话持久化决策事件的 python 转发目标（缺省同 cann-tools 约定） */
    python?: string;
    module?: string;
}
export declare const Config: z<PluginConfig>;
export declare function apply(ctx: Context, config: PluginConfig): void;
//# sourceMappingURL=index.d.ts.map