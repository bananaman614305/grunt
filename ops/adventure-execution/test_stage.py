import ast
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
from types import SimpleNamespace
import unittest


spec = importlib.util.spec_from_file_location("owner_stage", Path(__file__).with_name("stage.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

SUPERVISOR = """# synthetic infrastructure fixture, not game code
def sandbox():
    mounts=['--ro-bind',str(ROOT/'grunt-worker'),'/opt/adventure/bin/grunt-worker','--clearenv']
    env={'PI_CODING_AGENT_DIR':'/worker/state/pi','PI_OFFLINE':'1'}
def run_cycle():
    args=['--extension',WORKER_EXTENSION,'--grunt-worker-port','8793',
          '--session-id',configuration['sessionId']]
def main():
    if True:
        if True:
            failures=0
            while not STOP:
                run_fixture_cycle()
"""
POOL = """import { WorkerPool } from './runtime/dist/local/worker-pool.js';
const workers=new WorkerPool(sources);
const app=createLocalApp(sources,{port,workers});
await Promise.all([sync.close(),workers.close()]);
"""
BRIEF = """You are Grunt, sole builder.\n\nFor independent tasks, use `grunt_delegate` old text.\n\nGame decisions stay with Grunt.\n"""


class StageTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="grunt-owner-stage-")
        self.root = Path(self.temporary.name)
        self.owner = self.root / "owner"
        self.owner.mkdir()
        self.files = {"supervisor.py": SUPERVISOR.encode(), "free-pool.mjs": POOL.encode(), "worker-brief.md": BRIEF.encode()}
        for name, data in self.files.items():
            (self.owner / name).write_bytes(data)
        self.baseline = {name: module.digest(data) for name, data in self.files.items()}
        self.destination = self.root / "stage"

    def tearDown(self):
        self.temporary.cleanup()

    def stage(self):
        return module.stage(self.owner, self.destination, self.root / "state", self.baseline)

    def test_stages_only_preserving_exact_originals_and_session_authority(self):
        receipt = self.stage()
        self.assertFalse(receipt["activated"])
        for name, data in self.files.items():
            self.assertEqual((self.owner / name).read_bytes(), data)
            self.assertEqual((self.destination / "original" / name).read_bytes(), data)
        next_root = self.destination / "next"
        supervisor = (next_root / "supervisor.py").read_text()
        ast.parse(supervisor)
        self.assertIn("configuration['sessionId']", supervisor)
        self.assertIn("'--grunt-worker-port','8793'", supervisor)
        self.assertIn("'--grunt-agent-workers','--grunt-background-jobs'", supervisor)
        self.assertIn("'GRUNT_JOBS_STATE_DIR':'/worker/state/jobs'", supervisor)
        pool = (next_root / "free-pool.mjs").read_text()
        self.assertIn("workerScopes:scopes", pool)
        self.assertIn("workerRuntime.close()", pool)
        self.assertLess(pool.index("await workerRuntime.ready"), pool.index("createLocalApp"))
        self.assertNotIn("new WorkerPool", pool)
        brief = (next_root / "worker-brief.md").read_text()
        self.assertIn("Game decisions stay with Grunt.", brief)
        self.assertIn("collect or cancel all jobs and subworkers", brief)
        self.assertIn("grunt_spawn", brief)
        self.assertEqual(json.loads((self.destination / "receipt.json").read_text()), receipt)

    def test_baseline_drift_fails_before_any_staging_or_live_changes(self):
        (self.owner / "free-pool.mjs").write_text("new owner configuration")
        with self.assertRaisesRegex(ValueError, "baseline mismatch"):
            self.stage()
        self.assertFalse(self.destination.exists())
        self.assertEqual((self.owner / "free-pool.mjs").read_text(), "new owner configuration")

    def test_rejects_symlink_source_and_existing_destination(self):
        (self.owner / "supervisor.py").unlink()
        (self.root / "elsewhere").write_text(SUPERVISOR)
        (self.owner / "supervisor.py").symlink_to(self.root / "elsewhere")
        with self.assertRaises(OSError):
            self.stage()
        self.assertFalse(self.destination.exists())
        (self.owner / "supervisor.py").unlink()
        (self.owner / "supervisor.py").write_text(SUPERVISOR)
        self.destination.mkdir()
        (self.destination / "preserved").write_text("keep")
        with self.assertRaisesRegex(ValueError, "must be new"):
            self.stage()
        self.assertEqual((self.destination / "preserved").read_text(), "keep")

    def test_rejects_live_staging_including_parent_alias(self):
        self.destination = self.owner / "stage"
        with self.assertRaisesRegex(ValueError, "outside"):
            self.stage()
        (self.root / "alias").symlink_to(self.owner, target_is_directory=True)
        self.destination = self.root / "alias" / "stage"
        with self.assertRaisesRegex(ValueError, "outside"):
            self.stage()

    def test_rejects_drifted_anchor_even_if_digest_was_reviewed(self):
        data = self.files["supervisor.py"].replace(b"'--grunt-worker-port','8793'", b"'--grunt-worker-port','9000'")
        (self.owner / "supervisor.py").write_bytes(data)
        self.baseline["supervisor.py"] = module.digest(data)
        with self.assertRaisesRegex(ValueError, "anchor changed"):
            self.stage()
        self.assertFalse(self.destination.exists())

    def test_private_staging_and_wrapper_rejects_other_commands(self):
        self.stage()
        self.assertEqual(stat.S_IMODE(self.destination.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE((self.destination / "receipt.json").stat().st_mode), 0o600)
        wrapper = self.destination / "next" / "usegrunt"
        self.assertEqual(stat.S_IMODE(wrapper.stat().st_mode), 0o700)
        subprocess.run(["sh", "-n", str(wrapper)], check=True)
        for command in (["setup"], ["workers", "connect"], ["workers", "run"]):
            result = subprocess.run([str(wrapper), *command], capture_output=True)
            self.assertEqual(result.returncode, 64)
            self.assertNotIn(b"node", result.stderr)

    def hold_fixture(self, *, backend_exit=None, stop_while_held=False):
        self.stage()
        state = self.root / "private-state"
        state.mkdir()
        hold = state / "execution-upgrade-hold"
        hold.write_text("operator-owned activation hold")
        events = []
        namespace = {"STATE": state, "STOP": False, "status": {},
                     "backend": SimpleNamespace(poll=lambda: backend_exit),
                     "save": lambda path, status: events.append(("status", dict(status)))}
        sleeps = []
        def sleep(seconds):
            sleeps.append(seconds)
            if stop_while_held:
                namespace["STOP"] = True
            elif len(sleeps) == 2:
                hold.unlink()
        def cycle():
            events.append(("cycle", None))
            namespace["STOP"] = True
        namespace.update(time=SimpleNamespace(sleep=sleep), run_fixture_cycle=cycle)
        # Execute only synthetic infrastructure; no real supervisor, process,
        # model request, filesystem game source or game test is involved.
        code = (self.destination / "next" / "supervisor.py").read_text()
        exec(compile(code, "synthetic-owner-runner", "exec"), namespace)
        return namespace, events, sleeps, hold

    def test_startup_hold_keeps_backend_up_and_blocks_cycles_until_released(self):
        namespace, events, sleeps, hold = self.hold_fixture()
        namespace["main"]()
        self.assertEqual(sleeps, [0.25, 0.25])
        self.assertEqual(events, [("status", {"phase": "paused", "workerPid": None}),
                                  ("status", {"phase": "paused", "workerPid": None}), ("cycle", None)])
        self.assertFalse(hold.exists())

    def test_startup_hold_honors_stop_without_removing_operator_marker(self):
        namespace, events, sleeps, hold = self.hold_fixture(stop_while_held=True)
        namespace["main"]()
        self.assertEqual(sleeps, [0.25])
        self.assertFalse(any(event == "cycle" for event, _ in events))
        self.assertTrue(hold.exists())

    def test_startup_hold_fails_if_backend_dies_without_starting_cycle(self):
        namespace, events, sleeps, hold = self.hold_fixture(backend_exit=1)
        with self.assertRaisesRegex(RuntimeError, "Free pool stopped during activation hold"):
            namespace["main"]()
        self.assertEqual(events, [])
        self.assertEqual(sleeps, [])
        self.assertTrue(hold.exists())


if __name__ == "__main__":
    unittest.main()
