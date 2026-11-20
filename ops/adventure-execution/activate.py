"""Linux checkpoint gate for the separately reviewed owner activation transaction.

Import this module from the activation operation itself. It has no command-line
activation path and never edits files, runs game commands or restarts services.
"""
from dataclasses import dataclass
import json
import os
from pathlib import Path
import signal
import stat
import time
import urllib.request


class GateError(RuntimeError):
    pass


def read_json(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > 1024 * 1024:
            raise GateError("Oversized owner status")
        return json.loads(stream.read(1024 * 1024 + 1))


def read_pool(port):
    # Fixed loopback endpoints only; redirects must never send operator probes
    # to a different host. No account or model-request endpoints are involved.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *_args, **_kwargs):
            raise GateError("Unexpected local status redirect")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    with opener.open(f"http://127.0.0.1:{port}/v1/status", timeout=2) as response:
        data = response.read(1024 * 1024 + 1)
    if len(data) > 1024 * 1024:
        raise GateError("Oversized pool status")
    return json.loads(data)


@dataclass
class FrozenSupervisor:
    gate: "CheckpointGate"
    pid: int
    start_ticks: str
    backend_pid: int
    stopped: bool = True

    def release(self):
        if self.stopped:
            self.gate._send(self.pid, self.start_ticks, signal.SIGCONT)
            self.stopped = False

    def terminate_before_stop(self):
        """Queue STOP handling before resuming; caller then stops the same unit.

        SIGTERM is pending while frozen, so the supervisor sets its existing
        STOP flag before resuming its continuation loop. Never resume it first
        and only later request service termination.
        """
        if not self.stopped:
            raise GateError("Supervisor is no longer frozen")
        self.gate._send(self.pid, self.start_ticks, signal.SIGTERM)
        self.gate._send(self.pid, self.start_ticks, signal.SIGCONT)
        self.stopped = False

    def __enter__(self):
        return self

    def __exit__(self, *_error):
        self.release()


class CheckpointGate:
    def __init__(self, *, status_path, supervisor_pid, expected_backend_script,
                 expected_node, ports=(8792, 8793), proc_root=Path("/proc"),
                 status_reader=read_json, pool_reader=read_pool,
                 clock=time.monotonic, sleep=time.sleep):
        self.status_path = Path(status_path)
        self.supervisor_pid = supervisor_pid
        self.backend_script = str(Path(expected_backend_script))
        self.node = str(Path(expected_node))
        if not Path(self.backend_script).is_absolute() or not Path(self.node).is_absolute():
            raise ValueError("Expected backend executable and script must be absolute")
        if len(ports) != 2 or any(type(port) is not int or not 1 <= port <= 65535 for port in ports):
            raise ValueError("Exactly two fixed local pool ports are required")
        self.ports = ports
        self.proc = Path(proc_root)
        self.read_status = status_reader
        self.read_pool = pool_reader
        self.clock = clock
        self.sleep = sleep

    def _identity(self, pid):
        if type(pid) is not int or pid <= 1:
            raise GateError("Invalid supervisor process identity")
        raw = (self.proc / str(pid) / "stat").read_text()
        prefix, separator, tail = raw.rpartition(") ")
        fields = tail.split()
        if not separator or not prefix.startswith(f"{pid} (") or len(fields) < 20:
            raise GateError("Invalid process identity record")
        return fields[19], fields[0]

    def _send(self, pid, start_ticks, signum):
        # Pin the kernel process identity. Never signal a reused numeric PID.
        if not hasattr(os, "pidfd_open") or not hasattr(signal, "pidfd_send_signal"):
            raise GateError("Linux pidfd signaling is required for safe activation")
        fd = os.pidfd_open(pid)
        try:
            if self._identity(pid)[0] != start_ticks:
                raise GateError("Supervisor process changed during activation")
            signal.pidfd_send_signal(fd, signum)
        finally:
            os.close(fd)

    def _checkpoint(self):
        status = self.read_status(self.status_path)
        return (isinstance(status, dict)
                and status.get("phase") in ("checkpoint", "waiting_for_free_pool")
                and "workerPid" in status and status["workerPid"] is None)

    def _idle(self):
        for port in self.ports:
            pool = self.read_pool(port)
            if not isinstance(pool, dict):
                return False
            workers = pool.get("workers")
            if (type(pool.get("activeRequests")) is not int or pool["activeRequests"] != 0
                    or not isinstance(workers, dict)
                    or workers.get("active") != [] or workers.get("queued") != []):
                return False
        return True

    def _backend(self, pid):
        children = (self.proc / str(pid) / "task" / str(pid) / "children").read_text().split()
        if len(children) != 1 or not children[0].isdigit():
            raise GateError("Supervisor still has an active project child or unexpected children")
        child = int(children[0])
        command = (self.proc / str(child) / "cmdline").read_bytes().split(b"\0")
        argv = [value.decode("utf-8", errors="strict") for value in command if value]
        if argv != [self.node, self.backend_script]:
            raise GateError("The sole supervisor child is not the expected free-pool backend")
        if os.readlink(self.proc / str(child) / "exe") != self.node:
            raise GateError("Free-pool child executable does not match the trusted Node binary")
        return child

    def acquire(self, *, timeout_seconds=3600):
        """Wait for a real checkpoint; return a frozen handle or leave it running.

        Validate all staged bytes/runtime dependencies BEFORE calling this. The
        caller must use a context manager/finally, stop only the named Grunt
        services after terminate_before_stop, and perform its own file rollback.
        """
        if not 0 <= timeout_seconds <= 86400:
            raise ValueError("Checkpoint wait must be bounded to at most one day")
        deadline = self.clock() + timeout_seconds
        while True:
            frozen = None
            try:
                if self._checkpoint():
                    pid = self.supervisor_pid()
                    ticks, state = self._identity(pid)
                    if state not in ("R", "S", "D", "I"):
                        raise GateError("Supervisor is paused or not running; preserve its state")
                    if self.supervisor_pid() != pid:
                        raise GateError("Supervisor changed before checkpoint freeze")
                    frozen = FrozenSupervisor(self, pid, ticks, 0)
                    self._send(pid, ticks, signal.SIGSTOP)
                    stopped_deadline = self.clock() + 2
                    while True:
                        current_ticks, state = self._identity(pid)
                        if current_ticks != ticks:
                            raise GateError("Supervisor changed during checkpoint freeze")
                        if state in ("T", "t"):
                            break
                        if self.clock() >= stopped_deadline:
                            raise GateError("Supervisor freeze could not be verified")
                        self.sleep(0.01)
                    backend = self._backend(pid)
                    if not self._checkpoint() or not self._idle() or self.supervisor_pid() != pid:
                        raise GateError("Checkpoint or pool admission changed during freeze")
                    # Recheck children after all I/O. A prior model request being
                    # idle does not prove there is no foreground bash/tool child.
                    if self._backend(pid) != backend or not self._checkpoint():
                        raise GateError("Checkpoint changed before activation admission")
                    frozen.backend_pid = backend
                    return frozen
            except BaseException as error:
                if frozen:
                    # Failure to resume is material: surface it rather than
                    # claiming a harmless failed gate while leaving work frozen.
                    frozen.release()
                if not isinstance(error, (OSError, ValueError, GateError)):
                    raise
                if self.clock() >= deadline:
                    raise GateError("No verified idle checkpoint; activation was not admitted") from None
            if self.clock() >= deadline:
                raise GateError("No verified idle checkpoint; activation was not admitted")
            self.sleep(min(1, max(0, deadline - self.clock())))
