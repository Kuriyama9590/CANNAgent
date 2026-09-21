"""知识库最小实现测试（rag.md §2/§3/§6/§8）。"""

from __future__ import annotations

import pytest

from cannagent.knowledge_store import HashEmbedder, KnowledgeStore
from cannagent.task_schema import ExperienceEntry, ExperienceOutcome


def make_entry(eid: str = "exp-20260920-a1b2c3d4", **over) -> ExperienceEntry:
    base = dict(
        id=eid,
        run_id="r-test",
        created_at="2026-09-20T12:00:00+08:00",
        problem="Conv+BN+ReLU 融合 910B fp16",
        context={"dtype": "fp16", "device": "Ascend910B"},
        solution="AscendC 三算子融合 kernel",
        outcome=ExperienceOutcome(status="success", gain_pct=6.2),
        reuse_when="910B fp16 NCHW Conv 链",
        status="approved",
        source="manual",
    )
    base.update(over)
    return ExperienceEntry.model_validate(base)


@pytest.fixture()
def store(tmp_path):
    s = KnowledgeStore(db_path=tmp_path / "k.db", embedder=HashEmbedder())
    yield s
    s.close()


def test_upsert_and_retrieve_approved(store):
    store.upsert(make_entry())
    hits = store.retrieve("Conv BN ReLU 融合")
    assert len(hits) == 1
    assert hits[0]["ref"] == "rag://exp-20260920-a1b2c3d4"
    assert hits[0]["payload"]["problem"].startswith("Conv")


def test_draft_excluded_by_default(store):
    store.upsert(make_entry(status="draft"))
    assert store.retrieve("Conv 融合") == []
    assert store.retrieve("Conv 融合", include_drafts=True)


def test_context_filter(store):
    store.upsert(make_entry())
    assert store.retrieve("Conv 融合", filter={"dtype": "fp16"})
    assert store.retrieve("Conv 融合", filter={"dtype": "bf16"}) == []


def test_governance_lifecycle(store):
    store.upsert(make_entry(eid="exp-20260920-00000001"))
    assert store.set_status("exp-20260920-00000001", "rejected")
    assert store.retrieve("Conv") == []  # rejected 不进默认检索
    assert store.delete("exp-20260920-00000001")
    assert not store.delete("exp-20260920-00000001")


def test_sanitize_before_embed(workspace):
    """rag.md §8：密钥先脱敏再入库（检索面不可见）。"""
    from cannagent.knowledge_store import KnowledgeStore as KS

    s = KS(db_path=workspace / "knowledge" / "k2.db", embedder=HashEmbedder())
    try:
        entry = make_entry(eid="exp-20260920-00000002", solution="key=sk-secret123 then build")
        s.upsert(entry)
        payload = s.list()[0]
        assert "sk-secret123" not in str(payload)
    finally:
        s.close()


def test_retrieve_via_cli_roundtrip(workspace):
    """CLI 链路：add（manual/approved）→ retrieve 命中。"""
    import json
    import os
    import subprocess
    import sys

    env = {**os.environ, "CANNAGENT_WORKSPACE": str(workspace)}
    add_payload = {
        "op": "add",
        "problem": "MatMul+Add 融合 910B",
        "context": {"dtype": "fp16", "device": "Ascend910B"},
        "solution": "融合 kernel",
        "outcome": {"status": "success", "gain_pct": 4.0},
        "reuse_when": "MatMul Add 链",
    }
    p1 = subprocess.run(
        [sys.executable, "-m", "cannagent", "knowledge"],
        input=json.dumps(add_payload),
        capture_output=True,
        text=True,
        env=env,
        timeout=60,
    )
    assert p1.returncode == 0, p1.stderr
    added = json.loads(p1.stdout)
    assert added["status"] == "approved"

    p2 = subprocess.run(
        [sys.executable, "-m", "cannagent", "knowledge"],
        input=json.dumps({"op": "retrieve", "query": "MatMul Add 融合"}),
        capture_output=True,
        text=True,
        env=env,
        timeout=60,
    )
    results = json.loads(p2.stdout)["results"]
    assert len(results) == 1
    assert results[0]["payload"]["problem"].startswith("MatMul")


def test_show_and_edit_governance(store):
    store.upsert(make_entry(eid="exp-20260920-00000003"))
    # show：默认检索面（approved）可见
    hits = store.retrieve("Conv")
    assert hits and hits[0]["ref"] == "rag://exp-20260920-00000003"
    # edit 经 CLI 层（op_edit）覆盖字段并重校验——这里验证底层 upsert 幂等覆盖
    revised = make_entry(eid="exp-20260920-00000003", solution="修订后的方案")
    store.upsert(revised)
    payload = store.list(include_all=True)[0]
    assert payload["solution"] == "修订后的方案"


def test_edit_via_cli_roundtrip(workspace):
    """op_edit：取条目 → 覆盖 → 重新校验入库；非法编辑被 schema 拒绝。"""
    import json
    import os
    import subprocess
    import sys

    env = {**os.environ, "CANNAGENT_WORKSPACE": str(workspace)}
    add = {
        "op": "add",
        "problem": "GELU 融合",
        "context": {"dtype": "fp16", "device": "Ascend910B"},
        "solution": "v1 方案",
        "outcome": {"status": "success", "gain_pct": 3.0},
        "reuse_when": "GELU 场景",
    }
    p1 = subprocess.run(
        [sys.executable, "-m", "cannagent", "knowledge"],
        input=json.dumps(add),
        capture_output=True,
        text=True,
        env=env,
        timeout=60,
    )
    eid = json.loads(p1.stdout)["id"]

    edit = {"op": "edit", "id": eid, "solution": "v2 修订"}
    p2 = subprocess.run(
        [sys.executable, "-m", "cannagent", "knowledge"],
        input=json.dumps(edit),
        capture_output=True,
        text=True,
        env=env,
        timeout=60,
    )
    assert p2.returncode == 0

    show = {"op": "show", "id": eid}
    p3 = subprocess.run(
        [sys.executable, "-m", "cannagent", "knowledge"],
        input=json.dumps(show),
        capture_output=True,
        text=True,
        env=env,
        timeout=60,
    )
    entry = json.loads(p3.stdout)["entry"]
    assert entry["solution"] == "v2 修订"

    bad_edit = {"op": "edit", "id": eid, "context": {"dtype": "fp16"}}  # 缺 device → schema 拒
    p4 = subprocess.run(
        [sys.executable, "-m", "cannagent", "knowledge"],
        input=json.dumps(bad_edit),
        capture_output=True,
        text=True,
        env=env,
        timeout=60,
    )
    out4 = json.loads(p4.stdout)
    assert out4["ok"] is False and "schema" in out4["message"]
