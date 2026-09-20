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
| web/ 真实 dashboard | ⬜ 规划 | 由 web-demo 演进，消费 C7 FastAPI |
| 远程执行（昇腾服务器） | ⬜ 规划 | C5/C12/E2，需 910B 环境 |

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
| `build` / `analyze-error` | 🟫 占位 | 依赖 C5（远程任务包） |
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
| FastAPI 观测服务（C7） | 🟡 开发中 | 契约 = observability §5 消费面 |
| 真实 dashboard（C8） | ⬜ 规划 | — |

### 远程（昇腾 910B 服务器）

| 能力 | 状态 | 备注 |
|---|---|---|
| build 编译链路（C5） | ⬜ 规划 | 任务包下发/结果包回传（D9） |
| ATC 优化清单采集（C12） | ⬜ 规划 | D4 判定依据 |
| golden 基线固化（E2） | ⬜ 规划 | benchmark §8 |

## 3. 契约对齐跟踪（文档权威、代码跟进中）

| 规范条目 | 差距 | 修复 PR |
|---|---|---|
| task-schema §1.1 `output` 可选字段 | TaskYamp 暂缺该字段（extra=forbid 拒收文档合法输入）；model/operator 互斥未强制 | 进行中 |
| observability §2 `tool.invocation_id` 配对 | 插件未生成、python 未校验 | 进行中 |
| observability §5 截断语义 | 当前整包替换为 `$truncated`（丢失 kind/stage 等）；应为 tool.input/output 就地截断 + full_ref | 进行中 |
| plugin-dev §3/§6 子进程 env 白名单 | knowledge 插件未沿用（process.env 直传） | 进行中 |
| workflow §2.2 route 决策持久化 | loop 插件未写 decision 事件/检查点 | 进行中 |
| rag §4 治理命令 `show`/`edit` | 未实现 | 进行中 |
