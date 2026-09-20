"""CLI 入口（C3 插件的转发目标）：`python -m cannagent <subcommand>`。

契约（plugin-dev §3 / SPEC §3）：
- 参数 JSON 走 stdin；stdout 输出单 JSON 对象；退出码 0/1
- 失败输出 ``{ok: false, code, message, hint}``（官方错误码原样保留）
- 子命令幂等（固定 seed / 覆盖写）

领域模块互相禁止 import（SPEC §1）——全部经本文件组合。
"""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Callable
from typing import Any

EXIT_OK = 0
EXIT_FAIL = 1


def _read_stdin_json() -> dict[str, Any]:
    raw = sys.stdin.read()
    if not raw.strip():
        return {}
    data = json.loads(raw)
    if not isinstance(data, dict):
        raise ValueError("stdin payload 必须是 JSON 对象")
    return data


def _emit(obj: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False, default=str) + "\n")
    sys.stdout.flush()


def _not_implemented(subcommand: str, needed_by: str) -> Callable[[dict[str, Any]], dict[str, Any]]:
    def handler(_args: dict[str, Any]) -> dict[str, Any]:
        return {
            "ok": False,
            "code": "CANN_E_NOT_IMPLEMENTED",
            "message": f"子命令 {subcommand} 属于 {needed_by} 交付范围，骨架期未实现",
            "hint": "见 docs/ROADMAP.md 阶段③ 任务分解",
        }

    return handler


def _handler_events() -> Callable[[dict[str, Any]], dict[str, Any]]:
    def handler(args: dict[str, Any]) -> dict[str, Any]:
        from . import events as events_mod

        rid = args.get("run_id") or ""
        payload = (
            json.loads(args.get("payload", "{}"))
            if isinstance(args.get("payload"), str)
            else args.get("payload", {})
        )
        if not rid:
            rid = str(payload.get("run_id") or "")
        seq = events_mod.append_event(rid, payload)
        return {"ok": True, "seq": seq}

    return handler


def _handler_checkpoint_write() -> Callable[[dict[str, Any]], dict[str, Any]]:
    def handler(args: dict[str, Any]) -> dict[str, Any]:
        from . import checkpoint as cp

        rid = str(args.get("run_id", ""))
        state = args.get("state", {})
        if not isinstance(state, dict):
            raise ValueError("state 必须是对象")
        path = cp.write_checkpoint(rid, str(args.get("stage", "")), str(args.get("iter", "")), state)
        return {"ok": True, "path": str(path)}

    return handler


def _handler_checkpoint_read() -> Callable[[dict[str, Any]], dict[str, Any]]:
    def handler(args: dict[str, Any]) -> dict[str, Any]:
        from . import checkpoint as cp

        rid = str(args.get("run_id", ""))
        if args.get("latest"):
            return {"ok": True, "state": cp.latest_checkpoint(rid)}
        state = cp.read_checkpoint(rid, str(args.get("stage", "")), str(args.get("iter", "")))
        return {"ok": True, "state": state}

    return handler


def _handler_runs() -> Callable[[dict[str, Any]], dict[str, Any]]:
    def handler(args: dict[str, Any]) -> dict[str, Any]:
        from .runs import create_run

        task_data = args.get("task", {})
        input_files = [str(p) for p in args.get("input_files", [])]
        from pathlib import Path

        from .task_schema import TaskYaml

        task = TaskYaml.model_validate(task_data)
        root = create_run(task, input_files=[Path(p) for p in input_files])
        return {"ok": True, "run_id": root.name, "run_dir": str(root)}

    return handler


def _handler_parse_model() -> Callable[[dict[str, Any]], dict[str, Any]]:
    def handler(args: dict[str, Any]) -> dict[str, Any]:
        from .identify import parse_model

        rid = str(args.get("run_id", ""))
        return parse_model(rid)

    return handler


def _handler_op_profile() -> Callable[[dict[str, Any]], dict[str, Any]]:
    def handler(args: dict[str, Any]) -> dict[str, Any]:
        from .identify import op_profile

        return op_profile(str(args.get("run_id", "")))

    return handler


def _handler_fusion_scan() -> Callable[[dict[str, Any]], dict[str, Any]]:
    def handler(args: dict[str, Any]) -> dict[str, Any]:
        from .identify import fusion_scan

        result = fusion_scan(str(args.get("run_id", "")))
        return {"fusion_candidates": result.model_dump()}

    return handler


def _handler_knowledge() -> Callable[[dict[str, Any]], dict[str, Any]]:
    def handler(args: dict[str, Any]) -> dict[str, Any]:
        from .knowledge import handle

        return handle(args)

    return handler


SUBCOMMANDS: dict[str, Callable[[dict[str, Any]], dict[str, Any]]] = {
    # 真实现（C4 交付）
    "events": _handler_events(),
    "checkpoint": _handler_checkpoint_write(),
    "checkpoint-read": _handler_checkpoint_read(),
    "runs": _handler_runs(),
    "parse-model": _handler_parse_model(),
    "op-profile": _handler_op_profile(),
    "fusion-scan": _handler_fusion_scan(),
    "knowledge": _handler_knowledge(),
    # 结构化占位（后续任务交付）
    "strategy-gen": _not_implemented("strategy-gen", "C4 后续/C6 RAG 接入"),
    "code-gen": _not_implemented("code-gen", "C5 build 链路"),
    "patch-code": _not_implemented("patch-code", "C5"),
    "build": _not_implemented("build", "C5（任务包下发昇腾服务器）"),
    "analyze-error": _not_implemented("analyze-error", "C5"),
    "gen-test": _not_implemented("gen-test", "C5/verify 链路"),
    "run-test": _not_implemented("run-test", "C5（aclnn 基线对照，benchmark §3）"),
    "analyze-accuracy": _not_implemented("analyze-accuracy", "C5"),
    "bench-setup": _not_implemented("bench-setup", "C5（benchmark §2 环境指纹）"),
    "run-bench": _not_implemented("run-bench", "C5（三份对照，benchmark §4）"),
    "package": _not_implemented("package", "deliver 链路"),
    "gen-report": _not_implemented("gen-report", "deliver 链路"),
}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="cannagent", description="CannAgent 领域执行层 CLI")
    parser.add_argument("subcommand", choices=sorted(SUBCOMMANDS))
    parser.add_argument(
        "--payload-stdin", action="store_true", help="payload 从 stdin 读（events append 用）"
    )
    parser.add_argument("--latest", action="store_true", help="checkpoint-read：取最新检查点")
    args, _ = parser.parse_known_args(argv)

    try:
        stdin_json = _read_stdin_json()
        if args.payload_stdin:
            stdin_json = {"payload": stdin_json}
        result = SUBCOMMANDS[args.subcommand](stdin_json)
        _emit(result)
        return EXIT_OK if result.get("ok", True) else EXIT_FAIL
    except Exception as exc:  # noqa: BLE001 —— CLI 边界统一转结构化错误
        _emit(
            {
                "ok": False,
                "code": "CANN_E_PYTHON_EXIT",
                "message": f"{type(exc).__name__}: {exc}",
                "hint": "官方错误码（E1xx 等）在 message 原文中保留",
            }
        )
        return EXIT_FAIL


if __name__ == "__main__":
    sys.exit(main())
