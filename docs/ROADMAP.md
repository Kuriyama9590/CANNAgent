# CannAgent 总体路线图（ROADMAP）

> 项目：构建 agent harness，让 agent 在昇腾（CANN）服务器环境中自主完成
> **算子识别 → 融合/优化策略生成 → 代码编写 → 循环测试回归 → 经验总结 → 最终交付** 全流程。
> 本文档是规划讨论的落盘快照，作为后续规范与骨架开发的基准，随讨论持续更新。

- 状态基线：2026-09-15 规划讨论收敛
- 远程环境备忘：`10.14.3.87:/root/Blarock/Project/CannAgent`（CANN 9.0.0，venv `cannagent`，参考模型 resnet50 / swinv2，历史结果"比官方 +5%"）

---

## 1. 产品定义（已确认）

### 1.1 输入（两种任务 schema，均支持）
| 形态 | 内容 | 说明 |
|---|---|---|
| 整网模型文件 | ONNX / PyTorch 模型（如 resnet50、swinv2）+ 可选优化目标说明 | agent 自主解析、识别算子与融合机会点，拆解出算子任务 |
| 单算子规格文件 | yaml：算子类型、输入输出 shape/dtype、性能目标等 | 直接从策略生成阶段开始 |

### 1.2 交付物（完整交付包，四项全有）
1. **可编译算子代码**：AscendC/TBE kernel + host 侧调用 + 编译脚本 + 测试用例
2. **优化策略文档**：融合/优化方案说明与预期收益（可审计、可复用）
3. **精度 + 性能报告**：vs CANN 官方实现
4. **经验回流条目**：本次 run 的成功模式/踩坑自动写入经验库

### 1.3 可追溯性（硬需求）
优化路径中**每一步操作可见可追溯**，需要可视化前端界面（用户体验与视觉效果良好）。

### 1.4 基线
- CANN 官方算子实现为精度与性能基线
- **排除 ATC 自动优化影响**：基线测量采用单算子级官方 API 调用（或关闭 ATC 自动融合选项），不做整网 ATC 编译对比；测量方法学（预热、迭代次数、p50/p99 统计口径、同步点）写入规范

### 1.5 自主程度
全自主端到端，仅在连续失败降级或预算耗尽时停下等待人工。

---

## 2. 技术决策（已确认）

| 决策 | 选择 | 依据 |
|---|---|---|
| 内核 | **DeepSeek Harness (`dsh`)** | 224k+ stars、MIT；"一切皆插件"（模型/工具/技能/会话/沙箱/存储/循环/调度均为 Cordis 插件）；session-log 架构原生支持无人值守 batch/CI；备选 OpenHands / Goose / OpenCode 记入 ADR-001 |
| 模型端点 | **三协议原生多兼容**：`anthropic-messages` / `openai-completions` / `openai-responses` + 自定义 baseURL + compat 开关（`supportsDeveloperRole` / `maxTokensField` / `thinkingFormat`） | dsh 内置 providers：DeepSeek / Anthropic / OpenAI / Kimi / zai(GLM)；配置 `settings.yaml` 热生效；凭据 `apiKeyEnv` 引用环境变量 |
| 语言分层 | TypeScript 写 dsh 插件（薄适配层）+ Python 写领域执行层 + React/TS 写前端 | dsh 插件体系是 TS；CANN 生态是 Python。TS 插件只做注册/校验/转发，业务逻辑全在 Python |
| 前端栈 | React + Vite + TypeScript + Ant Design v5 + ECharts | 明暗双主题（AntD 主题算法）；布局经 demo 评审定稿 |
| 前端交互 | 轨迹=阶段管道图+下钻；实时=直播+可回放；主题=明暗可切换 | 已确认；整体布局通过 demo 逐项 grill 定稿 |
| RAG 起步栈 | SQLite + sqlite-vec + BGE-M3（接口抽象，后续可换 Qdrant/Milvus） | 服务器零依赖部署 |
| 风险缓解 | 锁定 dsh 版本 + 自建适配层收敛 API 引用 | dsh 处于 developer preview，官方承诺 breaking changes；核心仓库暂不接受外部贡献 |

---

## 3. 架构分层

```
web/                React dashboard：run 列表 / 七阶段进度 / 每步操作 trace / 产物浏览 / 报告渲染
  ↕ REST + SSE
python/cannagent/   领域执行层 + FastAPI 观测服务（读事件流与产物，供前端）
  ↑ 进程调用（CLI 子命令）
plugins/ (TS)       dsh 插件：dsh-cann-tools / dsh-cann-knowledge / dsh-cann-loop
  ↑ 适配层（收敛 dsh API 引用面）
dsh 内核            agent loop、session log、compaction、多协议模型端点
昇腾服务器           CANN 工具链、NPU 编译 / 运行 / 测试
```

事件流双写：dsh session log（原始会话取证）+ run 目录 `events.jsonl`（结构化事件，前端数据源）。

## 4. 目录结构（规划）

```
cann-neo/
├── docs/                   SPEC.md 总纲 / architecture / plugin-dev / task-schema /
│                           workflow / observability / rag / benchmark / adr/
├── plugins/                pnpm workspace：dsh-cann-tools / dsh-cann-knowledge / dsh-cann-loop
├── python/cannagent/       cli.py / server.py(FastAPI) / config.py
│                           identify/ strategy/ build/ verify/ bench/ deliver/ knowledge/ events.py
├── web/                    真实 dashboard（由 web-demo 演进而来）
├── web-demo/               前端交互评审 demo（全流程模拟，零后端）
├── profiles/               三协议模型端点配置示例
├── skills/                 dsh 技能：算子开发指南、融合模式手册
├── tests/                  TS 插件 vitest + Python pytest + golden 回归集
├── workspace/              运行时产物（gitignore）
└── README.md
```

**run 目录规范**（每任务一个，可追溯落盘）：
`task.yaml / input/ identify/ strategy/ implement/(v1..vN) verify/ bench/ deliver/(code + STRATEGY.md + REPORT.md) experience/ events.jsonl checkpoints/`

## 5. SPEC 规范要点（九条提纲）

1. 分层依赖单向；TS 插件零业务逻辑；Python 领域模块间禁止互相 import
2. 模型端点只在 settings.yaml/profiles 配置；凭据仅 `apiKeyEnv` 引用（`环境.txt` 明文密码迁出）
3. 工具规范：类型化 schema + 超时 + 结构化错误码 + 幂等 + 单测强制
4. Loop 规范：七阶段（identify→strategy→implement→verify→bench→summarize→deliver）；每阶段预算（时间/token/迭代）；检查点断点恢复；失败 N 次降级
5. 事件流规范：统一 Event Schema（stage/tool/iteration/decision/checkpoint/degrade），追加写 events.jsonl，禁止篡改历史事件；前端只读该流
6. 基准方法学：单算子级官方基线调用或关闭 ATC 融合；预热/迭代次数/统计口径（p50/p99）/同步点统一
7. RAG：`retrieve(query, top_k, filter)`；经验条目 schema（问题/方案/结果/复用条件）；run 结束自动回流；skills=静态方法论 vs RAG=动态经验+CANN 文档
8. 前端规范：组件库统一 AntD、图表 ECharts；页面 = 仪表盘 / run 详情（阶段进度+trace）/ 报告页；API 契约先行（OpenAPI）
9. Git/CI：trunk-based、conventional commits、CI = eslint+tsc+vitest + ruff+mypy+pytest + web build

---

## 6. 阶段划分与当前状态

| 阶段 | 内容 | 状态 |
|---|---|---|
| ① 前端 Demo | `web-demo/` 全流程可模拟（三套剧本：直播/完成/降级），交互样式逐项评审 | **进行中** |
| ② 规范文档 | docs/ 全部规范（SPEC、task-schema、observability 事件流契约、benchmark 方法学、plugin-dev、workflow、rag、ADR-001） | **进行中**：B1/B2/B3/B6/B8 已完成；B4/B5/B7 阻塞于 D1/D3/D4/D5 |
| ③ 完整骨架 | plugins/ 三插件 + python/cannagent + web/（demo 演进为真实 dashboard）+ profiles/ | 待启动 |
| ④ 测试与部署 | tests/ + golden 回归集 + README 部署说明 | 待启动 |

## 7. 待讨论清单

- [ ] RAG / 经验库细节：语料源清单、切块策略、索引更新机制、检索质量评估
- [ ] dsh 版本锁定与升级策略：跟随节奏、适配层测试基线
- [ ] 权限与沙箱边界：agent 可执行命令白名单、编译测试隔离策略
- [ ] 部署拓扑：dsh / python / web / NPU 服务器的进程与网络布局
- [ ] CI 细节：golden 回归集的准入标准、报告卡点
- [ ] 前端布局定稿（demo 评审后回填本文件）
