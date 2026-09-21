"""远程任务包派发（D9：agent 与测试环境解耦；C5 实现）。

流程：本地组包（脚本/数据）→ SFTP 上传 staging → 服务器执行（conda cannagent 环境
+ CANN 工具链，环境固定）→ 结果包回传 → 结构化返回。NPU 互斥（D6 v1）= 服务器侧
锁目录（mkdir 原子性），崩溃残留锁由 TTL 接管。

凭据来源：环境变量 CANN_SERVER_{HOST,USER,PASSWORD}（.env 由 _load_env 尽力加载，
值只进内存——SPEC §2）。
"""

from __future__ import annotations

import os
import re
import time
from pathlib import Path
from typing import Any

STAGE_ROOT_DEFAULT = "/root/Blarock/cannagent-tasks"
LOCK_TTL_SEC = 2 * 60 * 60  # 崩溃残留锁 2h 后可接管（单 run 卡队列上限由 max_wall_min 兜底）


def _load_env() -> None:
    """尽力加载仓库根 .env（不存在则依赖进程环境）。"""
    for cand in (Path.cwd() / ".env", Path(__file__).resolve().parents[2] / ".env"):
        if cand.is_file():
            for line in cand.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, _, v = line.partition("=")
                os.environ.setdefault(k.strip(), v.strip())
            return


class RemoteError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class RemoteRunner:
    """一次任务包的完整生命周期。"""

    def __init__(
        self,
        host: str | None = None,
        user: str | None = None,
        password: str | None = None,
        stage_root: str = STAGE_ROOT_DEFAULT,
    ) -> None:
        _load_env()
        self.host = host or os.environ.get("CANN_SERVER_HOST", "")
        self.user = user or os.environ.get("CANN_SERVER_USER", "")
        self.password = password or os.environ.get("CANN_SERVER_PASSWORD", "")
        if not (self.host and self.user):
            raise RemoteError("CANN_E_NO_SERVER", "CANN_SERVER_HOST/USER 未配置（.env）")
        self.stage_root = stage_root

    def _connect(self) -> Any:
        import paramiko

        client = paramiko.SSHClient()
        client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        client.connect(self.host, username=self.user, password=self.password, timeout=20)
        return client

    def _exec(self, client: Any, cmd: str, timeout: int = 600) -> tuple[int, str]:
        # 环境固定（security §4）：任务包不带环境，服务器侧锚定
        script = f"source /root/anaconda3/etc/profile.d/conda.sh && conda activate cannagent && {cmd}"
        _, out, err = client.exec_command(script, timeout=timeout)
        code = out.channel.recv_exit_status()
        return code, (out.read() + err.read()).decode("utf-8", errors="replace")

    # ---- NPU 互斥锁（D6 v1：目录锁，mkdir 原子）----

    def acquire_lock(self, client: Any, run_id: str, ttl: int = LOCK_TTL_SEC) -> bool:
        code, out = self._exec(
            client,
            (
                f"mkdir '{self.stage_root}/npu.lock' 2>/dev/null && echo acquired || "
                f"(find '{self.stage_root}/npu.lock' -maxdepth 0 -mmin +{ttl // 60} "
                f"-exec rm -rf {{}} \\; 2>/dev/null && mkdir '{self.stage_root}/npu.lock' "
                f"2>/dev/null && echo acquired-stale || echo busy)"
            ),
        )
        state = out.strip().splitlines()[-1] if out.strip() else "busy"
        if state.startswith("acquired"):
            self._exec(client, f"echo '{run_id} {int(time.time())}' > '{self.stage_root}/npu.lock/owner'")
            return True
        return False

    def release_lock(self, client: Any) -> None:
        self._exec(client, f"rm -rf '{self.stage_root}/npu.lock'")

    # ---- 任务包执行 ----

    def run_package(
        self,
        package: str,
        files: dict[str, bytes],
        command: str,
        expect_outputs: list[str],
        timeout: int = 600,
        need_npu: bool = True,
    ) -> dict[str, Any]:
        """组包 → 执行 → 回传。files: 远程相对路径 → 内容；expect_outputs: 需回传的相对路径。"""
        client = self._connect()
        try:
            stage = f"{self.stage_root}/{package}"
            self._exec(client, f"rm -rf '{stage}' && mkdir -p '{stage}/in' '{stage}/out'")
            sftp = client.open_sftp()
            for rel, content in files.items():
                remote = f"{stage}/in/{rel}"
                _sftp_mkdirs(sftp, remote.rsplit("/", 1)[0]) if "/" in rel else None
                with sftp.file(remote, "w") as f:
                    f.write(content)
            sftp.close()

            locked = True
            if need_npu and not self.acquire_lock(client, package):
                return {
                    "ok": False,
                    "code": "CANN_E_NPU_BUSY",
                    "message": "NPU 卡被其他 run 占用（D6 队列：稍后重试）",
                    "hint": "重试或检查 npu.lock/owner",
                }
            try:
                # 整体子 shell 包裹后再 tee：管道绑定到完整命令（否则只捕获末条）
                script = (
                    f"set -o pipefail; ( {command} ) 2>&1 | tee '{stage}/out/_exec.log'; "
                    f"echo EXIT=$? >> '{stage}/out/_exec.log'"
                )
                code, log = self._exec(
                    client, f"cd '{stage}/in' && bash -c {shquote(script)}", timeout=timeout
                )
                outputs: dict[str, bytes] = {}
                sftp = client.open_sftp()
                for rel in [*expect_outputs, "_exec.log"]:
                    try:
                        with sftp.file(f"{stage}/out/{rel}", "rb") as f:
                            outputs[rel] = f.read()
                    except OSError:
                        continue
                for rel in expect_outputs:
                    if rel in outputs:
                        continue
                    try:  # 工具可能把产物写在 in/ 下
                        with sftp.file(f"{stage}/in/{rel}", "rb") as f:
                            outputs[rel] = f.read()
                    except OSError:
                        continue
                sftp.close()
                exit_line = [ln for ln in log.splitlines() if ln.startswith("EXIT=")]
                exit_code = int(exit_line[-1].split("=")[1]) if exit_line else code
                return {
                    "ok": exit_code == 0 and all(rel in outputs for rel in expect_outputs),
                    "exit_code": exit_code,
                    "log": outputs.get("_exec.log", log.encode()).decode("utf-8", errors="replace"),
                    "outputs": {k: v for k, v in outputs.items() if k != "_exec.log"},
                }
            finally:
                if need_npu and locked:
                    self.release_lock(client)
        finally:
            client.close()


def shquote(s: str) -> str:
    return "'" + s.replace("'", "'\\''") + "'"


def _sftp_mkdirs(sftp: Any, remote_dir: str) -> None:
    """逐级建目录（SFTP mkdir 非递归；保持绝对/相对语义；已存在/竞态忽略）。"""
    absolute = remote_dir.startswith("/")
    cur = ""
    for part in (p for p in remote_dir.split("/") if p):
        cur = ("/" if absolute else "") + part if not cur else f"{cur}/{part}"
        try:
            sftp.stat(cur)
        except OSError:
            try:
                sftp.mkdir(cur)
            except OSError:
                pass


def npu_idle_check(runner: RemoteRunner) -> dict[str, Any]:
    """环境指纹（benchmark §2）：device/工具链/占用快照。"""
    client = runner._connect()
    try:
        _, out = runner._exec(
            client,
            (
                "npu-smi info | head -30; echo ---; "
                "readlink -f /usr/local/Ascend/cann; "
                "cat /usr/local/Ascend/cann/version.info 2>/dev/null | head -2"
            ),
            timeout=30,
        )
        info: dict[str, Any] = {"raw": out}
        m = re.search(r"Ascend\d+\w+", out)
        if not m:
            # npu-smi 新版 Name 列只给芯片型号（如 910B）——补 Ascend 前缀
            m2 = re.search(r"\b(9\d{2}[A-Z]\d?)\b", out)
            if m2:
                info["device"] = f"Ascend{m2.group(1)}"
        else:
            info["device"] = m.group(0)
        m = re.search(r"(cann-[\d.]+)", out)
        if m:
            info["cann"] = m.group(1)
        busy = bool(re.search(r"\d+\s+\d+\s+\d+\s+\d+", out.split("---")[0])) if "---" in out else False
        info["npu_processes"] = busy
        return info
    finally:
        client.close()
