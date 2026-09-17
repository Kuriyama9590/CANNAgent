# dsh 插件开发规范（plugin-dev）

> 阶段② 规范文档 · 关联任务 B5 · `plugins/` 三插件包（dsh-cann-tools / dsh-cann-knowledge / dsh-cann-loop）的权威开发规范。
> 状态：v1（2026-09-17）。事实依据：dsh 0.1.5-rc 源码（C1 spike 已验证的插件/Cordis 结构）+ ADR-001（D1：直连 dsh API、无适配层）。

## 1. 定位与职责

| 插件 | 职责 | 主要 ctx 服务 |
|---|---|---|
| `dsh-cann-tools` | 注册领域工具（parse_model / build / run_test / run_bench 等，workflow §2 工具清单），校验入参后 **spawn python CLI 转发**（D3），映射错误码，在工具边界发出观测事件 | `tools` |
| `dsh-cann-knowledge` | 注册 retrieve / experience_write 工具，转发 Python RAG 层 | `tools` |
| `dsh-cann-loop` | 七阶段状态机：转移边集、完成判定、预算、检查点、降级、routing 判定会话、NPU 卡队列 | `agents` / `sessions` |

**零业务逻辑铁律**（SPEC §1）：TS 插件只做注册、schema 校验、进程转发、错误码映射、事件发出。任何需要"判断"的逻辑（图分析、策略、误差计算、清单采集）都在 Python。代码评审以此为准绳：插件里出现 `if (gainPct >= …)` 即违规。

## 2. 插件结构规范

Cordis Service 形态（与 dsh 官方插件一致，参照 `dsh-tool-todo`）：

```ts
// packages/plugins/dsh-cann-tools/src/index.ts
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'cann-tools'                 // 稳定插件名（cordis.yml entry 的 id 引用）
export const inject = ['tools']                  // 声明式依赖：所需 ctx 服务
export const Config: z<PluginConfig> = z.object({ /* 部署期配置 */ })

export function apply(ctx: Context, config: PluginConfig) {
  ctx.tools.register(defineTool({ /* 见 §3 */ }))
}
```

- **ESM only**（`"type": "module"`）；入口 `src/index.ts` → `lib/index.js`；`exports` 暴露 `.` / `./invariant`（错误码常量）
- **peerDependencies** 指向 dsh 核心包（`@deepseek-ai/cordis` / `dsh-tools` / `dsh-agent` / `dsh-session` 等），版本策略见 §7；不重复打包内核
- 插件是纯函数式的注册体：**禁止模块级可变状态**；运行态（当前 run、迭代号）全部来自显式入参或 manifest 注入
- 每个注册必须可逆：`ctx.effect()` 返回 disposer，或使用 `ctx.on()` 的返回值

## 3. 工具注册规范（dsh-cann-tools / dsh-cann-knowledge）

```ts
defineTool({
  name: 'run_bench',
  description: '对指定 artifacts 执行性能测量（三份对照，benchmark.md §4）',
  parameters: z.object({ /* 与 Python pydantic 模型逐字段镜像 */ }),
  timeoutMs: 600_000,            // SPEC §3.2：超时上限自声明，默认 10min
  async execute(args, context) {
    // 1. spawn `python -m cannagent <subcommand> --run <run_id> <args>`
    // 2. 结构化输出透传；非零退出映射 {code, message, hint}
    // 3. 官方错误码（E1xx 等）原样保留（SPEC §3.3）
  },
})
```

1. **schema 单一事实源在 Python**（pydantic，task-schema §3 同理）；TS 侧 schemastery 镜像仅作边界校验。两份 schema 的字段对拍进 CI（E3：`pnpm test:schema`）
2. **幂等**：同参数重复调用结果一致（SPEC §3.4）——转发子命令必须是幂等的；`gen_test` 等带随机性的工具强制透传 seed
3. **事件发出**（observability §3）：工具边界统一发 `tool_started` / `tool_completed` / `tool_failed`，经 Python 写入函数落 events.jsonl（§4）
4. 转发进程环境：`cwd` = 当前 run 目录；`CANNAGENT_RUN_ID` / `CANNAGENT_STAGE` 注入子进程；凭据类变量按白名单透传（C11），**禁止整包继承 env**

## 4. 事件拦截与双写（C2 落地依据）

- **拦截点**（C1 已验证存在性）：dsh session 事件流中的 `tool/call` + `tool/result`（含 callId/name/arguments/结果）；插件侧两种消费路径：
  1. **工具自持**（v1 采用）：dsh-cann-tools 在 `execute()` 内自带埋点，工具边界即观测边界——不依赖 dsh 内部事件名，升级面最小
  2. **session 订阅**（备选）：经 `ctx.on(...)` 订阅 agent 事件流聚合——覆盖非领域工具的调用，但绑定 dsh 事件契约（升级风险），仅 C2 spike 验证后按需启用
- **写入路径唯一**：插件**不直接写 events.jsonl**；一律 spawn `python -m cannagent events append`（observability §5，events.py 是唯一写入函数）
- 会话直播事件（`session_message`）：由 loop 插件在 session 边界转发模型流（同样经 Python 写入函数）

## 5. 状态机实现要点（dsh-cann-loop）

- 权威行为 = workflow.md；本节只约束实现形态：
  - 转移边集、直通判定、预算、降级 = 插件内**显式状态表**实现，不依赖 prompt 约定（workflow §1）
  - routing 判定会话：`agents.create` 开轻量会话，唯一工具 `route(next, reason, evidence, confidence)`；判定结果持久化为 `decision` 事件并进下一检查点
  - 检查点读写：`python -m cannagent checkpoint write/read`（幂等）
  - NPU 卡队列：Python 侧持久化队列（D6），插件只做申请/释放转发
- prompt 文件（`prompts/<stage>.md`、`prompts/routing.md`）随包发布、同版本管理（workflow §7）

## 6. 加载与组合

| 场景 | 机制 |
|---|---|
| 本地开发（CLI headless） | profile 的 `cordis.patch.yml` 插入条目：`- { id: cann-tools, name: <repo相对路径>/plugins/dsh-cann-tools, config: … }`；或 `dsh plugin --profile headless add <路径>`（等价 pnpm add 进 profile 目录） |
| SDK 常驻 runtime（主形态，C1 F1） | `DSH_CORDIS_CONFIG` 指向组合文件：保留 `@deepseek-ai/dsh-sdk-jsonrpc-server` 条目 + 三插件条目（相对路径解析基准 = 组合文件位置） |
| 测试 | vitest 直接 `new Context()` 挂插件，mock `tools` / `agents` 服务（E1 样板） |

条目格式（`@cordisjs/plugin-include` 契约）：`{ id, name, config, disabled }`；patch 层可对同 id 覆盖 config 或 disable。

## 7. 版本与升级纪律（D7）

- dsh 处于 developer preview，有 breaking changes；插件 peerDependencies **不钉死 patch**，月检发现新版 → 升级 → 跑插件回归基线（vitest 全量 + 一轮 headless 冒烟 + SDK 常驻冒烟）→ 走 ADR 记录
- **双通道对齐**（C1 F4）：npm `@deepseek-ai/dsh`（CLI/profile 面）与 pip `deepseek-harness-runtime-bin`（SDK runtime 面）分别升级、分别冒烟；插件 API 以**实际加载 runtime 的版本**为准
- 回归基线用例清单（每插件至少）：工具注册成功 / schema 拒收非法入参 / 转发成功与失败路径 / 事件落盘 / 状态机边集校验

## 8. 禁止清单

1. 禁止业务判断逻辑（§1）
2. 禁止直接写 events.jsonl 或任何 run 目录文件（一律经 Python 子命令）
3. 禁止绕过 schemastery 校验透传原始 JSON
4. 禁止整包继承进程环境变量给子进程（C11 白名单）
5. 禁止在插件内解析/存储凭据
6. 禁止模块级可变状态与隐藏单例
