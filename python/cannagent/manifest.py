"""run 现场清单（workflow §2 判据注入）：routing 判定会话与阶段 session 的 manifest。

判据 = 证据不是判决（workflow §2 转移规则 4）：趋势表、按当前路线起算的历史最优、
停滞标记、失败明细、上轮策略摘要、预算余量——全部进 manifest 供判定会话参考，
不直接决定去向。
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .config import run_dir


def build(rid: str, wall_elapsed_min: float = 0.0) -> dict[str, Any]:
    """聚合 run 目录全程证据 → manifest（不落盘，调用方注入 session）。"""
    root = run_dir(rid)
    task = _load_task(root)

    trend: list[dict[str, Any]] = []
    for ver in _versions(root):
        acc = _load_opt(root / "verify" / f"accuracy_{ver}.json")
        gain = _load_opt(root / "bench" / f"gain_{ver}.json")
        trend.append(
            {
                "version": ver,
                "max_rel_err": acc.get("max_rel_err"),
                "accuracy_passed": bool(
                    acc
                    and acc.get("max_rel_err", 1) <= acc.get("threshold", 1e-3)
                    and not acc.get("failures")
                ),
                "p50_optimized_us": gain.get("p50_optimized_us"),
                "gain_pct": gain.get("gain_pct"),
            }
        )

    gains = [float(t["gain_pct"]) for t in trend if t["gain_pct"] is not None]
    best_gain = max(gains) if gains else None
    stagnation = _stagnation(gains)

    failures: list[dict[str, Any]] = []
    latest_acc = _latest(root / "verify", "accuracy_v*.json")
    if latest_acc:
        data = _load_opt(latest_acc)
        failures.extend(data.get("failures", [])[:5])

    strategy = _load_opt(root / "strategy" / "strategy.json")
    tried = [
        {"candidate_id": t.get("candidate_id"), "approach": t.get("approach")}
        for t in strategy.get("tasks", [])
    ]
    rejected = [r.get("candidate_id") for r in strategy.get("rejected", [])]

    budget = {
        "max_wall_min": task.budgets.max_wall_min,
        "max_tokens": task.budgets.max_tokens,
        "wall_elapsed_min": round(wall_elapsed_min, 1),
        "wall_remaining_min": round(max(0.0, task.budgets.max_wall_min - wall_elapsed_min), 1),
    }

    return {
        "schema_version": "1.0",
        "run_id": root.name,
        "stage_hint": None,
        "trend": trend,
        "best": {"gain_pct": best_gain},
        "stagnation": stagnation,
        "failures": failures,
        "strategy": {
            "selected": strategy.get("selected", []),
            "tried": tried,
            "rejected": rejected,
            "fallback": strategy.get("fallback", ""),
        },
        "budget": budget,
        "note": "判据是证据不是判决：分流由 routing 判定会话在合法边集内决策（workflow §2）",
    }


def render(manifest: dict[str, Any]) -> str:
    """manifest → session 注入文本（markdown，判定会话与阶段 session 共用）。"""
    lines = [
        "# run 现场 manifest（判据注入）",
        "",
        f"- run：{manifest.get('run_id')}",
        f"- 预算余量：墙钟 {manifest['budget']['wall_remaining_min']}/"
        f"{manifest['budget']['max_wall_min']} 分钟",
        "",
        "## 趋势表（逐迭代）",
        "",
        "| 版本 | max_rel_err | 精度达标 | p50 优化 (us) | gain % |",
        "|---|---|---|---|---|",
    ]
    for t in manifest.get("trend", []):
        lines.append(
            f"| {t['version']} | {t['max_rel_err']} | {t['accuracy_passed']} | "
            f"{t['p50_optimized_us']} | {t['gain_pct']} |"
        )
    lines += [
        "",
        f"- 历史最优 gain：{manifest['best']['gain_pct']}%（按当前 strategy 路线起算）",
        f"- 停滞标记：{'是（连续 2 次不优于历史最优）' if manifest['stagnation'] else '否'}",
        "",
        "## 失败明细（最近）",
        "",
    ]
    if manifest.get("failures"):
        for f in manifest["failures"]:
            lines.append(f"- {f.get('case_id')}：rel_err={f.get('rel_err')}")
    else:
        lines.append("- 无")
    s = manifest.get("strategy", {})
    lines += [
        "",
        "## 上轮策略摘要",
        "",
        f"- selected：{s.get('selected')}",
        f"- 已试路线：{[t.get('approach') for t in s.get('tried', [])]}",
        f"- rejected：{s.get('rejected')}",
        f"- 回退路线：{s.get('fallback')}",
        "",
        manifest.get("note", ""),
        "",
    ]
    return "\n".join(lines)


# ---- 内部 ----


def _stagnation(gains: list[float]) -> bool:
    """连续 2 次不优于历史最优（workflow §2 转移规则 4）。"""
    if len(gains) < 2:
        return False
    best = gains[0]
    stagnant = 0
    for g in gains[1:]:
        if g is not None and g > best:
            best = g
            stagnant = 0
        else:
            stagnant += 1
    return stagnant >= 2


def _versions(root: Path) -> list[str]:
    nums = [
        int(p.stem.removeprefix("accuracy_v"))
        for p in (root / "verify").glob("accuracy_v*.json")
        if p.stem.removeprefix("accuracy_v").isdigit()
    ]
    return [f"v{n}" for n in sorted(nums)]


def _latest(directory: Path, pattern: str) -> Path | None:
    paths = sorted(directory.glob(pattern)) if directory.exists() else []
    return paths[-1] if paths else None


def _load_opt(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}


def _load_task(root: Path) -> Any:
    from .runs import load_task

    return load_task(root)
