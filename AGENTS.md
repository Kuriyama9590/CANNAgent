# AGENTS.md — CannAgent 仓库协作守则

> 面向在本仓库工作的一切 AI 代理（ZCode / dsh / 未来协作者的工具链）。
> 与 docs/SPEC.md §9（Git/CI 规范）配套；涉及"代理行为边界"时以本文件为准。
> 2026-09-17 修订：移除原「PR 边界（硬规则）」一节——单人项目下 PR 由代理按需创建、推送与合并，唯一硬门槛是 CI 全绿（分支保护）。

## 1. Issue 与看板

- 新任务建议建 issue（`type/*` + `phase/*` 标签、挂里程碑），会自动进入[开发看板](https://github.com/users/Kuriyama9590/projects/1)
- **未经用户确认不得关闭 issue**——尤其"已完成归档"类操作，完成与否由用户评审判定（B1/B2/B3/B6 回滚事件即为教训）
- 回滚（重开）同样需要用户明确提出

## 2. 分支与提交

- trunk-based：短分支 → PR → squash 合入 main；PR 由代理按需创建、推送与合并，无需逐次确认
- 提交信息遵循 Conventional Commits（CI 强制校验，规则见 `.github/commitlint.config.mjs`，允许的 type：feat/fix/docs/style/refactor/perf/test/build/ci/chore/revert）
- main 受分支保护：必须 CI 全绿、禁止 force push；合并方式仅 Squash

## 3. 文档权威性

- docs/ 是单一事实源：行为或接口变更必须同步对应规范
- 冲突时的权威顺序：状态机 = `workflow.md`；输入 schema = `task-schema.md`；事件流 = `observability.md`；总纲 = `SPEC.md`
- 规范文档的修订也走 PR（由用户处理）

## 4. 安全

- 凭据只通过 `.env` 环境变量引用（见 `.env.example`）；任何密钥、密码、服务器口令不得进入仓库、日志或事件流
- `workspace/` 运行时产物不进 git

## 5. 沟通

- 使用中文交流与书写文档
- 拿不准就问；不代替用户做发行/归档决策（release、对外交付、里程碑归档）；issue 关闭见 §1
