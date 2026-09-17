# RAG 与经验库规范（rag）

> 阶段② 规范文档 · 关联任务 B7 · `python/cannagent/knowledge/` 与 dsh-cann-knowledge 工具的权威规范。
> 状态：v1（2026-09-17，D5 已拍板：schema 校验 + 人工抽检 + 经验库人工增删查改）。

## 1. 职责与分工

| 层 | 内容 | 时效 | 消费方 |
|---|---|---|---|
| `skills/` | 静态方法论：算子开发指南、融合模式手册 | 随仓库版本演进 | 所有 run（prompt 注入） |
| **RAG 经验库** | 动态经验：每个 run 结束自动回流的成败条目 | 持续累积 + 人工治理 | strategy / routing 判定（retrieve 注入） |
| RAG 文档库 | CANN 官方文档、ATC pass 说明、昇腾 FAQ | 随 CANN 版本更新 | identify / strategy / implement |
| events.jsonl | 本 run 事实 | 不可变 | 前端 / summarize |

RAG 不做决策：检索结果是**证据注入**（进 manifest / prompt），选型仍由阶段会话与 routing 判定会话做出。

## 2. 存储与检索栈（起步，可替换）

- **SQLite + sqlite-vec + BGE-M3**（D5：服务器零依赖部署）
- 访问面固定为接口（Python protocol），实现可整体替换为 Qdrant/Milvus 而不影响调用方：

```python
class KnowledgeStore(Protocol):
    def upsert(self, entry: ExperienceEntry, corpus: str = "experience") -> None: ...
    def retrieve(self, query: str, top_k: int = 5, filter: dict | None = None,
                 corpora: list[str] = ["experience", "docs"]) -> list[Retrieved]: ...
    def delete(self, entry_id: str) -> None: ...
    def list(self, corpus: str, status: str | None = None) -> list[ExperienceEntry]: ...
    def embed(self, texts: list[str]) -> list[list[float]]: ...
```

- 向量与元数据同库分表（`entries` / `vectors` / `chunks`）；`rag://<entry_id>` 为稳定引用形式（fusion_candidates.references、strategy 依据链使用）
- 索引文件位置：`workspace/knowledge/`（gitignore；备份/迁移 = 拷库文件 + rebuild 校验）

## 3. 经验条目 schema（权威定义）

workflow.md §2.1 summarize 段的最小字段的**完整版**（向后兼容扩展）：

```jsonc
{
  "schema_version": "1.0",
  "id": "exp-20260916-a1b2c3d4",        // exp-{date}-{hash8}；rag:// 引用键
  "run_id": "r20260916-…",              // 来源 run（溯源）
  "source": "auto",                     // auto（run 回流）| manual（人工录入）
  "status": "draft",                    // draft | approved | rejected（D5 人工治理）
  "created_at": "2026-09-16T21:40:00+08:00",
  "problem": "Conv+BN+ReLU 融合（910B/fp16/NCHW）",   // 问题/任务描述（检索主键之一）
  "context": {                          // 结构化复用条件（= filter 面）
    "dtype": "fp16", "layout": "NCHW", "device": "Ascend910B",
    "cann": "9.0.0", "pattern": "Conv+BN+ReLU" },
  "root_cause": "……",                   // 根因（失败/降级条目必填，校验强制）
  "solution": "……",                     // 方案与关键取舍
  "outcome": {                          // 结果（成功条目必填数值）
    "status": "success",                // success | partial | failed
    "gain_pct": 6.2, "max_rel_err": 8e-4,
    "atc_coverage": "not_covered" },    // D4 分类：stronger_than_atc | not_covered | invalid
  "reuse_when": "当 910B fp16 NCHW 下 Conv+BN+ReLU 且 ATC 未覆盖时……",  // 自然语言复用条件（检索摘要）
  "references": ["rag://exp-…", "docs://cann-9.0/aclnnConvolution"]  // 依据链
}
```

校验规则（pydantic 强制）：
1. `outcome.status ≠ success` 时 `root_cause` 必填
2. `source=auto` 的条目 `status` 起始为 `draft`
3. `context.device` / `context.dtype` 必填（最常用过滤面）
4. schema 违反 = summarize 阶段直通判定不满足（workflow §2）

## 4. 回流流程（summarize → 人工治理）

```
run 结束 → summarize 会话产出 exp-*.json（schema 校验）→ 写入 run 目录 summarize/ 与 experience/
        → upsert 进知识库（status=draft）→ 交付后人工抽检（D5）
人工治理（CLI：python -m cannagent knowledge list|show|approve|reject|edit|delete|add）
        → approved 条目进入默认检索面；draft/rejected 不参与默认检索（显式 filter 可查）
```

- **抽检节奏**：每次交付后人工抽检本次回流条目；不阻塞交付（回流即可被显式检索）
- **人工增删查改**（D5）：CLI 提供全套操作，人工条目 `source=manual` 默认 `approved`
- **冲突处理**：同 `problem+context` 出现矛盾结论时，新旧并存（id 不同），`references` 互引；检索按 `created_at` 降序 + 相关度混合排序

## 5. 文档库（CANN docs）

- 语料来源：CANN 官方文档（昇腾社区_RELEASE 包）、ATC pass 清单（C12 产出回填）、内部 FAQ
- 切块策略：按文档标题层级切块，块上限 ~1.5K 字符、重叠 10%；`docs://<cann版本>/<文档路径>#<锚点>` 为引用形式
- CANN 版本升级时：新版本语料增量入库，旧版本保留（`context.cann` 可过滤）；每版本入库后跑一遍固定问题集的检索 sanity check

## 6. 检索契约（工具 `retrieve`）

```jsonc
// dsh-cann-knowledge 注册的工具入参（pydantic 镜像）
{ "query": "Conv+BN+ReLU 融合 910B", "top_k": 5,
  "filter": { "dtype": "fp16", "status": "approved" },     // 精确匹配 context 面
  "corpora": ["experience", "docs"] }
// 返回：[{ "ref": "rag://exp-…", "score": 0.83, "summary": "…", "payload": {…条目或切块…} }]
```

- 默认 `status=approved`、`corpora=["experience","docs"]`
- 注入方式：检索结果进阶段会话的 manifest（workflow §2 判据注入），不直接拼进 system prompt 尾部
- 检索失败（库不可用）不阻塞 run：工具返回空集 + warning 事件（note severity=warning）

## 7. Embedding

- BGE-M3 本地推理（CPU 起步；NPU 服务器可后续切 torch_npu 推理，接口不变）
- 模型文件与索引同目录管理；换模型 = 全量 rebuild（版本号记入库元数据，检索时校验）

## 8. 安全

1. 入库前脱敏：与 observability §6 同规则（密钥模式过滤、路径用户名归一）；**先脱敏再 embed**（向量库不可逆，必须保证源文本干净）
2. 经验条目不得包含凭据、内网拓扑；`人工录入` 同样过脱敏器
3. 知识库导出（跨环境迁移）需经脱敏器复核后打包
