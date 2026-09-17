# C2 Spike 报告：dsh 插件事件拦截能力

> 任务：[#19 [C2] dsh 插件事件拦截能力 spike](https://github.com/Kuriyama9590/CANNAgent/issues/19) · 决策验证：[#35 [D2] 事件流双写可行性](https://github.com/Kuriyama9590/CANNAgent/issues/35)
> 日期：2026-09-17 · 前置：[C1 spike 报告](C1-dsh-headless-spike.md)
> 环境：npm `@deepseek-ai/dsh@0.1.5-rc.2`（CLI）· Windows 本地开发机

## 结论（验收判定）

**通过**：插件可在工具调用边界拦截事件并生成 events.jsonl——**D2（事件流双写）可行性成立**，采纳「session log（dsh 原生）+ events.jsonl（插件拦截生成）」双通道。同时验证了 C11 白名单钩子与 D3（工具转发 python CLI）模式。

| # | 验证项 | 结果 | 要点 |
|---|---|---|---|
| 1 | 插件加载进 headless profile | ✅ | profile `cordis.patch.yml` 插入条目（语法见 F1） |
| 2 | 领域工具注册 + python CLI 转发（D3） | ✅ | `defineTool` 注册 `cann_probe`，模型真实调用，python 子进程结果回流 |
| 3 | 工具边界事件拦截 → events.jsonl（D2 核心） | ✅ | `tools/pre-execute` + `tools/result` 钩子捕获**全部**工具（自定义 + 内置 `write`），带 duration，按序落 JSONL |
| 4 | 白名单 deny 钩子（C11 预演） | ✅ | `pre-execute` 返回 `{kind:'deny', reason}` → 模型收到结构化拒绝、不绕过、如实汇报；拒绝本身也落事件 |

## 拦截 API（权威记录，dsh 0.1.5-rc）

`ctx.tools` 事件面（`@deepseek-ai/dsh-tools` 的 `ToolRuntime` 声明合并）：

| 事件 | 模式 | 用途（CannAgent） |
|---|---|---|
| `tools/pre-execute` | waterfall | **白名单闸门**（allow/deny/ask）+ 记 `tool_started` |
| `tools/execute` | waterfall | around 包装：计时/超时/重试挂点 |
| `tools/post-execute` | waterfall | 结果富化/阻断 |
| `tools/result` | emit | **终态观察**（失败 contained）→ 记 `tool_completed/failed` |

- `PreToolDecision = {kind:'allow'} \| {kind:'deny', reason} \| {kind:'ask', reason?}`；deny 会物化为工具错误返回给模型
- `ToolExecutionResult` 判别 `isError`；`exec` 携带 name/args/agent
- 采用方案（plugin-dev.md §4 落定）：**pre-execute + result 双钩子**，覆盖所有工具（含 dsh 内置），不依赖 session log 事件名——升级面最小

## 工具注册 API 摘要（dsh-cann-tools 实现参照）

```js
ctx.tools.register(defineTool({
  name, description,
  parameters: { n: { type: 'integer', required: true } },   // DSL：required 在属性内
  output: {                                                  // 必填
    schema: { type: 'object', additionalProperties: false, properties: { … } },
    render: (_args, value) => [{ type: 'text', text: `… ${JSON.stringify(value)}` }],
  },
  execute(args, exec) { /* spawn python -m cannagent … */ },
}))
```

## 关键发现

### F1. patch 插入语法（踩坑记录）

profile 的 `cordis.patch.yml` 是**补丁层**，不是入口列表：

```yaml
# ✅ 向根列表追加新插件条目（无 id + insert）
- insert:
    - id: cann-observe
      name: ./plugins/cann-observe/index.js   # 必须指到文件；目录导入不支持（ESM）
# ❌ 顶层直接放条目 → "entry not found"（那是 id 定向覆盖的形状）
```

`--patch <overlay>` 叠加层同语法。`dsh --dump-config` 可离线核对组合树。

### F2. ⚠️ pip SDK 的 `dsh` 命令遮蔽 npm CLI（PATH 顺序）

`deepseek-harness-runtime-bin` 在 venv `Scripts/` 安装了同名 `dsh` 入口（Python 包装器）：要求显式 `DSH_HOME` 且启动的是 bundled exe——该 exe（0.1.5rc1 win-x64）完整 profile 启动时缺 `@deepseek-ai/dsh-session-title-llm`（包闭包缺陷）。**pip 安装后 `dsh` 命令行为改变**（C1 之后新发现，F4 的升级实例）。规约（并入 plugin-dev §7）：

- CLI 一律显式路径调用 npm 版（`$(npm root -g)/@deepseek-ai/dsh`）或保证 PATH 顺序
- Python 侧统一走 SDK（`deepseek_harness`），不走 CLI 包装器
- exe 的 profile 启动缺陷列入 D7 月检关注项

### F3. 事件顺序语义

deny 场景产生两条事件：`pre-execute` 拒绝决策（插件自记）+ registry 物化的 `tools/result` 错误（isError）。生产实现需把两者合并为一条 `tool_failed`（observability §3 的 started/completed 按 invocation 配对原则），避免前端重复渲染——记入 C3 实现注意项。

### F4. 本地插件零构建可行

插件以纯 ESM JS 放 profile 相邻目录，`@deepseek-ai/*` 导入经 node_modules 向上解析命中 dsh 安装树——**无需 pnpm/构建步骤**即可加载（spike 采用）。生产（C3）仍按 pnpm workspace 正式化，但此路径保留了「无构建快速迭代」的开发姿势。

## 实验记录

| 实验 | 结果 |
|---|---|
| exp1 拦截 + 自定义工具 | exit 0；`cann_probe`(207ms) 与 `write`(22ms) 的 started/completed 四事件按序落盘；模型真实调用工具（python 转发返回 42） |
| exp2 deny 钩子 | `CANN_DENY_TOOLS=write` → 拒绝事件 ×2；文件未创建；模型不绕过、如实汇报 |
| 失败路径（过程发现） | 目录导入 / output 缺失 / required 位置——均为注册 API 契约，见上文摘要 |

spike 插件源码：`~/.dsh/profiles/headless/plugins/cann-observe/`（本机留存；正式实现见 C3 `plugins/dsh-cann-tools`）。profile patch 已恢复原状。

## 对后续任务的输入

- **C3**：三插件骨架按本报告 API 摘要实现；事件合并注意 F3；加载按 F1 语法出 `profiles/` 组合文件
- **C11**：白名单 = `pre-execute` 闸门（本 spike 已验证机制），清单配置化进插件 config
- **#35（D2）**：双写可行性已验证，建议用户评审后归档决策 issue
