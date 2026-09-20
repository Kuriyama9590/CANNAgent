"""检查点读写（workflow.md §5：cp-{stage}-{iter}.json，幂等，恢复入口）。"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .config import run_dir

CP_PATTERN = "cp-{stage}-{iter}.json"


def cp_path(rid: str, stage: str, iter_tag: str) -> Path:
    return run_dir(rid) / "checkpoints" / CP_PATTERN.format(stage=stage, iter=iter_tag)


def write_checkpoint(rid: str, stage: str, iter_tag: str, state: dict[str, Any]) -> Path:
    """原子写（tmp + replace）；同键重写 = 覆盖（幂等）。"""
    path = cp_path(rid, stage, iter_tag)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)
    return path


def read_checkpoint(rid: str, stage: str, iter_tag: str) -> dict[str, Any] | None:
    path = cp_path(rid, stage, iter_tag)
    if not path.exists():
        return None
    loaded: dict[str, Any] = json.loads(path.read_text(encoding="utf-8"))
    return loaded


def latest_checkpoint(rid: str) -> dict[str, Any] | None:
    """最新合法检查点（按 mtime；损坏文件跳过）。"""
    cps_dir = run_dir(rid) / "checkpoints"
    if not cps_dir.exists():
        return None
    best: dict[str, Any] | None = None
    best_mtime = -1.0
    for f in sorted(cps_dir.glob("cp-*.json")):
        try:
            loaded: dict[str, Any] = json.loads(f.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        state = loaded
        mtime = f.stat().st_mtime
        if mtime > best_mtime:
            best, best_mtime = state, mtime
    return best
