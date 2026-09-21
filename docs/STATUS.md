# 实现状态矩阵（STATUS）

> **唯一状态源**：本文件维护「规范 → 实现现状」的对照；README/ROADMAP 只引用不重复。
> 分层标记：**可用**（已实现且实测）/ **骨架**（结构就位、核心逻辑可用、覆盖不全）/ **占位**（结构化 NOT_IMPLEMENTED 占位，规范已定）/ **规划**（仅规范，未动工）/ **远程**（需昇腾服务器环境）。
> 更新纪律：每个 PR 改变实现状态时同步本矩阵（AGENTS §3 文档权威性）。

## 1. 分层总览（2026-09-20）

| 层 | 状态 | 说明 |
|---|---|---|
| 规范文档（docs/ 八篇 + ADR） | ✅ 可用 | 全部发布；个别条目标「代码跟进中」（见 §3） |
| plugins/ 三插件 | 🟡 骨架 | 工具表/白名单/状态机边集可用；route 持久化、knowledge 白名单转发 = 代码跟进中 |
| python/cannagent | 🟡 骨架 | CLI/events/runs/checkpoint/identify/knowledge 可用；strategy→deliver 域为占位 |
| web-demo/ | ✅ 可用 | 交互评审定稿（模拟剧本，零后端） |
| web/ 真实 dashboard | ✅ 可用 | 消费 C7 FastAPI + SSE |
| 远程执行（昇腾服务器） | ✅ 可用 | C5/C12 实测通过（任务包 + ATC 编译 + 清单回传）；E2 待做 |

## 2. 能力矩阵（规范条目 → 实现）

### python CLI（`python -m cannagent <子命令>`）

| 子命令 | 状态 | 备注 |
|---|---|---|
| `events append` | ✅ 可用 | observability §5 唯一写入函数；截断/invocation_id 契约代码跟进中 |
| `runs`（创建 run 目录） | ✅ 可用 | task-schema §2 |
| `checkpoint` / `checkpoint-read` | ✅ 可用 | workflow §5 |
| `parse-model` / `op-profile` / `fusion-scan` | ✅ 可用 | 真实 ONNX 图枚举；D3 全链路实测 |
| `knowledge`（retrieve/experience_write/list/approve/reject/delete/add） | ✅ 可用 | rag §4/§6；show/edit 代码跟进中 |
| `strategy-gen` / `code-gen` / `patch-code` | 🟫 占位 | `CANN_E_NOT_IMPLEMENTED` |
| `build` | ✅ 可用 | C5 真实现：ATC 任务包端到端（om 回传 + C12 清单）；analyze-error 仍占位 |
| `gen-test` / `run-test` / `analyze-accuracy` | 🟫 占位 | verify 链路（aclnn 基线，远程） |
| `bench-setup` / `run-bench` | 🟫 占位 | benchmark §4 三份对照（远程） |
| `package` / `gen-report` | 🟫 占位 | deliver 链路 |

> **端到端现状**：identify 阶段可真实跑通（dsh 模型 → 插件 → CLI → 产物 + 事件）；strategy 起的七阶段流转 = 状态机骨架（插件边集）+ 上述占位，尚不能端到端执行优化流程。

### TS 插件（plugins/）

| 能力 | 状态 | 备注 |
|---|---|---|
| 15 工具表注册 + python 转发（D3） | ✅ 可用 | 真实 dsh 加载冒烟通过 |
| 工具边界事件拦截（D2 双写） | ✅ 可用 | tools/execute waterfall；C2/C4 实测 |
| C11 白名单闸门（pre-execute deny） | ✅ 可用 | pwsh 拒绝实测；一致性测试 CI 把关 |
| 状态机边集/route 工具（dsh-cann-loop） | 🟡 骨架 | 边集与兜底可用；decision 事件/检查点持久化代码跟进中 |
| knowledge 插件白名单转发 | 🟡 代码跟进中 | 当前 process.env 直传（与 security §1 第三层不一致，修复中） |

### 服务与前端

| 能力 | 状态 | 备注 |
|---|---|---|
| FastAPI 观测服务（C7） | ✅ 可用 | runs 列表/详情/增量事件/SSE/产物服务；契约测试 + 真实 uvicorn 冒烟 |
| 真实 dashboard（C8） | ✅ 可用 | web/（demo 演进）：API+SSE 接入、回放游标、浏览器实测（含 decision 事件渲染） |

### 远程（昇腾 910B 服务器）

| 能力 | 状态 | 备注 |
|---|---|---|
| 任务包派发（remote.RemoteRunner） | ✅ 可用 | SSH+SFTP 组包/执行/回传；NPU 目录锁（D6 v1）；环境锚定 conda cannagent |
| build ATC 编译（C5） | ✅ 可用 | **实测**：resblock.onnx → 服务器 atc → om 回传落盘（ATC run success） |
| ATC 优化清单（C12） | ✅ 可用 | **实测**：fusion_result.json 权威解析 → atc_opt_list_v1.json（18 pass / 4 生效） |
| golden 回归（E2 最小版） | ✅ 可用 | identify 逐字段 golden + **远程 ATC 编译回归**（applied pass 集比对，实测通过）；aclnn 性能 golden 待 bench 域 |

## 3. 契约对齐跟踪（文档权威、代码对齐）

| 规范条目 | 差距 | 状态 |
|---|---|---|
| task-schema §1.1 `output` 可选字段 + model/operator 互斥 | 字段缺失、互斥未强制 | ✅ 已修复（含互斥拒收测试） |
| observability §2 `tool.invocation_id` 配对 | 插件未生成、python 未校验 | ✅ 已修复（exec.callId 直通；缺失自动补全+note；端到端配对实测） |
| observability §5 截断语义 | 整包替换丢失骨架字段 | ✅ 已修复（tool.input/output 就地截断 + spill 文件 full_ref；骨架字段保留有测试） |
| plugin-dev §3 子进程 env 白名单 | knowledge 插件 process.env 直传 | ✅ 已修复（复用共享 forward/allowlistedEnv，workspace 依赖） |
| workflow §2.2 route 决策持久化 | 未写 decision 事件/检查点 | ✅ 已修复（await 持久化；端到端 tool_started→decision→tool_completed 实测） |
| rag §4 治理命令 `show`/`edit` | 未实现 | ✅ 已修复（edit 过 schema 重校验，非法编辑拒收） |

附带发现并修复（审查未覆盖）：
- **Windows 子进程编码**：最小 env 下 python 按 GBK 解码 stdin → 孤立代理对 → UTF-8 写入崩溃——`forward()` 注入 `PYTHONUTF8=1`/`PYTHONIOENCODING=utf-8` + CLI 流重配置双保险（中文 reason 端到端实测存活）
- `CANNAGENT_WORKSPACE` 加入 env 白名单（子进程工作区定位）
- pytest 全局 timeout=120（防无限流用例拖死 CI）
