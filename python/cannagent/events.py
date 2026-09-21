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
# 自由文本中的密钥值模式：sk-xxx 令牌 / key=value / token: xxx
_SECRET_VALUE_RE = re.compile(r"(?i)((?:sk|pk)-[a-z0-9_-]{8,}|\b(?:key|token|secret|password)\s*[=:]\s*\S+)")


def _sanitize(obj: Any) -> Any:
    """§6：密钥类 env 名过滤 + 绝对路径用户名归一为 ~。"""
    if isinstance(obj, dict):
        return {k: ("<redacted>" if _SECRET_KEY_RE.search(str(k)) else _sanitize(v)) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_sanitize(v) for v in obj]
    if isinstance(obj, str):
        return _USER_PATH_RE.sub("~", obj)
    return obj


def scrub_secrets(text: str) -> str:
    """自由文本密钥值擦除（rag.md §8：入库/嵌入前调用）。"""
    return _SECRET_VALUE_RE.sub("<redacted>", text)


def deep_scrub(obj: Any) -> Any:
    """递归脱敏：键名过滤 + 路径归一 + 字符串密钥值擦除（知识库入库用）。"""
    if isinstance(obj, dict):
        return {k: ("<redacted>" if _SECRET_KEY_RE.search(str(k)) else deep_scrub(v)) for k, v in obj.items()}
    if isinstance(obj, list):
        return [deep_scrub(v) for v in obj]
    if isinstance(obj, str):
        return scrub_secrets(_USER_PATH_RE.sub("~", obj))
    return obj


def _spill(rid: str, seq_hint: str, field: str, text: str) -> str:
    """全文落 run 目录 spill 文件，返回相对路径（full_ref）。"""
    spill_dir = run_dir(rid) / "spill"
    spill_dir.mkdir(parents=True, exist_ok=True)
    path = spill_dir / f"tool-{seq_hint}-{field}.json"
    path.write_text(text, encoding="utf-8")
    return f"spill/tool-{seq_hint}-{field}.json"


def _truncate_field(value: Any) -> tuple[Any, str | None]:
    """单字段截断（§5 就地语义）：≤4KB 原样；超限返回 (truncated 对象, 全文)。

    truncated 对象保留 $truncated/preview/size_bytes——full_ref 由调用方补
    （需要 seq，spill 文件名按事件编号落位）。
    """
    text = json.dumps(value, ensure_ascii=False, default=str)
    if len(text.encode("utf-8")) <= TRUNCATE_BYTES:
        return value, None
    return {
        "$truncated": True,
        "preview": text[:TRUNCATE_BYTES],
        "size_bytes": len(text.encode("utf-8")),
    }, text


def _wall_ts() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


_TOOL_KINDS = {"tool_started", "tool_completed", "tool_failed"}


class EventWriter:
    """一个 run 一个 writer；seq 进程内单调（按 events.jsonl 路径隔离，恢复场景从行数重放）。

    单写者约定（§5）：同一 run 的写入必须串行（loop 逐工具 await 子进程）；
    本模块不保证多进程并发追加下的 seq 唯一性。
    """

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
        """追加一条事件；返回分配的 seq。字段契约见 observability §2/§5.1。"""
        payload = _sanitize({"kind": kind, "tool": tool, **fields})
        tool_payload = payload.get("tool") if isinstance(payload.get("tool"), dict) else None

        with _LOCK:
            _SEQ[self._seq_key] += 1
            seq = _SEQ[self._seq_key]

            # §3：tool_* 事件的 invocation_id 强制存在（缺失即补全并落 note）
            if kind in _TOOL_KINDS and tool_payload is not None and not tool_payload.get("invocation_id"):
                tool_payload["invocation_id"] = f"inv-auto-{seq}"
                existing: Any = payload.get("notes", [])
                payload["notes"] = [
                    *(existing if isinstance(existing, list) else []),
                    "invocation_id 由写入函数补全（插件未提供）",
                ]

            # §5 就地截断：tool.input/output 各自处理；骨架字段不动
            if tool_payload is not None:
                for field_name in ("input", "output"):
                    original = tool_payload.get(field_name)
                    if original is None:
                        continue
                    truncated, full_text = _truncate_field(original)
                    if full_text is not None:
                        tool_payload[field_name] = truncated
                        tool_payload[field_name]["full_ref"] = _spill(
                            self.rid, str(seq), field_name, full_text
                        )

            # 顶层兜底：整行序列化仍超限（4×TRUNCATE_BYTES）时保留骨架字段截断 detail
            event = {
                "run_id": self.rid,
                "seq": seq,
                "ts": 0,  # 虚拟进度由 loop 插件注入；骨架期写 0（回放以 wall_ts 为准）
                "wall_ts": _wall_ts(),
                **payload,
            }
            line = json.dumps(event, ensure_ascii=False, default=str)
            if len(line.encode("utf-8")) > TRUNCATE_BYTES * 4 and isinstance(event.get("detail"), str):
                event["detail"] = event["detail"][:TRUNCATE_BYTES] + "…($truncated)"
                line = json.dumps(event, ensure_ascii=False, default=str)

            with self.path.open("a", encoding="utf-8") as f:
                f.write(line + "\n")
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
