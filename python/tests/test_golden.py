"""golden 回归集（E2 最小版，benchmark.md §8）。

层级：
1. identify golden（本地，必跑）：fixture 模型的 op_list / fusion_candidates 与固化值逐字段比对
2. ATC golden（远程，需 CANN_SERVER_* 时才跑）：编译成功 + 生效 pass 名集与固化快照比对
   （effect_times 可能随版本微调——比对 applied 名集合，不比对次数）

性能 golden（aclnn p50）依赖 bench 域实现，属后续扩展——当前层级先锚定图解析与编译面。
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from cannagent.runs import create_run
from cannagent.task_schema import TaskYaml

GOLDEN = Path(__file__).resolve().parents[1] / "tests" / "golden"
FIXTURE_MODEL = GOLDEN / "resblock.onnx"


def _load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


@pytest.fixture()
def identify_outputs(workspace):
    from cannagent.identify import fusion_scan, parse_model

    root = create_run(
        TaskYaml.model_validate(
            {
                "schema_version": "1.0",
                "task_type": "model",
                "task_name": "golden-probe",
                "model": {"path": f"input/{FIXTURE_MODEL.name}", "opset": 13, "input_shape": [1, 3, 32, 32]},
                "target": {"gain_pct": 1},
            }
        ),
        input_files=[FIXTURE_MODEL],
    )
    parse_model(root.name)
    candidates = fusion_scan(root.name)
    return _load(root / "identify" / "op_list.json"), candidates.model_dump()


def test_golden_op_list(identify_outputs):
    op_list, _ = identify_outputs
    golden = _load(GOLDEN / "identify" / "op_list.json")
    assert [(n["idx"], n["op_type"], n["name"]) for n in op_list["nodes"]] == [
        (n["idx"], n["op_type"], n["name"]) for n in golden["nodes"]
    ]
    assert op_list["stats"]["by_type"] == golden["stats"]["by_type"]
    assert op_list["model"]["opset"] == golden["model"]["opset"]


def test_golden_fusion_candidates(identify_outputs):
    _, candidates = identify_outputs
    golden = _load(GOLDEN / "identify" / "fusion_candidates.json")
    got = [(c["pattern"], c["node_idx"]) for c in candidates["candidates"]]
    want = [(c["pattern"], c["node_idx"]) for c in golden["candidates"]]
    assert got == want


@pytest.mark.skipif(
    not (
        os.environ.get("CANN_SERVER_HOST")
        or (Path(__file__).resolve().parents[2] / ".env").exists()
        and "CANN_SERVER_HOST=" in (Path(__file__).resolve().parents[2] / ".env").read_text(encoding="utf-8")
    ),
    reason="ATC golden 需要昇腾服务器（CANN_SERVER_*）",
)
def test_golden_atc_compile_and_passes(workspace):
    from cannagent.build import build
    from cannagent.remote import RemoteError

    root = create_run(
        TaskYaml.model_validate(
            {
                "schema_version": "1.0",
                "task_type": "model",
                "task_name": "golden-atc",
                "model": {"path": f"input/{FIXTURE_MODEL.name}", "opset": 13, "input_shape": [1, 3, 32, 32]},
                "target": {"gain_pct": 1},
            }
        ),
        input_files=[FIXTURE_MODEL],
    )
    try:
        result = build(root.name)
    except RemoteError as exc:
        pytest.skip(f"服务器不可达：{exc}")
    assert result["ok"], f"ATC 编译回归失败：{result}"

    atc_list = _load(root / "bench" / "atc_opt_list_v1.json")
    golden = _load(GOLDEN / "atc" / "resblock.atc_opt_list.json")
    applied_now = {p["name"] for p in atc_list["passes"] if p["applied"]}
    applied_golden = {p["name"] for p in golden["passes"] if p["applied"]}
    # 漂移告警语义（benchmark §8：性能仅报告不卡点；编译面 pass 集合变化 = 需人工判定）
    assert applied_now == applied_golden, (
        f"ATC 生效 pass 集漂移：新增 {applied_now - applied_golden} / 消失 {applied_golden - applied_now}"
    )
