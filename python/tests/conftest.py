"""pytest 公共夹具：workspace 隔离到 tmp。"""

from __future__ import annotations

from pathlib import Path

import pytest


@pytest.fixture()
def workspace(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    ws = tmp_path / "ws"
    ws.mkdir()
    monkeypatch.setenv("CANNAGENT_WORKSPACE", str(ws))
    return ws


@pytest.fixture()
def run_id(workspace: Path) -> str:
    rid = "r20260920-120000-abc12345"
    (workspace / "runs" / rid).mkdir(parents=True)
    return rid
