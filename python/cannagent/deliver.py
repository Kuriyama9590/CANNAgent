"""deliver 阶段：交付包组装 / 报告生成（workflow §2.1 deliver 契约）。

四件套 = code / tests / STRATEGY.md / REPORT.md；manifest.json 记录路径、最终版本、
收益与关键文件 sha256（防篡改）。``run.sh --check`` = 清单四项存在 + 校验和复核的
离线自检（直通判定）。
"""

from __future__ import annotations

import hashlib
import json
import shutil
from pathlib import Path
from typing import Any

from .config import run_dir


def gen_report(rid: str) -> dict[str, Any]:
    """从 run 目录产物生成 REPORT.md（幂等：覆盖写）。"""
    root = run_dir(rid)
    task = _load_task(root)
    final = _final_version(root)
    acc = _load_opt(root / "verify" / f"accuracy_{final}.json")
    gain = _load_opt(root / "bench" / f"gain_{final}.json")
    env = _load_opt(root / "bench" / "env.json")
    validity = _load_opt(root / "bench" / f"validity_{final}.json")
    atc_list = _load_opt(root / "bench" / f"atc_opt_list_{final}.json")
    v = final[1:] if final.startswith("v") else final
    bench = {
        kind: _load_opt(root / "bench" / f"bench_v{v}_{kind}.json")
        for kind in ("baseline", "optimized", "atc")
    }
    atc_bench = bench["atc"]

    lines: list[str] = [
        "# 交付报告（REPORT.md）",
        "",
        "## 1. 任务信息",
        "",
        f"- 任务：{task.task_name}（{task.task_type}；run={root.name}）",
        f"- 精度约束：dtype={task.constraints.dtype}；目标收益：≥ {task.target.gain_pct}%",
        f"- 基线口径：impl={task.baseline.impl}，warmup={task.baseline.metric.warmup}，"
        f"iters={task.baseline.metric.iters}，同步点=aclrtSynchronizeStream，"
        f"ε={task.baseline.metric.epsilon}",
        f"- 环境：device={env.get('device', '?')}，CANN={env.get('cann', '?')}",
        "",
        "## 2. 最终版本与迭代史",
        "",
        f"- 最终采纳：**{final}**",
        "",
        "| 版本 | max_rel_err | p50 优化 (us) | gain % |",
        "|---|---|---|---|",
    ]
    for ver in _versions(root):
        a = _load_opt(root / "verify" / f"accuracy_{ver}.json")
        g = _load_opt(root / "bench" / f"gain_{ver}.json")
        lines.append(
            f"| {ver} | {a.get('max_rel_err', '—')} | {g.get('p50_optimized_us', '—')} | "
            f"{g.get('gain_pct', '—')} |"
        )

    acc_ok = acc.get("max_rel_err", 1) <= acc.get("threshold", 1e-3)
    lines += [
        "",
        "## 3. 精度结论",
        "",
        f"- {final}：{acc.get('passed')}/{acc.get('total')} 用例通过，"
        f"max_rel_err={acc.get('max_rel_err')} ≤ threshold={acc.get('threshold')}"
        f"（seed={acc.get('seed')}，固定 seed 幂等复算）",
        f"- 判定：**{'达标（硬卡点通过，D10）' if acc_ok else '未达标'}**",
        "",
        "## 4. 性能对比（p50 口径）",
        "",
        "| 测量 | p50 (us) | p99 (us) | 说明 |",
        "|---|---|---|---|",
        f"| 基线（官方 aclnn 逐算子直调） | {bench['baseline'].get('p50_us')} | "
        f"{bench['baseline'].get('p99_us')} | {bench['baseline'].get('note', '')} |",
        f"| 优化（{final}） | {bench['optimized'].get('p50_us')} | "
        f"{bench['optimized'].get('p99_us')} | {bench['optimized'].get('note', '')} |",
    ]
    if atc_bench:
        lines.append(
            f"| ATC 门槛对照（om 整图） | {atc_bench.get('p50_us')} | "
            f"{atc_bench.get('p99_us')} | {atc_bench.get('note', '')} |"
        )
    lines += [
        "",
        f"- gain_pct = **{gain.get('gain_pct')}%**（目标 {gain.get('target_gain_pct')}%，"
        f"判定 {'达标' if gain.get('gain_ok') else '未达标'}；ε={gain.get('epsilon')}）",
        "",
        "## 5. ATC 优化清单与边界说明（D4）",
        "",
        f"- 有效性规则：{validity.get('rule', '＞ATC 或 ATC 未覆盖')}",
        f"- 本轮判定：**{'有效' if validity.get('valid') else '无效优化（不得进入交付）'}**",
    ]
    for e in validity.get("entries", []):
        lines.append(f"  - {e.get('candidate_id')}：{e.get('atc_coverage')}——{e.get('reason')}")
    if atc_list:
        lines += ["", "  | pass | scope | applied |", "  |---|---|---|"]
        for p in atc_list.get("passes", [])[:20]:
            lines.append(f"  | {p.get('name')} | {p.get('scope')} | {p.get('applied')} |")
    repro_stdin = json.dumps({"run_id": root.name, "version": final}, ensure_ascii=False)
    lines += [
        "",
        "## 6. 复现步骤",
        "",
        "1. `.env` 配置 CANN_SERVER_{HOST,USER,PASSWORD}（昇腾服务器，conda cannagent 环境）",
        f"2. `python -m cannagent run-bench`（stdin: {repro_stdin}）",
        "3. 或直接执行交付包内 `bash deliver/run.sh --check` 自检 + `deliver/bench.sh` 复测",
        "",
    ]
    (root / "deliver").mkdir(exist_ok=True)
    (root / "deliver" / "REPORT.md").write_text("\n".join(lines), encoding="utf-8")
    return {"report": "deliver/REPORT.md", "final_version": final}


def package(rid: str) -> dict[str, Any]:
    """组装交付包 deliver/ + manifest.json（四件套 + 复现脚本 + sha256）。"""
    root = run_dir(rid)
    final = _final_version(root)
    gen_report(rid)
    out = root / "deliver"

    code_dir = out / "code"
    if code_dir.exists():
        shutil.rmtree(code_dir)
    shutil.copytree(root / "implement" / final / "operator", code_dir)
    shutil.copyfile(root / "implement" / final / "build.sh", code_dir / "build.sh")

    tests_dir = out / "tests"
    if tests_dir.exists():
        shutil.rmtree(tests_dir)
    shutil.copytree(_case_dir(root, final), tests_dir / "cases")
    (tests_dir / "README.md").write_text(
        f"# 测试用例（{final}）\n\n固定 seed 生成，输入见 cases/（manifest.json 记录 seed/shape）。\n"
        "复算：远端运行 code/ 实现后以 verify 模式比对 ref/opt 两路输出。\n",
        encoding="utf-8",
    )

    shutil.copyfile(root / "strategy" / "STRATEGY.md", out / "STRATEGY.md")
    shutil.copyfile(root / "strategy" / "strategy.json", out / "strategy.json")

    (out / "run.sh").write_text(_run_sh(root.name, final), encoding="utf-8", newline="\n")
    (out / "bench.sh").write_text(_bench_sh(root.name, final), encoding="utf-8", newline="\n")

    gain = _load_opt(root / "bench" / f"gain_{final}.json")
    checksums = {
        "REPORT.md": _sha256(out / "REPORT.md"),
        "STRATEGY.md": _sha256(out / "STRATEGY.md"),
        "run.sh": _sha256(out / "run.sh"),
        "bench.sh": _sha256(out / "bench.sh"),
    }
    manifest = {
        "schema_version": "1.0",
        "code": "code/",
        "tests": "tests/",
        "strategy": "STRATEGY.md",
        "report": "REPORT.md",
        "repro": {"run": "run.sh", "bench": "bench.sh"},
        "final_version": final,
        "gain_pct": gain.get("gain_pct"),
        "checksums": checksums,
    }
    (out / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")

    checked = _check(root)
    return {"manifest": manifest, "check": checked}


def check(rid: str) -> dict[str, Any]:
    """直通判定自检：四件套存在 + 校验和一致（本地离线）。"""
    root = run_dir(rid)
    return _check(root)


# ---- 内部 ----


def _check(root: Path) -> dict[str, Any]:
    out = root / "deliver"
    mpath = out / "manifest.json"
    if not mpath.exists():
        return {"ok": False, "code": "CANN_E_NO_MANIFEST", "message": "deliver/manifest.json 缺失"}
    manifest = json.loads(mpath.read_text(encoding="utf-8"))
    missing = [k for k in ("code", "tests", "strategy", "report") if not (out / str(manifest[k])).exists()]
    if missing:
        return {"ok": False, "code": "CANN_E_DELIVER_INCOMPLETE", "message": f"四件套缺失：{missing}"}
    bad = [rel for rel, want in manifest.get("checksums", {}).items() if _sha256(out / rel) != want]
    if bad:
        return {"ok": False, "code": "CANN_E_CHECKSUM", "message": f"校验和不一致：{bad}"}
    return {"ok": True, "final_version": manifest["final_version"], "gain_pct": manifest.get("gain_pct")}


def _run_sh(rid: str, final: str) -> str:
    return f"""#!/usr/bin/env bash
# 复现入口（{rid} / {final}）
# --check：本地离线自检（manifest 四件套 + sha256）
# run：需要昇腾服务器凭据（.env 的 CANN_SERVER_*），重跑精度比对
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
if [ "${{1:-}}" = "--check" ]; then
  python - "$HERE" <<'PY'
import json, hashlib, sys
from pathlib import Path
out = Path(sys.argv[1])
m = json.loads((out / "manifest.json").read_text(encoding="utf-8"))
miss = [k for k in ("code", "tests", "strategy", "report") if not (out / m[k]).exists()]
assert not miss, f"四件套缺失：{{miss}}"
for rel, want in m["checksums"].items():
    got = hashlib.sha256((out / rel).read_bytes()).hexdigest()
    assert got == want, f"checksum mismatch: {{rel}}"
print("SELF_CHECK_OK", m["final_version"])
PY
  exit $?
fi
if [ -z "${{CANN_SERVER_HOST:-}}" ]; then
  echo "run 模式需要 CANN_SERVER_{{HOST,USER,PASSWORD}}（.env）" >&2
  exit 2
fi
echo 'python -m cannagent run-test  # stdin: {{"run_id": "{rid}", "version": "{final}"}}'
"""


def _bench_sh(rid: str, final: str) -> str:
    return f"""#!/usr/bin/env bash
# 性能复测（{rid} / {final}）：三份对照同包同卡重测
set -euo pipefail
if [ -z "${{CANN_SERVER_HOST:-}}" ]; then
  echo "需要 CANN_SERVER_{{HOST,USER,PASSWORD}}（.env）" >&2
  exit 2
fi
echo 'python -m cannagent run-bench  # stdin: {{"run_id": "{rid}", "version": "{final}"}}'
"""


def _sha256(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def _final_version(root: Path) -> str:
    """最终采纳版本 = 有 gain 报告且 gain_ok 的最大版本；无则最新 accuracy 版本。"""
    best: tuple[int, str] | None = None
    latest: tuple[int, str] | None = None
    for p in (root / "bench").glob("gain_v*.json"):
        ver = p.stem.removeprefix("gain_")
        num = int(ver[1:]) if ver[1:].isdigit() else 0
        data = json.loads(p.read_text(encoding="utf-8"))
        if data.get("gain_ok") and (best is None or num > best[0]):
            best = (num, ver)
        if latest is None or num > latest[0]:
            latest = (num, ver)
    if best:
        return best[1]
    if latest:
        return latest[1]
    accs = sorted((root / "verify").glob("accuracy_v*.json"))
    if accs:
        return accs[-1].stem.removeprefix("accuracy_")
    raise FileNotFoundError("无 verify/bench 产物可定最终版本")


def _versions(root: Path) -> list[str]:
    nums = [
        int(p.stem.removeprefix("accuracy_v"))
        for p in (root / "verify").glob("accuracy_v*.json")
        if p.stem.removeprefix("accuracy_v").isdigit()
    ]
    return [f"v{n}" for n in sorted(nums)]


def _case_dir(root: Path, version: str) -> Path:
    v = version[1:] if version.startswith("v") else version
    d = root / "verify" / f"cases_v{v}"
    if not d.exists():
        raise FileNotFoundError(f"用例缺失：verify/cases_v{v}")
    return d


def _load_opt(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}


def _load_task(root: Path) -> Any:
    from .runs import load_task

    return load_task(root)
