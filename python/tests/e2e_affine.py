"""端到端冒烟：affine 仿射（Mul+Add）七阶段全链路（需 CANN_SERVER_* 昇腾服务器）。

用法：python tests/e2e_affine.py [--keep]
驱动 identify → strategy → code-gen → build → gen-test → run-test → bench-setup →
run-bench → package（含 gen_report）→ manifest，逐步打印关键指标。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

FIXTURE = Path(__file__).resolve().parent / "golden" / "affine.onnx"
WS = Path(__file__).resolve().parents[2] / "workspace-e2e"


def main() -> int:
    import os

    os.environ.setdefault("CANNAGENT_WORKSPACE", str(WS))
    WS.mkdir(exist_ok=True)
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

    from cannagent.identify import parse_model
    from cannagent.runs import create_run, load_task
    from cannagent.task_schema import TaskYaml

    root = create_run(
        TaskYaml.model_validate(
            {
                "schema_version": "1.0",
                "task_type": "model",
                "task_name": "e2e-affine",
                "model": {"path": f"input/{FIXTURE.name}", "opset": 13,
                          "input_shape": [1024, 1024]},
                "constraints": {"dtype": "fp32"},
                "target": {"gain_pct": 10},
                "baseline": {"impl": "aclnn", "atc": "enabled"},
                # 纯相对误差口径（benchmark §3）在 y 过零点分母极小：fp32 舍入差 ~1 ulp
                # 会放大到 >1e-3；按 workflow §2.1 verify 的 task.yaml 覆盖机制放宽本任务阈值
                "output": {"precision_threshold": 0.005},
            }
        ),
        input_files=[FIXTURE],
    )
    rid = root.name
    print(f"[run] {rid}")

    task = load_task(root)
    print(f"[task] {task.task_name} dtype={task.constraints.dtype}")

    out = parse_model(rid)
    candidates = out["fusion_candidates"]["candidates"]
    print(f"[identify] nodes={out['op_list']['stats']['total_nodes']} "
          f"candidates={[(c['id'], c['pattern']) for c in candidates]}")
    assert any(c["pattern"] == "Mul+Add" for c in candidates), "fixture 应命中 Mul+Add"

    from cannagent.strategy import generate

    strat = generate(rid)["strategy"]
    print(f"[strategy] selected={strat['selected']} "
          f"approach={strat['tasks'][0]['approach']} target=+{strat['tasks'][0]['target_gain_pct']}%")

    from cannagent.codegen import code_gen

    cg = code_gen(rid)
    assert "version" in cg, cg
    version = cg["version"]
    print(f"[code-gen] {version} files={len(cg['files'])}")

    from cannagent.build import build

    b = build(rid, version)
    print(f"[build] ok={b['ok']} lane={b.get('lane')} exit={b.get('exit_code')}")
    if not b["ok"]:
        print((root / "implement" / version / "build.log").read_text(encoding="utf-8")[-3000:])
        return 1

    from cannagent.verify import gen_test, run_test

    gen_test(rid, version, seed=20260921, cases=4)
    v = run_test(rid, version)
    if not v.get("ok"):
        print(json.dumps(v, ensure_ascii=False, default=str))
        return 1
    acc = v["accuracy"]
    print(f"[verify] {acc['passed']}/{acc['total']} passed max_rel_err={acc['max_rel_err']:.3e} "
          f"threshold={acc['threshold']}")

    from cannagent.bench import bench_setup, run_bench

    bench_setup(rid)
    r = run_bench(rid, version)
    if not r.get("ok"):
        print(json.dumps(r, ensure_ascii=False, default=str))
        return 1
    p50 = r["p50"]
    print(f"[bench] p50 us: baseline={p50.get('baseline')} optimized={p50.get('optimized')} "
          f"atc={p50.get('atc')}")
    print(f"[bench] gain={r['gain_pct']}% gain_ok={r['gain_ok']} "
          f"validity={r['validity']['valid']} "
          f"coverage={[e['atc_coverage'] for e in r['validity']['entries']]}")

    from cannagent.deliver import package

    d = package(rid)
    print(f"[deliver] check={d['check']} final={d['manifest']['final_version']} "
          f"gain={d['manifest']['gain_pct']}%")

    from cannagent.manifest import build as build_manifest
    from cannagent.manifest import render

    m = build_manifest(rid)
    print(f"[manifest] trend={[(t['version'], t['gain_pct']) for t in m['trend']]} "
          f"stagnation={m['stagnation']}")
    (root / "checkpoints" / "cp-e2e.json").write_text(render(m), encoding="utf-8")

    print(f"[done] run dir: {root}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
