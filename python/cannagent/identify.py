"""identify 阶段：模型解析 / 算子画像 / 融合候选（workflow §2.1 identify 契约）。

parse_model 为真实现（onnx 图枚举），是 D3 全链路（插件→CLI→产物）的首个打通点。
"""

from __future__ import annotations

import json
from pathlib import Path

from .config import run_dir
from .task_schema import FusionCandidate, FusionCandidates, OpList, OpNode, TaskYaml

# 常见融合模式（骨架版规则表；strategy 阶段与 RAG 历史共同作用，此处只做图模式命中）
_FUSION_PATTERNS: list[tuple[str, list[str]]] = [
    ("Conv+BN+ReLU", ["Conv", "BatchNormalization", "Relu"]),
    ("Conv+BN", ["Conv", "BatchNormalization"]),
    ("MatMul+Add", ["MatMul", "Add"]),
    ("MatMul+Gelu+Add", ["MatMul", "Gelu", "Add"]),
]


def parse_model(rid: str) -> dict[str, object]:
    """解析 input/*.onnx → identify/op_list.json + fusion_candidates.json。"""
    try:
        import onnx  # 可选依赖（pyproject [onnx] extra）
    except ImportError as exc:
        raise DependencyMissing("onnx", str(exc)) from exc

    root = run_dir(rid)
    task = _load_task(root)
    if task.model is None:
        raise ValueError("task_type=model 才能解析模型")
    model_path = root / task.model.path
    if not model_path.exists():
        raise FileNotFoundError(f"model not found: {model_path}")

    model = onnx.load(str(model_path))
    graph = model.graph
    opset = next((o.version for o in model.opset_import if o.domain in ("", "ai.onnx")), 0)
    if opset < 13:
        raise ValueError(f"opset {opset} < 13（task-schema §1.2）")

    value_shapes = _infer_shapes(graph, task.model.input_shape)

    nodes = [
        OpNode(
            idx=i,
            op_type=n.op_type,
            name=n.name or f"{n.op_type}_{i}",
            attrs={a.name: _attr_value(a) for a in n.attribute},
            input_shapes=[value_shapes.get(v, []) for v in n.input if value_shapes.get(v)],
            output_shapes=[value_shapes.get(v, []) for v in n.output if value_shapes.get(v)],
        )
        for i, n in enumerate(graph.node)
    ]
    by_type: dict[str, int] = {}
    for n in nodes:
        by_type[n.op_type] = by_type.get(n.op_type, 0) + 1
    op_list = OpList(
        model={
            "format": "onnx",
            "opset": opset,
            "ir_version": model.ir_version,
            "input_shape": task.model.input_shape,
        },
        nodes=nodes,
        stats={"by_type": by_type, "total_nodes": len(nodes)},
    )
    (root / "identify" / "op_list.json").write_text(op_list.model_dump_json(indent=2), encoding="utf-8")

    candidates = fusion_scan(rid)
    return {"op_list": json.loads(op_list.model_dump_json()), "fusion_candidates": candidates.model_dump()}


def op_profile(rid: str) -> dict[str, object]:
    """算子热点画像（op_list 的聚合视图）。"""
    root = run_dir(rid)
    path = root / "identify" / "op_list.json"
    if not path.exists():
        raise FileNotFoundError("先运行 parse_model")
    data = json.loads(path.read_text(encoding="utf-8"))
    return {"stats": data.get("stats", {}), "total_nodes": len(data.get("nodes", []))}


def fusion_scan(rid: str) -> FusionCandidates:
    """图模式匹配融合候选（节点 idx 序列命中）。"""
    root = run_dir(rid)
    path = root / "identify" / "op_list.json"
    data = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {"nodes": []}
    types = [n["op_type"] for n in data.get("nodes", [])]

    found: list[FusionCandidate] = []
    seq = 0
    for pattern_name, pattern in _FUSION_PATTERNS:
        n = len(pattern)
        for i in range(len(types) - n + 1):
            if types[i : i + n] == pattern:
                seq += 1
                found.append(
                    FusionCandidate(
                        id=f"F{seq:03d}",
                        pattern=pattern_name,
                        node_idx=list(range(i, i + n)),
                        est_gain_pct=0.0,
                        status="pending",
                    )
                )
    candidates = FusionCandidates(candidates=found)
    (root / "identify" / "fusion_candidates.json").write_text(
        candidates.model_dump_json(indent=2), encoding="utf-8"
    )
    return candidates


def _infer_shapes(graph: object, input_shape: list[int]) -> dict[str, list[int]]:
    """骨架级 shape 推断：图输入 + 已知 initializer 维度（未覆盖输出留空，verify 前补全）。"""
    shapes: dict[str, list[int]] = {}
    for inp in getattr(graph, "input", []):
        dims = [d.dim_value for d in inp.type.tensor_type.shape.dim]
        if dims and all(d > 0 for d in dims):
            shapes[inp.name] = dims
        elif inp.name:
            shapes[inp.name] = list(input_shape)
    for init in getattr(graph, "initializer", []):
        if init.dims:
            shapes[init.name] = list(init.dims)
    return shapes


def _attr_value(attr: object) -> object:
    a = attr
    for field in ("i", "f", "s"):
        v = getattr(a, field)
        if v not in (0, 0.0, b"") and v is not None:
            if field == "s":
                return v.decode("utf-8", errors="replace")
            return v
    ints = getattr(a, "ints", None)
    if ints:
        return list(ints)
    floats = getattr(a, "floats", None)
    if floats:
        return list(floats)
    return None


def _load_task(root: Path) -> TaskYaml:
    from .runs import load_task

    return load_task(root)


class DependencyMissing(Exception):
    def __init__(self, package: str, detail: str) -> None:
        super().__init__(f"missing dependency: {package} ({detail})")
        self.package = package
