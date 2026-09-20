"""events.jsonl 唯一写入函数（observability.md §5 权威实现）。

- append + flush + seq 自增，进程内互斥（线程锁；跨进程由「一个 run 一个进程」的
  编排约定保证——D6 卡队列串行化同一 run 的任务包）
- 写入前脱敏（§6）与截断（§5：4KB 规则）
- append-only：本模块不提供修改/删除历史事件的任何入口
"""

from __future__ import annotations

import json
import re
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .config import run_dir

TRUNCATE_BYTES = 4096

_LOCK = threading.Lock()
_SEQ: dict[str, int] = {}

_SECRET_KEY_RE = re.compile(r"(?i)(key|token|secret|password|credential)")
_USER_PATH_RE = re.compile(r"[A-Za-z]:[/\\]+Users[/\\]+[^/\\\"']+")


def _sanitize(obj: Any) -> Any:
    """§6：密钥类 env 名过滤 + 绝对路径用户名归一为 ~。"""
    if isinstance(obj, dict):
        return {k: ("<redacted>" if _SECRET_KEY_RE.search(str(k)) else _sanitize(v)) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_sanitize(v) for v in obj]
    if isinstance(obj, str):
        return _USER_PATH_RE.sub("~", obj)
    return obj


def _truncate(obj: Any) -> Any:
    """§5：序列化后 >4KB 保留前 4KB + $truncated 标记（顶层替换）。"""
    text = json.dumps(obj, ensure_ascii=False, default=str)
    if len(text.encode("utf-8")) <= TRUNCATE_BYTES:
        return obj
    return {
        "$truncated": True,
        "preview": text[: TRUNCATE_BYTES // 2],
        "size_bytes": len(text.encode("utf-8")),
    }


def _wall_ts() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


class EventWriter:
    """一个 run 一个 writer；seq 进程内单调（按 events.jsonl 路径隔离，恢复场景从行数重放）。"""

    def __init__(self, rid: str) -> None:
        self.rid = rid
        self.path = run_dir(rid) / "events.jsonl"
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._seq_key = str(self.path)
        if self._seq_key not in _SEQ:
            _SEQ[self._seq_key] = self._count_existing()

    def _count_existing(self) -> int:
        if not self.path.exists():
            return 0
        with self.path.open("rb") as f:
            return sum(1 for _ in f)

    def append(self, kind: str, *, tool: dict[str, Any] | None = None, **fields: Any) -> int:
        """追加一条事件；返回分配的 seq。字段契约见 observability §2。"""
        payload = _sanitize({"kind": kind, "tool": tool, **fields})
        payload = _truncate(payload)
        with _LOCK:
            _SEQ[self._seq_key] += 1
            seq = _SEQ[self._seq_key]
            event = {
                "run_id": self.rid,
                "seq": seq,
                "ts": 0,  # 虚拟进度由 loop 插件注入；骨架期写 0（回放以 wall_ts 为准）
                "wall_ts": _wall_ts(),
                **payload,
            }
            with self.path.open("a", encoding="utf-8") as f:
                f.write(json.dumps(event, ensure_ascii=False, default=str) + "\n")
                f.flush()
        return seq


def append_event(rid: str, payload: dict[str, Any]) -> int:
    """插件转发入口：payload 至少含 kind（observability §3）。"""
    kind = payload.get("kind")
    if not isinstance(kind, str) or not kind:
        raise ValueError("event payload requires string 'kind'")
    writer = EventWriter(rid)
    rest = {k: v for k, v in payload.items() if k != "kind"}
    return writer.append(kind, **rest)


def read_events(rid: str, after_seq: int = 0) -> list[dict[str, Any]]:
    """消费侧读取（C7 FastAPI 用）：after_seq 增量拉取。"""
    path = run_dir(rid) / "events.jsonl"
    if not path.exists():
        return []
    events: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            event = json.loads(line)
            if event.get("seq", 0) > after_seq:
                events.append(event)
    return events


def events_path(rid: str) -> Path:
    return run_dir(rid) / "events.jsonl"
