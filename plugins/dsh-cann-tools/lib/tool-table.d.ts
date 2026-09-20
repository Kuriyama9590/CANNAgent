/**
 * 领域工具表（workflow.md §2 工具清单的 TS 投影）。
 * 单一事实源在 Python（pydantic）；本表只做边界校验与转发（D3）。
 * schema 对拍进 CI（E3）：字段名/类型与 python/cannagent/cli.py 的模型一致。
 */
import type { ParameterPropertySpec } from '@deepseek-ai/dsh-tools';
/** dsh-tools 的 value schema DSL（required 写在属性内，C2 spike 验证） */
export type ParamSpec = Record<string, ParameterPropertySpec>;
/** 开放对象参数（additionalProperties DSL 必填；true = 任意子键） */
export declare const ANY_OBJECT: ParameterPropertySpec;
export interface ToolSpec {
    /** 工具名（= python 子命令名） */
    readonly name: string;
    readonly description: string;
    readonly parameters: ParamSpec;
    /** python -m cannagent <subcommand> */
    readonly subcommand: string;
    /** 超时上限（SPEC §3.2 自声明；缺省 10min） */
    readonly timeoutMs: number;
    /** 输出 schema（骨架级：宽松 object，python 侧 pydantic 收紧） */
    readonly outputProperties: ParamSpec;
}
/** 参数表（stage → 允许的工具，与 workflow §2 表一致；顺序即声明顺序） */
export declare const TOOL_SPECS: readonly ToolSpec[];
export declare const TOOL_NAMES: readonly string[];
//# sourceMappingURL=tool-table.d.ts.map