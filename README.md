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
profiles/   三协议模型端点配置（openai-completions 实测 / anthropic-messages / openai-responses）
（规划中）web/        真实 dashboard（由 web-demo 演进）
```

## 快速开始（web-demo）

```bash
cd web-demo
npm ci
npm run dev      # http://localhost:5173
```

三套模拟剧本：resnet50 直播（含迭代修复）、swinv2 已完成回放、Conv3x3 降级态。

## 文档索引

| 文档 | 内容 |
|---|---|
| [ROADMAP](docs/ROADMAP.md) | 产品定义、技术决策、架构分层、阶段划分 |
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

- **阶段① 前端 Demo：已完成**（2026-09-17 布局与交互评审通过，定稿见 [ROADMAP](docs/ROADMAP.md) §2）
- **阶段② 规范文档：已完成**——SPEC / workflow / observability / task-schema / benchmark / plugin-dev / rag / ADR-001 全部发布（B1–B8；issue 归档由用户评审判定）
- **阶段③ 完整骨架：进行中**——C1（dsh headless 运行 spike）已完成（[报告](docs/spikes/C1-dsh-headless-spike.md)，2026-09-17）：headless/批处理/SDK 常驻形态全通过，Python SDK 为推荐主形态；C2（插件事件拦截）依赖解除，为下一关键路径
