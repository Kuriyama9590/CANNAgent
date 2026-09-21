"""ATC 优化清单采集（C12，D4 门限的判定依据）。

权威源 = atc 的 ``fusion_result.json``（随编译在输出目录生成，逐 pass 记录
``effect_times`` / ``match_times``）；``parse_atc_log`` 为辅助（stdout 日志解析，
覆盖无 fusion_result 的场景）。输出符合 workflow §2.1 bench 段 passes 条目。
"""

from __future__ import annotations

import json
import re
from typing import Any

# stdout 日志中的 pass/融合痕迹（辅助路径；fusion_result.json 缺席时兜底）
_PASS_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("GraphFusion", re.compile(r"(?:Fusion|fusion)[^,\n]*\[(?P<scope>[\w:,]+)\]", re.I)),
    ("ConstFolding", re.compile(r"constant folding", re.I)),
    ("OpTune", re.compile(r"op[_ ]tune", re.I)),
    ("TransDataEliminate", re.compile(r"transdata[^,\n]*(?:eliminat|optimiz)", re.I)),
    ("DeadNodeEliminate", re.compile(r"(?:dead|useless)[^,\n]*node", re.I)),
]

_SCOPE_NODE = re.compile(r"node[s]?\s*[:：]?\s*([\w\-.,\[\]]+)", re.I)


def parse_fusion_result(text: str) -> dict[str, Any]:
    """fusion_result.json → passes 清单（applied = effect_times > 0）。"""
    data = json.loads(text)
    passes: list[dict[str, Any]] = []
    for graph_key, sections in data.items():
        if not isinstance(sections, dict):
            continue
        for section, entries in sections.items():
            if not isinstance(entries, dict):
                continue
            for name, stats in entries.items():
                if not isinstance(stats, dict) or "effect_times" not in stats:
                    continue
                effect = int(stats.get("effect_times", 0))
                match = int(stats.get("match_times", 0))
                passes.append(
                    {
                        "name": name,
                        "scope": f"{graph_key}/{section}",
                        "applied": effect > 0,
                        "effect_times": effect,
                        "match_times": match,
                    }
                )
    passes.sort(key=lambda p: (not p["applied"], p["name"]))
    return {"passes": passes}


def parse_atc_log(log: str) -> dict[str, Any]:
    """stdout 日志文本 → passes 清单（辅助路径；scope 取首个节点引用）。"""
    passes: dict[str, dict[str, Any]] = {}
    for line in log.splitlines():
        for name, pattern in _PASS_PATTERNS:
            hit = pattern.search(line)
            if not hit:
                continue
            scope = "-"
            if hit.groupdict().get("scope"):
                scope = hit.group("scope")
            else:
                m = _SCOPE_NODE.search(line)
                if m:
                    scope = m.group(1)
            entry = passes.setdefault(name, {"name": name, "scope": scope, "applied": True})
            if scope != "-":
                entry["scope"] = scope
    return {"passes": list(passes.values())}
