"""run 目录生命周期（task-schema.md §2：目录即审计现场）。"""

from __future__ import annotations

import hashlib
import re
import shutil
from datetime import datetime
from pathlib import Path

import yaml

from .task_schema import TaskYaml

RUN_ID_RE = re.compile(r"^r\d{8}-\d{6}-[0-9a-z]{8}$")


def slugify(name: str) -> str:
    """task_name → 8 位 slug（拼音缺失场景退化为哈希前 8 位）。"""
    digest = hashlib.sha256(name.encode("utf-8")).hexdigest()[:8]
    return digest


def new_run_id(task_name: str, now: datetime | None = None) -> str:
    now = now or datetime.now()
    return f"r{now.strftime('%Y%m%d-%H%M%S')}-{slugify(task_name)}"


def create_run(task: TaskYaml, *, input_files: list[Path] | None = None) -> Path:
    """创建 run 目录骨架 + task.yaml 副本（含默认值回填）+ input/ 只读拷贝。"""
    rid = new_run_id(task.task_name)
    root = _runs_root() / rid
    root.mkdir(parents=True, exist_ok=False)
    for sub in (
        "input",
        "identify",
        "strategy",
        "implement",
        "verify",
        "bench",
        "summarize",
        "deliver",
        "experience",
        "checkpoints",
    ):
        (root / sub).mkdir()
    (root / "task.yaml").write_text(
        yaml.safe_dump(
            yaml.safe_load(task.model_dump_json(exclude_none=True)), allow_unicode=True, sort_keys=False
        ),
        encoding="utf-8",
    )
    for src in input_files or []:
        dst = root / "input" / src.name
        shutil.copy2(src, dst)
        dst.chmod(0o444)  # input/ 只读
    return root


def load_task(run_path: Path) -> TaskYaml:
    """加载并校验 task.yaml（校验失败直接抛 pydantic 错误——CLI 层转结构化输出）。"""
    data = yaml.safe_load((run_path / "task.yaml").read_text(encoding="utf-8"))
    return TaskYaml.model_validate(data)


def valid_run_id(rid: str) -> bool:
    return bool(RUN_ID_RE.match(rid))


def _runs_root() -> Path:
    from .config import runs_root

    return runs_root()
