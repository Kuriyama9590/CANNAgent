"""knowledge 子命令（rag.md 契约实现，C6）。

- retrieve：向量检索（KnowledgeStore；库缺席/为空返回空集——不阻塞 run 的契约在此兑现）
- experience_write：pydantic 校验 + run 目录双副本落盘 + 知识库 upsert（draft）
- 治理（D5 人工增删查改）：list / approve / reject / delete / add
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path

from .config import run_dir
from .knowledge_store import KnowledgeStore, now_iso
from .task_schema import ExperienceEntry, ExperienceOutcome

OPS = "retrieve | experience_write | list | show | approve | reject | edit | delete | add"


def handle(args: dict[str, object]) -> dict[str, object]:
    op = str(args.get("op", ""))
    handler = {
        "retrieve": retrieve,
        "experience_write": experience_write,
        "list": op_list,
        "show": op_show,
        "approve": lambda a: op_status(a, "approved"),
        "reject": lambda a: op_status(a, "rejected"),
        "edit": op_edit,
        "delete": op_delete,
        "add": op_add,
    }.get(op)
    if handler is None:
        return {
            "ok": False,
            "code": "CANN_E_BAD_OUTPUT",
            "message": f"unknown knowledge op: {op!r}",
            "hint": f"op = {OPS}",
        }
    return handler(args)


def retrieve(args: dict[str, object]) -> dict[str, object]:
    query = str(args.get("query", ""))
    if not query:
        return {"results": [], "note": "空查询"}
    raw_filter = args.get("filter")
    raw_corpora = args.get("corpora")
    try:
        store = KnowledgeStore()
        results = store.retrieve(
            query,
            top_k=int(str(args.get("top_k", 5) or 5)),
            filter=dict(raw_filter) if isinstance(raw_filter, dict) else None,
            corpora=(
                [str(c) for c in raw_corpora] if isinstance(raw_corpora, list) else ["experience", "docs"]
            ),
        )
        store.close()
        return {"results": results}
    except Exception as exc:  # noqa: BLE001 —— rag.md §6：检索不可用不阻塞 run
        return {"results": [], "warning": f"检索不可用：{type(exc).__name__}: {exc}"}


def experience_write(args: dict[str, object]) -> dict[str, object]:
    rid = str(args.get("run_id", ""))
    now = datetime.now(timezone.utc).astimezone()
    digest = sha256(json.dumps(args, sort_keys=True, default=str).encode()).hexdigest()[:8]
    entry_id = f"exp-{now.strftime('%Y%m%d')}-{digest}"
    context = args.get("context", {})
    outcome = args.get("outcome", {})
    root_cause = args.get("root_cause")
    entry = ExperienceEntry(
        id=entry_id,
        run_id=rid,
        created_at=now.isoformat(timespec="seconds"),
        problem=str(args.get("problem", "")),
        context=dict(context) if isinstance(context, dict) else {},
        root_cause=root_cause if isinstance(root_cause, str) else None,
        solution=str(args.get("solution", "")),
        outcome=(
            ExperienceOutcome.model_validate(outcome)
            if isinstance(outcome, dict)
            else ExperienceOutcome(status="failed")
        ),
        reuse_when=str(args.get("reuse_when", "")),
    )
    payload = entry.model_dump_json(indent=2)
    root = run_dir(rid)
    (root / "summarize").mkdir(parents=True, exist_ok=True)
    (root / "experience").mkdir(parents=True, exist_ok=True)
    (root / "summarize" / f"{entry_id}.json").write_text(payload, encoding="utf-8")
    (root / "experience" / f"{entry_id}.json").write_text(payload, encoding="utf-8")
    # 知识库回流（draft；入库失败不阻断落盘——run 目录是第一现场）
    try:
        store = KnowledgeStore()
        store.upsert(entry)
        store.close()
    except Exception:  # noqa: BLE001
        pass
    return {"id": entry_id, "status": entry.status}


# ---- 治理操作（D5：人工抽检 + 增删查改）----


def op_list(args: dict[str, object]) -> dict[str, object]:
    store = KnowledgeStore()
    entries = store.list(
        corpus=str(args.get("corpus", "experience")),
        status=str(args["status"]) if args.get("status") else None,
    )
    store.close()
    return {"count": len(entries), "entries": entries}


def op_show(args: dict[str, object]) -> dict[str, object]:
    store = KnowledgeStore()
    entries = store.list()
    store.close()
    for entry in entries:
        if entry.get("id") == str(args.get("id", "")):
            return {"entry": entry}
    return {"ok": False, "code": "CANN_E_NOT_FOUND", "message": f"entry {args.get('id')!r} not found"}


def op_edit(args: dict[str, object]) -> dict[str, object]:
    """人工编辑（D5）：按 id 取原条目 → 覆盖给出的字段 → 重新校验入库。"""
    entry_id = str(args.get("id", ""))
    store = KnowledgeStore()
    entries = store.list(include_all=True)
    original = next((e for e in entries if e.get("id") == entry_id), None)
    if original is None:
        store.close()
        return {"ok": False, "code": "CANN_E_NOT_FOUND", "message": f"entry {entry_id!r} not found"}
    merged = {
        **original,
        **{
            k: v
            for k, v in args.items()
            if k in ("problem", "context", "root_cause", "solution", "outcome", "reuse_when", "status")
        },
    }
    try:
        entry = ExperienceEntry.model_validate(merged)
    except Exception as exc:  # noqa: BLE001 —— 编辑结果必须过 schema（rag §3）
        store.close()
        return {"ok": False, "code": "CANN_E_BAD_OUTPUT", "message": f"schema 校验失败：{exc}"}
    store.upsert(entry)
    store.close()
    return {"id": entry.id, "status": entry.status}


def op_status(args: dict[str, object], status: str) -> dict[str, object]:
    entry_id = str(args.get("id", ""))
    store = KnowledgeStore()
    ok = store.set_status(entry_id, status)
    store.close()
    return {"id": entry_id, "status": status if ok else "not-found"}


def op_delete(args: dict[str, object]) -> dict[str, object]:
    entry_id = str(args.get("id", ""))
    store = KnowledgeStore()
    ok = store.delete(entry_id)
    store.close()
    return {"id": entry_id, "deleted": ok}


def op_add(args: dict[str, object]) -> dict[str, object]:
    """人工录入（source=manual 默认 approved，D5）。"""
    digest = sha256(json.dumps(args, sort_keys=True, default=str).encode()).hexdigest()[:8]
    context = args.get("context", {})
    outcome = args.get("outcome", {})
    root_cause = args.get("root_cause")
    entry = ExperienceEntry(
        id=f"exp-{now_iso()[:10].replace('-', '')}-{digest}",
        source="manual",
        status="approved",
        created_at=now_iso(),
        run_id=str(args.get("run_id", "manual")),
        problem=str(args.get("problem", "")),
        context=dict(context) if isinstance(context, dict) else {},
        root_cause=root_cause if isinstance(root_cause, str) else None,
        solution=str(args.get("solution", "")),
        outcome=(
            ExperienceOutcome.model_validate(outcome)
            if isinstance(outcome, dict)
            else ExperienceOutcome(status="failed")
        ),
        reuse_when=str(args.get("reuse_when", "")),
    )
    store = KnowledgeStore()
    store.upsert(entry)
    store.close()
    return {"id": entry.id, "status": entry.status}


def store_path() -> Path:
    return KnowledgeStore().path
