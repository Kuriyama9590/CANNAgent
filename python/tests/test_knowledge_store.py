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
