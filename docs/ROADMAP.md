# CannAgent 总体路线图（ROADMAP）

> 项目：构建 agent harness，让 agent 在昇腾（CANN）服务器环境中自主完成
> **算子识别 → 融合/优化策略生成 → 代码编写 → 循环测试回归 → 经验总结 → 最终交付** 全流程。
> 本文档是规划讨论的落盘快照，作为后续规范与骨架开发的基准，随讨论持续更新。

- 状态基线：2026-09-15 规划讨论收敛
- 任务跟踪：issue 与[开发看板](https://github.com/users/Kuriyama9590/projects/1)（`docs/CannAgent-TODO.xlsx` 为迁移前的历史存档，不再更新）
- 本地开发环境备忘（2026-09-17，dsh 装本地以支持"agent 任意环境可运行"——D9）：
  - **dsh**：npm 全局安装 `@deepseek-ai/dsh@0.1.5-rc.2`（D7：**每月检查一次 release，有新版即升级**——不钉版本，升级走 ADR + 插件回归测试基线）；`DSH_HOME=~/.dsh`；`dsh --profile headless "<任务>"` 已验证可用（2026-09-17 冒烟：单轮任务成功返回，见 C1 #18）
  - **Python SDK**：`deepseek-harness-sdk 0.1.5rc1`（含 `deepseek-harness-runtime-bin` 同版本单文件 exe）已装；⚠️ PyPI 有抢注包 `deepseek-harness`（无关三方客户端）——官方包名必须 `deepseek-harness-sdk`，本机镜像索引可能需 `--index-url https://pypi.org/simple/`；SDK 不隐式读 `~/.dsh`，需显式 `DSH_HOME`；npm 与 pip 双通道版本需同步盯（D7），详见 [C1 spike 报告](spikes/C1-dsh-headless-spike.md) F2/F4
  - **模型端点**：`$DSH_HOME/settings.yaml` 的 `llm-deepseek.baseURL` 指向网关 `https://www.dmxapi.cn/v1`（OpenAI 兼容协议；provider 仍为内置 `deepseek-official`），默认模型 `deepseek-v4-flash`（reasoningEffort max）
  - **凭据**：`$DSH_HOME/.credentials.yaml` 的 `DEEPSEEK_API_KEY`（仓库侧镜像到 `.env`，已被 .gitignore 忽略；旧值备份在同目录 `.credentials.yaml.bak-20260917`）
  - 网关可用模型 582 个（含 `deepseek-v4-flash` / `deepseek-v4-pro` / `deepseek-v3.1` / `glm-5` / `claude-opus-4-7` 等），为 C9 三协议端点配置提供候选
  - 源码参考副本：`D:\Tools\DeepSeekHarness`（v0.1.0-rc.5，与全局安装版存在版本差，仅作插件 API 参考）
  - ~~待办：C9 把端点配置固化进仓库~~ **已完成（2026-09-20，#26）**：`profiles/` 三协议配置入库（openai-completions 实测通过；llm-pi-ai id 定向覆盖 + agent-default-model 切换；凭据仅 apiKeyEnv）
- 远程环境备忘（2026-09-17 实测核实，`ssh root@10.14.3.87`，凭据见 `环境.txt`，待 E5 #33 迁出至 `.env`）：
  - 主机：openEuler 24.03 LTS-SP3 / 80 核 / 502GB 内存 / 806GB 可用盘
  - NPU：**2 张 910B**（`/dev/davinci1`、`/dev/davinci4`，各 32GB HBM，IT21PDXC01，探查时均空闲）→ D6 并发度上限 2
  - CANN：9.0.0（`/usr/local/Ascend/cann` → `cann-9.0.0`），驱动/固件 26.0.rc1；`atc` 已在 PATH
  - Python：conda 环境 `cannagent`（Python 3.13.9；torch 2.12.0 / numpy 2.4.6 / onnx 1.22.0 / onnxruntime 1.27.0 / pydantic 2.13.4 / qdrant-client 1.18.0；**未安装 torch_npu**）；node v24.16 + pnpm 已装
  - dsh 内核**尚未安装**；旧项目内留有可复用原型——`CannAgent/dsh-cannagent/`（dsh 插件包：cordis.patch.yml + skills/cann-fusion）与 `CannAgentRemote/`（runner / tasks / deploy_manifests，任务包模式雏形）→ 作为 C3/C5/D9 参考
  - 旧项目产物 `/root/Blarock/Project/CannAgent`：`build/`（编译与 ATC 边界脚本群）、`reports/工作进展报告-ATC边界外算子优化-20260907.html`（分项收益含 +15.24% / +1.85% 等，待细读核对）、`models/`（单算子 ONNX 集：gelu_silu / matmul_add / mylenet 等）
  - 参考模型：resnet50.onnx 见于 `OperatorAgent/models/` 与 `GraphAgent/`；swinv2 未在 maxdepth 4 内找到

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

### 1.4 基线（2026-09-17 D4 拍板）
- CANN 官方算子实现为精度与性能基线：**aclnn 单算子接口**直调官方算子库，天然无 ATC 图融合（公平对比口径）
- **有效性判据：＞ATC 或 ATC 未覆盖**（D4 + 2026-09-17 追加，见 C12 #55）：先枚举 ATC 自动应用的优化（融合/替换 pass 及作用范围），对每个优化点分类——ATC 已覆盖的必须**强于 ATC**，ATC 未覆盖的判为**有效**（价值来自覆盖空白）；清单与两种口径差异一并进交付报告
- 测量方法学（预热、迭代次数、p50/p99 统计口径、同步点）由 benchmark.md 固化（B4）

### 1.5 自主程度
全自主端到端，仅在连续失败降级或预算耗尽时停下等待人工。

---

## 2. 技术决策（已确认）

| 决策 | 选择 | 依据 |
|---|---|---|
| 内核 | **DeepSeek Harness (`dsh`)** | 224k+ stars、MIT；"一切皆插件"（模型/工具/技能/会话/沙箱/存储/循环/调度均为 Cordis 插件）；session-log 架构原生支持无人值守 batch/CI；**锁死 dsh 不留后路**（D1 拍板 2026-09-17：插件直连 dsh API、不建适配层，备选方案仅存档 ADR-001） |
| 模型端点 | **三协议原生多兼容**：`anthropic-messages` / `openai-completions` / `openai-responses` + 自定义 baseURL + compat 开关（`supportsDeveloperRole` / `maxTokensField` / `thinkingFormat`） | dsh 内置 providers：DeepSeek / Anthropic / OpenAI / Kimi / zai(GLM)；配置 `settings.yaml` 热生效；凭据 `apiKeyEnv` 引用环境变量；**当前实施**：内置 `deepseek-official` + `baseURL` 指向网关（见本地开发环境备忘） |
| 语言分层 | TypeScript 写 dsh 插件（零业务逻辑：注册/校验/转发）+ Python 写领域执行层 + React/TS 写前端 | dsh 插件体系是 TS；CANN 生态是 Python。插件直连 dsh API（D1：无适配层） |
| 前端栈 | React + Vite + TypeScript + Ant Design v5 + ECharts | 明暗双主题（AntD 主题算法）；布局经 demo 评审定稿 |
| 前端交互 | 轨迹=阶段管道图+下钻；实时=直播+可回放；主题=明暗可切换 | 已确认；整体布局通过 demo 逐项 grill 定稿 |
| RAG 起步栈 | SQLite + sqlite-vec + BGE-M3（接口抽象，后续可换 Qdrant/Milvus） | 服务器零依赖部署 |
| 风险缓解 | 锁死 dsh 不留后路（D1：无适配层）+ 每月检查 release、有新版即升级（D7，升级走 ADR + 插件回归测试基线） | dsh 处于 developer preview，有 breaking changes；D1 放弃适配层后回归测试是唯一防线 |
| 部署拓扑 | **agent 与测试环境解耦**：agent 任意环境可运行，以任务包形式下发昇腾服务器执行测试、结果包回传（D9 拍板 2026-09-17） | 开发/CI 与 NPU 资源解耦；任务包可审计、可重放 |
| NPU 调度 | 持久化队列：一个 run 独占一张卡，可用卡数可配置（D6 拍板 2026-09-17） | 重启不丢任务，符合无人值守 batch/CI |
| 权限沙箱 | workspace/runs 目录隔离 + dsh hooks 命令白名单 + CANN 环境变量固定，不引入容器（D8 拍板 2026-09-17） | 第一版够用；容器级隔离留作后续加固 |

---

## 3. 架构分层

```
web/                React dashboard：run 列表 / 七阶段进度 / 每步操作 trace / 产物浏览 / 报告渲染
  ↕ REST + SSE
python/cannagent/   领域执行层 + FastAPI 观测服务（读事件流与产物，供前端）
  ↑ 进程调用（CLI 子命令）
plugins/ (TS)       dsh 插件：dsh-cann-tools / dsh-cann-knowledge / dsh-cann-loop
  ↑ 直连 dsh API（锁死内核，无适配层——D1）
dsh 内核            agent loop、session log、compaction、多协议模型端点
  ↕ 任务包下发 / 结果包回传（agent 与测试环境解耦——D9）
昇腾服务器           CANN 工具链、NPU 编译 / 运行 / 测试（持久化队列，一 run 独占一卡——D6）
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
`task.yaml / input/ identify/ strategy/ implement/(v1..vN) verify/ bench/ summarize/(exp-*.json) deliver/(code + tests + STRATEGY.md + REPORT.md) experience/ events.jsonl checkpoints/`

## 5. SPEC 规范要点（九条提纲）

1. 分层依赖单向；TS 插件零业务逻辑；Python 领域模块间禁止互相 import
2. 模型端点只在 settings.yaml/profiles 配置；凭据仅 `apiKeyEnv` 引用（`环境.txt` 明文密码迁出）
3. 工具规范：类型化 schema + 超时 + 结构化错误码 + 幂等 + 单测强制
4. Loop 规范：七阶段（identify→strategy→implement⇄verify→bench→summarize→deliver）；预算（墙钟 + 单 session token；2026-09-17 修订：token 1M、迭代/重试无次数上限）；检查点断点恢复；失败分流由 routing 判定会话在固定边集内决策（判据注入、decision 事件留痕）、墙钟耗尽降级
5. 事件流规范：统一 Event Schema（stage/tool/iteration/decision/checkpoint/degrade），追加写 events.jsonl，禁止篡改历史事件；前端只读该流
6. 基准方法学：aclnn 单算子官方基线 + **有效性判据「＞ATC 或 ATC 未覆盖」**（D4；含 ATC 优化清单采集，C12 #55）；预热/迭代次数/统计口径（p50/p99）/同步点统一
7. RAG：`retrieve(query, top_k, filter)`；经验条目 schema（问题/方案/结果/复用条件）；run 结束自动回流；skills=静态方法论 vs RAG=动态经验+CANN 文档
8. 前端规范：组件库统一 AntD、图表 ECharts；页面 = 仪表盘 / run 详情（阶段进度+trace）/ 报告页；API 契约先行（OpenAPI）
9. Git/CI：trunk-based、conventional commits、CI = eslint+tsc+vitest + ruff+mypy+pytest + web build

---

## 6. 阶段划分与当前状态

| 阶段 | 内容 | 状态 |
|---|---|---|
| ① 前端 Demo | `web-demo/` 全流程可模拟（三套剧本：直播/完成/降级），交互样式逐项评审 | **已完成**（2026-09-17 逐项 grill 评审通过，布局定稿 = 仪表盘 + 下钻三栏 + 会话直播视图，见 D11） |
| ② 规范文档 | docs/ 全部规范（SPEC、task-schema、observability 事件流契约、benchmark 方法学、plugin-dev、workflow、rag、ADR-001） | **已完成**（2026-09-17 B4/B5/B7 发布：benchmark / plugin-dev / rag，PR 见 #10/#11/#12 评论；八篇齐） |
| ③ 完整骨架 | plugins/ 三插件 + python/cannagent + web/（demo 演进为真实 dashboard）+ profiles/ | **进行中**：C1/C2 spike 完成（D2 双写成立）；C3 三插件骨架合入（PR #61）；**C4 python 骨架已合入**（D3 全链路冒烟通过）；**C9 profiles/ 已合入**（三协议端点配置，openai-completions 实测）；C11/C6/C7 可并行启动 |
| ④ 测试与部署 | tests/ + golden 回归集 + README 部署说明 | 待启动 |

## 7. 待讨论清单

- [x] RAG / 经验库细节 → D5 拍板（2026-09-17）：schema 校验 + 人工抽检 + 人工增删查改；语料/切块/索引细节由 B7/C6 落实
- [x] dsh 版本锁定与升级策略 → D7 拍板：每月检查 release、无新版不更新，升级走 ADR + 插件回归测试基线（D1 已取消适配层）
- [x] 权限与沙箱边界 → D8 拍板：命令白名单 + 目录隔离，不引入容器；白名单清单由 C11 落实
- [x] 部署拓扑 → D9 拍板：agent 与测试环境解耦，任务包下发 / 结果包回传
- [x] CI 细节 → D10 拍板：精度硬卡点 + 性能仅报告
- [x] 前端布局定稿（demo 评审后回填本文件）→ 2026-09-17 评审通过，定稿见 §2 与 D11
