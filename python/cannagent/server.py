"""FastAPI 观测服务（C7）——前端唯一数据源的读取面。

契约 = observability.md §5：
- GET /api/runs                                run 列表（含状态推导）
- GET /api/runs/{rid}                          run 详情（task 摘要 + 阶段状态 + 产物索引）
- GET /api/runs/{rid}/events?after_seq=N       增量事件拉取
- GET /api/runs/{rid}/events/stream?after_seq=N SSE tail 推送
- GET /api/runs/{rid}/artifacts/{path}         产物文件（run 目录内，防穿越）

启动：python -m cannagent.server [--host 0.0.0.0] [--port 8300]
OpenAPI：/docs（SPEC §8 契约先行——前端只消费本服务的 OpenAPI）
"""

from __future__ import annotations

import argparse
import asyncio
import json
from collections.abc import AsyncGenerator
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, StreamingResponse

from .config import run_dir, runs_root, workspace_root
from .events import read_events
from .runs import load_task

APP = FastAPI(title="CannAgent 观测服务", version="0.1.0")

STAGES = ["identify", "strategy", "implement", "verify", "bench", "summarize", "deliver"]


def _list_runs() -> list[dict[str, object]]:
    root = runs_root()
    if not root.exists():
        return []
    runs = []
    for d in sorted(root.iterdir(), reverse=True):
        if not d.is_dir() or not (d / "task.yaml").exists():
            continue
        try:
            task = load_task(d)
        except Exception:  # noqa: BLE001 —— 损坏 run 不阻塞列表
            continue
        events = read_events(d.name)
        runs.append(
            {
                "run_id": d.name,
                "task_name": task.task_name,
                "task_type": task.task_type,
                "created": d.name[1:15].replace("-", "T", 1),
                "status": _run_status(events),
                "event_count": len(events),
            }
        )
    return runs


def _run_status(events: list[dict[str, object]]) -> str:
    """阶段状态推导（observability §3：以最后一条 stage_* / degrade 为准）。"""
    for event in reversed(events):
        kind = event.get("kind")
        if kind == "degrade":
            return "degraded"
        if kind in ("stage_started", "stage_completed", "stage_failed"):
            if kind == "stage_completed" and event.get("stage") == "deliver":
                return "completed"
            if kind == "stage_failed":
                return "running"  # 失败分流中（迭代环内），不是终态
            return "running"
    return "pending"


def _stage_statuses(events: list[dict[str, object]]) -> dict[str, str]:
    statuses = {stage: "pending" for stage in STAGES}
    for event in events:
        stage = event.get("stage")
        if not isinstance(stage, str) or stage not in statuses:
            continue
        kind = event.get("kind")
        if kind == "stage_started":
            statuses[stage] = "running"
        elif kind == "stage_completed":
            statuses[stage] = "completed"
        elif kind == "stage_failed":
            statuses[stage] = "failed"
        elif kind == "degrade":
            statuses[stage] = "degraded"
    return statuses


def _artifact_index(rid: str) -> list[dict[str, str]]:
    """run 目录产物索引（相对路径 + 类型猜测）。"""
    root = run_dir(rid)
    skip = {"events.jsonl", "task.yaml"}
    items = []
    for f in sorted(root.rglob("*")):
        rel = f.relative_to(root).as_posix()
        if not f.is_file() or rel in skip:
            continue
        items.append({"path": rel, "tab": _tab_of(rel), "size": str(f.stat().st_size)})
    return items[:500]  # 上限防巨目录


def _tab_of(rel: str) -> str:
    if rel.startswith(("verify/", "bench/")):
        return "accuracy" if rel.startswith("verify/") else "bench"
    if rel.startswith("strategy/"):
        return "strategy"
    if rel.startswith("summarize/") or rel.startswith("experience/"):
        return "experience"
    if rel.startswith("deliver/"):
        return "report" if rel.endswith(".md") else "meta"
    if rel.startswith("implement/"):
        return "diff"
    return "meta"


@APP.get("/api/runs")
def list_runs() -> list[dict[str, object]]:
    return _list_runs()


@APP.get("/api/runs/{rid}")
def run_detail(rid: str) -> dict[str, object]:
    root = _safe_run_dir(rid)
    events = read_events(rid)
    task = load_task(root)
    return {
        "run_id": rid,
        "task": {
            "task_name": task.task_name,
            "task_type": task.task_type,
            "target_gain_pct": task.target.gain_pct,
            "budgets": {"max_wall_min": task.budgets.max_wall_min, "max_tokens": task.budgets.max_tokens},
        },
        "status": _run_status(events),
        "stages": _stage_statuses(events),
        "artifacts": _artifact_index(rid),
        "event_count": len(events),
    }


@APP.get("/api/runs/{rid}/events")
def run_events(rid: str, after_seq: int = 0) -> dict[str, object]:
    _safe_run_dir(rid)
    events = read_events(rid, after_seq=after_seq)
    last = events[-1]["seq"] if events else after_seq
    return {"run_id": rid, "events": events, "last_seq": last}


@APP.get("/api/runs/{rid}/events/stream")
async def run_events_stream(rid: str, after_seq: int = 0) -> StreamingResponse:
    _safe_run_dir(rid)

    async def tail() -> AsyncGenerator[str, None]:
        last = after_seq
        idle = 0.0
        while True:
            chunk = None
            for event in read_events(rid, after_seq=last):
                last = int(event.get("seq", last))
                chunk = f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
                yield chunk
            if chunk is None:
                idle += 1.0
                if idle > 300:  # 5 分钟无事件 → 心跳注释行保持连接
                    idle = 0.0
                    yield ": keepalive\n\n"
                await asyncio.sleep(1.0)
            else:
                idle = 0.0

    return StreamingResponse(tail(), media_type="text/event-stream")


@APP.get("/api/runs/{rid}/artifacts/{file_path:path}")
def artifact(rid: str, file_path: str) -> FileResponse:
    root = _safe_run_dir(rid)
    target = (root / file_path).resolve()
    if not target.is_relative_to(root.resolve()):
        raise HTTPException(status_code=403, detail="path outside run dir")
    if not target.is_file():
        raise HTTPException(status_code=404, detail="artifact not found")
    return FileResponse(target)


@APP.get("/api/health")
def health() -> dict[str, str]:
    return {"ok": "true", "workspace": str(workspace_root())}


def _safe_run_dir(rid: str) -> Path:
    root = run_dir(rid)
    if not (root / "task.yaml").exists():
        raise HTTPException(status_code=404, detail=f"run {rid} not found")
    return root


def main() -> None:
    import uvicorn

    parser = argparse.ArgumentParser(prog="cannagent-server")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8300)
    args = parser.parse_args()
    uvicorn.run(APP, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
