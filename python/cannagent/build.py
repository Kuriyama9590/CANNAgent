"""build 子命令（C5）：ATC 编译任务包端到端（D9）。

流程：run 目录取输入 onnx → 任务包下发（remote.RemoteRunner）→ 服务器 atc 编译
（soc_version=Ascend910B，--log=info 供 C12 清单采集）→ om + 日志回传落盘
implement/v{N}/（完整快照）→ 返回结构化结果。编译成功即 implement 直通判定产物。
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from .config import run_dir
from .remote import RemoteError, RemoteRunner

SOC_VERSION = "Ascend910B"


def next_version(root: Path) -> str:
    """下一迭代号 v1..vN（完整快照语义，task-schema §2）。"""
    if not root.exists():
        return "v1"
    versions = [d.name for d in root.iterdir() if d.is_dir() and d.name.startswith("v")]
    nums = sorted(int(v[1:]) for v in versions if v[1:].isdigit())
    return f"v{(nums[-1] + 1) if nums else 1}"


def build(rid: str, version: str | None = None) -> dict[str, Any]:
    """实现编译（直通判定产物生产）。

    双车道（workflow §2.1 implement）：
    - 算子路线：implement/vN/build.sh 存在 → 远程编译快照（g++，artifacts = 可执行）
    - 模型路线：task.model 输入 onnx → 服务器 atc 编译（soc_version=Ascend910B）
    """
    root = run_dir(rid)
    from .runs import load_task

    task = load_task(root)
    version = version or next_version(root / "implement")
    imp = root / "implement" / version

    if (imp / "build.sh").exists():
        return _compile_snapshot(root, rid, version, imp)
    return _build_atc(root, task, rid, version)


def _compile_snapshot(root: Path, rid: str, version: str, imp: Path) -> dict[str, Any]:
    """算子路线：任务包 = 实现快照 → bash build.sh → 二进制回填 artifacts/。"""
    files = {str(p.relative_to(imp).as_posix()): p.read_bytes() for p in imp.rglob("*") if p.is_file()}
    result = RemoteRunner().run_package(
        package=f"{rid}-build-{version}",
        files=files,
        command="bash build.sh",
        expect_outputs=["artifacts/affine_impl"],
        timeout=600,
        need_npu=False,  # 纯编译；NPU 锁留给 verify/bench（D6）
    )
    (imp / "build.log").write_text(result["log"], encoding="utf-8")
    binary = result["outputs"].get("artifacts/affine_impl")
    if binary:
        (imp / "artifacts").mkdir(exist_ok=True)
        (imp / "artifacts" / "affine_impl").write_bytes(binary)
    return {
        "ok": bool(result["ok"] and binary),
        "version": version,
        "lane": "operator",
        "artifacts": {"binary": f"implement/{version}/artifacts/affine_impl"} if binary else {},
        "exit_code": result.get("exit_code"),
        "log_path": f"implement/{version}/build.log",
    }


def _build_atc(root: Path, task: Any, rid: str, version: str) -> dict[str, Any]:
    """模型路线：ATC 编译（既有实现）。"""
    if task.model is None:
        raise ValueError("build 需要整网模型输入（task_type=model）")
    onnx_path = root / task.model.path
    if not onnx_path.exists():
        raise FileNotFoundError(f"model not found: {onnx_path}")

    out_dir = root / "implement" / version
    (out_dir / "artifacts").mkdir(parents=True, exist_ok=True)

    base = onnx_path.stem
    result = RemoteRunner().run_package(
        package=f"{rid}-build-{version}",
        files={onnx_path.name: onnx_path.read_bytes()},
        command=(
            f"atc --framework=5 --model={shq(onnx_path.name)} --soc_version={SOC_VERSION} "
            f"--output={shq(base)} --log=info; "
            f"rc=$?; mv -f {shq(base)}.om ../out/ 2>/dev/null; "
            f"cp -f fusion_result.json ../out/ 2>/dev/null; exit $rc"
        ),
        # fusion_result.json = ATC 逐 pass 生效记录（C12 权威源）；全量 stdout 经 tee 回传
        expect_outputs=[f"{base}.om", "fusion_result.json"],
        timeout=900,
        need_npu=False,  # atc 编译走 CPU，NPU 锁留给 run/bench（D6）
    )
    (out_dir / "build.log").write_text(result["log"], encoding="utf-8")
    om = result["outputs"].get(f"{base}.om")
    if om:
        (out_dir / "artifacts" / f"{base}.om").write_bytes(om)

    if om:
        # C12：ATC 优化清单（workflow §2.1 bench 段 schema）——fusion_result.json 为权威源
        fusion = result["outputs"].get("fusion_result.json", b"")
        atc_list = _collect_atc_list(fusion, result["log"], version)
        if atc_list:
            (root / "bench").mkdir(exist_ok=True)
            (root / "bench" / f"atc_opt_list_{version}.json").write_text(atc_list, encoding="utf-8")

    return {
        "ok": bool(result["ok"] and om),
        "version": version,
        "lane": "model",
        "artifacts": {"om": f"implement/{version}/artifacts/{base}.om"} if om else {},
        "exit_code": result.get("exit_code"),
        "log_path": f"implement/{version}/build.log",
    }


def _collect_atc_list(fusion_result: bytes, atc_log: str, version: str) -> str | None:
    """C12：fusion_result.json（权威）→ passes；缺席时退回 stdout 日志解析。"""
    import json

    from .atc_list import parse_atc_log, parse_fusion_result

    data = (
        parse_fusion_result(fusion_result.decode("utf-8", errors="replace"))
        if fusion_result
        else parse_atc_log(atc_log)
    )
    if not data["passes"]:
        return None
    payload = {
        "schema_version": "1.0",
        "version": version,
        "source": "atc --log=info（任务包回传）",
        "passes": data["passes"],
        "overlap_with_ours": [],
    }
    return json.dumps(payload, ensure_ascii=False, indent=2)


def shq(s: str) -> str:
    return "'" + s.replace("'", "'\\''") + "'"


def remote_unavailable(exc: RemoteError) -> dict[str, Any]:
    return {"ok": False, "code": exc.code, "message": str(exc), "hint": "检查 .env 的 CANN_SERVER_*"}
