# 七阶段任务状态机规范（workflow）

> 阶段② 规范文档 · 关联任务 B6 · `plugins/dsh-cann-loop` 的权威行为定义。
> 状态：v1 草案（阻塞策略与预算默认值可在 D6 拍板后微调）

## 1. 总原则

- **全自主**：输入 task.yaml 后端到端跑完七阶段，仅在**降级**（§4）或**完成**时停下——"全自主 + 失败降级"是已确认的产品决策
- **状态机在循环插件手里**：阶段推进、预算、检查点由 dsh-cann-loop 插件强制执行，**不依赖 prompt 约定**（模型超预算的请求在插件层被拒绝）
- 每个阶段 = 一次受控 loop 运行：限定该阶段工具集 + 阶段 system prompt（`prompts/<stage>.md`）+ 阶段预算

## 2. 阶段定义

```
identify → strategy → implement ⇄ verify → bench → summarize → deliver
                          └── 迭代环（≤ budgets.max_iterations）──┘
```

| 阶段 | 输入 | 输出 | 允许的工具 | 完成判定 |
|---|---|---|---|---|
| identify | ONNX 模型（格式约束见 task-schema §1.2：仅 `.onnx`、opset ≥ 13、静态 shape）/ 算子规格 yaml | `identify/*.json` | parse_model, op_profile, fusion_scan, retrieve | 算子清单+融合候选落盘 |
| strategy | 融合候选 + RAG 检索 | `strategy/STRATEGY.md` + strategy.json | retrieve, strategy_gen | 策略文档落盘且通过 schema 校验 |
| implement | 策略 | `implement/vN/` 完整快照 | code_gen, patch_code, build, analyze_error | 编译通过（build 成功） |
| verify | 编译产物 | `verify/accuracy_vN.json` | gen_test, run_test, analyze_accuracy | 精度达标（≤阈值且全用例通过） |
| bench | 通过精度的版本 | `bench/bench_vN.json`（基线+优化各一份） | bench_setup, run_bench | 双份测量完成 |
| summarize | 全程事件+产物 | `summarize/exp-*.json` | experience_write | 经验条目过校验写入知识库 |
| deliver | 全部产物 | `deliver/` 完整交付包 | package, gen_report | 清单四项齐（code/STRATEGY/REPORT/tests）+ 复现脚本自检 |

**达标判定**（bench 后）：`gain_pct ≥ target.gain_pct` → 继续 summarize；`0 ≤ gain < target` → 回 implement 优化一轮（占用 implement 迭代预算）；`gain < 0` → 回 strategy（最多 1 次）。

### 2.1 阶段 I/O 格式明细（v1 权威定义）

每阶段输入 = 上一阶段落盘产物（首个阶段为 task.yaml / `input/`），输出 = run 目录内规范文件（目录结构见 task-schema §2）。约定：

- 所有 JSON：UTF-8、单文件 ≤ 8MB，超限分片并以索引文件记录路径
- 本节文件与 observability.md §4 的 artifact 同源：events.jsonl 中 `artifact.data` 即这些文件的内嵌快照（≤8KB）或 `$ref` 引用
- 字段变更遵循 task-schema §3 的版本规则（次位兼容新增，主位走 ADR）

#### identify

- **输入**：`input/*.onnx`（格式契约见 task-schema §1.2：仅 `.onnx`、opset ≥ 13、静态 shape）或 task.yaml `operator` 段（单算子任务，仅做规格校验）
- **输出**：
  - `identify/op_list.json`
    ```jsonc
    {
      "schema_version": "1.0",
      "model": { "format": "onnx", "opset": 13, "ir_version": 10, "input_shape": [16,3,224,224] },
      "nodes": [
        { "idx": 0, "op_type": "Conv", "name": "conv1",
          "attrs": { "kernel_shape": [7,7], "strides": [2,2] },
          "input_shapes": [[16,3,224,224]], "output_shapes": [[16,64,56,56]], "dtype": "fp16" }
      ],
      "stats": { "by_type": { "Conv": { "count": 53, "params": "45M" } }, "total_nodes": 189 }
    }
    ```
  - `identify/fusion_candidates.json`
    ```jsonc
    { "schema_version": "1.0",
      "candidates": [
        { "id": "F001", "pattern": "Conv+BN+ReLU", "node_idx": [3,4,5],
          "est_gain_pct": 8.0, "references": ["rag://exp-1234"], "status": "pending" }
      ] }
    ```
- **校验点**：opset 与静态 shape 复核通过；`nodes` 非空；candidates 的 `node_idx` 必须存在于 op_list

#### strategy

- **输入**：`op_list.json` + `fusion_candidates.json` + retrieve 检索结果（内存传递，不落盘）
- **输出**：
  - `strategy/strategy.json`
    ```jsonc
    { "schema_version": "1.0",
      "selected": ["F001"],
      "tasks": [
        { "op_task_id": "T-F001", "candidate_id": "F001", "approach": "AscendC 融合 kernel",
          "target_gain_pct": 8.0, "risk": "low", "order": 1 }
      ],
      "rejected": [ { "candidate_id": "F002", "reason": "官方已有等价融合" } ],
      "fallback": "单算子逐个优化" }
    ```
  - `strategy/STRATEGY.md`：人读策略文档（背景 / 候选评估 / 排序理由 / 风险与回退）
- **校验点**：`selected` ⊆ candidates 的 id 集合；每个 selected 均有对应 tasks 项；文档结论与 json 一致

#### implement

- **输入**：strategy.json 的单个 `tasks` 项 +（迭代时）上一版本快照 `implement/v{N-1}/`
- **输出**：`implement/vN/` 完整快照
  ```
  implement/vN/
  ├── operator/      # AscendC/TBE kernel 源码 + host 侧调用代码
  ├── build.sh       # 编译脚本（幂等，可独立执行）
  ├── build.log      # 本次编译完整日志
  └── artifacts/     # 编译产物（自定义算子包 / .so / .o）
  ```
- **校验点**（= 完成判定）：`build.sh` exit 0 且 `artifacts/` 非空

#### verify

- **输入**：`implement/vN/artifacts` + gen_test 生成的用例（固定 seed，落盘 `verify/cases_v{N}/`）+ 官方基线实现（对照输出）
- **输出**：`verify/accuracy_v{N}.json`
  ```jsonc
  { "schema_version": "1.0", "version": "v2",
    "passed": 79, "total": 80, "max_rel_err": 9.8e-4, "threshold": 1e-3,
    "failures": [ { "case_id": "case_042", "rel_err": 3.1e-2, "input_summary": "seed=42 idx=17" } ],
    "seed": 20260916, "duration_ms": 64000 }
  ```
- **校验点**：`failures` 数量 = `total − passed`；达标判定 = `max_rel_err ≤ threshold` 且 `failures` 为空（threshold 来自 task.yaml 或缺省 1e-3）

#### bench

- **输入**：通过精度判定的 `implement/vN/artifacts` + task.yaml `baseline` 段（`impl`：aclnn/torch_npu；`metric` 口径）
- **输出**：`bench/bench_v{N}_baseline.json` 与 `bench/bench_v{N}_optimized.json`（双份，结构相同）
  ```jsonc
  { "schema_version": "1.0", "version": "v2", "impl": "aclnn",
    "metric": { "warmup": 20, "iters": 100 },
    "p50_us": 412.3, "p99_us": 486.1, "mean_us": 419.7,
    "sync": "aclrtSynchronizeStream", "device": "Ascend910B", "note": "关闭 ATC 自动融合" }
  ```
- **gain 口径**：`gain_pct = (baseline.p50_us − optimized.p50_us) / baseline.p50_us × 100`（判死用 p50；p99 仅供报告参考）
- **校验点**：双份文件齐全；`iters` 与配置一致；`device` 必填（可审计）

#### summarize

- **输入**：`events.jsonl`（全程）+ 各阶段产物路径索引
- **输出**：`summarize/exp-{id}.json`（完整 schema 以 rag.md 为权威，最小字段如下）
  ```jsonc
  { "schema_version": "1.0", "id": "exp-20260916-a1b2c3d4",
    "problem": "Conv+BN+ReLU 融合", "root_cause": "……", "solution": "……",
    "reuse_when": { "dtype": "fp16", "layout": "NCHW" },
    "outcome": { "gain_pct": 6.2, "max_rel_err": 8e-4 } }
  ```
- **校验点**（= 完成判定）：通过 rag.md schema 校验并写入知识库

#### deliver

- **输入**：全部阶段产物（路径来自 events.jsonl 的 artifact 引用）
- **输出**：`deliver/`（目录结构见 task-schema §2）+ `deliver/manifest.json`
  ```jsonc
  { "schema_version": "1.0",
    "code": "code/", "tests": "tests/", "strategy": "STRATEGY.md", "report": "REPORT.md",
    "repro": { "run": "run.sh", "bench": "bench.sh" },
    "final_version": "v3", "gain_pct": 6.2,
    "checksums": { "REPORT.md": "sha256:…", "run.sh": "sha256:…" } }
  ```
- **REPORT.md 必含**：任务信息 / 最终版本与迭代史 / 精度结论 / 性能对比（vs target 与 vs baseline）/ 复现步骤
- **校验点**（= 完成判定）：manifest 四项路径存在 + `run.sh --check` 自检通过 + checksums 复核一致

## 3. 预算（缺省值，task.yaml 可覆盖）

| 预算 | 缺省 | 类型 | 超限动作 |
|---|---|---|---|
| `max_wall_min` | 90 | 硬 | 降级（当前阶段现场保留） |
| `max_tokens` | 200k | 硬 | 降级 |
| implement 编译失败 | 3 次 | 硬 | 降级 |
| verify 迭代 | 3 次 | 硬 | 降级 |
| 回 strategy 重规划 | 1 次 | 硬 | 降级 |
| 单工具调用超时 | 工具自声明（默认 10min） | 硬 | 该次调用失败，计入迭代 |

- 预算消耗随 `checkpoint` 事件展示（前端可见）
- 软提醒：预算用量 80% 时发 `note`（severity=warning），不打断

## 4. 降级（degrade）

触发即：发 `degrade` 事件（detail 必含：失败摘要、已尝试路径、建议人工动作、关联经验/文档引用）→ 状态机冻结 → 现场完整保留（代码/日志/检查点）→ 任务标记 `degraded` 等待人工。

人工介入点只有两个动作：**重试**（从最近检查点恢复，预算重置可配置）或 **放弃**（归档 run 目录）。前端 Dashboard 提供"重试/放弃"入口（demo 已实现交互样式）。

## 5. 检查点与恢复

- 检查点时机：每阶段 completed 后 + 每次迭代开始前
- `checkpoints/cp-{stage}-{iter}.json` 内容：状态机位置、迭代号、预算余量、关键产物路径、（可选）dsh session 续接句柄
- 恢复语义：进程崩溃/重启后，loop 插件扫描最新合法检查点 → 从该阶段重入 → **所有工具必须幂等**（同输入重复执行结果一致；编译/测试天然满足，gen_test 用固定 seed）
- 恢复本身发 `note` 事件，恢复前的 seq 保留（append-only 不破坏）

## 6. 并发与 NPU 队列（简述，D6 拍板后细化）

第一版：一个 run 独占一张 NPU 卡；loop 插件维护卡队列，排队 run 状态为 `pending`；队列是否持久化待 D6。

## 7. 阶段 system prompt 约定

- 每阶段 prompt 文件 `prompts/<stage>.md`，内容含：阶段目标、允许工具清单、输出 schema、失败处理指引、预算余量注入位
- prompt 与代码同版本管理，禁止运行时手改
