"""events.jsonl 写入契约测试（observability §5/§6）。"""

from __future__ import annotations

import json

from cannagent import events


def test_seq_monotonic_and_persisted(workspace, run_id):
    w1 = events.EventWriter(run_id)
    s1 = w1.append("tool_started", tool={"name": "parse_model"})
    s2 = w1.append("tool_completed", tool={"name": "parse_model"})
    assert (s1, s2) == (1, 2)
    # 新 writer（模拟新进程）从文件行数续 seq
    w2 = events.EventWriter(run_id)
    assert w2.append("note") == 3


def test_append_only_shape(workspace, run_id):
    events.append_event(run_id, {"kind": "stage_started", "stage": "identify"})
    lines = (events.events_path(run_id)).read_text(encoding="utf-8").strip().splitlines()
    assert len(lines) == 1
    e = json.loads(lines[0])
    assert e["run_id"] == run_id
    assert e["seq"] == 1
    assert e["kind"] == "stage_started"
    assert e["wall_ts"]


def test_sanitize_secrets_and_paths(workspace, run_id):
    events.append_event(
        run_id,
        {
            "kind": "tool_started",
            "tool": {
                "name": "run_test",
                "input": {"DEEPSEEK_API_KEY": "sk-secret", "path": r"C:\Users\QiuYC\x", "n": 3},
            },
        },
    )
    line = events.events_path(run_id).read_text(encoding="utf-8")
    assert "sk-secret" not in line
    assert "<redacted>" in line
    assert "QiuYC" not in line
    assert "~" in line


def test_truncate_oversized(workspace, run_id):
    events.append_event(run_id, {"kind": "note", "detail": "x" * 10_000})
    e = events.read_events(run_id)[0]
    assert e.get("$truncated") is True
    assert e.get("size_bytes", 0) > 4096


def test_read_events_after_seq(workspace, run_id):
    for i in range(5):
        events.append_event(run_id, {"kind": "note", "detail": i})
    assert [e["seq"] for e in events.read_events(run_id, after_seq=3)] == [4, 5]


def test_kind_required(workspace, run_id):
    import pytest

    with pytest.raises(ValueError):
        events.append_event(run_id, {"detail": "no kind"})
