"""knowledge 子命令（rag.md 契约的骨架实现）。

- retrieve：知识库缺席时返回空集（rag.md §6：检索不可用不阻塞 run）
- experience_write：pydantic 校验（task_schema.ExperienceEntry）+ run 目录落盘
  （summarize/ 与 experience/ 双副本）；内存索引（sqlite-vec）为 C6 交付
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from hashlib import sha256

from .config import run_dir
from .task_schema import ExperienceEntry, ExperienceOutcome


def handle(args: dict[str, object]) -> dict[str, object]:
    op = str(args.get("op", ""))
    if op == "retrieve":
        return retrieve(args)
    if op == "experience_write":
        return experience_write(args)
    return {
        "ok": False,
        "code": "CANN_E_BAD_OUTPUT",
        "message": f"unknown knowledge op: {op!r}",
        "hint": "op = retrieve | experience_write",
    }


def retrieve(args: dict[str, object]) -> dict[str, object]:
    # C6 交付 sqlite-vec + BGE-M3；骨架期空集（不阻塞 run 的契约在此兑现）
    del args
    return {"results": [], "note": "知识库未建（C6）；空集不阻塞"}


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
        outcome=(ExperienceOutcome.model_validate(outcome)
                 if isinstance(outcome, dict) else ExperienceOutcome(status="failed")),
        reuse_when=str(args.get("reuse_when", "")),
    )
    payload = entry.model_dump_json(indent=2)
    root = run_dir(rid)
    (root / "summarize").mkdir(parents=True, exist_ok=True)
    (root / "experience").mkdir(parents=True, exist_ok=True)
    (root / "summarize" / f"{entry_id}.json").write_text(payload, encoding="utf-8")
    (root / "experience" / f"{entry_id}.json").write_text(payload, encoding="utf-8")
    return {"id": entry_id, "status": entry.status}
