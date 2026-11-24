import copy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest

from startup_gate import StartupGate, GateError, MaintenanceWindowError, EXPECTED_UNION, EXPECTED_DEFERRED, TEMP_ENV_CONTENT
ROOT = Path(__file__).resolve().parent
# Explicit private candidate build only; never import a live installed runtime.
import test_support

def write(path, value):
    path.write_text(json.dumps(value, separators=(',', ':')))
    path.chmod(0o600)

class StartupGateTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        global RUNTIME, NODE
        RUNTIME, NODE = test_support.runtime(), test_support.node()
        module = (RUNTIME / 'dist/local/data-sharing.js').as_uri()
        command = 'const m=await import(process.argv[1]);process.stdout.write(JSON.stringify(m.DATA_SHARING_POLICIES));'
        cls.policies = json.loads(subprocess.check_output([NODE, '--input-type=module', '-e', command, module], env={'PATH': '/usr/bin:/bin'}))

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='startup-gate-fixture-', dir=ROOT)
        self.addCleanup(self.temp.cleanup)
        self.config = Path(self.temp.name)
        self.config.chmod(0o700)
        self.env = {'GRUNT_CONFIG_DIR': str(self.config), 'GRUNT_PORT': '8792', 'GRUNT_SOURCES': 'opencode',
                    'GRUNT_DAEMON': '1', 'GRUNT_OPT_IN_SOURCES': 'antseed-vikey,reflection-beam',
                    'GRUNT_BACKGROUND_ACCOUNT_ACQUISITION': '0', 'GRUNT_SETUP_NO_DATA_SHARING': '1'}
        self.now = time.time_ns() // 1000000
        self.deadline = self.now + 180000
        approved = {}
        for policy in self.policies:
            if policy['provider'] in EXPECTED_UNION and policy['provider'] not in EXPECTED_DEFERRED:
                encoded = json.dumps(policy, ensure_ascii=False, separators=(',', ':')).encode()
                approved[policy['provider']] = {'policy': hashlib.sha256(encoded).hexdigest(), 'approvedAt': '2026-11-20T12:00:00Z'}
        approved['kilo'] = {'policy': '0' * 64, 'approvedAt': '2026-11-20T12:00:00Z'}
        self.receipt = {'version': 1, 'approved': approved}
        write(self.config / 'data-sharing-consent.json', self.receipt)
        write(self.config / 'automatic-pool.json', {'version': 1, 'mode': 'automatic', 'serviceSources': ['opencode'], 'selectedSources': ['opencode']})
        self.schedule = {'version': 1, 'nextStartAt': self.now, 'entries': {item: {'nextCheckAt': self.now + (1000 if item in EXPECTED_DEFERRED else 3600000)} for item in EXPECTED_UNION}}
        write(self.config / 'maintenance.json', self.schedule)
        self.ports = {'8792': EXPECTED_UNION, '8793': EXPECTED_UNION}

    def capture(self, **changes):
        args = dict(config_directory=str(self.config), candidate_runtime=str(RUNTIME), node=NODE,
                    effective_environment=self.env, hard_deadline_ms=self.deadline,
                    source_ids_per_port=self.ports)
        args.update(changes)
        return StartupGate.capture(**args)

    def test_real_release_metadata_allows_due_consent_deferred_rows_without_any_writes(self):
        before = {p.name: p.read_bytes() for p in self.config.iterdir()}
        gate = self.capture()
        self.assertEqual(gate.baseline['consentDeferred'], EXPECTED_DEFERRED)
        self.assertEqual(len(gate.baseline['potentialChecks']), 19)
        self.assertEqual(gate.assert_ready()['eligibleUnion'], EXPECTED_UNION)
        self.assertEqual(before, {p.name: p.read_bytes() for p in self.config.iterdir()})
        self.assertEqual(TEMP_ENV_CONTENT, b'[Service]\nEnvironment=GRUNT_SETUP_NO_DATA_SHARING=1\n')

    def test_old_clixad_status_and_orphan_consent_are_only_projected_away(self):
        self.ports = {port: sorted(ids + ['clixad']) for port, ids in self.ports.items()}
        self.receipt['approved']['clixad'] = {'policy': 'f' * 64, 'approvedAt': '2026-11-20T12:00:00Z'}
        self.schedule['entries']['clixad'] = {'nextCheckAt': self.now - 1}
        write(self.config / 'data-sharing-consent.json', self.receipt)
        write(self.config / 'maintenance.json', self.schedule)
        before = {p.name: p.read_bytes() for p in self.config.iterdir()}
        gate = self.capture()
        self.assertEqual(gate.baseline['retiredPackagedSources'], ['clixad'])
        self.assertNotIn('clixad', gate.baseline['eligibleUnion'])
        self.assertNotIn('clixad', gate.baseline['nextCheckAt'])
        self.assertEqual(before, {p.name: p.read_bytes() for p in self.config.iterdir()})

    def test_legacy_automatic_receipt_with_retired_clixad_remains_managed_without_writes(self):
        for service_sources in (['opencode'], ['opencode', 'clixad']):
            with self.subTest(serviceSources=service_sources):
                self.env['GRUNT_SOURCES'] = ','.join(service_sources)
                write(self.config / 'automatic-pool.json', {'version': 1, 'mode': 'automatic', 'serviceSources': service_sources, 'selectedSources': ['opencode', 'clixad']})
                before = {p.name: p.read_bytes() for p in self.config.iterdir()}
                gate = self.capture()
                self.assertTrue(gate.baseline['primaryManagedAutomatic'])
                self.assertEqual(gate.baseline['eligibleUnion'], EXPECTED_UNION)
                self.assertNotIn('clixad', gate.baseline['potentialChecks'])
                self.assertEqual(before, {p.name: p.read_bytes() for p in self.config.iterdir()})

    def test_missing_or_soon_probe_row_fails_closed(self):
        for value in [None, self.deadline + 30000, self.now - 1]:
            with self.subTest(value=value):
                if value is None:
                    self.schedule['entries'].pop('kenari', None)
                else:
                    self.schedule['entries']['kenari'] = {'nextCheckAt': value}
                write(self.config / 'maintenance.json', self.schedule)
                with self.assertRaises(GateError):
                    self.capture()

    def test_only_schedule_timing_is_the_retryable_maintenance_window(self):
        floor = self.deadline + 60000
        for value in [self.now - 1, floor - 1, floor]:
            with self.subTest(value=value):
                self.schedule['entries']['kenari'] = {'nextCheckAt': value}
                write(self.config / 'maintenance.json', self.schedule)
                with self.assertRaises(MaintenanceWindowError) as caught:
                    self.capture(margin_ms=60000)
                self.assertEqual((caught.exception.earliest_source, caught.exception.earliest_at_ms, caught.exception.floor_ms), ('kenari', value, floor))
        # Exactly one millisecond beyond the floor passes; the margin is unchanged.
        self.schedule['entries']['kenari'] = {'nextCheckAt': floor + 1}
        write(self.config / 'maintenance.json', self.schedule)
        self.capture(margin_ms=60000)
        # Missing rows and malformed or out-of-range values stay ordinary, non-retryable failures.
        for value in [None, True, 8640000000000001]:
            with self.subTest(value=value):
                if value is None:
                    self.schedule['entries'].pop('kenari', None)
                else:
                    self.schedule['entries']['kenari'] = {'nextCheckAt': value}
                write(self.config / 'maintenance.json', self.schedule)
                with self.assertRaises(GateError) as caught:
                    self.capture(margin_ms=60000)
                self.assertNotIsInstance(caught.exception, MaintenanceWindowError)

    def test_stale_ordinary_approval_cannot_be_renewed_by_startup(self):
        self.receipt['approved']['opencode']['policy'] = '0' * 64
        write(self.config / 'data-sharing-consent.json', self.receipt)
        with self.assertRaises(GateError):
            self.capture()

    def test_changed_receipt_or_newly_approved_deferred_source_invalidates_baseline(self):
        gate = self.capture()
        self.receipt['approved']['opencode']['approvedAt'] = '2026-11-21T12:00:00Z'
        write(self.config / 'data-sharing-consent.json', self.receipt)
        with self.assertRaises(GateError):
            gate.assert_ready()

    def test_only_deferred_schedule_changes_are_accepted_with_future_probe_deadlines(self):
        gate = self.capture()
        self.schedule['entries']['goedel'] = {'nextCheckAt': self.now + 300000, 'outcome': 'deferred', 'code': 'consent'}
        write(self.config / 'maintenance.json', self.schedule)
        gate.assert_ready()
        self.schedule['entries']['kenari']['nextCheckAt'] = self.deadline
        write(self.config / 'maintenance.json', self.schedule)
        with self.assertRaises(GateError):
            gate.assert_ready()

    def test_even_future_probe_schedule_mutation_invalidates_no_probe_proof(self):
        gate = self.capture()
        self.schedule['entries']['kenari']['lastAttemptAt'] = self.now
        write(self.config / 'maintenance.json', self.schedule)
        with self.assertRaises(GateError):
            gate.assert_ready()

    def test_source_port_mismatch_and_optout_absence_fail(self):
        ports = copy.deepcopy(self.ports)
        ports['8793'] = ports['8793'][:-1]
        with self.assertRaises(GateError):
            self.capture(source_ids_per_port=ports)
        wrong = dict(self.env)
        wrong.pop('GRUNT_SETUP_NO_DATA_SHARING')
        with self.assertRaises(GateError):
            self.capture(effective_environment=wrong)

    def test_preload_or_node_resolution_overrides_are_rejected(self):
        for key in ['NODE_OPTIONS', 'NODE_PATH']:
            with self.subTest(key=key), self.assertRaises(GateError):
                self.capture(effective_environment={**self.env, key: '/unapproved-module'})

    def test_expired_or_oversized_transaction_budget_fails(self):
        with self.assertRaises(GateError):
            self.capture(hard_deadline_ms=self.now + 181000)
        gate = self.capture()
        gate.now_ms = lambda: self.deadline
        with self.assertRaises(GateError):
            gate.assert_ready()

    def test_actual_inert_node_process_environment_and_argv_are_checked(self):
        script = self.config / 'inert.mjs'
        script.write_text("process.stdout.write('ready\\n');await new Promise(done=>setTimeout(done,1000));")
        child = subprocess.Popen([NODE, str(script)], env={**self.env, 'PATH': '/usr/bin:/bin'}, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        try:
            self.assertEqual(child.stdout.readline(), b'ready\n')
            gate = self.capture()
            gate.assert_process_environment(child.pid, str(script))
            with self.assertRaises(GateError):
                gate.assert_process_environment(child.pid, str(script) + '-wrong')
        finally:
            child.wait(timeout=3)
            child.stdout.close()

    def test_receipt_symlink_is_rejected_without_reading_target(self):
        outside = self.config / 'unselected.json'
        write(outside, self.receipt)
        receipt = self.config / 'data-sharing-consent.json'
        receipt.unlink()
        receipt.symlink_to(outside)
        with self.assertRaises(GateError):
            self.capture()

if __name__ == '__main__':
    unittest.main()
