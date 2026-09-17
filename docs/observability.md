# 可观测性：事件流契约（observability）

> 阶段② 规范文档 · 关联任务 B3/C2/C7 · 这是"每一步操作可见可追溯"需求的权威契约。
> 状态：v1 草案。**demo（web-demo/src/types.ts）与本文件同构；冲突时以本文件为准，demo 跟随修改。**

## 1. 目标与原则

1. **单一数据源**：前端/报告/统计只消费 `events.jsonl`，不读 dsh 内部状态
2. **双通道分工**：dsh session log = 原始会话取证（开发者排查，dsh 自有格式）；`events.jsonl` = 结构化展示流（用户可追溯，本契约）
3. **append-only**：一行一事件 JSON，写入后禁止修改与删除；顺序即真相
4. **每事件可定位**：`run_id + seq` 唯一，`wall_ts` 与虚拟进度双时间戳

## 2. 事件结构（权威定义）

生产版在 demo 基础上扩展三个字段：`run_id`、`seq`、`wall_ts`。

```jsonc
{
  "run_id": "r20260915-140201-x8f3k2a1",
  "seq": 27,                          // run 内单调递增，从 1 开始
  "ts": 1870000,                      // 虚拟进度：距 run 开始毫秒（预算计时基准）
  "wall_ts": "2026-09-15T14:33:07+08:00",  // 真实挂钟时间

  "stage": "verify",                  // identify|strategy|implement|verify|bench|summarize|deliver
  "kind": "tool_failed",
  "title": "v1 精度超差",
  "detail": "max_rel_err 3.1e-2，阈值 1e-3，失败 9/80 例",
  "severity": "error",                // info|success|warning|error（缺省 info）
  "iteration": "v1",                  // 迭代标签（可选）
  "sessionId": "s-implement-v2",      // 可选：dsh 会话归属（session_* 与 tool_* 事件携带）
                                       // 前端"会话直播"视图按此分组渲染思考/输出/工具调用

  "tool": {                           // 可选：工具调用边界
    "name": "run_test",
    "input": { },                     // 结构化参数（脱敏后）
    "output": { },                    // 结构化结果摘要（大对象截断规则见 §5）
    "duration_ms": 64000
  },
  "artifact": { "tab": "accuracy", "title": "精度报告 · v1", "data": { } },
  "message": { "part": "thinking", "content": "…" }  // 可选：模型消息增量（kind=session_message 必填）
}
```

## 3. 事件类型语义

| kind | 触发点 | 语义约束 |
|---|---|---|
| `stage_started` / `stage_completed` / `stage_failed` | 状态机转移（workflow.md） | 每阶段 started 恰好一次；completed/failed 二选一终结 |
| `session_started` / `session_ended` | dsh 会话边界（loop 插件开/收 session） | 携带 `sessionId`；started 的 title 标会话角色（如 `implement 会话 · v2`、`routing 判定会话`）；ended 说明收尾原因（完成 / token 满滚转 / 异常） |
| `session_message` | 模型消息增量（思考流 / 文本输出） | 携带 `sessionId` 与 `message.part`（thinking\|text）；按 flush 窗口合并（≤500ms 或 ≤2KB 一条），超长截断同 §5；前端"会话直播"视图的唯一消息来源 |
| `tool_started` / `tool_completed` / `tool_failed` | 工具调用边界（适配层统一发出 | started/completed 按 `tool.invocation_id` 配对（长工具才有 started；快工具可只发终态）；建议携带 `sessionId` 以便会话视图内联展示 |
| `iteration_started` | implement/verify 新迭代 | `iteration` 必填（v1/v2/…） |
| `decision` | agent 关键决策（选融合模式/达标判定） | detail 必填理由 |
| `checkpoint` | 状态机落盘检查点 | detail 带检查点文件相对路径 |
| `degrade` | 降级（workflow.md §4） | severity=error；detail 必含人工介入建议 |
| `note` | 其他需要展示的信息 | 不得滥用（前端默认平铺展示） |

阶段状态推导（与 demo `engine/derive.ts` 一致）：以同 stage 最后一条 stage_* / degrade 事件为准。

## 4. 产物（artifact）类型

| tab | 内容 | 生产数据来源 |
|---|---|---|
| `bench` | 性能对比（baseline/optimized 的 p50/p99、gainPct、口径 note） | `bench/bench_v{N}.json` |
| `accuracy` | 精度报告（误差、通过率、迭代记录） | `verify/accuracy_v{N}.json` |
| `diff` | 代码变更（file/summary/unified diff 文本） | implement 迭代快照 diff |
| `strategy` | 策略文档（markdown） | `strategy/STRATEGY.md` |
| `experience` | 经验条目（rag.md schema） | `summarize/exp-*.json` |
| `report` | 交付报告（markdown） | `deliver/REPORT.md` |
| `meta` | 交付清单/其他结构化产物 | `deliver/` 打包清单 |

规则：artifact.data 为**内嵌快照**（≤8KB）或**文件引用**（`{"$ref": "verify/accuracy_v1.json"}`）；前端两种都要支持。大对象一律引用。

## 5. 写入与消费

- **写入**：`python/cannagent/events.py` 提供唯一写入函数（append + flush + seq 自增，进程内互斥）；dsh 插件经适配层调用，禁止直接写文件
- **消费**：FastAPI（C7）`GET /api/runs/{id}/events?after_seq=N` 增量拉取；SSE 端点 tail 推送；回放 = `after_seq=0` 全量重读
- **截断**：`tool.input/output` 序列化后 > 4KB 保留前 4KB + `{"$truncated": true, "full_ref": <run目录内文件>}`
- **顺序保证**：写入方保证 seq 与文件行序一致；消费方按 seq 排序兜底

## 6. 脱敏与安全

1. 写入前过滤：密钥类 env 名（`*KEY*`/`*TOKEN*`/`*SECRET*`）、绝对路径中的用户名（归一为 `~`）
2. 编译/运行日志入事件前抽取关键行（错误码/告警），全文落 run 目录文件
3. events.jsonl 属于 run 现场，随目录归档；对外导出需经脱敏器复核
