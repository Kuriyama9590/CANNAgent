# C1 Spike 报告：dsh headless 运行形态验证

> 任务：[#18 [C1] dsh headless 运行 spike](https://github.com/Kuriyama9590/CANNAgent/issues/18)（阶段③ 关键路径第一环，P0）
> 日期：2026-09-17 · 环境：Windows 本地开发机（ROADMAP「本地开发环境备忘」同环境）
> 版本：npm `@deepseek-ai/dsh@0.1.5-rc.2` · pip `deepseek-harness-sdk 0.1.5rc1`（含 `deepseek-harness-runtime-bin 0.1.5rc1` 单文件 exe）
> 模型：`deepseek-v4-flash`（reasoningEffort max）经 dmxapi 网关（OpenAI 兼容协议）

## 结论（验收判定）

**通过**：dsh 无人值守运行形态可用，且 Python SDK 常驻 runtime 是比 headless CLI 更适合 CannAgent 的主形态。session/loop 两项 API 达预期；scheduling 一项澄清了语义边界（dsh 不提供进程级调度，D6 队列归 Python 层，与现有分层决策一致）。

| # | 验证项 | 结果 | 要点 |
|---|---|---|---|
| 1 | headless 单任务直驱 | ✅ | `dsh --profile headless "<task>"`：stdout 返回最终答复、stderr 流式 reasoning、`turn/end.reason=completed → exit 0`；最小任务 6.2s |
| 2 | 无人值守多步工具 loop | ✅ | 写文件→读回任务：turn 内 3 个 step、`tool/call`+`tool/result` 事件完整落盘（含 callId/name/arguments/结果），8.6s 完成 |
| 3 | 批处理 / CI 形态 | ✅ | 连续 3 次 one-shot 全部 exit 0；每次运行独立 `session-<uuid>`，互不干扰 |
| 4 | 失败语义 | ✅ | 坏凭据（无效 API key）→ stdout 空、stderr 报 `AUTH: Invalid token (...)`、exit 1——CI 可直接用退出码判型 |
| 5 | 沙箱边界（无人值守安全） | ✅ | workspace 外写入在**工具层**被拒绝（PowerShell `UnauthorizedAccessException`），运行不挂起、不等待人工审批，agent 收到错误自行汇报 |
| 6 | session 持久化 | ✅ | `$DSH_HOME/sessions/<cwd-slug>/<session-id>/session.v3.jsonl.zstd`，**多帧 zstd**（每次 append 一帧）；事件含模型配置（`request/header`）与全量工具轨迹，满足「原始会话取证」需求 |
| 7 | Python SDK 常驻 runtime | ✅ | `DeepSeekHarness` 一次握手（~4s）后多 `run()` 复用；**同 session 跨 run 记忆延续验证通过**；事件流/finish_reason 在 Python 侧直接可得；干净关闭 exit 0 |
| 8 | 跨进程 session 恢复 | ❌ | jsonrpc wire 仅 `initialize` / `session/prompt` / `shutdown` 三方法；对已落盘 id `start_session` 报 `SESSION_ALREADY_EXISTS`。协议层存在 `session/load`（供 web/ACP 前端）但 SDK server 未暴露 |
| 9 | scheduling 语义澄清 | ➖ | dsh `schedule` = session 内提醒（需活跃 root agent）；`jobs` = 会话内后台长任务。无进程级 cron/队列 → **D6 NPU 持久化队列归 python/cannagent 层**，符合现有分层 |

## 关键发现

### F1. 主形态建议：Python SDK 常驻 runtime（C4 的输入）

- headless CLI = 无状态单发：每任务新进程、新 session、无延续。适合 CI 冒烟与脚本化单步。
- Python SDK = 有状态常驻：`DeepSeekHarness` 持有 runtime 子进程，`run(input, session_id=...)` 在同一 session 上多轮推进，`RunResult` 携带 `final_response` / `finish_reason`（`turn/end` 的 kind）/ `events`。
- **七阶段状态机的载体**：每任务 run 一个 `DeepSeekHarness` 实例，identify→strategy→implement⇄verify→bench→summarize→deliver 各阶段 = 同 session 的多次 `run()`；崩溃/检查点恢复 = 新 session + run 目录重注入上下文（与 workflow.md「检查点断点恢复」的状态外置设计一致，见 F3）。
- 凭据与端点：`DEEPSEEK_API_KEY` + `DEEPSEEK_BASE_URL` 环境变量即可驱动 bundled runtime，**不依赖本机 `settings.yaml`**——与 C9 profiles「任意机器 clone 即可运行」的目标吻合。
- SDK 明确**不隐式使用 `~/.dsh`**：必须显式设置 `DSH_HOME`（本 spike 设为 `C:\Users\QiuYC\.dsh`，与 CLI 共享 sessions/credentials）。

### F2. ⚠️ PyPI 抢注包（供应链安全）

PyPI 上的 **`deepseek-harness`**（0.3.1，作者 HenryZ838978）是**无关的第三方 DeepSeek API 客户端，不是官方 SDK**。官方发行名：

- `deepseek-harness-sdk`（客户端，`import deepseek_harness`）
- `deepseek-harness-runtime-bin`（bundled runtime，随 sdk 同版本安装）

本机默认 pip 索引查不到官方包，需 `pip install --index-url https://pypi.org/simple/ deepseek-harness-sdk`。**C4/requirements 与部署文档必须钉死官方包名**（误装抢注包已在本次 spike 中发现并卸载，未造成影响）。

### F3. 跨进程 session 恢复不可用（0.1.5rc1）→ 恢复策略定型

- SDK jsonrpc server 的 `createSession` 对已存在的 sessionId 直接报错，没有 load-if-exists 路径；durable log 在磁盘上但无法经 SDK 重开。
- **对策（采纳）**：检查点状态以 run 目录为准（task.yaml / checkpoints / events.jsonl），恢复 = 新 session + 重注入；dsh session log 仅作取证。这与 SPEC #4「检查点断点恢复」的既有设计一致，无需变更规范。
- **跟进**：列入 D7 每月版本检查的关注项（若上游 SDK 暴露 `session/load` 可简化恢复路径）。

### F4. 版本双通道对齐（D7 的输入）

npm dsh（`0.1.5-rc.2`，CLI/profile/插件开发面）与 pip runtime-bin（`0.1.5rc1`，SDK 驱动的执行面）是**两个发行通道**，版本号不保证同步。C3 插件经 `DSH_CORDIS_CONFIG` 注入 SDK runtime 时，**插件 API 面以 runtime-bin 版本为准**——月检与回归基线需同时覆盖两个通道。

### F5. 无人值守审批语义（C11 的输入）

headless 默认 `permission/preset=workspace-write` + `sandbox/mode=workspace-write` + `approval/policy=ask`：workspace 内写自动放行、越界写在工具层被沙箱拒绝（不触发人工等待）。实测无挂起。C11 落地命令白名单时需复核 `ask` 策略在无 UI 场景对「沙箱外但未显式禁止」操作的行为（本次未覆盖该角落）。

### F6. session 日志格式（C2 的输入）

- 落盘为多帧 zstd 压缩 JSONL，**不能**用单次解压读取（Node `zlib.zstdDecompressSync` 只解首帧）；仓库附工具 `tools/session-log-dump.mjs`（零依赖，Node ≥24 原生 zstd）按帧切分解压。
- 事件类型清单（实测）：`session`(头) / `permission/preset` / `sandbox/mode` / `approval/policy` / `agent/inbox/spliced` / `turn/start|end` / `step/start|end` / `system/message` / `user/message` / `assistant/message` / `request/header|context` / `session/title*` / **`tool/call` / `tool/result`**。
- `tool/call{callId, name, arguments}` + `tool/result{callId, content}` 是 C2 双写（events.jsonl）的天然拦截点；SDK 路线下亦可直接在 Python 侧消费 `RunResult.events` / `on_notification` 流。

## 实验记录

| 实验 | 命令/脚本 | 结果 |
|---|---|---|
| exp1 单轮冒烟 | `dsh --profile headless "Reply with exactly: C1-SMOKE-OK"` | exit 0，6.2s，精确返回 |
| exp2 工具闭环 | headless：创建 `loop-probe.txt` 并读回 | exit 0，8.6s，文件内容正确，3 step + 2 组 tool 事件 |
| exp3 批处理 | 同任务连续 3 次 one-shot | 3/3 exit 0 |
| exp3b 失败语义 | `DEEPSEEK_API_KEY=sk-invalid...` | exit 1，stderr `AUTH: Invalid token` |
| exp4 沙箱边界 | headless：向父目录写文件 | 工具层拒绝（UnauthorizedAccess），不挂起，exit 0（汇报任务本身完成） |
| exp5 SDK 常驻 | `DeepSeekHarness` + 同 session 两次 `run()`（记忆存取） | 4.0s 握手；run1 2.1s / run2 1.8s；`SAME_SESSION=True`、`MEMORY_OK=True` |
| exp5b 跨进程恢复 | 新进程 `start_session(旧id)` | ❌ `SESSION_ALREADY_EXISTS`（见 F3） |

实验工作目录在仓库外（`D:\Projects\cann-neo\spike-c1\`），不入 git；探针脚本经验证的有效部分已沉淀为 `tools/session-log-dump.mjs`。

## 对看板的建议状态流转

- **#18（C1）**：spike 完成，建议用户评审后归档（本 PR 不自动关闭）
- **#19（C2）**：依赖解除，可启动——拦截点与消费路径已在 F6 给出
- **#21/#4（C4）**：架构输入已就绪（F1 主形态 + F2 包名红线 + F3 恢复策略）
