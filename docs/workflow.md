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
