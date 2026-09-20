# profiles/ — 三协议模型端点配置

目标（ROADMAP 待办）：端点配置固化进仓库，**任意机器 clone 后即可运行**，不依赖本机 `$DSH_HOME/settings.yaml`（SPEC §2）。

## 三协议

| 文件 | 协议 | 状态 |
|---|---|---|
| `openai-completions.yml` | OpenAI Chat Completions | ✅ 已实测（dmxapi 网关 + deepseek-v4-flash，2026-09-20 headless 冒烟） |
| `anthropic-messages.yml` | Anthropic Messages | 模板（字段面同源 dsh-llm-pi-ai 契约，未实测） |
| `openai-responses.yml` | OpenAI Responses | 模板（自建网关，未实测） |

## 接入（三步）

```bash
# 1. 凭据进环境（.env → 运行环境；值不入仓库）
cp .env.example .env && $EDITOR .env

# 2. 把所选协议的 yml 内容追加进目标 profile 的补丁层
cat profiles/openai-completions.yml >> ~/.dsh/profiles/headless/cordis.patch.yml
#   （文件首的 `[]` 占位请删除或保留为独立一行注释外的空列表）

# 3. 冒烟验证
dsh --profile headless "Reply with exactly: PROFILES-OK"
```

SDK 常驻形态（C1 F1 主形态）：`DSH_CORDIS_CONFIG` 组合文件中保留 `@deepseek-ai/dsh-sdk-jsonrpc-server` 条目 + 上述 provider 配置。

## 机制说明

- 三协议由 `@deepseek-ai/dsh-llm-pi-ai` 承载：`api:` 选协议、`baseURL:` 自定义端点、`compat:` 兼容开关（supportsDeveloperRole / maxTokensField / thinkingFormat）、`apiKeyEnv:` 凭据变量名
- 默认模型经 `agent-default-model` 条目的 **id 定向覆盖**（不新增条目）
- 与内置 `llm`（deepseek-official）路由共存：pi-ai 路由按 provider key 注册，`agent-default-model.provider` 决定实际使用哪条
- `dsh --profile <name> --dump-config` 可离线核对组合结果
