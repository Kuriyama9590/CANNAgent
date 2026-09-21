"""七阶段域离线单测：strategy / codegen / verify（生成与统计）/ bench（统计/门限/D4）
/ deliver（包+自检）/ manifest。远程链路（run_test / run_bench / bench_setup）走
test_golden.py 的真实验证（需 CANN_SERVER_*）。"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from cannagent.runs import create_run
from cannagent.task_schema import TaskYaml


def _task(dtype: str = "fp32", exclude: list[str] | None = None, atc: str = "enabled") -> TaskYaml:
    return TaskYaml.model_validate(
        {
            "schema_version": "1.0",
            "task_type": "model",
            "task_name": "域单测",
            "model": {"path": "input/affine.onnx", "opset": 13, "input_shape": [64, 64]},
            "constraints": {"dtype": dtype, "exclude_ops": exclude or []},
            "target": {"gain_pct": 10},
            "baseline": {"atc": atc},
        }
    )


@pytest.fixture()
def rid(workspace: Path) -> str:
    root = create_run(_task())
    (root / "identify").mkdir(exist_ok=True)
    (root / "identify" / "op_list.json").write_text(
        json.dumps(
            {
                "schema_version": "1.0",
                "model": {"format": "onnx", "opset": 13, "input_shape": [64, 64]},
                "nodes": [
                    {"idx": 0, "op_type": "Mul", "name": "m0"},
                    {"idx": 1, "op_type": "Add", "name": "a0"},
                ],
                "stats": {"by_type": {"Mul": 1, "Add": 1}, "total_nodes": 2},
            }
        ),
        encoding="utf-8",
    )
    (root / "identify" / "fusion_candidates.json").write_text(
        json.dumps(
            {
                "schema_version": "1.0",
                "candidates": [
                    {
                        "id": "F001",
                        "pattern": "Mul+Add",
                        "node_idx": [0, 1],
                        "est_gain_pct": 0.0,
                        "status": "pending",
                    },
                ],
            }
        ),
        encoding="utf-8",
    )
    return root.name


# ---- strategy ----


def test_strategy_generate_selects_and_writes_back(rid: str, workspace: Path):
    from cannagent.strategy import generate

    out = generate(rid)
    strat = out["strategy"]
    assert strat["selected"] == ["F001"]
    assert strat["tasks"][0]["op_task_id"] == "T-F001"
    assert strat["tasks"][0]["approach"].startswith("aclnn 标量仿射融合")
    assert strat["tasks"][0]["target_gain_pct"] > 0

    root = workspace / "runs" / rid
    assert (root / "strategy" / "strategy.json").exists()
    doc = (root / "strategy" / "STRATEGY.md").read_text(encoding="utf-8")
    for section in ("候选评估", "排序理由", "风险与回退"):
        assert section in doc
    # 候选状态回写（identify 契约）
    candidates = json.loads((root / "identify" / "fusion_candidates.json").read_text(encoding="utf-8"))[
        "candidates"
    ]
    assert candidates[0]["status"] == "selected"
    assert candidates[0]["est_gain_pct"] > 0


def test_strategy_excluded_candidate_rejected(workspace: Path):
    root = create_run(_task(exclude=["Mul"]))
    (root / "identify").mkdir(exist_ok=True)
    (root / "identify" / "op_list.json").write_text(
        json.dumps({"schema_version": "1.0", "model": {}, "nodes": [], "stats": {}}),
        encoding="utf-8",
    )
    (root / "identify" / "fusion_candidates.json").write_text(
        json.dumps(
            {
                "schema_version": "1.0",
                "candidates": [
                    {
                        "id": "F001",
                        "pattern": "Mul+Add",
                        "node_idx": [0, 1],
                        "est_gain_pct": 0.0,
                        "status": "pending",
                    },
                ],
            }
        ),
        encoding="utf-8",
    )
    from cannagent.strategy import generate

    strat = generate(root.name)["strategy"]
    assert strat["selected"] == []
    assert "exclude_ops" in strat["rejected"][0]["reason"]


# ---- codegen ----


def test_codegen_renders_affine_snapshot(rid: str, workspace: Path):
    from cannagent.strategy import generate

    generate(rid)
    from cannagent.codegen import code_gen

    out = code_gen(rid)
    assert out["version"] == "v1"
    root = workspace / "runs" / rid / "implement" / "v1"
    assert (root / "operator" / "affine_impl.cpp").exists()
    assert (root / "operator" / "om_bench.cpp").exists()
    sh = (root / "build.sh").read_text(encoding="utf-8")
    assert "-DM=64 -DN=64" in sh and "-lascendcl -lopapi" in sh
    params = json.loads((root / "params.json").read_text(encoding="utf-8"))
    assert params["shape"] == [64, 64] and params["candidate_id"] == "F001"


def test_codegen_unsupported_approach(workspace: Path):
    root = create_run(_task())
    (root / "identify").mkdir(exist_ok=True)
    (root / "identify" / "op_list.json").write_text(
        json.dumps({"schema_version": "1.0", "model": {}, "nodes": [], "stats": {}}),
        encoding="utf-8",
    )
    (root / "identify" / "fusion_candidates.json").write_text(
        json.dumps(
            {
                "schema_version": "1.0",
                "candidates": [
                    {
                        "id": "F001",
                        "pattern": "Conv+BN",
                        "node_idx": [0, 1],
                        "est_gain_pct": 0.0,
                        "status": "pending",
                    },
                ],
            }
        ),
        encoding="utf-8",
    )
    from cannagent.codegen import code_gen
    from cannagent.strategy import generate

    generate(root.name)
    out = code_gen(root.name)
    assert out["ok"] is False and out["code"] == "CANN_E_APPROACH_UNSUPPORTED"


def test_patch_code_inherits_and_overrides(rid: str, workspace: Path):
    from cannagent.codegen import code_gen, patch_code
    from cannagent.strategy import generate

    generate(rid)
    code_gen(rid)
    out = patch_code(rid, file="operator/note.md", content="v2 修复：调整编译级别")
    assert out["version"] == "v2" and out["base"] == "v1"
    root = workspace / "runs" / rid / "implement"
    assert (root / "v2" / "operator" / "affine_impl.cpp").exists()  # 继承
    assert (root / "v2" / "operator" / "note.md").read_text(encoding="utf-8").startswith("v2")


def test_analyze_error_classification(rid: str, workspace: Path):
    from cannagent.codegen import analyze_error

    root = workspace / "runs" / rid / "implement" / "v1"
    root.mkdir(parents=True)
    (root / "build.log").write_text(
        "g++ -O2 ...\n/usr/bin/ld: operator/affine_impl.cpp:(text+0x10): "
        "undefined reference to `aclnnAdd'\ncollect2: error: ld returned 1 exit status\n",
        encoding="utf-8",
    )
    analysis = analyze_error(rid)
    assert analysis["class"] == "code_level" and analysis["target"] == "implement"

    (root / "build.log").write_text("ERROR: op type Mul is not support on this soc\n", encoding="utf-8")
    assert analyze_error(rid)["class"] == "route_infeasible"


# ---- verify（生成/组装） ----


def test_gen_test_deterministic(rid: str, workspace: Path):
    from cannagent.codegen import code_gen
    from cannagent.strategy import generate
    from cannagent.verify import gen_test

    generate(rid)
    code_gen(rid)
    gen_test(rid, "v1", seed=42, cases=4)
    case_dir = workspace / "runs" / rid / "verify" / "cases_v1"
    digest1 = hashlib.sha256((case_dir / "case_000" / "a.bin").read_bytes()).hexdigest()
    s1 = (case_dir / "case_000" / "s.txt").read_text(encoding="utf-8")
    # 幂等：同 seed 重建逐字节一致
    gen_test(rid, "v1", seed=42, cases=4)
    digest2 = hashlib.sha256((case_dir / "case_000" / "a.bin").read_bytes()).hexdigest()
    assert digest1 == digest2 and s1 == (case_dir / "case_000" / "s.txt").read_text(encoding="utf-8")


def test_verify_assemble_builds_report(rid: str, workspace: Path):
    from cannagent.verify import _assemble

    raw = json.dumps(
        {
            "cases": [
                {"case_id": "case_000", "max_rel_err": 2e-4, "pass": True},
                {"case_id": "case_001", "max_rel_err": 3e-2, "pass": False},
            ]
        }
    )
    report = _assemble(workspace / "runs" / rid, "v1", raw, threshold=1e-3, seed=7)
    assert report.total == 2 and report.passed == 1
    assert len(report.failures) == 1 and report.failures[0]["case_id"] == "case_001"
    assert not report.passed_threshold
    saved = json.loads((workspace / "runs" / rid / "verify" / "accuracy_v1.json").read_text(encoding="utf-8"))
    assert saved["seed"] == 7


# ---- bench（统计/门限/D4） ----


def test_bench_stats_outlier_and_percentile():
    from cannagent.bench import _stats

    body = "\n".join(f"{i},100" for i in range(100))
    csv = "iter,us\n" + body + "\n50,10000\n"  # 1 个 100×p50 异常值
    stats = _stats(csv)
    assert stats.p50 == 100.0 and stats.removed == 1 and stats.total == 101
    # 线性插值：101 个值去掉 1 个后 100 个
    csv2 = "iter,us\n" + "\n".join(f"{i},{v}" for i, v in enumerate([10, 20, 30, 40])) + "\n"
    assert _stats(csv2).p50 == 25.0


def test_bench_stats_rejects_high_outlier_ratio():
    from cannagent.bench import _stats

    rows = [100] * 90 + [10000] * 10  # 10% 超限 → 组作废（§6）
    csv = "iter,us\n" + "\n".join(f"{i},{v}" for i, v in enumerate(rows)) + "\n"
    with pytest.raises(ValueError, match="作废"):
        _stats(csv)


def test_bench_accuracy_gate(rid: str, workspace: Path):
    from cannagent.bench import _gate_accuracy

    vdir = workspace / "runs" / rid / "verify"
    vdir.mkdir(parents=True, exist_ok=True)
    (vdir / "accuracy_v1.json").write_text(
        json.dumps({"max_rel_err": 5e-2, "threshold": 1e-3, "failures": [{"case_id": "c"}]}),
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="D10"):
        _gate_accuracy(workspace / "runs" / rid, "v1")
    (vdir / "accuracy_v1.json").write_text(
        json.dumps({"max_rel_err": 1e-4, "threshold": 1e-3, "failures": []}), encoding="utf-8"
    )
    _gate_accuracy(workspace / "runs" / rid, "v1")  # 达标不抛


def _bench_report(p50: float) -> object:
    from cannagent.task_schema import BenchReport

    return BenchReport(version="v1", impl="aclnn", metric={}, p50_us=p50, device="Ascend910B", note="")


def test_d4_validity_covered_and_not_covered(rid: str, workspace: Path):
    from cannagent.bench import _d4_validity

    root = workspace / "runs" / rid
    (root / "strategy").mkdir(exist_ok=True)
    (root / "strategy" / "strategy.json").write_text(
        json.dumps(
            {
                "schema_version": "1.0",
                "selected": ["F001"],
                "tasks": [
                    {
                        "op_task_id": "T-F001",
                        "candidate_id": "F001",
                        "approach": "aclnn 标量仿射融合（Mul+Add）",
                        "target_gain_pct": 10,
                        "risk": "low",
                        "order": 1,
                    }
                ],
                "rejected": [],
            }
        ),
        encoding="utf-8",
    )
    (root / "bench").mkdir(exist_ok=True)
    # 未覆盖：无 atc_opt_list → not_covered 分支
    validity = _d4_validity(
        root, "v1", {"optimized": _bench_report(100), "atc": _bench_report(80)}, gain_ok=True
    )
    assert validity["entries"][0]["atc_coverage"] == "not_covered" and validity["valid"]

    # 已覆盖（pass 名同时含 mul/add）且未强于 ATC → 无效
    (root / "bench" / "atc_opt_list_v1.json").write_text(
        json.dumps(
            {
                "schema_version": "1.0",
                "version": "v1",
                "source": "t",
                "passes": [{"name": "MulAddFusionPass", "scope": "node:0,1", "applied": True}],
            }
        ),
        encoding="utf-8",
    )
    validity = _d4_validity(
        root, "v1", {"optimized": _bench_report(90), "atc": _bench_report(80)}, gain_ok=True
    )
    entry = validity["entries"][0]
    assert entry["atc_coverage"] == "covered" and entry["valid"] is False
    # 强于 ATC → 有效
    validity = _d4_validity(
        root, "v1", {"optimized": _bench_report(70), "atc": _bench_report(80)}, gain_ok=True
    )
    assert validity["entries"][0]["valid"] is True


# ---- deliver ----


@pytest.fixture()
def delivered(rid: str, workspace: Path) -> Path:
    """预置全产物现场（strategy/implement/verify/bench），供 deliver 测试。"""
    root = workspace / "runs" / rid
    from cannagent.codegen import code_gen
    from cannagent.strategy import generate
    from cannagent.verify import _assemble

    generate(rid)
    code_gen(rid)
    (root / "implement" / "v1" / "build.log").write_text("BUILD_OK\n", encoding="utf-8")
    raw = json.dumps({"cases": [{"case_id": "case_000", "max_rel_err": 1e-4, "pass": True}]})
    _assemble(root, "v1", raw, threshold=1e-3, seed=7)
    from cannagent.verify import gen_test

    gen_test(rid, "v1", seed=7, cases=1)
    (root / "bench").mkdir(exist_ok=True)
    (root / "bench" / "env.json").write_text(
        json.dumps({"device": "Ascend910B", "cann": "cann-9.0.0"}), encoding="utf-8"
    )
    for kind, p50 in (("baseline", 200.0), ("optimized", 120.0), ("atc", 180.0)):
        (root / "bench" / f"bench_v1_{kind}.json").write_text(
            json.dumps(
                {
                    "schema_version": "1.0",
                    "version": "v1",
                    "impl": "aclnn",
                    "metric": {"warmup": 20, "iters": 100},
                    "p50_us": p50,
                    "p99_us": p50 * 1.2,
                    "mean_us": p50,
                    "device": "Ascend910B",
                    "note": kind,
                }
            ),
            encoding="utf-8",
        )
    (root / "bench" / "gain_v1.json").write_text(
        json.dumps(
            {
                "schema_version": "1.0",
                "version": "v1",
                "gain_pct": 40.0,
                "target_gain_pct": 10,
                "epsilon": 0,
                "gain_ok": True,
                "p50_baseline_us": 200.0,
                "p50_optimized_us": 120.0,
            }
        ),
        encoding="utf-8",
    )
    (root / "bench" / "validity_v1.json").write_text(
        json.dumps(
            {
                "schema_version": "1.0",
                "version": "v1",
                "rule": "＞ATC 或 ATC 未覆盖（D4）",
                "entries": [
                    {
                        "candidate_id": "F001",
                        "atc_coverage": "not_covered",
                        "valid": True,
                        "reason": "覆盖空白",
                    }
                ],
                "valid": True,
            }
        ),
        encoding="utf-8",
    )
    return root


def test_deliver_report_and_package(delivered: Path):
    from cannagent.deliver import check, package

    report = package(delivered.name)
    out = delivered / "deliver"
    # 四件套
    for rel in (
        "code/build.sh",
        "code/affine_impl.cpp",
        "tests/cases/index.txt",
        "STRATEGY.md",
        "REPORT.md",
        "run.sh",
        "bench.sh",
        "manifest.json",
    ):
        assert (out / rel).exists(), rel
    md = (out / "REPORT.md").read_text(encoding="utf-8")
    for section in ("任务信息", "精度结论", "性能对比", "ATC 优化清单", "复现步骤"):
        assert section in md
    assert report["manifest"]["final_version"] == "v1"
    assert report["manifest"]["gain_pct"] == 40.0
    assert check(delivered.name)["ok"] is True


def test_deliver_check_detects_tamper(delivered: Path):
    from cannagent.deliver import check, package

    package(delivered.name)
    report_path = delivered / "deliver" / "REPORT.md"
    report_path.write_text(report_path.read_text(encoding="utf-8") + "\n篡改\n", encoding="utf-8")
    result = check(delivered.name)
    assert result["ok"] is False and result["code"] == "CANN_E_CHECKSUM"


# ---- manifest ----


def test_manifest_build_and_render(delivered: Path):
    from cannagent.manifest import build, render

    m = build(delivered.name, wall_elapsed_min=30.0)
    assert m["trend"][0]["version"] == "v1" and m["trend"][0]["gain_pct"] == 40.0
    assert m["budget"]["wall_remaining_min"] == 60.0
    assert m["stagnation"] is False
    md = render(m)
    assert "趋势表" in md and "v1" in md and "已试路线" in md
