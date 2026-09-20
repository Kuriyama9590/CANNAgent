/**
 * 领域工具表（workflow.md §2 工具清单的 TS 投影）。
 * 单一事实源在 Python（pydantic）；本表只做边界校验与转发（D3）。
 * schema 对拍进 CI（E3）：字段名/类型与 python/cannagent/cli.py 的模型一致。
 */

import type { ParameterPropertySpec } from '@deepseek-ai/dsh-tools'

/** dsh-tools 的 value schema DSL（required 写在属性内，C2 spike 验证） */
export type ParamSpec = Record<string, ParameterPropertySpec>

/** 开放对象参数（additionalProperties DSL 必填；true = 任意子键） */
export const ANY_OBJECT: ParameterPropertySpec = { type: 'object', additionalProperties: true }

export interface ToolSpec {
  /** 工具名（= python 子命令名） */
  readonly name: string
  readonly description: string
  readonly parameters: ParamSpec
  /** python -m cannagent <subcommand> */
  readonly subcommand: string
  /** 超时上限（SPEC §3.2 自声明；缺省 10min） */
  readonly timeoutMs: number
  /** 输出 schema（骨架级：宽松 object，python 侧 pydantic 收紧） */
  readonly outputProperties: ParamSpec
}

const runId: ParameterPropertySpec = { type: 'string', required: true, description: 'run id（run 目录名）' }

/** 参数表（stage → 允许的工具，与 workflow §2 表一致；顺序即声明顺序） */
export const TOOL_SPECS: readonly ToolSpec[] = [
  {
    name: 'parse_model',
    description: '解析 ONNX 模型为算子清单（identify 阶段；task-schema §1.2 格式约束校验）',
    parameters: { run_id: runId },
    subcommand: 'parse-model',
    timeoutMs: 300_000,
    outputProperties: {
      op_list: { type: 'object', additionalProperties: true },
      fusion_candidates: { type: 'object', additionalProperties: true },
    },
  },
  {
    name: 'op_profile',
    description: '算子热点画像（按类型/参数量统计）',
    parameters: { run_id: runId },
    subcommand: 'op-profile',
    timeoutMs: 300_000,
    outputProperties: { stats: { type: 'object', additionalProperties: true } },
  },
  {
    name: 'fusion_scan',
    description: '扫描融合候选（依据 skills 融合模式手册 + RAG 历史）',
    parameters: { run_id: runId, max_count: { type: 'integer' } },
    subcommand: 'fusion-scan',
    timeoutMs: 300_000,
    outputProperties: { candidates: { type: 'object', additionalProperties: true } },
  },
  {
    name: 'strategy_gen',
    description: '生成优化策略（strategy.json + STRATEGY.md；重规划时注入已试路线）',
    parameters: { run_id: runId, replan: { type: 'boolean' } },
    subcommand: 'strategy-gen',
    timeoutMs: 600_000,
    outputProperties: { strategy: { type: 'object', additionalProperties: true } },
  },
  {
    name: 'code_gen',
    description: '按策略生成 AscendC/TBE 算子代码（implement/vN 完整快照）',
    parameters: { run_id: runId, op_task_id: { type: 'string', required: true }, version: { type: 'string' } },
    subcommand: 'code-gen',
    timeoutMs: 600_000,
    outputProperties: { version: { type: 'string' } },
  },
  {
    name: 'patch_code',
    description: '对指定版本打补丁（修复迭代）',
    parameters: {
      run_id: runId,
      op_task_id: { type: 'string', required: true },
      version: { type: 'string', required: true },
      notes: { type: 'string' },
    },
    subcommand: 'patch-code',
    timeoutMs: 600_000,
    outputProperties: { version: { type: 'string' } },
  },
  {
    name: 'build',
    description: '编译算子（任务包下发昇腾服务器，D9；结果包回传）',
    parameters: { run_id: runId, version: { type: 'string', required: true } },
    subcommand: 'build',
    timeoutMs: 600_000,
    outputProperties: { ok: { type: 'boolean' }, artifacts: { type: 'object', additionalProperties: true } },
  },
  {
    name: 'analyze_error',
    description: '编译/运行错误分类（代码层 | 路线不可行——routing 判据）',
    parameters: { run_id: runId, version: { type: 'string', required: true } },
    subcommand: 'analyze-error',
    timeoutMs: 300_000,
    outputProperties: { category: { type: 'string' }, detail: { type: 'object', additionalProperties: true } },
  },
  {
    name: 'gen_test',
    description: '生成精度用例（固定 seed，幂等——workflow §5）',
    parameters: { run_id: runId, seed: { type: 'integer' }, count: { type: 'integer' } },
    subcommand: 'gen-test',
    timeoutMs: 300_000,
    outputProperties: { cases_dir: { type: 'string' }, total: { type: 'integer' } },
  },
  {
    name: 'run_test',
    description: '执行精度测量（benchmark.md §3 口径：vs aclnn 官方基线）',
    parameters: { run_id: runId, version: { type: 'string', required: true } },
    subcommand: 'run-test',
    timeoutMs: 600_000,
    outputProperties: { max_rel_err: { type: 'number' }, passed: { type: 'integer' }, total: { type: 'integer' } },
  },
  {
    name: 'analyze_accuracy',
    description: '精度失败明细分析（失败分流判据）',
    parameters: { run_id: runId, version: { type: 'string', required: true } },
    subcommand: 'analyze-accuracy',
    timeoutMs: 300_000,
    outputProperties: { failures: { type: 'object', additionalProperties: true } },
  },
  {
    name: 'bench_setup',
    description: '准备性能测量脚本与任务包（benchmark.md §2 环境指纹采集）',
    parameters: { run_id: runId, version: { type: 'string', required: true } },
    subcommand: 'bench-setup',
    timeoutMs: 300_000,
    outputProperties: { package_path: { type: 'string' } },
  },
  {
    name: 'run_bench',
    description: '执行性能测量（三份对照：baseline/optimized/atc；p50 判定口径）',
    parameters: { run_id: runId, version: { type: 'string', required: true } },
    subcommand: 'run-bench',
    timeoutMs: 600_000,
    outputProperties: { p50_us: { type: 'number' }, gain_pct: { type: 'number' } },
  },
  {
    name: 'package',
    description: '打包交付物（deliver/ 四件套 + checksums）',
    parameters: { run_id: runId, version: { type: 'string', required: true } },
    subcommand: 'package',
    timeoutMs: 300_000,
    outputProperties: { manifest: { type: 'object', additionalProperties: true } },
  },
  {
    name: 'gen_report',
    description: '生成交付报告（REPORT.md，含 ATC 清单与口径差异）',
    parameters: { run_id: runId, version: { type: 'string', required: true } },
    subcommand: 'gen-report',
    timeoutMs: 300_000,
    outputProperties: { report_path: { type: 'string' } },
  },
]

export const TOOL_NAMES: readonly string[] = TOOL_SPECS.map(t => t.name)
