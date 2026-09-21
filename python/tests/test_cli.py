"""CLI 子命令端到端（D3 契约：stdin JSON → stdout 单 JSON → 退出码）。"""

from __future__ import annotations

import json
import subprocess
import sys

import pytest


def run_cli(
    args: list[str], payload: dict | None = None, env: dict[str, str] | None = None
) -> tuple[int, dict]:
    proc = subprocess.run(
        [sys.executable, "-m", "cannagent", *args],
        input=json.dumps(payload or {}),
        capture_output=True,
        text=True,
        env=env,
        timeout=60,
    )
    return proc.returncode, json.loads(proc.stdout)


def test_events_append_via_cli(workspace, run_id):
    code, out = run_cli(
        ["events", "append", "--payload-stdin"],
        {"run_id": run_id, "kind": "tool_started", "tool": {"name": "parse_model"}},
    )
    assert code == 0 and out["ok"] and out["seq"] == 1


def test_runs_create_via_cli(workspace):
    task = {
        "schema_version": "1.0",
        "task_type": "operator",
        "task_name": "探针",
        "operator": {
            "pattern": "Relu",
            "inputs": [{"shape": [1], "dtype": "fp16", "layout": "NCHW"}],
            "outputs": [{"shape": [1], "dtype": "fp16", "layout": "NCHW"}],
        },
        "target": {"gain_pct": 1},
    }
    code, out = run_cli(["runs"], {"task": task})
    assert code == 0 and out["ok"]
    assert out["run_id"].startswith("r20")


def test_unsupported_approach_structured(workspace):
    # 七阶段域已真实现；不支持路线返回结构化 CANN_E_APPROACH_UNSUPPORTED（诚实占位）
    from cannagent.runs import create_run
    from cannagent.task_schema import TaskYaml

    root = create_run(
        TaskYaml.model_validate(
            {
                "schema_version": "1.0",
                "task_type": "model",
                "task_name": "cli 占位语义",
                "model": {"path": "input/a.onnx", "opset": 13, "input_shape": [64, 64]},
                "target": {"gain_pct": 10},
            }
        )
    )
    (root / "identify" / "op_list.json").write_text(
        json.dumps({"schema_version": "1.0", "model": {}, "nodes": [], "stats": {}}),
        encoding="utf-8",
    )
    (root / "identify" / "fusion_candidates.json").write_text(
        json.dumps(
            {
                "schema_version": "1.0",
                "candidates": [
                    {"id": "F001", "pattern": "Conv+BN", "node_idx": [0, 1],
                     "est_gain_pct": 0.0, "status": "pending"},
                ],
            }
        ),
        encoding="utf-8",
    )
    code, out = run_cli(["strategy-gen"], {"run_id": root.name})
    assert code == 0 and out["strategy"]["selected"] == ["F001"]
    code, out = run_cli(["code-gen"], {"run_id": root.name})
    assert code == 1
    assert out["ok"] is False and out["code"] == "CANN_E_APPROACH_UNSUPPORTED"


def test_invalid_stdin_structured_error():
    proc = subprocess.run(
        [sys.executable, "-m", "cannagent", "parse-model"],
        input="not json",
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert proc.returncode == 1
    out = json.loads(proc.stdout)
    assert out["ok"] is False and "JSONDecodeError" in out["message"]


def test_parse_model_real_onnx(workspace):
    """D3 全链路首通：真实 onnx → op_list + fusion_candidates 落盘。"""
    onnx = pytest.importorskip("onnx")  # 可选依赖缺席则跳过
    from cannagent.runs import create_run
    from cannagent.task_schema import TaskYaml

    helper = onnx.helper
    graph = helper.make_graph(
        [
            helper.make_node("Conv", ["x", "w"], ["c1"], name="conv1", kernel_shape=[3, 3]),
            helper.make_node("BatchNormalization", ["c1"], ["b1"], name="bn1"),
            helper.make_node("Relu", ["b1"], ["y"], name="relu1"),
        ],
        "g",
        [helper.make_tensor_value_info("x", onnx.TensorProto.FLOAT, [1, 3, 8, 8])],
        [helper.make_tensor_value_info("y", onnx.TensorProto.FLOAT, [1, 3, 8, 8])],
    )
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 13)])
    model_path = workspace / "probe.onnx"
    onnx.save(model, str(model_path))

    task = TaskYaml.model_validate(
        {
            "schema_version": "1.0",
            "task_type": "model",
            "task_name": "probe",
            "model": {"path": f"input/{model_path.name}", "opset": 13, "input_shape": [1, 3, 8, 8]},
            "target": {"gain_pct": 1},
        }
    )

    root = create_run(task, input_files=[model_path])
    code, out = run_cli(["parse-model"], {"run_id": root.name})
    assert code == 0  # 成功输出纯领域字段（无 ok 包裹——工具 output schema 契约）
    nodes = out["op_list"]["nodes"]
    assert [n["op_type"] for n in nodes] == ["Conv", "BatchNormalization", "Relu"]
    # Conv+BN+ReLU 模式命中
    cands = out["fusion_candidates"]["candidates"]
    assert any(c["pattern"] == "Conv+BN+ReLU" and c["node_idx"] == [0, 1, 2] for c in cands)
    # 产物文件真实落盘
    identify = root / "identify"
    assert (identify / "op_list.json").exists()
    assert (identify / "fusion_candidates.json").exists()
