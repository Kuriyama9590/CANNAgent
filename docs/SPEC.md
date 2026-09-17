# CannAgent 开发规范总纲（SPEC）

> 全项目开发规范索引与核心规则。子规范一旦拆出，本文件只留规则本体并链接。
> 状态：v1 · 2026-09-15 · 未覆盖部分以 ROADMAP 与 ADR 为补充

## 0. 范围与定位

CannAgent = 昇腾算子优化 agent harness：输入整网模型/单算子规格，全自主完成七阶段优化流程并交付完整包，全程可追溯。分层架构、目录结构、技术决策见 `docs/ROADMAP.md` 与 `docs/adr/`。

## 1. 分层与依赖

```
web/ → (REST/SSE) → python/cannagent → (进程调用) → plugins/(TS) → dsh 内核
```

- 依赖只能自上而下；**TS 插件零业务逻辑**（注册/校验/转发/错误码映射）；业务逻辑全在 Python
- Python 领域模块（identify/strategy/build/verify/bench/deliver/knowledge）**互相禁止 import**，经 cli.py 组合
- 对 dsh API 的引用收敛在各插件的 `kernel/` 适配层（ADR-001 退出策略的前提）

## 2. 模型端点

- providers 只配置在 `profiles/` 与 `$DSH_HOME/settings.yaml`；三协议：`anthropic-messages` / `openai-completions` / `openai-responses`
- 凭据**仅** `apiKeyEnv` 引用环境变量；`.env` 入 `.gitignore`；任何明文密钥不得进仓库/run 目录/事件流

## 3. 工具开发

每个工具（TS 注册 + Python 实现）必须满足：

1. pydantic 输入/输出 schema（即文档）
2. 超时上限自声明（默认 10min）
3. 结构化错误码 `{code, message, hint}`；编译/运行错误保留官方错误码（E1xx 等）
4. **幂等**（断点恢复的硬要求，workflow.md §5）
5. 单测强制：happy path + 错误码路径；无单测的 PR 不合入

## 4. 任务与状态机

- 双输入 schema 与 run 目录规范：`docs/task-schema.md`
- 七阶段状态机/预算/检查点/降级：`docs/workflow.md`（转移边集/完成判定/预算/降级由插件强制；失败分流由 routing 判定会话在边集内决策，不写死规则）

## 5. 可观测性

- 事件流契约（唯一展示数据源）：`docs/observability.md`；demo `web-demo/src/types.ts` 与其同构
- 每 run 一个 run 目录 = 审计现场；events.jsonl append-only

## 6. 基准与精度

- 基线方法学（aclnn 单算子、排除 ATC、统一口径）：`docs/benchmark.md`（待 D4 拍板后发布，此前按 task-schema.md §1.4 默认值执行）

## 7. RAG 与经验库

- 规范：`docs/rag.md`（待 D5 拍板后发布）；经验条目 schema 已在 demo 剧本中体现雏形
- 职责分工：skills = 静态方法论；RAG = 动态经验 + CANN 文档

## 8. 前端

- 技术栈锁定：React + Vite + TS + Ant Design v5 + ECharts；明暗双主题
- 页面 = 仪表盘 / run 详情（管道+下钻+检视）/ 报告；布局以 demo 定稿为准（D11）
- 只消费 FastAPI OpenAPI 契约；契约先行（接口变更先改 OpenAPI 再实现）

## 9. 工程与协作

- **Python**：3.10+，uv 管理依赖，ruff（format+lint），mypy strict，pytest
- **TypeScript**：pnpm workspace，eslint + tsc（strict），vitest
- **Git**：trunk-based，conventional commits（`feat:/fix:/docs:/spec:`），PR 必过 CI
- **文档**：规范变更走 PR + 对应子文档同步；架构决策记 `docs/adr/`
- **CI**：eslint+tsc+vitest / ruff+mypy+pytest / web build；golden 准入标准待 D10
