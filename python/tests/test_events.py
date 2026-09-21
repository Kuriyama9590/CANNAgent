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


def test_truncate_tool_field_in_place(workspace, run_id):
    """§5 就地截断：只替换 tool.input，kind/seq 等骨架字段不动，全文落 spill。"""
    events.append_event(
        run_id, {"kind": "tool_started", "tool": {"name": "run_test", "input": {"big": "x" * 10_000}}}
    )
    e = events.read_events(run_id)[0]
    assert e["kind"] == "tool_started"  # 骨架字段保留（审查修复核心点）
    truncated = e["tool"]["input"]
    assert truncated["$truncated"] is True
    assert truncated["size_bytes"] > 4096
    assert truncated["full_ref"].startswith("spill/tool-1-input.json")
    full = (events.events_path(run_id).parent / truncated["full_ref"]).read_text(encoding="utf-8")
    assert "x" * 100 in full  # 全文在 spill 文件可寻回


def test_truncate_detail_bound_keeps_skeleton(workspace, run_id):
    """顶层兜底：超大 detail 截断但事件结构完整。"""
    events.append_event(run_id, {"kind": "note", "detail": "y" * 20_000})
    e = events.read_events(run_id)[0]
    assert e["kind"] == "note"
    assert e["detail"].endswith("…($truncated)")
    assert len(e["detail"]) <= 4096 + len("…($truncated)")


def test_read_events_after_seq(workspace, run_id):
    for i in range(5):
        events.append_event(run_id, {"kind": "note", "detail": i})
    assert [e["seq"] for e in events.read_events(run_id, after_seq=3)] == [4, 5]


def test_kind_required(workspace, run_id):
    import pytest

    with pytest.raises(ValueError):
        events.append_event(run_id, {"detail": "no kind"})


def test_tool_event_invocation_id_autofill(workspace, run_id):
    """§3：tool_* 事件缺 invocation_id 时写入函数补全并落 note。"""
    events.append_event(run_id, {"kind": "tool_completed", "tool": {"name": "build", "output": {"ok": True}}})
    e = events.read_events(run_id)[0]
    assert e["tool"]["invocation_id"].startswith("inv-auto-")
    assert any("invocation_id 由写入函数补全" in str(n) for n in e.get("notes", []))


def test_tool_event_invocation_id_passthrough(workspace, run_id):
    """插件提供的 invocation_id 原样保留（配对键不被改写）。"""
    events.append_event(
        run_id, {"kind": "tool_started", "tool": {"invocation_id": "call_abc", "name": "build"}}
    )
    e = events.read_events(run_id)[0]
    assert e["tool"]["invocation_id"] == "call_abc"
    assert "notes" not in e
