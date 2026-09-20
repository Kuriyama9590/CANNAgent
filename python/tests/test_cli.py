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


def test_not_implemented_subcommand_structured(workspace, run_id):
    code, out = run_cli(["build"], {"run_id": run_id, "version": "v1"})
    assert code == 1
    assert out["ok"] is False and out["code"] == "CANN_E_NOT_IMPLEMENTED"


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
