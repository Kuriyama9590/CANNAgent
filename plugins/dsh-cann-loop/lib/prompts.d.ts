/**
 * 阶段 system prompt（workflow §7：与代码同版本管理，禁止运行时手改）。
 * 每条含：阶段目标 / 允许工具 / 输出契约 / 失败处理指引；manifest 注入位由编排器追加。
 */
import type { Stage } from './state-machine.js';
export declare const STAGE_PROMPTS: Record<Stage | 'routing', string>;
/** 组装完整注入 prompt：阶段 prompt + manifest 判据 + run 上下文 */
export declare function composePrompt(stage: Stage | 'routing', manifestMd: string, rid: string): string;
//# sourceMappingURL=prompts.d.ts.map