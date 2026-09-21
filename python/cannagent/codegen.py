"""implement 阶段支撑：代码生成 / 快照内补丁 / 错误分类（workflow §2.1 implement 契约）。

- code_gen：按 strategy 任务路线渲染实现快照 ``implement/vN/``（operator/ 源码 + build.sh
  + params.json）。v1 支持路线 = aclnn 标量仿射融合（Mul+Add → 单次 aclnnAdd(alpha)）；
  其余路线返回结构化 CANN_E_APPROACH_UNSUPPORTED（诚实占位，不假装成功）。
- patch_code：迭代补丁——在快照内替换/新增文件（模型在 implement⇄verify 环里改代码的真实面）。
- analyze_error：build.log / verify 失败的错误分类（代码层 / API 误用 / 路线不可行 / 环境），
  供 routing 判定会话作 manifest 证据。
"""

from __future__ import annotations

import re
import shutil
from pathlib import Path
from typing import Any

from .config import run_dir

_TEMPLATES = Path(__file__).resolve().parent / "templates"

# dtype → (ELEM_T, ACL_DTYPE, ELEM_SIZE)；v1 仿射模板仅 fp32（fp16 host 侧无半型依赖，v2 再开）
_DTYPE_RENDER: dict[str, tuple[str, str, int]] = {
    "fp32": ("float", "ACL_FLOAT", 4),
}

# 错误分类表（顺序即优先级；命中即归类）——target 是 workflow §2 转移规则的分流建议
_ERROR_CLASSES: list[tuple[str, str, str, str]] = [
    (r"undefined reference|cannot find -l|No such file .*include", "link", "code_level", "implement"),
    (r"error:|错误：|expected .* at end of input", "compile", "code_level", "implement"),
    (r"aclnnStatus=\d+|ACL_ERROR|EZ\d+|FATAL: GetWorkspaceSize|FATAL: aclnn execute",
     "aclnn_api", "api_misuse", "implement"),
    (r"atc.*ERROR|unsupported op|not support|op type .* invalid", "atc", "route_infeasible", "strategy"),
    (r"NPU.*busy|CANN_E_NPU_BUSY", "npu_queue", "env", "implement"),
    (r"timeout|timed out|Timeout", "timeout", "env", "implement"),
]


def code_gen(rid: str, version: str | None = None, shape: list[int] | None = None) -> dict[str, Any]:
    """按 strategy 路线渲染实现快照（幂等：同版本覆盖写）。"""
    root = run_dir(rid)
    from .runs import load_task

    task = load_task(root)
    strategy = _load_json(root / "strategy" / "strategy.json")
    tasks = strategy.get("tasks", [])
    if not tasks:
        raise ValueError("strategy.tasks 为空：无可实现的算子任务")

    affine = [t for t in tasks if "仿射" in str(t.get("approach", ""))]
    if not affine:
        return {
            "ok": False,
            "code": "CANN_E_APPROACH_UNSUPPORTED",
            "message": "v1 code_gen 仅支持「aclnn 标量仿射融合」路线；其余路线属下一开发周期",
            "hint": f"当前任务路线：{[t.get('approach') for t in tasks]}",
        }

    dtype = task.constraints.dtype
    render = _DTYPE_RENDER.get(dtype)
    if render is None:
        return {
            "ok": False,
            "code": "CANN_E_DTYPE_UNSUPPORTED",
            "message": f"仿射模板暂不支持 dtype={dtype}（v1 仅 fp32）",
            "hint": "task.yaml constraints.dtype 调整为 fp32，或等待模板扩展",
        }

    dims = shape or _task_2d_shape(task)
    m, n = dims
    version = version or _next_version(root / "implement")
    out = root / "implement" / version
    (out / "operator").mkdir(parents=True, exist_ok=True)
    (out / "artifacts").mkdir(exist_ok=True)

    elem_t, acl_dtype, elem_size = render
    _copy_lf(_TEMPLATES / "affine_impl.cpp", out / "operator" / "affine_impl.cpp")
    _copy_lf(_TEMPLATES / "om_bench.cpp", out / "operator" / "om_bench.cpp")
    (out / "build.sh").write_text(
        _build_sh(elem_t, acl_dtype, elem_size, m, n), encoding="utf-8", newline="\n"
    )
    (out / "params.json").write_text(
        _dump_json(
            {
                "schema_version": "1.0",
                "version": version,
                "approach": affine[0]["approach"],
                "op_task_id": affine[0]["op_task_id"],
                "candidate_id": affine[0]["candidate_id"],
                "dtype": dtype,
                "shape": [m, n],
            }
        ),
        encoding="utf-8",
    )
    return {
        "version": version,
        "approach": affine[0]["approach"],
        "files": [
            f"implement/{version}/operator/affine_impl.cpp",
            f"implement/{version}/operator/om_bench.cpp",
            f"implement/{version}/build.sh",
            f"implement/{version}/params.json",
        ],
    }


def patch_code(
    rid: str,
    version: str | None = None,
    file: str | None = None,
    content: str | None = None,
) -> dict[str, Any]:
    """快照内文件替换（新版本 = 继承上一版快照后覆盖目标文件）。

    这是 implement⇄verify 迭代环里模型改代码的真实入口：file 为快照内相对路径
    （如 ``operator/affine_impl.cpp``），content 为完整文件内容（v1 整文件替换，
    unified diff 应用属 v2）。
    """
    root = run_dir(rid)
    version = version or _next_version(root / "implement")
    src = root / "implement" / str(_latest_version(root / "implement") or "")
    if not src.exists():
        raise FileNotFoundError("无可继承的实现快照（先 code_gen）")
    dst = root / "implement" / version
    if dst.exists():
        shutil.rmtree(dst)
    shutil.copytree(src, dst)

    if file and content is not None:
        target = _safe_child(dst, file)
        if target is None or ".." in Path(file).parts:
            return {"ok": False, "code": "CANN_E_PATH", "message": f"非法快照内路径：{file}"}
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
    elif file or content is not None:
        return {"ok": False, "code": "CANN_E_ARGS", "message": "file 与 content 必须成对出现"}
    return {
        "version": version,
        "base": src.name,
        "patched": [file] if file else [],
    }


def analyze_error(rid: str, version: str | None = None) -> dict[str, Any]:
    """错误分类（routing manifest 证据；无错时返回 class=none）。"""
    root = run_dir(rid)
    imp = root / "implement"
    version = version or _latest_version(imp)
    log_path = imp / version / "build.log" if version else None
    log = log_path.read_text(encoding="utf-8", errors="replace") if log_path and log_path.exists() else ""

    for pattern, kind, cls, target in _ERROR_CLASSES:
        hits = [ln.strip() for ln in log.splitlines() if re.search(pattern, ln)][:5]
        if hits:
            return {"class": cls, "kind": kind, "target": target, "evidence": hits, "version": version}
    if log.strip():
        tail = [ln.strip() for ln in log.splitlines() if ln.strip()][-5:]
        return {"class": "unknown", "kind": "unclassified", "target": "implement",
                "evidence": tail, "version": version}
    return {"class": "none", "kind": "none", "target": "implement",
            "evidence": [], "version": version}


# ---- 内部 ----


def _copy_lf(src: Path, dst: Path) -> None:
    """模板拷贝并钉死 LF（Windows checkout / write_text 的 CRLF 会破坏远端 bash）。"""
    dst.write_bytes(src.read_bytes().replace(b"\r\n", b"\n"))


def _build_sh(elem_t: str, acl_dtype: str, elem_size: int, m: int, n: int) -> str:
    defines = f"-DELEM_T={elem_t} -DACL_DTYPE={acl_dtype} -DELEM_SIZE={elem_size} -DM={m} -DN={n}"
    return f"""#!/usr/bin/env bash
# 幂等编译脚本（workflow §2.1 implement：exit 0 且 artifacts/ 非空 = 直通判定）
set -euo pipefail
CANN_HOME="$(readlink -f /usr/local/Ascend/cann)"
mkdir -p artifacts
g++ -O2 -std=c++17 {defines} \\
  -I"$CANN_HOME/include" operator/affine_impl.cpp -o artifacts/affine_impl \\
  -L"$CANN_HOME/lib64" -lascendcl -lopapi -lnnopbase
g++ -O2 -std=c++17 -I"$CANN_HOME/include" operator/om_bench.cpp -o artifacts/om_bench \\
  -L"$CANN_HOME/lib64" -lascendcl
echo BUILD_OK
"""


def _task_2d_shape(task: Any) -> list[int]:
    if task.model is not None and len(task.model.input_shape) >= 2:
        dims = task.model.input_shape[-2:]
        if all(isinstance(d, int) and d > 0 for d in dims):
            return [int(d) for d in dims]
    if task.operator is not None:
        shape = task.operator.inputs[0].get("shape") if task.operator.inputs else None
        if isinstance(shape, list) and len(shape) >= 2:
            return [int(shape[-2]), int(shape[-1])]
    raise ValueError("无法确定仿射作用域 shape（task.model.input_shape 或 operator.inputs[0].shape）")


def _next_version(root: Path) -> str:
    from .build import next_version

    return next_version(root)


def _latest_version(imp: Path) -> str | None:
    """已存在的最大版本号（空目录 → None）。"""
    if not imp.exists():
        return None
    nums = [int(d.name[1:]) for d in imp.iterdir() if d.is_dir() and d.name.startswith("v")
            and d.name[1:].isdigit()]
    return f"v{max(nums)}" if nums else None


def _safe_child(base: Path, rel: str) -> Path | None:
    try:
        return base / rel
    except (ValueError, OSError):
        return None


def _load_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        raise FileNotFoundError(f"缺少前置产物：{path}")
    import json

    data = json.loads(path.read_text(encoding="utf-8"))
    return data if isinstance(data, dict) else {"_raw": data}


def _dump_json(obj: dict[str, Any]) -> str:
    import json

    return json.dumps(obj, ensure_ascii=False, indent=2)
