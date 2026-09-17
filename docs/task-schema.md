# 任务输入 Schema 与 run 目录规范（task-schema）

> 阶段② 规范文档 · 关联任务 B2 · 供 `python/cannagent/config.py` 的 pydantic 模型与 dsh-cann-loop 插件实现参照。
> 状态：v1 草案（随实现修订，字段变更需同步本文件）

## 1. 任务输入双 Schema

两种入口（已确认的产品决策），公共字段合并定义，差异字段按 `task_type` 区分。文件统一为 YAML，命名 `task.yaml`，置于 run 目录根部。

### 1.1 公共字段

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `schema_version` | string | ✓ | 当前 `1.0`；task-schema 的语义化版本 |
| `task_type` | enum | ✓ | `model`（整网模型）/ `operator`（单算子规格） |
| `task_name` | string | ✓ | 展示名（run 名称默认取此值） |
| `baseline` | object | ✓ | 基线配置（见 1.4） |
| `budgets` | object | ✓ | 预算（见 1.5），缺省值由 workflow.md §3 给出 |
| `output` | object | ✗ | 交付要求覆盖（如 `target_gain_pct` 已有则冗余） |

### 1.2 整网模型任务（`task_type: model`）

```yaml
schema_version: "1.0"
task_type: model
task_name: resnet50 算子融合优化
model:
  path: input/resnet50_bs16.onnx        # 相对 run 目录
  format: onnx                          # v1 仅支持 onnx（见下方"输入格式"）
  opset: 13                             # ≥ 13（CANN 9.0 支持范围，加载时校验）
  input_shape: [16, 3, 224, 224]        # 必须静态固化；动态轴 v1 不支持
constraints:
  dtype: fp16
  exclude_ops: []                       # 跳过的算子类型
  max_fusion_count: 6                   # 单 run 最多处理的融合机会数
target:
  gain_pct: 5                           # 相对官方实现的提升目标
baseline: *默认官方基线*                # 见 1.4
budgets: {}                             # 见 1.5
```

**语义**：agent 自主解析模型 → 识别算子与融合机会 → 按 `max_fusion_count` 拆解出算子任务队列，逐个走七阶段；`target.gain_pct` 为每个算子任务的目标。

**输入格式（identify 的消费契约）**：identify 读取的是**计算图**（算子类型 / 属性 / 拓扑 / shape），不是权重文件。因此：

| 格式 | v1 定位 | 理由 |
|---|---|---|
| ONNX（`.onnx`） | **唯一支持** | 图结构自包含，`onnx` 包可枚举 node/initializer；与 CANN 工具链（ATC / aclnn）算子语义一致 |
| torchscript（`.pt`） | 不支持 | 图在 torch 内部 IR 中，解析脆弱；落地 CANN 前仍需转 ONNX，多一跳无收益 |
| pdparams | 不支持 | Paddle 生态，与参考模型（resnet50 / swinv2）无关 |
| `.pth` / safetensors 等**纯权重格式** | **排除**（ schema 层拒收） | 只含张量、不含图，identify 无法从中读出算子清单；角色是 verify/bench 的附加权重，放 `input/weights/`（专用 schema 字段后续版本再定） |

PyTorch 用户导出指引：`torch.onnx.export(model, dummy_input, path, opset_version=13, do_constant_folding=True)`，batch 维固定不使用动态轴。

### 1.3 单算子规格任务（`task_type: operator`）

```yaml
schema_version: "1.0"
task_type: operator
task_name: Conv3x3 融合（32×64×32×32）
operator:
  pattern: "Conv3x3 + BN + ReLU"        # 融合模式或单一算子类型
  inputs:  [{shape: [32, 64, 32, 32], dtype: fp16, layout: NCHW}]
  outputs: [{shape: [32, 64, 32, 32], dtype: fp16, layout: NCHW}]
  attrs: {kernel: [3, 3], stride: [1, 1], pad: [1, 1, 1, 1]}
target:
  gain_pct: 8
baseline: {}
budgets: {}
```

**语义**：跳过模型解析，identify 阶段仅做规格校验（约秒级），直接进入 strategy。

### 1.4 基线配置（`baseline`，对应 D4）

| 字段 | 默认 | 说明 |
|---|---|---|
| `kind` | `official` | `official`（CANN 官方算子库）/ `custom`（任务指定实现） |
| `impl` | `aclnn` | `aclnn`（单算子 API）或 `torch_npu`；**默认 aclnn**，天然不含 ATC 图融合 |
| `atc` | `disabled` | 显式关闭自动融合的选项名（写入 bench 日志，报告可审计） |
| `metric` | `{warmup: 20, iters: 100, stats: [p50, p99]}` | 统一口径 |

### 1.5 预算（`budgets`，缺省值；2026-09-17 修订）

| 字段 | 缺省 | 含义 |
|---|---|---|
| `max_wall_min` | 90 | 整 run 墙钟上限（分钟），**唯一硬性终止条件**（超限→降级） |
| `max_tokens` | 1_000_000 | **单 session** token 上限（session 内累计消耗口径）；满额即收尾该 session 并新开续跑，不终止 run |

**无次数上限**（2026-09-17 用户拍板）：不设 `max_iterations`——implement 编译失败重试、verify 迭代、回 strategy 重规划均不限次，持续优化直至达标或墙钟耗尽。超限语义见 workflow.md §3/§4。

## 2. run 目录规范

每个任务一个 run，目录 `workspace/runs/<run_id>/`，`run_id = r{yyyyMMdd-HHmmss}-{slug}`（slug 取 task_name 拼音/哈希 8 位）。**目录即审计现场**：只追加、不篡改（events.jsonl 见 observability.md）。

```
workspace/runs/<run_id>/
├── task.yaml              # 输入任务副本（含解析后的默认值回填）
├── input/                 # 原始输入（模型文件/规格文件），只读
├── identify/
│   ├── op_list.json       # 算子清单（类型/数量/shape/热点占比）
│   └── fusion_candidates.json
├── strategy/
│   └── STRATEGY.md        # 策略文档（+ 结构化 strategy.json）
├── implement/
│   ├── v1/ … vN/          # 每迭代一份完整代码快照（不 diff 存储，保证可独立编译）
│   │   ├── operator/      # kernel + host 侧
│   │   └── build.log
├── verify/
│   └── accuracy_v{N}.json # 每迭代精度报告
├── bench/
│   └── bench_v{N}.json    # 官方基线与优化后各一份
├── summarize/
│   └── exp-{id}.json      # 经验条目（schema 见 rag.md）
├── deliver/               # 最终交付包（可独立打包带走）
│   ├── code/  tests/  STRATEGY.md  REPORT.md  run.sh  bench.sh
├── experience/            # 经验回流副本
├── events.jsonl           # 全步骤事件流（observability.md，前端唯一数据源）
└── checkpoints/
    └── cp-{stage}-{iter}.json   # 状态机快照（workflow.md §5）
```

规则：
1. `input/` 只读；agent 的一切写入发生在其余子目录
2. `implement/vN/` 存完整快照而非增量——保证断点恢复时任意版本可独立编译
3. `deliver/` 为交付边界：内容打包后可脱离 workspace 复现（`run.sh` 自含编译/测试调用）
4. 目录内禁止出现凭据/密钥（observability.md §6 脱敏）

## 3. 校验与版本

- pydantic 模型 `cannagent.task_schema` 为唯一权威实现，task.yaml 加载即校验，校验失败直接拒收并报结构化错误
- `schema_version` 主位变更 = 破坏性变更，需 ADR；次位 = 兼容新增
