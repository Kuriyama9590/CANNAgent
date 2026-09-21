"""C5/C12 单测：远程命令构造与 ATC 日志解析（不触网；真实链路走冒烟）。"""

from __future__ import annotations

from cannagent.atc_list import parse_atc_log, parse_fusion_result
from cannagent.build import next_version, shq
from cannagent.remote import shquote


def test_shq_and_shquote_quote_specials():
    # POSIX 单引号转义：a'b → 'a' + \' + 'b'（chr(92)=反斜杠，避免源码转义歧义）
    assert shq("a'b") == "'a'" + chr(92) + "'" + "'b'"
    assert shquote("x y") == "'x y'"


def test_next_version_sequence(tmp_path):
    assert next_version(tmp_path) == "v1"
    (tmp_path / "v1").mkdir()
    (tmp_path / "v2").mkdir()
    assert next_version(tmp_path) == "v3"


def test_remote_runner_requires_config(monkeypatch):
    import pytest

    import cannagent.remote as remote_mod
    from cannagent.remote import RemoteError, RemoteRunner

    monkeypatch.delenv("CANN_SERVER_HOST", raising=False)
    monkeypatch.delenv("CANN_SERVER_USER", raising=False)
    monkeypatch.setattr(remote_mod, "_load_env", lambda: None)  # 测试不读 .env
    with pytest.raises(RemoteError):
        RemoteRunner()


def test_parse_atc_log_extracts_passes():
    log = """
INFO] Fusion [Conv,BN,Relu] start
INFO] constant folding applied
INFO] node : conv1 rewritten
INFO] TransDataEliminate: removed 2 nodes
"""
    data = parse_atc_log(log)
    names = [p["name"] for p in data["passes"]]
    assert "GraphFusion" in names
    assert "ConstFolding" in names
    assert "TransDataEliminate" in names
    fusion = next(p for p in data["passes"] if p["name"] == "GraphFusion")
    assert fusion["scope"] == "Conv,BN,Relu"
    assert fusion["applied"] is True


def test_parse_atc_log_empty_on_no_signal():
    assert parse_atc_log("nothing relevant\n") == {"passes": []}


def test_parse_fusion_result_authoritative():
    import json

    fusion = json.dumps(
        {
            "session_and_graph_id_0_0": {
                "graph_fusion": {
                    "ConvBatchnormFusionPass": {"effect_times": "2", "match_times": "2"},
                    "Conv2dToConv2dV2FusionPass": {"effect_times": "0", "match_times": "4"},
                }
            }
        }
    )
    data = parse_fusion_result(fusion)
    by_name = {p["name"]: p for p in data["passes"]}
    assert by_name["ConvBatchnormFusionPass"]["applied"] is True
    assert by_name["ConvBatchnormFusionPass"]["effect_times"] == 2
    assert by_name["Conv2dToConv2dV2FusionPass"]["applied"] is False
    assert by_name["ConvBatchnormFusionPass"]["scope"].startswith("session_and_graph")
