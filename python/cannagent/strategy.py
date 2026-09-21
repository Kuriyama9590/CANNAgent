"""strategy 阶段：候选评估、排序与任务拆解（workflow §2.1 strategy 契约）。

真实逻辑 = 图证据（候选模式/出现次数）+ RAG 历史经验（knowledge_store.retrieve）
双轮驱动：预估收益优先取历史同类模式的 outcome.gain_pct，缺席时退回模式启发式表；
风险按模式定级；constraints.exclude_ops 命中即拒绝。产物 = strategy.json + STRATEGY.md，
并回写 identify/fusion_candidates.json 的 status（selected/rejected）。
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Literal

from .config import run_dir
from .task_schema import StrategyRejected, StrategyReport, StrategyTask, TaskYaml

RiskLevel = Literal["low", "mid", "high"]

# 模式启发式（无 RAG 命中时的预估收益 %：kernel 发射节省 + 中间张量往返消除的量级）
_PATTERN_HEURISTIC: dict[str, float] = {
    "Mul+Add": 35.0,  # 标量仿射：两次算子调用 → 单次 aclnnAdd(alpha)
    "Conv+BN+ReLU": 25.0,
    "Conv+BN": 18.0,
    "MatMul+Add": 15.0,
    "MatMul+Gelu+Add": 20.0,
}

_PATTERN_RISK: dict[str, RiskLevel] = {
    "Mul+Add": "low",
    "Conv+BN+ReLU": "mid",
    "Conv+BN": "mid",
    "MatMul+Add": "mid",
    "MatMul+Gelu+Add": "high",
}

_PATTERN_APPROACH: dict[str, str] = {
    "Mul+Add": "aclnn 标量仿射融合（单次 aclnnAdd(alpha=s) 替代 Mul+Add 两次调用）",
    "Conv+BN+ReLU": "ONNX 图改写：BN 折叠进 Conv 后 ATC 重编译",
    "Conv+BN": "ONNX 图改写：BN 折叠进 Conv 后 ATC 重编译",
    "MatMul+Add": "ONNX 图改写 + ATC 重编译（暂无 aclnn 单算子融合面）",
    "MatMul+Gelu+Add": "ONNX 图改写 + ATC 重编译（暂无 aclnn 单算子融合面）",
}

_RAG_MIN_SCORE = 0.35  # 语义相似度门槛：低于此视作无相关经验


def generate(rid: str) -> dict[str, Any]:
    """生成 strategy.json + STRATEGY.md（幂等：覆盖写）。"""
    root = run_dir(rid)
    task = _load_task(root)
    op_list = _load_json(root / "identify" / "op_list.json")
    candidates = _load_json(root / "identify" / "fusion_candidates.json")["candidates"]

    by_id = {c["id"]: c for c in candidates}
    selected: list[str] = []
    tasks: list[StrategyTask] = []
    rejected: list[StrategyRejected] = []

    # 图证据：同模式出现次数（热点模式收益按出现次数放大，封顶 ×2）
    occurrences: dict[str, int] = {}
    for c in candidates:
        occurrences[c["pattern"]] = occurrences.get(c["pattern"], 0) + 1

    scored: list[tuple[float, str, str]] = []
    for c in candidates:
        pattern = str(c["pattern"])
        refs, rag_gain = _rag_gain(root, task, pattern)
        heuristic = _PATTERN_HEURISTIC.get(pattern, 5.0)
        est: float = rag_gain if rag_gain is not None else heuristic
        est = min(est * min(2.0, max(1.0, occurrences[pattern] * 0.5 + 0.5)), 80.0)

        excluded = _excluded(task, pattern)
        if excluded or est <= 0:
            rejected.append(
                StrategyRejected(
                    candidate_id=c["id"],
                    reason=excluded or f"预估收益非正（est={est:.1f}%）",
                )
            )
            by_id[c["id"]]["status"] = "rejected"
            continue
        by_id[c["id"]]["status"] = "selected"
        by_id[c["id"]]["est_gain_pct"] = round(est, 1)
        if refs:
            by_id[c["id"]]["references"] = refs
        selected.append(c["id"])
        scored.append((est, c["id"], pattern))

    # 排序：预估收益降序，同分按 risk 升级（低风险优先）
    risk_order = {"low": 0, "mid": 1, "high": 2}
    scored.sort(key=lambda t: (-t[0], risk_order[_PATTERN_RISK.get(t[2], "high")]))
    for order, (est, cid, pattern) in enumerate(scored, start=1):
        recorded = by_id[cid].get("est_gain_pct", est)
        tasks.append(
            StrategyTask(
                op_task_id=f"T-{cid}",
                candidate_id=cid,
                approach=_PATTERN_APPROACH.get(pattern, "待定路线"),
                target_gain_pct=round(min(est, float(recorded)), 1),
                risk=_PATTERN_RISK.get(pattern, "high"),  # 未知模式保守定级
                order=order,
            )
        )

    report = StrategyReport(
        selected=selected,
        tasks=tasks,
        rejected=rejected,
        fallback="逐算子独立优化（融合候选全部失败时回退官方 aclnn 直调基线）",
    )
    (root / "strategy" / "strategy.json").write_text(
        report.model_dump_json(indent=2), encoding="utf-8"
    )
    _write_doc(root, task, report, by_id, occurrences, len(op_list.get("nodes", [])))

    # 回写候选状态（identify 契约：status 由 strategy 阶段回写）
    (root / "identify" / "fusion_candidates.json").write_text(
        json.dumps(
            {"schema_version": "1.0", "candidates": list(by_id.values())},
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    return {"strategy": report.model_dump()}


def _rag_gain(root: Path, task: TaskYaml, pattern: str) -> tuple[list[str], float | None]:
    """RAG 检索同类模式历史经验 → (引用, 历史收益)。未命中/低于门槛返回 ([], None)。"""
    try:
        from .knowledge_store import KnowledgeStore

        store = KnowledgeStore()
        try:
            hits = store.retrieve(
                query=pattern, top_k=3, filter={"dtype": task.constraints.dtype}
            )
        finally:
            store.close()
    except Exception:  # noqa: BLE001 —— RAG 缺席不阻断策略（降级为启发式）
        return [], None
    refs: list[str] = []
    for h in hits:
        if h["score"] < _RAG_MIN_SCORE:
            continue
        refs.append(h["ref"])
        gain = h.get("payload", {}).get("outcome", {}).get("gain_pct")
        if gain is not None:
            return refs, float(gain)
    return refs, None


def _excluded(task: TaskYaml, pattern: str) -> str | None:
    for op in task.constraints.exclude_ops:
        if op.lower() in pattern.lower():
            return f"constraints.exclude_ops 命中：{op}"
    return None


def _write_doc(
    root: Path,
    task: TaskYaml,
    report: StrategyReport,
    by_id: dict[str, dict[str, Any]],
    occurrences: dict[str, int],
    total_nodes: int,
) -> None:
    lines = [
        "# 策略文档（STRATEGY.md）",
        "",
        f"- 任务：{task.task_name}（{task.task_type}）",
        f"- 图规模：{total_nodes} 节点；融合候选 {len(by_id)} 个（{len(report.selected)} 选中 / "
        f"{len(report.rejected)} 拒绝）",
        f"- 精度约束：dtype={task.constraints.dtype}；目标收益：≥ {task.target.gain_pct}%",
        "",
        "## 候选评估",
        "",
        "| 候选 | 模式 | 节点 | 预估收益 % | 风险 | 结论 |",
        "|---|---|---|---|---|---|",
    ]
    rejected_by_id = {r.candidate_id: r.reason for r in report.rejected}
    for cid in sorted(by_id):
        c = by_id[cid]
        verdict = (
            f"选中（{rejected_by_id[cid] if cid in rejected_by_id else '任务 T-' + cid}）"
            if c["status"] == "selected"
            else f"拒绝：{rejected_by_id.get(cid, '')}"
        )
        lines.append(
            f"| {cid} | {c['pattern']} | {c['node_idx']} | {c.get('est_gain_pct', 0)} | "
            f"{next((t.risk for t in report.tasks if t.candidate_id == cid), '-')} | {verdict} |"
        )
    lines += ["", "## 排序理由", ""]
    for t in report.tasks:
        c = by_id[t.candidate_id]
        mult = min(2.0, max(1.0, occurrences[c["pattern"]] * 0.5 + 0.5))
        lines.append(
            f"{t.order}. **{t.op_task_id}**（{c['pattern']}，出现 {occurrences[c['pattern']]} 次，"
            f"放大系数 ×{mult:.1f}）：{t.approach}；目标 +{t.target_gain_pct}%，风险 {t.risk}"
        )
    lines += [
        "",
        "## 风险与回退",
        "",
        f"- 回退路线：{report.fallback}",
        "- 精度为硬卡点（D10）：任何实现未过精度阈值不进入 bench/交付",
        "- 有效性判据（D4）：与 ATC 优化清单对照，重叠命中须强于 ATC，未覆盖即有效",
        "",
    ]
    (root / "strategy" / "STRATEGY.md").write_text("\n".join(lines), encoding="utf-8")


def _load_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        raise FileNotFoundError(f"先运行前置阶段产物：{path.name}（{path}）")
    data = json.loads(path.read_text(encoding="utf-8"))
    return data if isinstance(data, dict) else {"_raw": data}


def _load_task(root: Path) -> TaskYaml:
    from .runs import load_task

    return load_task(root)
