# ADR-001：内核框架选型 — DeepSeek Harness (dsh)

- 状态：已采纳 · **2026-09-17 修订（D1 拍板：锁死 dsh，取消适配层与退出路径）**
- 日期：2026-09-15（2026-09-17 修订）
- 关联决策项：D1（内核形态与后路）、D7（版本锁定与升级）
- 关联任务：C1 / C2 / C3 / B5

## 背景与需求

CannAgent 需要让 agent 在昇腾服务器上**无人值守**跑完七阶段长流程（识别→策略→编码→测试→基准→总结→交付），对内核的硬性要求：

1. 成熟的 harness 能力：agent loop、上下文压缩（compaction）、subagents、hooks/权限、session 记录
2. **模型端点多协议兼容**：Anthropic Messages / OpenAI Chat Completions / OpenAI Responses 三协议 + 自定义 baseURL（不锁厂商，GLM/DeepSeek/Qwen/Anthropic 可切换）
3. 插件化扩展：领域工具（编译/测试/性能）、RAG、任务循环都能以插件形式注入
4. 无人值守与批量：CI/cron 式 unattended 运行、session log 取证

## 决策

**采用 DeepSeek Harness（`dsh`）作为 agent 内核**，以 headless 常驻服务形态运行；**插件直连 dsh API，不建 `kernel/` 适配层**（D1 拍板 2026-09-17：接受内核绑定，换取省去一层抽象与双倍维护成本）。

选型依据（2026-09 调研）：

| 需求 | dsh 的满足方式 |
|---|---|
| harness 完整性 | "一切皆插件"（模型/工具/技能/会话/沙箱/存储/循环/调度均为 Cordis 插件）；session/session-log 架构 |
| 三协议多兼容 | provider 原生支持 `anthropic-messages` / `openai-completions` / `openai-responses` 三种 api 协议 + compat 开关（`supportsDeveloperRole` / `maxTokensField` / `thinkingFormat`）；内置 DeepSeek / Anthropic / OpenAI / Kimi / zai(GLM)；`settings.yaml` 配置热生效，凭据 `apiKeyEnv` 引用环境变量 |
| 插件化 | TypeScript Cordis 插件体系；Profile 机制隔离场景配置；辅助模型按 purpose 分流 |
| 无人值守 | session-log 支持 unattended batch / CI / 定时任务（loops、scheduling 均为插件） |
| 生态与许可 | 224k+ stars、MIT、社区活跃（大量中文教程与云厂商接入文档） |

## 备选方案对比

| 方案 | 优势 | 劣势 | 结论 |
|---|---|---|---|
| **dsh**（选用） | harness/loop/compaction/插件全内置；三协议原生；session-log 取证 | developer preview，承诺 breaking changes；核心仓不接受外部贡献；CLI 仍在演进 | 采用；风险用月度升级 + 插件回归测试对冲（D1 已放弃适配层缓冲；D7 不钉版本） |
| OpenHands | 平台型最完整、Python、SWE-bench 强 | 架构重、改造受上游耦合、多协议端点不如 dsh 原生 | **未采用**（D1 已放弃退出路径，此行仅存调研记录） |
| Goose (Block) | 25+ provider、MCP 生态好 | 定位交互式助手，无人值守批量弱 | 排除 |
| OpenCode | 终端 agent、任意 provider | 面向交互式内循环，服务器常驻编排弱 | 排除 |
| Claude Agent SDK | harness 能力最强 | Anthropic 协议绑定（接国产模型需网关转换）、与"多协议原生"诉求冲突 | 排除（前期调研已否） |
| LangGraph 自研 | 控制力最强、无绑定 | harness 全自研，前期投入最大 | 排除 |

## 后果与风险对冲

1. **breaking changes（developer preview）**：**每月检查一次 release，有新版即升级**（不钉版本）；升级必须走 ADR + 插件回归测试基线——D1 已放弃适配层，这是唯一防线（→ D7）
2. **headless/CLI 形态仍在演进**：C1 spike 第一周验证无人值守形态可用性；不可用则评估 dsh 以服务形态 + session API 驱动
3. **不接受外部代码贡献**：我们的插件全部放在自有仓库（`plugins/dsh-cann-*`），不向上游提 PR
4. **无退出路径（D1 的已知代价）**：放弃内核可替换性——不建适配层、不保留 OpenHands 接入预案。若 dsh 演进到不可接受（许可变更、关键能力移除、长期停更），代价是插件层重写；`python/cannagent` 领域层与 `web/` 前端不受影响
