# 权限与沙箱边界（security）

> 关联任务 C11 · 决策依据 D8（2026-09-17：命令白名单 + 目录隔离，不引入容器）。
> 状态：v1（2026-09-20，三层防线中两层已实测）。

## 1. 三层防线模型

```
第 1 层  dsh 文件沙箱（sandbox/mode=workspace-write）      ← 进程内文件系统边界
第 2 层  插件工具白名单（tools/pre-execute 闸门）          ← 工具调用边界（C11 核心）
第 3 层  python 转发约束（env 白名单 + run 目录路径校验）   ← 子进程边界
```

| 层 | 机制 | 实测 |
|---|---|---|
| 1 | workspace 外写入在工具层被沙箱拒绝（`UnauthorizedAccessException`），不等待人工审批、不挂起 | ✅ C1 spike exp4 |
| 2 | `dsh-cann-tools` 在 `tools/pre-execute` 返回 `{kind:'deny'}`——白名单外的工具调用被拒并落 `tool_failed` 事件 | ✅ C2 spike exp2 |
| 3 | `forward.ts` 只透传环境白名单变量给 python 子进程；`config.run_dir()` 拒绝含路径分隔符的 run_id（防穿越）；events 写入前脱敏（observability §6） | ✅ 单测覆盖 |

## 2. 工具白名单（生产清单）

权威清单在 `profiles/cann-whitelist.yml`（作为 `cann-tools` 插件的 config 注入，与端点配置同为 profile 层资产）：

- **领域工具**：`plugins/dsh-cann-tools/src/tool-table.ts` 全部 15 个 + `retrieve` / `experience_write` + `route`（routing 判定会话唯一工具）
- **最小内置集**：`read` / `write` / `edit`（implement 阶段写代码必需）；`bash` 默认**不进白名单**——命令执行一律经 `build` 等领域工具走任务包（D9），agent 不直接拿 shell
- 一致性由 `plugins` 测试保证：白名单必须覆盖全部领域工具（tool-table 增删未同步白名单 → CI 失败）

## 3. 目录隔离

- run 目录 = `workspace/runs/<run_id>/`，`input/` 只读、事件只追加（task-schema §2）
- dsh 会话 cwd = run 目录（`cann-tools` 的 `runsRoot` 配置），文件沙箱以 cwd 为 workspace 边界
- 跨 run 访问被第 1 层阻断（沙箱只放行本 run 目录树）

## 4. CANN 环境固定（远程任务包侧）

agent 与执行环境解耦（D9）：编译/测试/测量以任务包下发，服务器侧 runner 固定环境：

- 工具链版本由服务器 conda 环境 `cannagent` + CANN 9.0.0 安装锚定，任务包**只带脚本与数据，不带环境**
- 环境指纹随 bench 结果落盘（benchmark §2：device/CANN/驱动/固件），跨环境结果不可比
- 服务器凭据经 `.env`（`CANN_SERVER_*`）注入，不进任务包、不进事件流（E5 迁移后唯一入口）

## 5. 边界外（D8 明确不做，留作加固方向）

- 容器级隔离（gVisor/Kata）与 seccomp profile
- 服务器侧命令白名单（当前信任任务包生成端=白名单约束的 agent；服务器加固时再收紧执行面）
- 密钥的 Vault 化托管（当前 env/credentials seam 足够）
