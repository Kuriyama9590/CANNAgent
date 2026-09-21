"""bench 阶段：环境指纹 / 三份对照测量 / gain 与 D4 有效性（workflow §2.1 bench 契约）。

口径（benchmark.md §4-§6）：
- 三份对照同包同卡完成：baseline（官方 aclnn 逐算子直调）/ optimized（本迭代实现）/
  atc（ATC 编译整图，om_bench 执行——baseline.atc=enabled 时）
- 统计本地计算（可离线单测）：逐迭代原始延迟 → 异常值剔除（>10×p50）→ p50/p99/mean
- gain 判定唯一口径 = p50；ε 噪声容差默认 0（task.baseline.metric.epsilon）
- p50 差异 < 3% 时自动追加一组复测（仅报告，不改变判定）
- D4 有效性：优化点与 ATC 优化清单 overlap 命中 → 须 optimized.p50 < atc.p50；未覆盖 → 有效

精度硬卡点（D10）：未过 accuracy 阈值的版本禁止进入 bench。
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .config import run_dir
from .task_schema import AtcOptList, AtcPass, BaselineMetric, BenchReport

SOC_VERSION = "Ascend910B"


def bench_setup(rid: str) -> dict[str, Any]:
    """环境指纹（benchmark §2）：device/工具链/占用快照 → bench/env.json。"""
    from .remote import RemoteRunner, npu_idle_check

    info = npu_idle_check(RemoteRunner())
    device = info.get("device") or SOC_VERSION
    payload = {
        "schema_version": "1.0",
        "device": device,
        "cann": info.get("cann", ""),
        "npu_processes": info.get("npu_processes", False),
        "note": "npu-smi + version.info 快照（测量前必采；降频/占用该组作废）",
        "raw": (info.get("raw", "") or "")[:4000],
    }
    root = run_dir(rid)
    (root / "bench").mkdir(exist_ok=True)
    (root / "bench" / "env.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2),
                                              encoding="utf-8")
    return {"env": payload}


def run_bench(rid: str, version: str) -> dict[str, Any]:
    """三份对照测量（真实现）：任务包编译+测量 → 本地统计 → 三份 bench json + gain + D4 判定。"""
    root = run_dir(rid)
    task = _load_task(root)
    _gate_accuracy(root, version)

    imp = root / "implement" / version
    if not (imp / "build.sh").exists():
        raise FileNotFoundError(f"实现快照缺失：implement/{version}")
    metric = task.baseline.metric
    env = _load_json(root / "bench" / "env.json") if (root / "bench" / "env.json").exists() else {}
    device = env.get("device") or SOC_VERSION
    atc_enabled = task.baseline.atc == "enabled"

    files: dict[str, bytes] = {}
    for p in imp.rglob("*"):
        if p.is_file():
            files[str(p.relative_to(imp).as_posix())] = p.read_bytes()
    expect = ["lat_ref.csv", "lat_opt.csv"]
    command = (
        "bash build.sh && "
        f"./artifacts/affine_impl bench ref --warmup {metric.warmup} --iters {metric.iters} "
        "--csv ../out/lat_ref.csv && "
        f"./artifacts/affine_impl bench opt --warmup {metric.warmup} --iters {metric.iters} "
        "--csv ../out/lat_opt.csv"
    )
    if atc_enabled:
        onnx_name = _stage_model(root, files)
        xbin = _make_atc_input(root, version)
        files["x_atc.bin"] = xbin
        expect += ["lat_atc.csv", "fusion_result.json"]
        command += (
            f" && atc --framework=5 --model={onnx_name} --soc_version={SOC_VERSION} "
            f"--output=./atc_graph --log=info; "
            f"rc=$?; cp -f fusion_result.json ../out/ 2>/dev/null; "
            f"[ $rc -eq 0 ] && ./artifacts/om_bench --om atc_graph.om --input x_atc.bin "
            f"--warmup {metric.warmup} --iters {metric.iters} --csv ../out/lat_atc.csv || "
            f"(echo ATC_LEG_FAILED; exit 1)"
        )

    from .remote import RemoteRunner

    result = RemoteRunner().run_package(
        package=f"{rid}-bench-{version}", files=files, command=command,
        expect_outputs=expect, timeout=1200,
    )
    (root / "bench" / f"exec_v{version}.log").write_text(result["log"], encoding="utf-8")
    if not result["ok"]:
        return {
            "ok": False,
            "code": "CANN_E_BENCH_EXEC",
            "message": "bench 任务包失败（编译/执行/atc 任一环节错误）",
            "hint": f"详见 bench/exec_v{version}.log",
        }

    ref = _stats(result["outputs"]["lat_ref.csv"].decode())
    opt = _stats(result["outputs"]["lat_opt.csv"].decode())
    atc = _stats(result["outputs"]["lat_atc.csv"].decode()) if atc_enabled else None

    # 噪声疑似区间复测（benchmark §6：仅报告）
    note_tail = ""
    if abs(ref.p50 - opt.p50) / ref.p50 < 0.03:
        second = _rerun_pair(rid, version, metric)
        if second is not None:
            ref2, opt2 = second
            note_tail = f"；噪声疑似区间已复测：p50₂ base={ref2.p50:.1f}us opt={opt2.p50:.1f}us"

    base_note = "官方 aclnn 逐算子直调（aclnnMul + aclnnAdd）"
    opt_note = "aclnnAdd(alpha=s) 单次调用（标量仿射融合）"
    if note_tail:
        base_note += note_tail
        opt_note += note_tail

    reports: dict[str, BenchReport] = {}
    base_report = _report(task.baseline.impl, metric, ref, device, base_note)
    opt_report = _report(task.baseline.impl, metric, opt, device, opt_note)
    _write_report(root, version, "baseline", base_report)
    _write_report(root, version, "optimized", opt_report)
    reports = {"baseline": base_report, "optimized": opt_report}
    if atc is not None:
        atc_report = _report(
            task.baseline.impl, metric, atc, device,
            "ATC 编译整图（om_bench，aclmdlExecute）——D4 门槛对照",
        )
        _write_report(root, version, "atc", atc_report)
        reports["atc"] = atc_report
        _write_atc_list(root, version, result["outputs"].get("fusion_result.json", b""))

    gain = (reports["baseline"].p50_us - reports["optimized"].p50_us) / reports["baseline"].p50_us * 100
    gain_ok = gain >= task.target.gain_pct + metric.epsilon
    (root / "bench" / f"gain_v{_vnum(version)}.json").write_text(
        json.dumps(
            {
                "schema_version": "1.0",
                "version": version,
                "gain_pct": round(gain, 3),
                "target_gain_pct": task.target.gain_pct,
                "epsilon": metric.epsilon,
                "gain_ok": gain_ok,
                "p50_baseline_us": reports["baseline"].p50_us,
                "p50_optimized_us": reports["optimized"].p50_us,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )

    validity = _d4_validity(root, version, reports, gain_ok)
    return {
        "ok": True,
        "version": version,
        "gain_pct": round(gain, 3),
        "gain_ok": gain_ok,
        "p50": {k: v.p50_us for k, v in reports.items()},
        "validity": validity,
    }


# ---- 统计（纯函数，离线可测） ----


class _Stats:
    def __init__(self, p50: float, p99: float, mean: float, removed: int, total: int) -> None:
        self.p50 = p50
        self.p99 = p99
        self.mean = mean
        self.removed = removed
        self.total = total


def _stats(csv_text: str) -> _Stats:
    """lat CSV → 异常值剔除 + 分位数（线性插值；§6：剔除率 >5% 视为不稳定）。"""
    values: list[float] = []
    for line in csv_text.splitlines()[1:]:  # 跳过表头 iter,us
        parts = line.split(",")
        if len(parts) == 2:
            values.append(float(parts[1]))
    if not values:
        raise ValueError("空延迟 CSV")

    def percentile(sorted_vals: list[float], q: float) -> float:
        idx = (len(sorted_vals) - 1) * q
        lo = int(idx)
        hi = min(lo + 1, len(sorted_vals) - 1)
        frac = idx - lo
        return sorted_vals[lo] * (1 - frac) + sorted_vals[hi] * frac

    work = sorted(values)
    removed = 0
    while True:
        p50 = percentile(work, 0.50)
        outliers = [v for v in work if v > 10 * p50]
        if not outliers:
            break
        work = [v for v in work if v <= 10 * p50]
        removed += len(outliers)
    if removed / len(values) > 0.05:
        raise ValueError(f"异常值剔除率 {removed / len(values):.1%} > 5%（benchmark §6：该组作废重测）")
    return _Stats(
        p50=percentile(work, 0.50),
        p99=percentile(work, 0.99),
        mean=sum(work) / len(work),
        removed=removed,
        total=len(values),
    )


# ---- D4 有效性 ----


def _d4_validity(root: Path, version: str, reports: dict[str, BenchReport], gain_ok: bool) -> dict[str, Any]:
    """「＞ATC 或 ATC 未覆盖」逐优化点判定（benchmark §5）。"""
    strategy = _load_json(root / "strategy" / "strategy.json")
    atc_list_path = root / "bench" / f"atc_opt_list_v{_vnum(version)}.json"
    atc_list = _load_json(atc_list_path) if atc_list_path.exists() else None

    entries: list[dict[str, Any]] = []
    for task_item in strategy.get("tasks", []):
        covered = _overlap(atc_list, task_item) if atc_list else False
        if covered and "atc" in reports:
            stronger = reports["optimized"].p50_us < reports["atc"].p50_us
            entries.append(
                {
                    "candidate_id": task_item["candidate_id"],
                    "atc_coverage": "covered",
                    "p50_optimized_us": reports["optimized"].p50_us,
                    "p50_atc_us": reports["atc"].p50_us,
                    "valid": stronger,
                    "reason": (
                        f"ATC 已覆盖：optimized.p50 {'<' if stronger else '>='} atc.p50"
                        f"（须严格小于，benchmark §5）"
                    ),
                }
            )
        else:
            entries.append(
                {
                    "candidate_id": task_item["candidate_id"],
                    "atc_coverage": "not_covered",
                    "valid": gain_ok,
                    "reason": "ATC 未覆盖本优化点：价值来自覆盖空白（仍须精度达标 + gain 达标）",
                }
            )
    valid = all(e["valid"] for e in entries) if entries else gain_ok
    payload = {
        "schema_version": "1.0",
        "version": version,
        "rule": "＞ATC 或 ATC 未覆盖（D4）",
        "entries": entries,
        "valid": valid,
    }
    (root / "bench" / f"validity_v{_vnum(version)}.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return payload


def _overlap(atc_list: dict[str, Any], task_item: dict[str, Any]) -> bool:
    """优化点 ↔ ATC 清单 overlap 判定：命中的 pass 名/作用域同时覆盖模式的全部算子。"""
    pattern = str(task_item.get("approach", ""))
    ops = [w for w in ("Mul", "Add") if w.lower() in pattern.lower()]
    if not ops:
        return bool(atc_list.get("passes"))
    applied = [p for p in atc_list.get("passes", []) if p.get("applied")]
    for p in applied:
        text = f"{p.get('name', '')} {p.get('scope', '')}".lower()
        if all(op.lower() in text for op in ops):
            return True
    return False


# ---- 内部 ----


def _report(
    impl: str,
    metric: BaselineMetric,
    stats: _Stats,
    device: str,
    note: str,
) -> BenchReport:
    return BenchReport(
        version="",
        impl=impl,  # type: ignore[arg-type]
        metric=metric,
        p50_us=round(stats.p50, 3),
        p99_us=round(stats.p99, 3),
        mean_us=round(stats.mean, 3),
        device=device,
        note=(note + f"；异常值剔除 {stats.removed}/{stats.total}").lstrip("；"),
    )


def _write_report(root: Path, version: str, kind: str, report: BenchReport) -> None:
    report.version = version
    v = version[1:] if version.startswith("v") else version
    (root / "bench" / f"bench_v{v}_{kind}.json").write_text(
        report.model_dump_json(indent=2), encoding="utf-8"
    )


def _rerun_pair(rid: str, version: str, metric: BaselineMetric) -> tuple[_Stats, _Stats] | None:
    """噪声复测（§6）：同口径再来一组，仅报告。失败不阻断主判定。"""
    root = run_dir(rid)
    imp = root / "implement" / version
    files = {
        str(p.relative_to(imp).as_posix()): p.read_bytes() for p in imp.rglob("*") if p.is_file()
    }
    from .remote import RemoteRunner

    try:
        result = RemoteRunner().run_package(
            package=f"{rid}-bench2-{version}",
            files=files,
            command=(
                "bash build.sh && "
                f"./artifacts/affine_impl bench ref --warmup {metric.warmup} "
                f"--iters {metric.iters} --csv ../out/lat_ref.csv && "
                f"./artifacts/affine_impl bench opt --warmup {metric.warmup} "
                f"--iters {metric.iters} --csv ../out/lat_opt.csv"
            ),
            expect_outputs=["lat_ref.csv", "lat_opt.csv"],
            timeout=1200,
        )
        if not result["ok"]:
            return None
        return (
            _stats(result["outputs"]["lat_ref.csv"].decode()),
            _stats(result["outputs"]["lat_opt.csv"].decode()),
        )
    except Exception:  # noqa: BLE001 —— 复测为报告性增强
        return None


def _write_atc_list(root: Path, version: str, fusion_result: bytes) -> None:
    from .atc_list import parse_fusion_result

    data = parse_fusion_result(fusion_result.decode("utf-8", errors="replace")) if fusion_result else {
        "passes": []
    }
    # fusion_result 原始键（effect_times/match_times 等）超出 AtcPass schema——投影到模型字段
    passes = [
        AtcPass(name=str(p.get("name", "")), scope=str(p.get("scope", "")),
                applied=bool(p.get("applied", False)))
        for p in data["passes"]
    ]
    payload = AtcOptList(
        version=version,
        source="atc --log=info（bench 任务包回传 fusion_result.json）",
        passes=passes,
        overlap_with_ours=[],
    )
    (root / "bench" / f"atc_opt_list_v{_vnum(version)}.json").write_text(
        payload.model_dump_json(indent=2), encoding="utf-8"
    )


def _stage_model(root: Path, files: dict[str, bytes]) -> str:
    task = _load_task(root)
    if task.model is None:
        raise ValueError("atc 对照腿需要整网模型输入")
    model = task.model
    if model is None:
        raise ValueError("atc 对照腿需要整网模型输入")
    path = root / model.path
    if not path.exists():
        raise FileNotFoundError(path)
    files[path.name] = path.read_bytes()
    return str(path.name)


def _make_atc_input(root: Path, version: str) -> bytes:
    """om 输入 x（值不影响性能，确定性生成）。"""
    import numpy as np

    params = _load_json(root / "implement" / version / "params.json")
    m, n = params["shape"]
    rng = np.random.RandomState(20260921)
    return rng.uniform(-1.0, 1.0, size=(m, n)).astype(np.float32).tobytes()


def _gate_accuracy(root: Path, version: str) -> None:
    path = root / "verify" / f"accuracy_v{_vnum(version)}.json"
    if not path.exists():
        raise FileNotFoundError(
            f"精度报告缺失：verify/accuracy_v{_vnum(version)}.json（D10 硬卡点：先 run_test）"
        )
    data = json.loads(path.read_text(encoding="utf-8"))
    if data["max_rel_err"] > data.get("threshold", 1e-3) or data.get("failures"):
        raise ValueError(
            f"精度未达标（D10 硬卡点）：max_rel_err={data['max_rel_err']} > "
            f"threshold={data.get('threshold', 1e-3)}——回 implement 修复，不进 bench"
        )


def _vnum(version: str) -> str:
    return version[1:] if version.startswith("v") else version


def _load_json(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    return data if isinstance(data, dict) else {"_raw": data}


def _load_task(root: Path) -> Any:
    from .runs import load_task

    return load_task(root)
