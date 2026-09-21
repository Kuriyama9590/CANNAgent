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


def _handler_build() -> Callable[[dict[str, Any]], dict[str, Any]]:
    def handler(args: dict[str, Any]) -> dict[str, Any]:
        from .build import build
        from .remote import RemoteError

        rid = str(args.get("run_id", ""))
        version = args.get("version")
        try:
            return build(rid, str(version) if isinstance(version, str) else None)
        except RemoteError as exc:
            return {"ok": False, "code": exc.code, "message": str(exc), "hint": "检查 .env 的 CANN_SERVER_*"}

    return handler


def _handler_knowledge() -> Callable[[dict[str, Any]], dict[str, Any]]:
    def handler(args: dict[str, Any]) -> dict[str, Any]:
        from .knowledge import handle

        return handle(args)

    return handler


def _handler_strategy_gen() -> Callable[[dict[str, Any]], dict[str, Any]]:
    def handler(args: dict[str, Any]) -> dict[str, Any]:
        from .strategy import generate

        return generate(str(args.get("run_id", "")))

    return handler


def _handler_code_gen() -> Callable[[dict[str, Any]], dict[str, Any]]:
    def handler(args: dict[str, Any]) -> dict[str, Any]:
        from .codegen import code_gen

        shape = args.get("shape")
        return code_gen(
            str(args.get("run_id", "")),
            version=str(args["version"]) if args.get("version") else None,
            shape=[int(d) for d in shape] if isinstance(shape, list) else None,
        )

    return handler


def _handler_patch_code() -> Callable[[dict[str, Any]], dict[str, Any]]:
    def handler(args: dict[str, Any]) -> dict[str, Any]:
        from .codegen import patch_code

        return patch_code(
            str(args.get("run_id", "")),
            version=str(args["version"]) if args.get("version") else None,
            file=str(args["file"]) if args.get("file") else None,
            content=str(args["content"]) if args.get("content") is not None else None,
        )

    return handler


def _handler_analyze_error() -> Callable[[dict[str, Any]], dict[str, Any]]:
    def handler(args: dict[str, Any]) -> dict[str, Any]:
        from .codegen import analyze_error

        result = analyze_error(
            str(args.get("run_id", "")),
            version=str(args["version"]) if args.get("version") else None,
        )
        return {"analysis": result}

    return handler


def _handler_gen_test() -> Callable[[dict[str, Any]], dict[str, Any]]:
    def handler(args: dict[str, Any]) -> dict[str, Any]:
        from .verify import gen_test

        version = str(args.get("version", ""))
        if not version:
            raise ValueError("gen-test 需要 version")
        seed = args.get("seed")
        cases = args.get("cases")
        return gen_test(
            str(args.get("run_id", "")),
            version,
            seed=int(seed) if seed is not None else None,
            cases=int(cases) if cases is not None else None,
        )

    return handler


def _handler_run_test() -> Callable[[dict[str, Any]], dict[str, Any]]:
    def handler(args: dict[str, Any]) -> dict[str, Any]:
        from .remote import RemoteError
        from .verify import run_test

        version = str(args.get("version", ""))
        if not version:
            raise ValueError("run-test 需要 version")
        threshold = args.get("threshold")
        try:
            return run_test(
                str(args.get("run_id", "")),
                version,
                threshold=float(threshold) if threshold is not None else None,
            )
        except RemoteError as exc:
            return {"ok": False, "code": exc.code, "message": str(exc), "hint": "检查 .env 的 CANN_SERVER_*"}

    return handler


def _handler_analyze_accuracy() -> Callable[[dict[str, Any]], dict[str, Any]]:
    def handler(args: dict[str, Any]) -> dict[str, Any]:
        from .verify import analyze_accuracy

        return analyze_accuracy(
            str(args.get("run_id", "")),
            version=str(args["version"]) if args.get("version") else None,
        )

    return handler


def _handler_bench_setup() -> Callable[[dict[str, Any]], dict[str, Any]]:
    def handler(args: dict[str, Any]) -> dict[str, Any]:
        from .bench import bench_setup
        from .remote import RemoteError

        try:
            return bench_setup(str(args.get("run_id", "")))
        except RemoteError as exc:
            return {"ok": False, "code": exc.code, "message": str(exc), "hint": "检查 .env 的 CANN_SERVER_*"}

    return handler


def _handler_run_bench() -> Callable[[dict[str, Any]], dict[str, Any]]:
    def handler(args: dict[str, Any]) -> dict[str, Any]:
        from .bench import run_bench
        from .remote import RemoteError

        version = str(args.get("version", ""))
        if not version:
            raise ValueError("run-bench 需要 version")
        try:
            return run_bench(str(args.get("run_id", "")), version)
        except RemoteError as exc:
            return {"ok": False, "code": exc.code, "message": str(exc), "hint": "检查 .env 的 CANN_SERVER_*"}

    return handler


def _handler_package() -> Callable[[dict[str, Any]], dict[str, Any]]:
    def handler(args: dict[str, Any]) -> dict[str, Any]:
        from .deliver import package

        return package(str(args.get("run_id", "")))

    return handler


def _handler_gen_report() -> Callable[[dict[str, Any]], dict[str, Any]]:
    def handler(args: dict[str, Any]) -> dict[str, Any]:
        from .deliver import gen_report

        return gen_report(str(args.get("run_id", "")))

    return handler


def _handler_manifest() -> Callable[[dict[str, Any]], dict[str, Any]]:
    def handler(args: dict[str, Any]) -> dict[str, Any]:
        from .manifest import build, render

        elapsed = args.get("wall_elapsed_min")
        m = build(
            str(args.get("run_id", "")),
            wall_elapsed_min=float(elapsed) if elapsed is not None else 0.0,
        )
        result: dict[str, Any] = {"manifest": m}
        if args.get("markdown"):
            result["markdown"] = render(m)
        return result

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
    "build": _handler_build(),
    # 七阶段域实现（strategy/implement 支撑/verify/bench/deliver + manifest）
    "strategy-gen": _handler_strategy_gen(),
    "code-gen": _handler_code_gen(),
    "patch-code": _handler_patch_code(),
    "analyze-error": _handler_analyze_error(),
    "gen-test": _handler_gen_test(),
    "run-test": _handler_run_test(),
    "analyze-accuracy": _handler_analyze_accuracy(),
    "bench-setup": _handler_bench_setup(),
    "run-bench": _handler_run_bench(),
    "package": _handler_package(),
    "gen-report": _handler_gen_report(),
    "manifest": _handler_manifest(),
}


def main(argv: list[str] | None = None) -> int:
    # Windows 控制台代码页防御：stdin/stdout 一律 UTF-8（与插件侧 PYTHONUTF8 双保险）
    for stream in (sys.stdin, sys.stdout):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
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
