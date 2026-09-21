"""FastAPI 观测服务契约测试（observability §5 消费面）。"""

from __future__ import annotations

import pytest

pytest.importorskip("fastapi")
pytest.importorskip("httpx")

from fastapi.testclient import TestClient  # noqa: E402

from cannagent import events as events_mod  # noqa: E402
from cannagent.runs import create_run  # noqa: E402
from cannagent.server import APP  # noqa: E402
from cannagent.task_schema import TaskYaml  # noqa: E402

TASK = {
    "schema_version": "1.0",
    "task_type": "operator",
    "task_name": "server 探针",
    "operator": {
        "pattern": "Relu",
        "inputs": [{"shape": [1], "dtype": "fp16", "layout": "NCHW"}],
        "outputs": [{"shape": [1], "dtype": "fp16", "layout": "NCHW"}],
    },
    "target": {"gain_pct": 1},
}


@pytest.fixture()
def seeded_run(workspace):
    root = create_run(TaskYaml.model_validate(TASK))
    rid = root.name
    events_mod.append_event(rid, {"kind": "stage_started", "stage": "identify"})
    events_mod.append_event(
        rid, {"kind": "tool_completed", "tool": {"name": "parse_model", "duration_ms": 5}}
    )
    events_mod.append_event(rid, {"kind": "stage_completed", "stage": "identify"})
    events_mod.append_event(rid, {"kind": "stage_started", "stage": "strategy"})
    (root / "strategy" / "STRATEGY.md").write_text("# 策略\n", encoding="utf-8")
    return rid


@pytest.fixture()
def client():
    return TestClient(APP)


def test_health(client, workspace):
    r = client.get("/api/health")
    assert r.status_code == 200 and r.json()["ok"] == "true"


def test_runs_list_and_status(client, seeded_run):
    r = client.get("/api/runs")
    assert r.status_code == 200
    runs = r.json()
    assert any(run["run_id"] == seeded_run and run["status"] == "running" for run in runs)


def test_run_detail_stages_and_artifacts(client, seeded_run):
    r = client.get(f"/api/runs/{seeded_run}")
    assert r.status_code == 200
    detail = r.json()
    assert detail["stages"]["identify"] == "completed"
    assert detail["stages"]["strategy"] == "running"
    assert detail["stages"]["deliver"] == "pending"
    assert any(a["path"] == "strategy/STRATEGY.md" and a["tab"] == "strategy" for a in detail["artifacts"])


def test_events_incremental(client, seeded_run):
    r1 = client.get(f"/api/runs/{seeded_run}/events")
    events = r1.json()["events"]
    assert [e["seq"] for e in events] == [1, 2, 3, 4]
    r2 = client.get(f"/api/runs/{seeded_run}/events", params={"after_seq": 2})
    assert [e["seq"] for e in r2.json()["events"]] == [3, 4]
    assert r2.json()["last_seq"] == 4


def test_artifact_serving_and_traversal_blocked(client, seeded_run):
    r = client.get(f"/api/runs/{seeded_run}/artifacts/strategy/STRATEGY.md")
    assert r.status_code == 200 and "策略" in r.text
    # 穿越被拒（config 层 run_id 校验 + resolve 归属双重防线）
    bad = client.get(f"/api/runs/{seeded_run}/artifacts/../../task.yaml")
    assert bad.status_code in (403, 404)
    bad2 = client.get("/api/runs/..%2F..%2Fetc/artifacts/passwd")
    assert bad2.status_code in (403, 404)


# SSE 端点（/events/stream）不经 TestClient 单测：无限生成器与同步客户端的
# 关闭语义死锁；以真实 uvicorn + curl 冒烟覆盖（见 server README / PR 描述）。


def test_404_unknown_run(client, workspace):
    assert client.get("/api/runs/r20990101-000000-zzzzzzzz").status_code == 404
