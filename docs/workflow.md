# 七阶段任务状态机规范（workflow）

> 阶段② 规范文档 · 关联任务 B6 · `plugins/dsh-cann-loop` 的权威行为定义。
> 状态：v1 草案（阻塞策略可在 D6 拍板后微调；2026-09-17 用户拍板两项修订——①预算：单 session token 上限 1M、取消迭代/重试次数上限，见 §3；②转移：失败分流改由 routing 判定会话在边集内决策，见 §2）

## 1. 总原则

- **全自主**：输入 task.yaml 后端到端跑完七阶段，仅在**降级**（§4）或**完成**时停下——"全自主 + 失败降级"是已确认的产品决策
- **轨道与闸门在插件、道岔在判定会话**：转移边集、阶段完成判定、预算、检查点、降级由 dsh-cann-loop 插件强制执行，**不依赖 prompt 约定**（模型超预算的请求在插件层被拒绝）；失败后的分流（回 implement 还是回 strategy）由 **routing 判定会话**在边集内决策（§2 转移规则），插件只做结构校验与执行
- 每个阶段 = 一次受控 loop 运行：限定该阶段工具集 + 阶段 system prompt（`prompts/<stage>.md`）+ 阶段预算

## 2. 阶段定义

```
        ┌── 分叉点：routing 判定会话在边集内选边（见"转移规则"）──────────┐
        │                                                              │
identify → strategy → implement ⇄ verify → bench → summarize → deliver
                          └── 修复/优化迭代环（v1..vN，无次数上限，§3）──┘
```

| 阶段 | 输入 | 输出 | 允许的工具 | 完成判定 |
|---|---|---|---|---|
| identify | ONNX 模型（格式约束见 task-schema §1.2：仅 `.onnx`、opset ≥ 13、静态 shape）/ 算子规格 yaml | `identify/*.json` | parse_model, op_profile, fusion_scan, retrieve | 算子清单+融合候选落盘 |
| strategy | 融合候选 + RAG 检索 | `strategy/STRATEGY.md` + strategy.json | retrieve, strategy_gen | 策略文档落盘且通过 schema 校验 |
| implement | 策略 | `implement/vN/` 完整快照 | code_gen, patch_code, build, analyze_error | 编译通过（build 成功，= 直通判定） |
| verify | 编译产物 | `verify/accuracy_vN.json` | gen_test, run_test, analyze_accuracy | 报告落盘且过校验点；达标 = 直通判定 |
| bench | 通过精度的版本 | `bench/bench_vN.json`（基线+优化各一份） | bench_setup, run_bench | 双份测量完成 |
| summarize | 全程事件+产物 | `summarize/exp-*.json` | experience_write | 经验条目过校验写入知识库 |
| deliver | 全部产物 | `deliver/` 完整交付包 | package, gen_report | 清单四项齐（code/STRATEGY/REPORT/tests）+ 复现脚本自检 |

> 表中"完成判定"= **直通判定**（沿唯一边推进到下一阶段的条件）。verify / implement / bench 未满足 ≠ 阶段失败——进入转移规则分叉点；其余阶段（identify / strategy / summarize / deliver）未满足则同阶段重开会话，无次数上限、墙钟兜底。

**转移规则**（2026-09-17 拍板：**轨道与闸门在插件、道岔在判定会话**——分流不写死，由模型在固定边集内决策）：

1. **合法边集**（插件强制；判定会话只能在边集内选择，单一边的直通不判）：

| 当前状态 | 触发 | 允许的去向 |
|---|---|---|
| verify 会话结束 | 产物校验通过且精度达标 | bench（唯一边，不判） |
| verify 会话结束 | 产物校验通过但精度未达标 | implement \| strategy |
| bench 会话结束 | `gain_pct ≥ target.gain_pct` | summarize（唯一边，不判） |
| bench 会话结束 | `gain < target`（含 ≤ 0） | implement \| strategy |
| implement 会话结束 | build 通过（直通判定满足） | verify（唯一边，不判） |
| implement 会话结束 | build 未通过（含会话 token 满滚转后仍未建成） | implement \| strategy |
| identify / strategy / summarize / deliver 会话结束 | 直通判定未满足（产物缺失或校验不过） | 同阶段重开会话（唯一去向，不判；无次数上限，墙钟兜底） |
| 任意 | 墙钟耗尽 / 预算硬超限 | **degrade**（插件直判，不经会话） |

2. **routing 判定会话**（分叉点的决策者）：loop 插件在上表的多去向分叉处开一个轻量判定会话：
   - **无业务工具**，唯一工具 `route(next, reason, evidence, confidence)`（pydantic schema，TS 层校验后持久化为 `decision` 事件，observability §3——reason 与数值 evidence 必填，分流可审计）
   - **判据注入**（manifest）：趋势表（逐迭代 `max_rel_err` / `p50_us`、按当前 strategy 路线起算的历史最优、停滞标记）、失败明细（verify failures / 编译错误及 analyze_error 分类）、上轮 strategy 摘要与已试路线（selected/rejected）、预算余量
   - 判定会话可经 purpose 路由到独立模型角色（如强推理模型），与 worker 阶段模型解耦
   - 判定结果记入下一检查点；崩溃后重入分叉点即重判（判定会话廉价，幂等无副作用）

3. **结构校验与兜底**：`next` 不在边集内 / 缺失 / schema 非法 → 取默认边（**implement**，最保守的"再修一轮"）并发 warning 事件。兜底不是常态路径，只保证判定会话失效时 run 不中断

4. **判据计算 = 证据，不是判决**：`err_best / p50_best`（按当前 strategy 路线起算，重规划换路线后重新积累；vN 标签仍全 run 单调递增）、停滞标记（连续 2 次不优于历史最优）、bench 噪声容差 ε（默认 0 = 严格优于，D4 拍板后可配；verify 固定 seed 无噪声不容差）、编译错误分类（analyze_error 错误码映射：代码层 / 路线不可行）——全部进 manifest 供判定会话参考，**不直接决定去向**

5. **硬闸门不经判定会话**（插件直判）：墙钟耗尽→降级；单 session token 满→滚转新 session 续跑；任何转移前先过阶段完成判定（产物 schema 校验）；所有转移边无次数上限，唯一终止 = 达标/完成或墙钟耗尽

6. **软观察保留**（不打断、不阻止）：连续 2 次 route→strategy 而 `gain_pct` 无改善时发 warning note，提示判定会话可能被失败叙事误导

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
      "schema_version": "1.0",               // 语义化版本（task-schema §3 规则）
      "model": {
        "format": "onnx",                    // 输入格式，v1 仅 onnx（task-schema §1.2）
        "opset": 13,                         // 导出 opset，要求 ≥ 13
        "ir_version": 10,                    // ONNX IR 版本（排障用）
        "input_shape": [16,3,224,224]        // 静态输入 shape（与 task.yaml 一致性复核）
      },
      "nodes": [                             // 图中全部节点，按拓扑序
        { "idx": 0,                          // 节点序号（fusion_candidates.node_idx 引用此值）
          "op_type": "Conv",                 // 算子类型（ONNX op 类型）
          "name": "conv1",                   // 原始节点名（排障/报告引用）
          "attrs": { "kernel_shape": [7,7], "strides": [2,2] },  // 算子属性（原样透传）
          "input_shapes": [[16,3,224,224]],  // 各输入张量 shape
          "output_shapes": [[16,64,56,56]],  // 各输出张量 shape
          "dtype": "fp16" }                  // 计算精度（来自 constraints.dtype）
      ],
      "stats": {                             // 汇总统计（strategy 热点分析输入）
        "by_type": { "Conv": { "count": 53, "params": "45M" } },  // 按类型计数/参数量
        "total_nodes": 189 }                 // 节点总数
    }
    ```
  - `identify/fusion_candidates.json`
    ```jsonc
    { "schema_version": "1.0",
      "candidates": [                        // 融合候选清单
        { "id": "F001",                      // 候选编号（strategy.selected 引用此值）
          "pattern": "Conv+BN+ReLU",        // 融合模式名（对应 skills/ 融合模式手册条目）
          "node_idx": [3,4,5],               // 涉及节点序号（必须存在于 op_list.nodes）
          "est_gain_pct": 8.0,               // 预估收益 %（RAG 历史经验或启发式估算）
          "references": ["rag://exp-1234"],  // 依据来源（经验条目 / 文档引用）
          "status": "pending" } ]            // pending | selected | rejected（strategy 阶段回写）
    }
    ```
- **校验点**：opset 与静态 shape 复核通过；`nodes` 非空；candidates 的 `node_idx` 必须存在于 op_list

#### strategy

- **输入**：`op_list.json` + `fusion_candidates.json` + retrieve 检索结果（内存传递，不落盘）；**重规划时**（转移规则升级回流）另注入：上轮 strategy.json + verify/bench 证据（失败明细、误差/延迟趋势）+ 已试路线清单（前版的 selected/rejected）
- **输出**：
  - `strategy/strategy.json`
    ```jsonc
    { "schema_version": "1.0",
      "selected": ["F001"],                  // 选中的候选 id（⊆ fusion_candidates 的 id 集合）
      "tasks": [                             // 拆解出的算子任务队列（按 order 逐个走七阶段）
        { "op_task_id": "T-F001",            // 算子任务 id（implement 及后续阶段的关联键）
          "candidate_id": "F001",            // 来源候选
          "approach": "AscendC 融合 kernel", // 实现路线（strategy 拍板）
          "target_gain_pct": 8.0,            // 本任务收益目标（bench 判定基准）
          "risk": "low",                     // low | mid | high（失败预案与排序依据）
          "order": 1 } ],                    // 执行顺序
      "rejected": [ { "candidate_id": "F002", "reason": "官方已有等价融合" } ],  // 拒绝清单及理由
      "fallback": "单算子逐个优化" }         // 整体回退路线（融合全部失败时）
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
- **校验点**（= 直通判定，未满足则走分叉点）：`build.sh` exit 0 且 `artifacts/` 非空

#### verify

- **输入**：`implement/vN/artifacts` + gen_test 生成的用例（固定 seed，落盘 `verify/cases_v{N}/`）+ 官方基线实现（对照输出）
- **输出**：`verify/accuracy_v{N}.json`
  ```jsonc
  { "schema_version": "1.0",
    "version": "v2",                        // 对应 implement/vN 的迭代号
    "passed": 79, "total": 80,              // 通过数 / 总用例数
    "max_rel_err": 9.8e-4,                  // 全用例最大相对误差
    "threshold": 1e-3,                      // 达标阈值（task.yaml 覆盖，缺省 1e-3）
    "failures": [                           // 失败明细（可复现的输入摘要）
      { "case_id": "case_042",              // 用例编号（对应 verify/cases_v{N}/）
        "rel_err": 3.1e-2,                  // 该用例相对误差
        "input_summary": "seed=42 idx=17" } // 输入摘要（seed + 序号，可重建）
    ],
    "seed": 20260916,                       // 用例生成 seed（幂等复现的关键）
    "duration_ms": 64000 }                  // 全组用例耗时
  ```
- **校验点**：`failures` 数量 = `total − passed`；达标判定 = `max_rel_err ≤ threshold` 且 `failures` 为空（threshold 来自 task.yaml 或缺省 1e-3）

#### bench

- **输入**：通过精度判定的 `implement/vN/artifacts` + task.yaml `baseline` 段（`impl`：aclnn/torch_npu；`metric` 口径）+ ATC 门槛对照（`atc: enabled`，D4）
- **输出**：`bench/bench_v{N}_baseline.json` 与 `bench/bench_v{N}_optimized.json`（双份，结构相同；ATC 对照结果另存 `bench_v{N}_atc.json`，结构同）
  ```jsonc
  { "schema_version": "1.0",
    "version": "v2",                        // 对应 implement/vN 的迭代号
    "impl": "aclnn",                        // 实现来源：aclnn | torch_npu（task.yaml baseline.impl）
    "metric": { "warmup": 20, "iters": 100 },  // 测量口径（与 task.yaml baseline.metric 一致）
    "p50_us": 412.3,                        // 中位延迟（gain 判定的唯一口径）
    "p99_us": 486.1,                        // 尾延迟（仅报告参考）
    "mean_us": 419.7,                       // 均值（仅报告参考）
    "sync": "aclrtSynchronizeStream",       // 同步点（口径可审计）
    "device": "Ascend910B",                 // 测量设备型号（必填，报告引用）
    "note": "aclnn 基线（无 ATC 融合）+ ATC 门槛对照" } // 口径备注（写入交付报告）
  ```
- **gain 口径**：`gain_pct = (baseline.p50_us − optimized.p50_us) / baseline.p50_us × 100`（判死用 p50；p99 仅供报告参考）
- **ATC 有效性门槛（D4 拍板 2026-09-17）**：`optimized.p50_us` 须强于启用 ATC 自动优化的对照结果（`bench_v{N}_atc.json`），否则本迭代判为**无效优化**（不进入交付）；两种口径差异写入交付报告
- **校验点**：双份文件齐全（ATC 门槛启用时三份）；`iters` 与配置一致；`device` 必填（可审计）

#### summarize

- **输入**：`events.jsonl`（全程）+ 各阶段产物路径索引
- **输出**：`summarize/exp-{id}.json`（完整 schema 以 rag.md 为权威，最小字段如下）
  ```jsonc
  { "schema_version": "1.0",
    "id": "exp-20260916-a1b2c3d4",          // 经验条目 id（rag:// 引用形式）
    "problem": "Conv+BN+ReLU 融合",         // 问题 / 任务描述
    "root_cause": "……",                     // 根因分析（失败案例必填）
    "solution": "……",                       // 方案（做了什么、关键取舍）
    "reuse_when": { "dtype": "fp16", "layout": "NCHW" },  // 复用条件（检索时的过滤字段）
    "outcome": { "gain_pct": 6.2, "max_rel_err": 8e-4 } } // 结果（收益与精度）
  ```
- **校验点**（= 直通判定）：通过 rag.md schema 校验并写入知识库

#### deliver

- **输入**：全部阶段产物（路径来自 events.jsonl 的 artifact 引用）
- **输出**：`deliver/`（目录结构见 task-schema §2）+ `deliver/manifest.json`
  ```jsonc
  { "schema_version": "1.0",
    "code": "code/",                        // 可编译算子代码（四件套之一）
    "tests": "tests/",                      // 测试用例（四件套之二）
    "strategy": "STRATEGY.md",              // 策略文档（四件套之三）
    "report": "REPORT.md",                  // 交付报告（四件套之四）
    "repro": { "run": "run.sh", "bench": "bench.sh" },  // 复现脚本（自检入口）
    "final_version": "v3",                  // 最终采纳的迭代版本
    "gain_pct": 6.2,                        // 最终收益（vs 官方基线，p50 口径）
    "checksums": { "REPORT.md": "sha256:…", "run.sh": "sha256:…" } }  // 关键文件校验和（防篡改）
  ```
- **REPORT.md 必含**：任务信息 / 最终版本与迭代史 / 精度结论 / 性能对比（vs target 与 vs baseline）/ 复现步骤
- **校验点**（= 直通判定）：manifest 四项路径存在 + `run.sh --check` 自检通过 + checksums 复核一致

## 3. 预算（缺省值，task.yaml 可覆盖；2026-09-17 用户拍板修订）

| 预算 | 缺省 | 作用域 | 类型 | 超限动作 |
|---|---|---|---|---|
| `max_wall_min` | 90 | 整 run | 硬 | 降级（当前阶段现场保留）——**唯一硬性终止条件** |
| `max_tokens` | 1M | 单 session | 硬 | 收尾当前 session，按 manifest 新开 session 续跑（**不降级**） |
| 单工具调用超时 | 工具自声明（默认 10min） | 单次调用 | 硬 | 该次调用失败，计入当前迭代 |

**不设次数上限**：implement 编译失败重试、verify 迭代、回 strategy 重规划均无次数限制——在 `max_wall_min` 耗尽前，状态机持续循环优化直至达标（§2）或完成。迭代号 v1..vN 只是标签与检查点粒度，**不构成终止条件**。

- `max_tokens` 口径 = session 内**累计消耗**（含 compaction 重写；实际上下文窗口远小于此值）。它的作用是**上下文卫生**而非进度限制：单 session 计量满 1M，loop 插件即结束该 session、以最新现场重新注入 manifest 开新 session，run 不中断——这也是无迭代上限在本架构下可行的原因（session 边界天然切分上下文）
- 预算消耗随 `checkpoint` 事件展示（前端可见）
- 软提醒：`max_wall_min` 或单 session token 用量 80% 时发 `note`（severity=warning），不打断
- 软观察（不打断、不阻止）：连续 2 次回 strategy 重规划而 `gain_pct` 无改善时发 `note`（severity=warning），提示策略震荡，仅供人工参考

## 4. 降级（degrade）

触发即：发 `degrade` 事件（detail 必含：失败摘要、已尝试路径、建议人工动作、关联经验/文档引用）→ 状态机冻结 → 现场完整保留（代码/日志/检查点）→ 任务标记 `degraded` 等待人工。

人工介入点只有两个动作：**重试**（从最近检查点恢复，预算重置可配置）或 **放弃**（归档 run 目录）。前端 Dashboard 提供"重试/放弃"入口（demo 已实现交互样式）。

## 5. 检查点与恢复

- 检查点时机：每阶段 completed 后 + 每次迭代开始前
- `checkpoints/cp-{stage}-{iter}.json` 内容：状态机位置、迭代号、预算余量、关键产物路径、（可选）dsh session 续接句柄
- 恢复语义：进程崩溃/重启后，loop 插件扫描最新合法检查点 → 从该阶段重入 → **所有工具必须幂等**（同输入重复执行结果一致；编译/测试天然满足，gen_test 用固定 seed）
- 恢复本身发 `note` 事件，恢复前的 seq 保留（append-only 不破坏）

## 6. 并发与 NPU 队列（简述，D6 拍板后细化）

第一版：一个 run 独占一张 NPU 卡；loop 插件维护卡队列，排队 run 状态为 `pending`；队列是否持久化待 D6。迭代无次数上限（§3）后，单 run 卡占用时长的上界由 `max_wall_min` 保证——队列公平性依赖各任务的该值合理配置。

## 7. 阶段 system prompt 约定

- 每阶段 prompt 文件 `prompts/<stage>.md`，内容含：阶段目标、允许工具清单、输出 schema、失败处理指引、预算余量注入位
- 判定会话同规格受控：`prompts/routing.md`（分叉点判据清单、边集、`route` 工具契约、禁止臆造证据）
- prompt 与代码同版本管理，禁止运行时手改
