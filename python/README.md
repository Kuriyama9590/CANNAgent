# python/cannagent — 领域执行层

七阶段工具的 Python 实现（TS 插件零业务逻辑，全部转发到这里——D3）。

## 模块

| 模块 | 职责 | 规范 |
|---|---|---|
| `cli.py` | `python -m cannagent <subcommand>` 入口；stdin JSON → stdout 单 JSON → 退出码 | plugin-dev §3 |
| `events.py` | events.jsonl **唯一**写入函数（seq 自增/脱敏/截断/append-only） | observability §5-6 |
| `task_schema.py` | 双输入 schema + 阶段产物 pydantic 模型（权威） | task-schema / rag §3 |
| `runs.py` | run 目录创建（r{日期}-{slug}）与 task.yaml 加载回填 | task-schema §2 |
| `checkpoint.py` | cp-{stage}-{iter}.json 原子读写 + 最新检查点恢复 | workflow §5 |
| `identify.py` | parse_model（真实 ONNX 图枚举）/ op_profile / fusion_scan | workflow §2.1 |
| `knowledge.py` | retrieve / experience_write / 治理操作（list/show/approve/reject/edit/delete/add） | rag §4/§6 |
| `remote.py` | 任务包派发（SSH+SFTP；NPU 目录锁 D6；conda cannagent 环境锚定） | security §4 / D9 |
| `build.py` | ATC 编译端到端（C5）：onnx → 服务器 atc → om + build.log 回传 | workflow implement 段 |
| `atc_list.py` | ATC 优化清单（C12）：fusion_result.json 权威解析 | workflow bench 段 / D4 |
| `knowledge_store.py` | SQLite 知识库：向量检索 + context 过滤 + 先脱敏再 embed | rag §2/§8 |
| `config.py` | workspace/run 定位（CANNAGENT_WORKSPACE / CANNAGENT_RUN_ID） | — |

后续：strategy/code-gen 域、verify/bench（aclnn 基线）、deliver 域；golden（E2）。

## 开发

```bash
cd python
pip install -e ".[dev,onnx]"
pytest -q          # 用例数以 CI 输出为准（不在此硬编码）
ruff check . && ruff format --check .
mypy cannagent     # strict
```
