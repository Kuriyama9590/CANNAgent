"""运行配置：workspace 根与 run 目录定位（task-schema.md §2）。

环境变量（C11 白名单透传集）：
- ``CANNAGENT_WORKSPACE``：workspace 根（缺省 ``./workspace``）
- ``CANNAGENT_RUN_ID``：当前 run id（插件注入）
"""

from __future__ import annotations

import os
from pathlib import Path

WORKSPACE_ENV = "CANNAGENT_RUN_ID"
RUN_ID_ENV = "CANNAGENT_RUN_ID"

DEFAULT_WORKSPACE = Path("workspace")


def workspace_root() -> Path:
    """workspace 根（运行时产物，gitignore；task-schema §2）。"""
    root = os.environ.get("CANNAGENT_WORKSPACE")
    return Path(root).resolve() if root else Path.cwd() / DEFAULT_WORKSPACE


def runs_root() -> Path:
    return workspace_root() / "runs"


def run_dir(run_id: str) -> Path:
    """单个 run 的审计现场目录。"""
    if not run_id or "/" in run_id or "\\" in run_id or ".." in run_id:
        raise ValueError(f"illegal run_id: {run_id!r}")
    return runs_root() / run_id


def current_run_id() -> str:
    return os.environ.get(RUN_ID_ENV, "")
