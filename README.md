# CannAgent

[![CI](https://github.com/Kuriyama9590/CANNAgent/actions/workflows/ci.yml/badge.svg)](https://github.com/Kuriyama9590/CANNAgent/actions/workflows/ci.yml)
[![issues](https://img.shields.io/github/issues/Kuriyama9590/CANNAgent)](https://github.com/Kuriyama9590/CANNAgent/issues)

构建 agent harness，让 agent 在昇腾（CANN）服务器环境中自主完成
**算子识别 → 融合/优化策略生成 → 代码编写 → 循环测试回归 → 经验总结 → 最终交付** 全流程。

- 任务跟踪：[开发看板](https://github.com/users/Kuriyama9590/projects/1)（实时状态流转）
- 阶段里程碑：[阶段① 前端 Demo](https://github.com/Kuriyama9590/CANNAgent/milestone/1) · [阶段② 规范文档](https://github.com/Kuriyama9590/CANNAgent/milestone/2) · [阶段③ 完整骨架](https://github.com/Kuriyama9590/CANNAgent/milestone/3) · [阶段④ 测试与部署](https://github.com/Kuriyama9590/CANNAgent/milestone/4)

## 目录结构

```
docs/        规范文档：SPEC / workflow / observability / task-schema / benchmark / plugin-dev / rag / ROADMAP / ADR / spikes
plugins/     dsh 插件 workspace：dsh-cann-tools / dsh-cann-knowledge / dsh-cann-loop（pnpm + tsc + vitest）
python/      cannagent 领域执行层：CLI 子命令 + events 唯一写入 + pydantic 权威 schema（pytest + ruff + mypy strict）
web-demo/    前端交互评审 demo（React + Vite + TS + AntD v5 + ECharts，零后端）
web/         真实 dashboard（消费 C7 观测服务 API + SSE；vite 代理 /api）
profiles/   三协议模型端点配置（openai-completions 实测 / anthropic-messages / openai-responses）
```

## 快速开始

三条链路独立可跑，任选入口：

```bash
# ① 前端 demo（模拟剧本，零后端）
cd web-demo && npm ci && npm run dev        # http://localhost:5173

# ② python 领域层（CLI 子命令 + 测试）
cd python && pip install -e ".[dev,onnx]" && pytest -q

# ③ 插件 workspace（构建 + 测试 + lint）
cd plugins && pnpm install && pnpm build && pnpm test

# ④ 真实 dashboard（需先启动观测服务）
cd python && python -m cannagent.server &   # :8300
cd web && npm ci && npm run dev             # :5174，/api 已代理
```

> 三者串成端到端（dsh 模型 → 插件 → CLI）的加载方法见 `plugins/README.md` 与 `docs/spikes/`。当前端到端覆盖 identify 阶段；七阶段全流程状态见 [STATUS](docs/STATUS.md)。

## 文档索引

| 文档 | 内容 |
|---|---|
| [ROADMAP](docs/ROADMAP.md) | 产品定义、技术决策、架构分层、阶段划分 |
| [STATUS](docs/STATUS.md) | **实现状态矩阵**（可用/骨架/占位/规划——唯一状态源） |
| [SPEC](docs/SPEC.md) | 开发规范总纲（九条） |
| [workflow](docs/workflow.md) | 七阶段任务状态机（预算 / 检查点 / 降级） |
| [observability](docs/observability.md) | 事件流契约（events.jsonl，append-only） |
| [task-schema](docs/task-schema.md) | 任务输入 schema 与 run 目录规范 |
| [benchmark](docs/benchmark.md) | 基线测量方法学（aclnn 基线 / ＞ATC 或未覆盖 / 口径统一） |
| [plugin-dev](docs/plugin-dev.md) | dsh 插件开发规范（三插件 / 零业务逻辑 / 加载组合） |
| [rag](docs/rag.md) | RAG 与经验库规范（条目 schema / 回流治理 / 检索契约） |
| [security](docs/security.md) | 权限与沙箱边界（三层防线 / 工具白名单 / CANN 环境固定） |
| [ADR-001](docs/adr/ADR-001-内核选型-dsh.md) | 内核选型：dsh |
| [C1 spike 报告](docs/spikes/C1-dsh-headless-spike.md) | dsh headless / Python SDK 运行形态验证（阶段③ 关键路径第一环） |

## 开发流程

- **trunk-based**：短分支 → PR → 合并 `main`；`main` 受分支保护，禁止直接 push 与 force push
- **Conventional Commits**：`feat(loop): ...` / `fix(web): ...`，PR 中由 CI 校验
- **任务即 issue**：新任务建 issue（打 `type/*` + `phase/*` 标签、挂里程碑），自动进入看板；PR 描述写 `Closes #编号` 关联任务
- **密钥**：凭据只通过环境变量引用（见 `.env.example`），任何密钥不得进入仓库

## 状态

**唯一状态源：[docs/STATUS.md](docs/STATUS.md)（实现状态矩阵：可用 / 骨架 / 占位 / 规划 / 远程）**——本节不重复细节，只给一句话定位：

- 阶段①②已完成；阶段③ 进行中：**C1–C4 / C6 / C7 / C8 / C9 / C11 已合入**（identify 端到端 + 观测服务 + 真实 dashboard 实测），七阶段其余域为占位，详见 [STATUS §2](docs/STATUS.md)
