# 基准测量方法学（benchmark）

> 阶段② 规范文档 · 关联任务 B4 · 精度与性能测量的唯一方法学权威。
> 状态：v1（2026-09-17，D4 / D10 已拍板）。**分工**：本文件定义"怎么测"；workflow.md §2.1 bench 段定义"何时测、结果文件 schema 与状态机判定"；冲突时测量口径以本文件为准。

## 1. 目标与原则

1. **公平对比**：优化实现与官方基线在**同一设备、同一环境指纹、同一口径**下测量；基线 = CANN 官方算子库 **aclnn 单算子接口**直调（D4）——天然不含 ATC 图融合，排除图编译器干扰
2. **有效性判据（D4 + 2026-09-17 追加）**：`＞ATC 或 ATC 未覆盖`——先采集 ATC 优化清单（C12），对每个优化点分类判定（§5）；"比官方 aclnn 快"不再是充分条件
3. **可复现**：测量脚本、口径参数、环境指纹全部随 run 目录落盘；golden 基线固化（§8）保证跨 run 可对照
4. **CI 卡点（D10）**：精度 = 硬卡点（不达标不合入/不交付）；性能 = 仅报告，不做合入卡点

## 2. 测量环境与前提

| 项 | 要求 | 说明 |
|---|---|---|
| 执行位置 | 昇腾服务器，任务包模式（D9） | agent 侧不测量；`bench_setup` 生成的测量脚本随任务包下发，结果包回传 |
| 卡占用 | 一 run 独占一卡（D6） | 测量前 `npu-smi info` 确认目标卡空闲（无其他 process 占用）；排队由持久化卡队列保证 |
| 环境指纹 | 必采集 | `device` 型号、CANN 版本、驱动/固件版本、CPU 型号、卡 id；写入 bench json 的环境段与 REPORT.md |
| 频率与降频 | 测量前检查 | 记录测量时段 `npu-smi` 的频率/温度/功耗快照；发现降频（温度墙）该组测量作废重测 |
| 算子加载 | 预热期完成 | 首次调用含算子加载/JIT 编译，一律计入 warmup 不计入统计 |

环境指纹采集命令（脚本内置，输出进结果包）：`npu-smi info`、`npu-smi info -t board`、`cat /usr/local/Ascend/cann/version.info`、`uname -a`。

## 3. 精度测量（verify）

- **对照实现**：官方 aclnn 同算子接口，相同输入逐用例对比
- **用例生成**：固定 seed（`verify/accuracy_v{N}.json` 的 `seed` 字段）；输入分布按算子语义选择（均匀/正态），生成参数落盘 `verify/cases_v{N}/`，可独立重建
- **误差口径**：`rel_err = |out_opt − out_ref| / (|out_ref| + eps)`，逐元素计算后取**全用例最大值** `max_rel_err`；`eps = 1e-6` 防除零；fp16 任务参考值用 fp32 累加的官方实现输出
- **达标判定（硬卡点，D10）**：`max_rel_err ≤ threshold` 且 `failures` 为空（threshold 缺省 `1e-3`，task.yaml 可覆盖）；未达标 = verify 不通过，走 workflow 转移规则（回 implement / strategy）
- **无噪声假设**：verify 固定 seed + 同卡执行，误差不容差（区别于 bench 的 ε，§6）

## 4. 性能测量（bench）

### 4.1 三份对照（同一次任务包内完成）

| 测量 | 对象 | 说明 |
|---|---|---|
| `bench_v{N}_baseline.json` | 官方 aclnn 单算子直调 | 公平基线（无 ATC 图融合） |
| `bench_v{N}_optimized.json` | `implement/vN/artifacts` | 本次迭代实现 |
| `bench_v{N}_atc.json` | ATC 编译后的整图/子图执行 | ATC 门槛对照（`baseline.atc: enabled` 时必测，D4） |

三份使用**同一** metric 口径、同一输入 shape/dtype、同一设备与卡。

### 4.2 统一口径（缺省值，task.yaml `baseline.metric` 可覆盖）

| 参数 | 缺省 | 规则 |
|---|---|---|
| `warmup` | 20 | 预热次数；不足 20 的算子（单次耗时长）按 `min(20, ⌈10s/单次耗时⌉)` 下调并在 note 记录 |
| `iters` | 100 | 统计迭代次数；变更须同步 note |
| `stats` | `[p50, p99]` | 输出分位数；`mean` 附带仅作参考 |
| 同步点 | `aclrtSynchronizeStream` | 每次迭代独立同步后计时；同步点字符串写入 bench json（可审计） |

### 4.3 计时方法

- host 侧计时：`aclrtSynchronizeStream` 后取单调时钟（`clock_gettime(CLOCK_MONOTONIC)` / `std::chrono::steady_clock`），**逐迭代记录原始延迟**（不只记录汇总值），落结果包 `latencies_v{N}_*.csv`
- 单次迭代 = 一次完整算子调用（含必要的入参拷贝 H2D/D2H 计入；**设备内存分配不计入**——内存在测量脚本前置分配）
- 多输入/分支算子：按算子语义定义"一次调用"，在 bench 脚本头部注释声明

### 4.4 gain 计算

`gain_pct = (baseline.p50_us − optimized.p50_us) / baseline.p50_us × 100`（p50 唯一判定口径；p99/mean 仅报告参考——workflow.md §2.1）

## 5. 有效性判据（D4 权威流程）

测量前先执行 **ATC 优化清单采集**（C12 实现，产出 `bench/atc_opt_list_v{N}.json`，schema 见 workflow.md §2.1）：

1. 对输入图跑 ATC 编译（任务包内），从编译日志/图 dump 枚举自动应用的 pass（融合/替换等）及作用范围
2. 对 `strategy.selected` 的每个优化点，对照清单二选一：
   - **ATC 已覆盖**（pass 重叠命中）→ 必须 `optimized.p50_us < bench_v{N}_atc.p50_us`（严格小于，不容差），否则该优化点判**无效**，不得进入交付
   - **ATC 未覆盖** → 判**有效**（价值来自覆盖空白），不做 ATC 对照，仍须精度达标并按 §4.4 报告 gain
3. 清单、分类结论、两种口径差异一并写入交付报告（REPORT.md 必含项，workflow.md deliver 段）

## 6. 噪声与稳定性

- **ε 容差**：`gain` 判定的噪声容差，默认 **0**（严格优于；D4 拍板），task.yaml `baseline.metric.epsilon` 可配置——bench 与 verify 不同，verify 永不容差（§3）
- **重复测量**：判定用单组测量；当 `0 ≤ gain_pct < ε_disabled 且 |gain| 处于噪声疑似区间`（默认 p50 差异 < 3%）时，bench 工具自动追加一组复测并报告两组 p50——复测仅报告，不改变判定逻辑
- **异常处理**：单迭代延迟超出同组 p50 的 10 倍视为异常值，剔除后在 note 记录剔除数；剔除率 > 5% 该组作废重测
- **环境漂移**：同 run 内若两次任务包间隔 > 24h，基线测量随优化测量同包重做（不引用旧包基线）

## 7. 报告口径

- 结果文件 schema：workflow.md §2.1 bench 段（本文件不重复定义字段）
- REPORT.md 性能章节必含：三份 p50/p99 对照表、gain_pct、ATC 优化清单与每个优化点的覆盖分类、口径 note（warmup/iters/同步点/ε）、环境指纹、复现命令
- 事件流：`artifact.tab=bench`（observability.md §4）内嵌三份摘要 + `atc_opt_list` 引用

## 8. golden 基线固化（E2 落地）

- **官方基线 golden 集**：对代表性算子集（首批：resnet50/swinv2 涉及的热点算子 + 单算子 ONNX 集）固化 aclnn 基线测量，随**环境指纹**存入 `tests/golden/`
- **复测节奏**：CANN 升级、驱动升级、D7 月检 dsh 升级触发的回归，都先跑 golden 复测再比对
- **漂移告警**：golden 复测 p50 偏离固化值超过 5% 时，CI 发 warning（性能仅报告不卡点，D10），由人工判定环境变化还是真回归

## 9. 版本

- v1（2026-09-17）：随 D4（aclnn 基线 + ＞ATC 或未覆盖判据）、D10（精度硬卡点/性能报告）、D6（独占卡）拍板发布
