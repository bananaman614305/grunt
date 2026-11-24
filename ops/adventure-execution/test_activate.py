import importlib.util
from pathlib import Path
import signal
import sys
import tempfile
import unittest


spec = importlib.util.spec_from_file_location("owner_checkpoint_gate", Path(__file__).with_name("activate.py"))
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)


class FakeGate(module.CheckpointGate):
    def __init__(self):
        self.now = 0
        self.status = {"phase": "checkpoint", "workerPid": None}
        self.pools = {port: {"activeRequests": 0, "workers": {"active": [], "queued": []}}
                      for port in (8792, 8793)}
        self.signals = []
        self.ticks = "100"
        self.pid = 1000
        self.backend = 1001
        self.state = "S"
        self.before_pool = None
        self.after_stop = None
        self.after_sleep = None
        self.backend_reads = 0
        super().__init__(status_path="/private/status.json", supervisor_pid=lambda: self.pid,
                         expected_backend_script="/trusted/free-pool.mjs", expected_node="/trusted/node",
                         status_reader=lambda _path: self.status, pool_reader=self.pool,
                         clock=lambda: self.now, sleep=self.advance)

    def advance(self, duration):
        self.now += duration
        if self.after_sleep:
            self.after_sleep()

    def pool(self, port):
        if self.before_pool:
            self.before_pool(port)
        return self.pools[port]

    def _identity(self, _pid):
        return self.ticks, self.state

    def _send(self, pid, ticks, signum):
        if ticks != self.ticks:
            raise module.GateError("identity changed")
        self.signals.append((pid, signum))
        if signum == signal.SIGSTOP:
            self.state = "T"
            if self.after_stop:
                self.after_stop()
        elif signum == signal.SIGCONT:
            self.state = "S"

    def _backend(self, _pid):
        self.backend_reads += 1
        if not self.backend:
            raise module.GateError("active project child")
        return self.backend


class GateTests(unittest.TestCase):
    def test_verified_checkpoint_freezes_only_supervisor_and_always_releases(self):
        gate = FakeGate()
        with gate.acquire(timeout_seconds=0) as frozen:
            self.assertEqual((frozen.pid, frozen.backend_pid), (1000, 1001))
            self.assertEqual(gate.signals, [(1000, signal.SIGSTOP)])
            self.assertEqual(gate.backend_reads, 2)
        self.assertEqual(gate.signals[-1], (1000, signal.SIGCONT))

    def test_working_status_does_not_signal_even_when_http_is_idle(self):
        gate = FakeGate()
        gate.status = {"phase": "working", "workerPid": 1234}
        with self.assertRaises(module.GateError):
            gate.acquire(timeout_seconds=0)
        self.assertEqual(gate.signals, [])

    def test_missing_worker_pid_is_not_a_checkpoint(self):
        gate = FakeGate()
        gate.status = {"phase": "checkpoint"}
        with self.assertRaises(module.GateError):
            gate.acquire(timeout_seconds=0)
        self.assertEqual(gate.signals, [])

    def test_deliberately_paused_supervisor_is_never_resumed(self):
        gate = FakeGate()
        gate.state = "T"
        with self.assertRaises(module.GateError):
            gate.acquire(timeout_seconds=0)
        self.assertEqual(gate.signals, [])

    def test_checkpoint_spawn_race_resumes_without_admission(self):
        gate = FakeGate()
        gate.after_stop = lambda: setattr(gate, "backend", 0)
        with self.assertRaises(module.GateError):
            gate.acquire(timeout_seconds=0)
        self.assertEqual(gate.signals, [(1000, signal.SIGSTOP), (1000, signal.SIGCONT)])

    def test_pool_or_status_race_resumes_without_admission(self):
        for change in (lambda g: g.pools[8792].update(activeRequests=1),
                       lambda g: g.pools[8793]["workers"].update(active=[{"id": "work"}]),
                       lambda g: g.pools[8793]["workers"].update(queued=[{"id": "work"}]),
                       lambda g: setattr(g, "status", {"phase": "working", "workerPid": 2}),
                       lambda g: g.pools.update({8792: []}),
                       lambda g: g.pools[8793].update(workers=[])):
            with self.subTest(change=change):
                gate = FakeGate()
                gate.before_pool = lambda _port: change(gate)
                with self.assertRaises(module.GateError):
                    gate.acquire(timeout_seconds=0)
                self.assertEqual(gate.signals[-1], (1000, signal.SIGCONT))

    def test_runtime_without_subworkers_is_idle_when_no_request_is_active(self):
        gate = FakeGate()
        for pool in gate.pools.values():
            del pool["workers"]
        self.assertTrue(gate._idle())
        gate.pools[8793]["activeRequests"] = 1
        self.assertFalse(gate._idle())

    def test_keyboard_interrupt_after_freeze_resumes_and_propagates(self):
        gate = FakeGate()
        def interrupt(_port):
            raise KeyboardInterrupt()
        gate.before_pool = interrupt
        with self.assertRaises(KeyboardInterrupt):
            gate.acquire(timeout_seconds=0)
        self.assertEqual(gate.signals[-1], (1000, signal.SIGCONT))

    def test_bounded_poll_can_acquire_at_next_checkpoint(self):
        gate = FakeGate()
        gate.status = {"phase": "working", "workerPid": 1234}
        gate.after_sleep = lambda: setattr(gate, "status", {"phase": "waiting_for_free_pool", "workerPid": None})
        with gate.acquire(timeout_seconds=5):
            self.assertEqual(gate.now, 1)

    def test_termination_order_prevents_continuation_before_stop_flag(self):
        gate = FakeGate()
        with gate.acquire(timeout_seconds=0) as frozen:
            frozen.terminate_before_stop()
        self.assertEqual(gate.signals, [(1000, signal.SIGSTOP), (1000, signal.SIGTERM), (1000, signal.SIGCONT)])

    def test_pid_identity_change_never_signals_replacement(self):
        gate = FakeGate()
        with gate.acquire(timeout_seconds=0) as frozen:
            gate.ticks = "replacement"
            with self.assertRaises(module.GateError):
                frozen.terminate_before_stop()
            # Prevent test-context cleanup signaling the replacement too.
            frozen.stopped = False
        self.assertEqual(gate.signals, [(1000, signal.SIGSTOP)])

    def test_proc_child_check_requires_exact_single_node_backend(self):
        with tempfile.TemporaryDirectory(prefix="grunt-checkpoint-proc-") as directory:
            proc = Path(directory)
            (proc / "1000/task/1000").mkdir(parents=True)
            (proc / "1001").mkdir()
            children = proc / "1000/task/1000/children"
            cmdline = proc / "1001/cmdline"
            (proc / "1001/exe").symlink_to("/trusted/node")
            gate = module.CheckpointGate(status_path="/unused", supervisor_pid=lambda: 1000,
                expected_backend_script="/trusted/free-pool.mjs", expected_node="/trusted/node", proc_root=proc)
            cmdline.write_bytes(b"/trusted/node\0/trusted/free-pool.mjs\0")
            children.write_text("1001")
            self.assertEqual(gate._backend(1000), 1001)
            for content in ("", "1001 1002"):
                children.write_text(content)
                with self.assertRaises(module.GateError):
                    gate._backend(1000)
            children.write_text("1001")
            cmdline.write_bytes(b"/trusted/node\0/trusted/pi.js\0")
            with self.assertRaises(module.GateError):
                gate._backend(1000)

    def test_proc_identity_handles_spaces_and_parentheses_in_process_name(self):
        with tempfile.TemporaryDirectory(prefix="grunt-checkpoint-identity-") as directory:
            proc = Path(directory)
            (proc / "1000").mkdir()
            fields = ["S"] + ["0"] * 18 + ["4444"]
            (proc / "1000/stat").write_text("1000 (owner (runner)) " + " ".join(fields))
            gate = module.CheckpointGate(status_path="/unused", supervisor_pid=lambda: 1000,
                expected_backend_script="/trusted/free-pool.mjs", expected_node="/trusted/node", proc_root=proc)
            self.assertEqual(gate._identity(1000), ("4444", "S"))


if __name__ == "__main__":
    unittest.main()
