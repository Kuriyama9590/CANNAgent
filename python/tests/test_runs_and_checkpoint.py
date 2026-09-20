"""run 目录与检查点（task-schema §2 / workflow §5）。"""

from __future__ import annotations

from cannagent import checkpoint as cp
from cannagent.runs import create_run, load_task, new_run_id, valid_run_id
from cannagent.task_schema import TaskYaml

TASK = {
    "schema_version": "1.0",
    "task_type": "operator",
    "task_name": "Conv3x3 融合",
    "operator": {
        "pattern": "Conv3x3 + BN + ReLU",
        "inputs": [{"shape": [32, 64, 32, 32], "dtype": "fp16", "layout": "NCHW"}],
        "outputs": [{"shape": [32, 64, 32, 32], "dtype": "fp16", "layout": "NCHW"}],
        "attrs": {"kernel": [3, 3]},
    },
    "target": {"gain_pct": 8},
}


def test_create_run_layout_and_roundtrip(workspace):
    root = create_run(TaskYaml.model_validate(TASK))
    rid = root.name
    assert valid_run_id(rid)
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
        assert (root / sub).is_dir(), sub
    # task.yaml 副本含默认值回填（缺省 budgets/baseline 写盘）
    task = load_task(root)
    assert task.budgets.max_wall_min == 90
    assert task.baseline.impl == "aclnn"


def test_run_id_format():
    rid = new_run_id("resnet50 优化")
    assert rid.startswith("r20") and len(rid.split("-")) == 3
    assert valid_run_id(rid)


def test_checkpoint_write_read_and_idempotent(workspace, run_id):
    state = {"stage": "implement", "iter": "v2", "budget_left_min": 43.5}
    p1 = cp.write_checkpoint(run_id, "implement", "v2", state)
    assert cp.read_checkpoint(run_id, "implement", "v2") == state
    # 同键重写 = 覆盖（幂等）
    state2 = {**state, "budget_left_min": 40.0}
    p2 = cp.write_checkpoint(run_id, "implement", "v2", state2)
    assert p1 == p2
    assert cp.read_checkpoint(run_id, "implement", "v2") == state2


def test_latest_checkpoint_picks_newest_and_skips_corrupt(workspace, run_id):
    cp.write_checkpoint(run_id, "verify", "v1", {"stage": "verify"})
    (cp.cp_path(run_id, "identify", "v0").parent / "cp-broken-x.json").write_text("{not json")
    latest = cp.latest_checkpoint(run_id)
    assert latest is not None and latest["stage"] == "verify"
