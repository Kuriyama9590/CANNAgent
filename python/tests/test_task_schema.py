"""task.yaml 双 schema 与产物模型校验（task-schema.md / rag.md §3 / workflow §2.1）。"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from cannagent.task_schema import (
    AccuracyReport,
    Budgets,
    ExperienceEntry,
    TaskYaml,
)

MODEL_TASK = {
    "schema_version": "1.0",
    "task_type": "model",
    "task_name": "resnet50 算子融合优化",
    "model": {"path": "input/resnet50.onnx", "opset": 13, "input_shape": [16, 3, 224, 224]},
    "target": {"gain_pct": 5},
}

OPERATOR_TASK = {
    "schema_version": "1.0",
    "task_type": "operator",
    "task_name": "Conv3x3 融合",
    "operator": {
        "pattern": "Conv3x3 + BN + ReLU",
        "inputs": [{"shape": [32, 64, 32, 32], "dtype": "fp16", "layout": "NCHW"}],
        "outputs": [{"shape": [32, 64, 32, 32], "dtype": "fp16", "layout": "NCHW"}],
        "attrs": {"kernel": [3, 3]},
    },
    "target": {"gain_pct": 8},
}


def test_model_task_defaults():
    t = TaskYaml.model_validate(MODEL_TASK)
    assert t.baseline.impl == "aclnn"  # D4：默认 aclnn（无 ATC 图融合）
    assert t.baseline.atc == "enabled"
    assert t.budgets.max_wall_min == 90  # workflow §3 缺省
    assert t.budgets.max_tokens == 1_000_000
    assert t.constraints.max_fusion_count == 6


def test_operator_task_valid():
    t = TaskYaml.model_validate(OPERATOR_TASK)
    assert t.operator is not None and t.operator.pattern.startswith("Conv3x3")


def test_model_task_requires_model_section():
    bad = {k: v for k, v in MODEL_TASK.items() if k != "model"}
    with pytest.raises(ValidationError, match="model 段"):
        TaskYaml.model_validate(bad)


def test_opset_below_13_rejected():
    bad = {**MODEL_TASK, "model": {**MODEL_TASK["model"], "opset": 11}}
    with pytest.raises(ValidationError):
        TaskYaml.model_validate(bad)


def test_extra_fields_rejected():
    with pytest.raises(ValidationError):
        TaskYaml.model_validate({**MODEL_TASK, "unknown_field": 1})


def test_no_iteration_cap():
    with pytest.raises(ValidationError):
        Budgets.model_validate({"max_iterations": 3})  # 2026-09-17 拍板：无次数上限


def test_accuracy_failures_consistency():
    ok = AccuracyReport(
        version="v1", passed=79, total=80, max_rel_err=1e-4, seed=42, failures=[{"case_id": "case_042"}]
    )
    assert not ok.passed_threshold  # 明细一致可构造，但有失败用例 → 不达标
    ok2 = AccuracyReport(version="v1", passed=80, total=80, max_rel_err=1e-4, seed=42)
    assert ok2.passed_threshold
    # 失败明细与计数不一致 → 拒收
    with pytest.raises(ValidationError):
        AccuracyReport(
            version="v1", passed=78, total=80, max_rel_err=1e-4, seed=42, failures=[{"case_id": "c1"}]
        )
    # 超阈值 → 不达标（硬卡点判据）
    bad = AccuracyReport(version="v1", passed=80, total=80, max_rel_err=1e-2, seed=42)
    assert not bad.passed_threshold


def _experience_kwargs(**over):
    base = {
        "id": "exp-20260920-a1b2c3d4",
        "run_id": "r20260920-120000-abc12345",
        "created_at": "2026-09-20T12:00:00+08:00",
        "problem": "Conv+BN+ReLU 融合",
        "context": {"dtype": "fp16", "device": "Ascend910B"},
        "solution": "AscendC 融合 kernel",
        "outcome": {"status": "success", "gain_pct": 6.2},
        "reuse_when": "910B fp16 NCHW",
    }
    return {**base, **over}


def test_experience_rules():
    assert ExperienceEntry.model_validate(_experience_kwargs()).status == "draft"
    # 失败条目 root_cause 必填
    with pytest.raises(ValidationError, match="root_cause"):
        ExperienceEntry.model_validate(_experience_kwargs(outcome={"status": "failed"}))
    # 自动回流不允许直接 approved
    with pytest.raises(ValidationError):
        ExperienceEntry.model_validate(_experience_kwargs(status="approved"))
    # 人工条目可直接 approved
    manual = ExperienceEntry.model_validate(_experience_kwargs(source="manual", status="approved"))
    assert manual.status == "approved"


def test_output_field_accepted():
    t = TaskYaml.model_validate({**MODEL_TASK, "output": {"report_lang": "zh"}})
    assert t.output == {"report_lang": "zh"}


def test_model_operator_mutual_exclusion():
    with pytest.raises(ValidationError, match="互斥"):
        TaskYaml.model_validate({**MODEL_TASK, "operator": OPERATOR_TASK["operator"]})
    with pytest.raises(ValidationError, match="互斥"):
        TaskYaml.model_validate({**OPERATOR_TASK, "model": MODEL_TASK["model"]})
