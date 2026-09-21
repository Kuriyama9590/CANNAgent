"""任务输入双 Schema 与阶段产物模型（task-schema.md 权威 pydantic 实现）。

模型变更须同步 docs/task-schema.md（SPEC §3.1：schema 即文档）。
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class BaselineMetric(StrictModel):
    warmup: int = 20
    iters: int = 100
    stats: list[str] = Field(default_factory=lambda: ["p50", "p99"])
    epsilon: float = 0.0  # bench 噪声容差（默认 0 = 严格优于；benchmark §6）


class Baseline(StrictModel):
    kind: Literal["official", "custom"] = "official"
    impl: Literal["aclnn", "torch_npu"] = "aclnn"
    atc: Literal["enabled", "disabled"] = "enabled"
    metric: BaselineMetric = Field(default_factory=BaselineMetric)


class Budgets(StrictModel):
    max_wall_min: int = 90
    max_tokens: int = 1_000_000
    # 无迭代次数上限（2026-09-17 拍板）：不接受 max_iterations 字段
    model_config = ConfigDict(extra="forbid")


class ModelInput(StrictModel):
    path: str
    format: Literal["onnx"] = "onnx"
    opset: int = Field(ge=13)
    input_shape: list[int] = Field(min_length=1)  # 静态固化；动态轴 v1 拒收


class OperatorSpec(StrictModel):
    pattern: str
    inputs: list[dict[str, object]]
    outputs: list[dict[str, object]]
    attrs: dict[str, object] = Field(default_factory=dict)


class Constraints(StrictModel):
    dtype: str = "fp16"
    exclude_ops: list[str] = Field(default_factory=list)
    max_fusion_count: int = 6


class Target(StrictModel):
    gain_pct: float = Field(ge=0)


class TaskYaml(StrictModel):
    """task.yaml 根模型（task-schema §1）。"""

    schema_version: Literal["1.0"] = "1.0"
    task_type: Literal["model", "operator"]
    task_name: str = Field(min_length=1)
    model: ModelInput | None = None
    operator: OperatorSpec | None = None
    constraints: Constraints = Field(default_factory=Constraints)
    target: Target
    output: dict[str, object] | None = None  # 交付要求覆盖（task-schema §1.1，自由键值）
    baseline: Baseline = Field(default_factory=Baseline)
    budgets: Budgets = Field(default_factory=Budgets)

    @model_validator(mode="after")
    def _check_type_fields(self) -> TaskYaml:
        if self.task_type == "model":
            if self.model is None:
                raise ValueError("task_type=model 需要 model 段")
            if self.operator is not None:
                raise ValueError("task_type=model 不允许携带 operator 段（互斥，task-schema §1.1）")
        else:
            if self.operator is None:
                raise ValueError("task_type=operator 需要 operator 段")
            if self.model is not None:
                raise ValueError("task_type=operator 不允许携带 model 段（互斥，task-schema §1.1）")
        return self


# ---- identify 产物（workflow §2.1） ----


class OpNode(StrictModel):
    idx: int
    op_type: str
    name: str
    attrs: dict[str, object] = Field(default_factory=dict)
    input_shapes: list[list[int]] = Field(default_factory=list)
    output_shapes: list[list[int]] = Field(default_factory=list)
    dtype: str = "fp16"


class OpList(StrictModel):
    schema_version: str = "1.0"
    model: dict[str, object]
    nodes: list[OpNode]
    stats: dict[str, object] = Field(default_factory=dict)


class FusionCandidate(StrictModel):
    id: str
    pattern: str
    node_idx: list[int]
    est_gain_pct: float = 0.0
    references: list[str] = Field(default_factory=list)
    status: Literal["pending", "selected", "rejected"] = "pending"


class FusionCandidates(StrictModel):
    schema_version: str = "1.0"
    candidates: list[FusionCandidate] = Field(default_factory=list)


# ---- strategy 产物（workflow §2.1） ----


class StrategyTask(StrictModel):
    op_task_id: str
    candidate_id: str
    approach: str
    target_gain_pct: float
    risk: Literal["low", "mid", "high"]
    order: int


class StrategyRejected(StrictModel):
    candidate_id: str
    reason: str


class StrategyReport(StrictModel):
    schema_version: str = "1.0"
    selected: list[str]
    tasks: list[StrategyTask]
    rejected: list[StrategyRejected] = Field(default_factory=list)
    fallback: str = ""

    @model_validator(mode="after")
    def _selected_covered(self) -> StrategyReport:
        have = {t.candidate_id for t in self.tasks}
        for cid in self.selected:
            if cid not in have:
                raise ValueError(f"selected 候选 {cid} 缺少对应 tasks 项（workflow §2.1 校验点）")
        return self


# ---- verify / bench 产物（workflow §2.1；口径见 benchmark.md） ----


class AccuracyReport(StrictModel):
    schema_version: str = "1.0"
    version: str
    passed: int
    total: int
    max_rel_err: float
    threshold: float = 1e-3
    failures: list[dict[str, object]] = Field(default_factory=list)
    seed: int
    duration_ms: int = 0

    @model_validator(mode="after")
    def _failures_consistent(self) -> AccuracyReport:
        if self.failures and len(self.failures) != self.total - self.passed:
            raise ValueError("failures 数量必须等于 total − passed")
        return self

    @property
    def passed_threshold(self) -> bool:
        return self.max_rel_err <= self.threshold and not self.failures


class BenchReport(StrictModel):
    schema_version: str = "1.0"
    version: str
    impl: Literal["aclnn", "torch_npu"]
    metric: BaselineMetric
    p50_us: float
    p99_us: float = 0.0
    mean_us: float = 0.0
    sync: str = "aclrtSynchronizeStream"
    device: str = Field(min_length=1)  # 必填（benchmark §4 校验点）
    note: str = ""


class AtcPass(StrictModel):
    name: str
    scope: str
    applied: bool


class AtcOptList(StrictModel):
    schema_version: str = "1.0"
    version: str
    source: str
    passes: list[AtcPass]
    overlap_with_ours: list[str] = Field(default_factory=list)


# ---- 经验条目（rag.md §3 权威） ----


class ExperienceOutcome(StrictModel):
    status: Literal["success", "partial", "failed"]
    gain_pct: float | None = None
    max_rel_err: float | None = None
    atc_coverage: Literal["stronger_than_atc", "not_covered", "invalid"] | None = None


class ExperienceEntry(StrictModel):
    schema_version: str = "1.0"
    id: str = Field(pattern=r"^exp-[0-9]{8}-[0-9a-f]{8}$")
    run_id: str
    source: Literal["auto", "manual"] = "auto"
    status: Literal["draft", "approved", "rejected"] = "draft"
    created_at: str
    problem: str = Field(min_length=1)
    context: dict[str, str]
    root_cause: str | None = None
    solution: str
    outcome: ExperienceOutcome
    reuse_when: str
    references: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def _rules(self) -> ExperienceEntry:
        if self.outcome.status != "success" and not self.root_cause:
            raise ValueError("失败/部分成功条目 root_cause 必填")
        if self.source == "auto" and self.status != "draft":
            raise ValueError("自动回流条目起始 status 必须为 draft")
        if "device" not in self.context or "dtype" not in self.context:
            raise ValueError("context.device 与 context.dtype 必填（检索过滤面）")
        return self
