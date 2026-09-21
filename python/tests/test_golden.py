"""golden 回归集（E2，benchmark.md §8）。

层级：
1. identify golden（本地，必跑）：fixture 模型的 op_list / fusion_candidates 与固化值逐字段比对
2. ATC golden（远程，需 CANN_SERVER_* 时才跑）：编译成功 + 生效 pass 名集与固化快照比对
   （effect_times 可能随版本微调——比对 applied 名集合，不比对次数）
3. aclnn 性能 golden（远程）：三份对照真测量——结构硬校验 + p50 漂移软告警（>5% 发 warning，
   性能仅报告不卡点，D10）；物理不变量（融合 gain > 0）硬校验
"""

from __future__ import annotations

import json
import os
import warnings
from pathlib import Path

import pytest

from cannagent.runs import create_run
from cannagent.task_schema import TaskYaml

GOLDEN = Path(__file__).resolve().parents[1] / "tests" / "golden"
FIXTURE_MODEL = GOLDEN / "resblock.onnx"
AFFINE_MODEL = GOLDEN / "affine.onnx"


def _server_configured() -> bool:
    return bool(
        os.environ.get("CANN_SERVER_HOST")
        or (
            (Path(__file__).resolve().parents[2] / ".env").exists()
            and "CANN_SERVER_HOST="
            in (Path(__file__).resolve().parents[2] / ".env").read_text(encoding="utf-8")
        )
    )


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


@pytest.mark.skipif(not _server_configured(), reason="ATC golden 需要昇腾服务器（CANN_SERVER_*）")
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


@pytest.mark.skipif(not _server_configured(), reason="aclnn 性能 golden 需要昇腾服务器（CANN_SERVER_*）")
def test_golden_aclnn_bench(workspace):
    """aclnn 性能 golden：affine 三份对照真测量（benchmark §8）。

    硬校验 = 产物结构与物理不变量（融合必须 > 逐算子基线 gain>0、device 非空、口径一致）；
    软告警 = p50 相对固化值漂移 >5% 发 warning（性能仅报告不卡点，D10）；
    sanity 边界 = p50 落在固化值 [0.2×, 5×] 之外视为环境异常（硬失败）。
    """
    from cannagent.bench import bench_setup, run_bench
    from cannagent.codegen import code_gen
    from cannagent.identify import parse_model
    from cannagent.remote import RemoteError
    from cannagent.strategy import generate
    from cannagent.verify import gen_test, run_test

    root = create_run(
        TaskYaml.model_validate(
            {
                "schema_version": "1.0",
                "task_type": "model",
                "task_name": "golden-aclnn-bench",
                "model": {"path": f"input/{AFFINE_MODEL.name}", "opset": 13, "input_shape": [1024, 1024]},
                "constraints": {"dtype": "fp32"},
                "target": {"gain_pct": 10},
                "baseline": {"impl": "aclnn", "atc": "enabled"},
                "output": {"precision_threshold": 0.005},
            }
        ),
        input_files=[AFFINE_MODEL],
    )
    try:
        parse_model(root.name)
        generate(root.name)
        cg = code_gen(root.name)
        assert cg.get("version"), cg
        version = cg["version"]
        gen_test(root.name, version, seed=20260921, cases=2)
        v = run_test(root.name, version)
        assert v.get("ok"), v
        bench_setup(root.name)
        result = run_bench(root.name, version)
    except RemoteError as exc:
        pytest.skip(f"服务器不可达：{exc}")
    assert result["ok"], f"aclnn bench 回归失败：{result}"

    golden = _load(GOLDEN / "bench" / "affine.aclnn_p50.json")
    reports = {
        kind: _load(root / "bench" / f"bench_v{version[1:]}_{kind}.json")
        for kind in ("baseline", "optimized", "atc")
    }
    # 结构硬校验（workflow §2.1 bench 校验点）
    for kind, rep in reports.items():
        assert rep["device"] == golden["device"], kind
        assert rep["metric"]["warmup"] == golden["metric"]["warmup"], kind
        assert rep["metric"]["iters"] == golden["metric"]["iters"], kind
        assert rep["p50_us"] > 0, kind

    # 物理不变量：单次调用融合必须快于两次算子调用
    assert result["gain_pct"] > 0, f"融合收益非正：{result}"

    # 漂移软告警 + sanity 边界（benchmark §8）
    for kind, key in (("baseline", "baseline_p50_us"), ("optimized", "optimized_p50_us")):
        now, frozen = reports[kind]["p50_us"], golden[key]
        drift = abs(now / frozen - 1) * 100
        lo, hi = golden["sanity_bound"]
        assert lo * frozen <= now <= hi * frozen, (
            f"{kind} p50={now}us 超出固化值 {frozen}us 的 sanity 边界（环境异常？）"
        )
        if drift > golden["drift_warn_pct"]:
            warnings.warn(
                f"aclnn golden 漂移告警：{kind} p50 {frozen}→{now}us（{drift:.1f}%，"
                f"benchmark §8：性能仅报告不卡点，请人工判定环境变化或真回归）",
                stacklevel=2,
            )
