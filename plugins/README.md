# plugins/ — CannAgent dsh 插件 workspace

三个 Cordis 插件（规范：`docs/plugin-dev.md`；TS 侧零业务逻辑——注册/校验/转发/错误码映射）：

| 包 | 职责 |
|---|---|
| `dsh-cann-tools` | 15 个领域工具（workflow §2 清单）：白名单闸门（C11）+ python CLI 转发（D3）+ 工具边界事件拦截（C2 定案钩子） |
| `dsh-cann-knowledge` | `retrieve` / `experience_write`（rag.md §6 契约） |
| `dsh-cann-loop` | 七阶段状态机（workflow §2 边集）+ routing 判定会话 `route` 工具 + 预算缺省 |

## 开发

```bash
cd plugins
pnpm install
pnpm build     # tsc -b（composite，产物 lib/）
pnpm test      # vitest（用例数以 CI 输出为准）
pnpm lint      # eslint
```

## 加载进 dsh（profile patch 语法，C2 spike F1）

```yaml
# $DSH_HOME/profiles/<profile>/cordis.patch.yml
- insert:
    - id: cann-tools
      name: <repo>/plugins/dsh-cann-tools/lib/index.js
```

插件 `@deepseek-ai/*` 导入经 workspace `node_modules` 解析；peer 版本对齐 npm `@deepseek-ai/dsh@0.1.5-rc.2`（D7 双通道纪律见 plugin-dev §7）。
