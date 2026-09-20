"""知识库存储（rag.md §2 起步栈的最小实现）。

- SQLite 单库（workspace/knowledge/knowledge.db），entries 表存完整条目 + 向量 blob
- 向量检索：python 侧余弦（v0；sqlite-vec 加速为后续优化，接口不变——rag.md §2 抽象约定）
- embedding 后端可插拔：hash（开发态，确定性零依赖）/ bge-m3（生产态，可选依赖懒加载）
- 检索默认只搜 approved；context 面精确过滤；入库前先脱敏（rag.md §8：先脱敏再 embed）
"""

from __future__ import annotations

import json
import math
import os
import sqlite3
from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path
from typing import Any, Protocol

from .config import workspace_root
from .events import deep_scrub, scrub_secrets
from .task_schema import ExperienceEntry

DB_NAME = "knowledge.db"

EMBED_DIM = 256


class Embedder(Protocol):
    name: str

    def embed(self, texts: list[str]) -> list[list[float]]: ...


class HashEmbedder:
    """开发态后端：确定性 bag-of-words 哈希向量（256 维，零依赖）。

    语义能力有限（词面重叠即相关）——足够单测与链路验证；生产切换 bge-m3。
    """

    name = "hash"

    def embed(self, texts: list[str]) -> list[list[float]]:
        return [self._one(t) for t in texts]

    def _one(self, text: str) -> list[float]:
        vec = [0.0] * EMBED_DIM
        for token in _tokenize(text):
            h = int(sha256(token.encode("utf-8")).hexdigest()[:8], 16)
            vec[h % EMBED_DIM] += 1.0
        norm = math.sqrt(sum(v * v for v in vec)) or 1.0
        return [v / norm for v in vec]


class BgeM3Embedder:
    """生产态后端：BGE-M3（可选依赖 sentence-transformers；服务器侧部署）。"""

    name = "bge-m3"

    def __init__(self, model_name: str = "BAAI/bge-m3") -> None:
        from sentence_transformers import SentenceTransformer

        self._model = SentenceTransformer(model_name)

    def embed(self, texts: list[str]) -> list[list[float]]:
        vectors = self._model.encode(texts, normalize_embeddings=True)
        return [[float(x) for x in v] for v in vectors]


def _tokenize(text: str) -> list[str]:
    """简易分词：英文按词、中文按双字滑窗（hash 后端够用即可）。"""
    tokens: list[str] = []
    buf = ""
    for ch in text:
        if ch.isascii() and (ch.isalnum() or ch in "+-."):
            buf += ch.lower()
            continue
        if buf:
            tokens.append(buf)
            buf = ""
        if "\u4e00" <= ch <= "\u9fff":
            tokens.append(ch)
    if buf:
        tokens.append(buf)
    # 中文双字组合
    cjk = [t for t in tokens if len(t) == 1 and not t.isascii()]
    tokens.extend(a + b for a, b in zip(cjk, cjk[1:], strict=False))
    return tokens


def get_embedder() -> Embedder:
    kind = os.environ.get("CANNAGENT_EMBEDDER", "hash")
    if kind == "bge-m3":
        return BgeM3Embedder()
    return HashEmbedder()


def _cosine(a: list[float], b: list[float]) -> float:
    return sum(x * y for x, y in zip(a, b, strict=False))


class KnowledgeStore:
    """经验库（+ 文档库预留同表不同 corpus 列）。"""

    def __init__(self, db_path: Path | None = None, embedder: Embedder | None = None) -> None:
        self.path = db_path or workspace_root() / "knowledge" / DB_NAME
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.embedder = embedder or get_embedder()
        self._conn = sqlite3.connect(self.path)
        self._conn.execute("""
            CREATE TABLE IF NOT EXISTS entries (
                id TEXT PRIMARY KEY,
                corpus TEXT NOT NULL DEFAULT 'experience',
                status TEXT NOT NULL DEFAULT 'draft',
                source TEXT NOT NULL DEFAULT 'auto',
                context_json TEXT NOT NULL DEFAULT '{}',
                payload_json TEXT NOT NULL,
                vector BLOB NOT NULL,
                created_at TEXT NOT NULL
            )""")
        self._conn.execute("CREATE INDEX IF NOT EXISTS idx_entries_corpus_status ON entries(corpus, status)")
        self._conn.commit()

    # ---- 写入 ----

    def upsert(self, entry: ExperienceEntry, corpus: str = "experience") -> None:
        """入库：先脱敏（rag.md §8）再 embed；同 id 覆盖（幂等）。"""
        clean = deep_scrub(json.loads(entry.model_dump_json()))
        text = f"{entry.problem} | {entry.reuse_when} | {entry.solution}"
        vector = self.embedder.embed([clean_sanitize(text)])[0]
        self._conn.execute(
            "INSERT OR REPLACE INTO entries VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                entry.id,
                corpus,
                entry.status,
                entry.source,
                json.dumps(entry.context, ensure_ascii=False),
                json.dumps(clean, ensure_ascii=False),
                _pack(vector),
                entry.created_at,
            ),
        )
        self._conn.commit()

    # ---- 检索 ----

    def retrieve(
        self,
        query: str,
        top_k: int = 5,
        filter: dict[str, Any] | None = None,
        corpora: list[str] | None = None,
        include_drafts: bool = False,
    ) -> list[dict[str, Any]]:
        """rag.md §6 契约：默认 approved + 双语料；context 面精确过滤。"""
        where = ["1=1"]
        params: list[Any] = []
        if not include_drafts:
            where.append("status = 'approved'")
        if corpora:
            where.append(f"corpus IN ({','.join('?' * len(corpora))})")
            params.extend(corpora)
        rows = self._conn.execute(
            f"SELECT id, corpus, context_json, payload_json, vector FROM entries WHERE {' AND '.join(where)}",
            params,
        ).fetchall()
        qvec = self.embedder.embed([query])[0]
        scored: list[tuple[float, dict[str, Any]]] = []
        for rid, corpus, context_json, payload_json, blob in rows:
            context = json.loads(context_json)
            if filter and any(str(context.get(k)) != str(v) for k, v in filter.items()):
                continue
            score = _cosine(qvec, _unpack(blob))
            scored.append(
                (
                    score,
                    {
                        "ref": f"rag://{rid}",
                        "score": round(score, 4),
                        "corpus": corpus,
                        "payload": json.loads(payload_json),
                    },
                )
            )
        scored.sort(key=lambda t: t[0], reverse=True)
        return [item for _, item in scored[:top_k]]

    # ---- 治理（D5 人工增删查改）----

    def list(self, corpus: str = "experience", status: str | None = None) -> list[dict[str, Any]]:
        where = "corpus = ?"
        params: list[Any] = [corpus]
        if status:
            where += " AND status = ?"
            params.append(status)
        rows = self._conn.execute(
            f"SELECT payload_json FROM entries WHERE {where} ORDER BY created_at DESC", params
        ).fetchall()
        return [json.loads(r[0]) for r in rows]

    def set_status(self, entry_id: str, status: str) -> bool:
        cur = self._conn.execute("UPDATE entries SET status = ? WHERE id = ?", (status, entry_id))
        self._conn.commit()
        return cur.rowcount > 0

    def delete(self, entry_id: str) -> bool:
        cur = self._conn.execute("DELETE FROM entries WHERE id = ?", (entry_id,))
        self._conn.commit()
        return cur.rowcount > 0

    def close(self) -> None:
        self._conn.close()


def clean_sanitize(text: str) -> str:
    return scrub_secrets(text)


def _pack(vector: list[float]) -> bytes:
    return json.dumps(vector).encode("utf-8")


def _unpack(blob: bytes) -> list[float]:
    vec: list[float] = json.loads(blob.decode("utf-8"))
    return vec


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")
