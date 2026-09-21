"""verify 阶段：用例生成 / 远程执行精度比对 / 达标分析（workflow §2.1 verify 契约）。

口径（benchmark.md §3）：
- 对照实现 = 官方 aclnn 同算子接口（affine 模板 ref 路 = aclnnMul + aclnnAdd 逐算子直调）
- 固定 seed 生成输入（幂等可重建），落盘 ``verify/cases_v{N}/``
- rel_err = |y_opt − y_ref| / (|y_ref| + 1e-6)，逐元素取全用例最大值
- 精度 = 硬卡点（D10）：max_rel_err ≤ threshold 且 failures 为空

run_test 为远程真实现：任务包 = 实现快照源码 + 用例，服务器编译后同卡跑 ref/opt 两路，
逐用例 max_rel_err 回传，本地组装 AccuracyReport（threshold 判定在本地复核）。
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .config import run_dir
from .task_schema import AccuracyReport

DEFAULT_SEED = 20260916
DEFAULT_CASES = 8
EPS = 1e-6


def gen_test(
    rid: str,
    version: str,
    seed: int | None = None,
    cases: int | None = None,
) -> dict[str, Any]:
    """固定 seed 生成仿射用例（y = s·x + b 的 x/b/s）→ verify/cases_v{N}/。"""
    import numpy as np

    root = run_dir(rid)
    params = _params(root, version)
    m, n = params["shape"]
    dtype = np.float32
    seed = DEFAULT_SEED if seed is None else seed
    count = DEFAULT_CASES if cases is None else cases

    case_dir = root / "verify" / f"cases_v{version[1:] if version.startswith('v') else version}"
    case_dir.mkdir(parents=True, exist_ok=True)
    rng = np.random.RandomState(seed)
    for i in range(count):
        cid = f"case_{i:03d}"
        d = case_dir / cid
        d.mkdir(exist_ok=True)
        # 分布按算子语义（benchmark §3）：x 均匀有符号、b 正态、s 正缩放
        x = rng.uniform(-1.0, 1.0, size=(m, n)).astype(dtype)
        b = rng.normal(0.0, 0.1, size=(m, n)).astype(dtype)
        s = float(rng.uniform(0.5, 2.0))
        x.tofile(d / "a.bin")
        b.tofile(d / "b.bin")
        (d / "s.txt").write_text(f"{s!r}\n", encoding="utf-8", newline="\n")
    (case_dir / "index.txt").write_text(
        "\n".join(f"case_{i:03d}" for i in range(count)) + "\n", encoding="utf-8", newline="\n"
    )
    (case_dir / "manifest.json").write_text(
        _dump(
            {
                "schema_version": "1.0",
                "version": version,
                "seed": seed,
                "count": count,
                "shape": [m, n],
                "dtype": params["dtype"],
                "note": "输入摘要 = seed + 序号（可独立重建，benchmark §3）",
            }
        ),
        encoding="utf-8",
    )
    return {"version": version, "seed": seed, "cases": count, "dir": f"verify/{case_dir.name}"}


def run_test(rid: str, version: str, threshold: float | None = None) -> dict[str, Any]:
    """远程执行精度比对（真实现）：包 = 快照源码 + 用例 → accuracy_v{N}.json。"""
    root = run_dir(rid)
    task = _load_task(root)
    from .remote import RemoteRunner

    imp = root / "implement" / version
    if not (imp / "build.sh").exists():
        raise FileNotFoundError(f"实现快照缺失：implement/{version}（先 code_gen/build）")
    case_dir = _case_dir(root, version)
    thr = _threshold(task, threshold)

    files: dict[str, bytes] = {}
    for p in imp.rglob("*"):
        if p.is_file():
            files[p.relative_to(imp).as_posix()] = p.read_bytes()
    for p in case_dir.rglob("*"):
        if p.is_file():
            # 远程路径必须 POSIX 分隔符（Windows Path 拼接会产出反斜杠）
            files[(Path("cases") / p.relative_to(case_dir)).as_posix()] = p.read_bytes()

    result = RemoteRunner().run_package(
        package=f"{rid}-verify-{version}",
        files=files,
        command=(
            "bash build.sh && ./artifacts/affine_impl verify "
            f"--cases cases --threshold {thr!r} --out ../out/results.json"
        ),
        expect_outputs=["results.json"],
        timeout=900,
    )
    (root / "verify" / f"exec_v{version}.log").write_text(result["log"], encoding="utf-8")
    raw = result["outputs"].get("results.json", b"").decode("utf-8", errors="replace")
    if not result["ok"] or not raw:
        return {
            "ok": False,
            "code": "CANN_E_VERIFY_EXEC",
            "message": "精度比对任务包失败（编译或执行错误）",
            "hint": f"详见 verify/exec_v{version}.log；analyze-error 可分类",
        }

    report = _assemble(root, version, raw, thr, seed=_seed_of(case_dir))
    return {"ok": True, "accuracy": report.model_dump()}


def analyze_accuracy(rid: str, version: str | None = None) -> dict[str, Any]:
    """达标分析（routing manifest 证据）：最新 accuracy 报告 → 趋势与失败摘要。"""
    root = run_dir(rid)
    version = version or _latest_accuracy(root)
    if version is None:
        return {"ok": False, "code": "CANN_E_NO_REPORT", "message": "无 accuracy 报告（先 run_test）"}
    report = AccuracyReport.model_validate(
        json.loads((root / "verify" / f"accuracy_v{_vnum(version)}.json").read_text(encoding="utf-8"))
    )
    history = _accuracy_history(root)
    best = min((h["max_rel_err"], h["version"]) for h in history) if history else None
    return {
        "ok": True,
        "version": version,
        "passed_threshold": report.passed_threshold,
        "max_rel_err": report.max_rel_err,
        "threshold": report.threshold,
        "trend": history,
        "best": {"version": best[1], "max_rel_err": best[0]} if best else None,
        "failures": report.failures[:5],
    }


# ---- 内部 ----


def _assemble(
    root: Path, version: str, results_json: str, threshold: float, seed: int
) -> AccuracyReport:
    cases = json.loads(results_json)["cases"]
    passed = sum(1 for c in cases if c["pass"] and c["max_rel_err"] <= threshold)
    failures = [
        {"case_id": c["case_id"], "rel_err": c["max_rel_err"], "input_summary": f"seed={seed} {c['case_id']}"}
        for c in cases
        if not (c["pass"] and c["max_rel_err"] <= threshold)
    ]
    report = AccuracyReport(
        version=version,
        passed=passed,
        total=len(cases),
        max_rel_err=max((c["max_rel_err"] for c in cases), default=0.0),
        threshold=threshold,
        failures=failures,
        seed=seed,
        duration_ms=0,
    )
    (root / "verify" / f"accuracy_v{_vnum(version)}.json").write_text(
        report.model_dump_json(indent=2), encoding="utf-8"
    )
    return report


def _vnum(version: str) -> str:
    return version[1:] if version.startswith("v") else version


def _accuracy_history(root: Path) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    vdir = root / "verify"
    if not vdir.exists():
        return out
    for p in sorted(vdir.glob("accuracy_v*.json")):
        data = json.loads(p.read_text(encoding="utf-8"))
        out.append({"version": data["version"], "max_rel_err": data["max_rel_err"]})
    return out


def _latest_accuracy(root: Path) -> str | None:
    reports = sorted((root / "verify").glob("accuracy_v*.json")) if (root / "verify").exists() else []
    return reports[-1].stem.removeprefix("accuracy_") if reports else None


def _threshold(task: Any, override: float | None) -> float:
    if override is not None:
        return float(override)
    out = task.output or {}
    value = out.get("precision_threshold")
    return float(value) if isinstance(value, (int, float)) else 1e-3


def _seed_of(case_dir: Path) -> int:
    manifest = case_dir / "manifest.json"
    if manifest.exists():
        return int(json.loads(manifest.read_text(encoding="utf-8")).get("seed", DEFAULT_SEED))
    return DEFAULT_SEED


def _case_dir(root: Path, version: str) -> Path:
    v = version[1:] if version.startswith("v") else version
    d = root / "verify" / f"cases_v{v}"
    if not (d / "index.txt").exists():
        raise FileNotFoundError(f"用例缺失：verify/cases_v{v}（先 gen_test）")
    return d


def _params(root: Path, version: str) -> dict[str, Any]:
    path = root / "implement" / version / "params.json"
    if not path.exists():
        raise FileNotFoundError(f"实现参数缺失：implement/{version}/params.json（先 code_gen）")
    data = json.loads(path.read_text(encoding="utf-8"))
    return data if isinstance(data, dict) else {"_raw": data}


def _load_task(root: Path) -> Any:
    from .runs import load_task

    return load_task(root)


def _dump(obj: dict[str, Any]) -> str:
    return json.dumps(obj, ensure_ascii=False, indent=2)
