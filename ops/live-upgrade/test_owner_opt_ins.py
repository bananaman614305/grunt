"""Owner-approved per-port opt-in sources (IFM on the owner pool 8793 only): reviewed constant, pins, startup gate, source transition.

Synthetic fixtures: a private copy of the candidate build that carries `ifm`, temp config directories, inert status snapshots. Nothing live is
read, written, signalled or started."""
import contextlib
import copy
import hashlib
import json
import subprocess
import tempfile
import time
import unittest
import unittest.mock
from pathlib import Path

import attempt as at
import rollout_config as rc
import source_transition
import startup_gate
import test_support
from startup_gate import StartupGate, GateError, MaintenanceWindowError

ROOT = Path(__file__).resolve().parent
OWNER = {'8792': [], '8793': ['ifm']}


def expectations(*, ifm_deferred):
    """The pins of an attempt whose candidate serves ifm on 8793: deferred while no consent receipt exists, probe-eligible once it does."""
    value = copy.deepcopy(rc.DEFAULT_EXPECTATIONS)
    value.update(eligibleUnion=sorted(value['eligibleUnion'] + ['ifm']), ownerOptIns=copy.deepcopy(OWNER),
                 consentDeferred=sorted(value['consentDeferred'] + (['ifm'] if ifm_deferred else [])))
    return value


@contextlib.contextmanager
def pinned(value):
    ports = rc.expected_port_sets(value)
    with contextlib.ExitStack() as stack:
        for module, names in ((startup_gate, {'EXPECTATIONS': value, 'EXPECTED_UNION': value['eligibleUnion'], 'EXPECTED_DEFERRED': value['consentDeferred'], 'EXPECTED_PORTS': ports}),
                              (source_transition, {'EXPECTED_UNION': value['eligibleUnion'], 'EXPECTED_PORTS': ports, 'OWNER_OPT_INS': value['ownerOptIns']})):
            for name, replacement in names.items():
                stack.enter_context(unittest.mock.patch.object(module, name, replacement))
        yield ports



class Constants(unittest.TestCase):
    def test_the_reviewed_constant_allows_ifm_on_the_owner_pool_only(self):
        self.assertEqual(rc.OWNER_OPT_INS, {'8792': [], '8793': ['ifm']})
        self.assertEqual(rc.DEFAULT_EXPECTATIONS['ownerOptIns'], {'8792': [], '8793': []})

    def test_port_sets_remove_only_the_other_ports_owner_opt_ins(self):
        value = expectations(ifm_deferred=True)
        ports = rc.expected_port_sets(value)
        self.assertEqual(ports['8793'], value['eligibleUnion'])
        self.assertEqual(ports['8792'], [item for item in value['eligibleUnion'] if item != 'ifm'])
        self.assertEqual(rc.expected_port_sets(rc.DEFAULT_EXPECTATIONS), {'8792': rc.DEFAULT_EXPECTATIONS['eligibleUnion'], '8793': rc.DEFAULT_EXPECTATIONS['eligibleUnion']})

    def test_the_launcher_literal_is_the_base_plus_the_owner_additions_exactly(self):
        self.assertEqual(rc.launcher_opt_ins(rc.DEFAULT_EXPECTATIONS), ['antseed-vikey', 'reflection-beam'])
        self.assertEqual(rc.launcher_opt_ins(expectations(ifm_deferred=True)), ['antseed-vikey', 'ifm', 'reflection-beam'])


class Pins(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=ROOT)
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name)

    def load(self, value):
        (self.path / rc.EXPECTATIONS_FILE).write_text(json.dumps(value))
        return rc.load_expectations(self.path)

    def test_the_owner_opt_ins_are_derived_only_when_the_candidate_serves_them(self):
        metadata = {'eligibleUnion': ['a', 'ifm'], 'consentDeferred': [], 'retiredPackagedSources': []}
        self.assertEqual(at.derive_expectations(metadata)['ownerOptIns'], OWNER)
        metadata['eligibleUnion'] = ['a']
        self.assertEqual(at.derive_expectations(metadata)['ownerOptIns'], {'8792': [], '8793': []})

    def test_a_pin_file_naming_anything_else_is_refused(self):
        good = expectations(ifm_deferred=True)
        self.assertEqual(self.load(good), good)
        for name, bad in {'ifm on the primary': {'8792': ['ifm'], '8793': []}, 'unreviewed source': {'8792': [], '8793': ['crowllm']},
                          'both ports': {'8792': ['ifm'], '8793': ['ifm']}, 'not a list': {'8792': [], '8793': 'ifm'}, 'missing port': {'8793': ['ifm']},
                          'extra port': {'8792': [], '8793': ['ifm'], '8794': []}, 'unsorted duplicates': {'8792': [], '8793': ['ifm', 'ifm']}}.items():
            with self.subTest(name), self.assertRaises(ValueError):
                self.load({**good, 'ownerOptIns': bad})
        with self.assertRaises(ValueError):   # an owner opt-in must be a source the candidate serves
            self.load({**rc.DEFAULT_EXPECTATIONS, 'ownerOptIns': OWNER})
        with self.assertRaises(ValueError):   # the key is required
            self.load({key: item for key, item in good.items() if key != 'ownerOptIns'})


def snapshot(ids):
    return {'sources': [{'id': key, 'state': 'available', 'active': 0} for key in ids] + [{'id': key, 'state': 'disabled', 'active': 0} for key in ('freebuff', 'apinex')]}


class Transition(unittest.TestCase):
    def setUp(self):
        self.value = expectations(ifm_deferred=True)
        scope = pinned(self.value)
        self.ports = scope.__enter__()
        self.addCleanup(scope.__exit__, None, None, None)
        union = [item for item in self.value['eligibleUnion'] if item != 'ifm']
        retired = ['clixad']
        self.old = {'8792': snapshot(union + retired + ['freellmapi']), '8793': snapshot(union + retired)}
        self.candidate = {'retiredPackagedSources': ['clixad'], 'eligibleUnion': self.value['eligibleUnion'], 'sourceIdsPerPort': copy.deepcopy(self.ports)}

    def after(self, port, proof, *, ifm):
        rows = copy.deepcopy(self.old[port])
        next(row for row in rows['sources'] if row['id'] == 'clixad')['state'] = 'disabled'
        if ifm:
            rows['sources'].append({'id': 'ifm', 'state': 'available', 'active': 0})
        return rows

    def test_the_first_release_adds_ifm_to_8793_only(self):
        proof = source_transition.capture_before(self.old, self.candidate)
        self.assertEqual(proof['ownerOptInAdditions'], {'8792': [], '8793': ['ifm']})
        self.assertNotIn('ifm', proof['eligibleSourceSetsBefore']['8793'])
        self.assertIn('ifm', proof['eligibleSourceSetsAfter']['8793'])
        self.assertNotIn('ifm', proof['eligibleSourceSetsAfter']['8792'])
        self.assertEqual(source_transition.assert_after(self.after('8793', proof, ifm=True), '8793', proof)['eligibleSourceIds'], self.ports['8793'])
        self.assertEqual(source_transition.assert_after(self.after('8792', proof, ifm=False), '8792', proof)['eligibleSourceIds'], self.ports['8792'])

    def test_a_later_release_accepts_8793_already_serving_ifm_and_8792_not(self):
        old = copy.deepcopy(self.old)
        old['8793']['sources'].append({'id': 'ifm', 'state': 'available', 'active': 0})
        proof = source_transition.capture_before(old, self.candidate)
        self.assertEqual(proof['ownerOptInAdditions'], {'8792': [], '8793': []})
        self.assertIn('ifm', proof['eligibleSourceSetsBefore']['8793'])
        rows = copy.deepcopy(old['8793'])
        next(row for row in rows['sources'] if row['id'] == 'clixad')['state'] = 'disabled'
        self.assertEqual(source_transition.assert_after(rows, '8793', proof)['eligibleSourceIds'], self.ports['8793'])

    def test_ifm_must_never_appear_on_the_primary_before_or_after(self):
        old = copy.deepcopy(self.old)
        old['8792']['sources'].append({'id': 'ifm', 'state': 'available', 'active': 0})
        with self.assertRaises(RuntimeError):
            source_transition.capture_before(old, self.candidate)
        proof = source_transition.capture_before(self.old, self.candidate)
        with self.assertRaises(RuntimeError):
            source_transition.assert_after(self.after('8792', proof, ifm=True), '8792', proof)

    def test_nothing_but_the_approved_addition_may_be_added_moved_or_dropped(self):
        extra = {'id': 'crowllm', 'state': 'available', 'active': 0}
        for name in ('extra_before_8793', 'extra_before_8792', 'common_missing_8793', 'candidate_extra_8793', 'candidate_8792_has_ifm', 'ifm_disabled_after', 'ifm_missing_after', 'extra_after'):
            with self.subTest(name):
                old, candidate = copy.deepcopy(self.old), copy.deepcopy(self.candidate)
                if name == 'extra_before_8793': old['8793']['sources'].append(extra)
                if name == 'extra_before_8792': old['8792']['sources'].append(extra)
                if name == 'common_missing_8793': old['8793']['sources'] = [row for row in old['8793']['sources'] if row['id'] != 'kenari']
                if name == 'candidate_extra_8793': candidate['sourceIdsPerPort']['8793'] = sorted(candidate['sourceIdsPerPort']['8793'] + ['crowllm'])
                if name == 'candidate_8792_has_ifm': candidate['sourceIdsPerPort']['8792'] = sorted(candidate['sourceIdsPerPort']['8792'] + ['ifm'])
                with self.assertRaises(RuntimeError):
                    proof = source_transition.capture_before(old, candidate)
                    after = self.after('8793', proof, ifm=name != 'ifm_missing_after')
                    if name == 'ifm_disabled_after': next(row for row in after['sources'] if row['id'] == 'ifm')['state'] = 'disabled'
                    if name == 'extra_after': after['sources'].append(extra)
                    source_transition.assert_after(after, '8793', proof)

    def test_the_proof_cannot_be_replayed_under_other_owner_scope(self):
        proof = source_transition.capture_before(self.old, self.candidate)
        proof['ownerOptIns'] = {'8792': [], '8793': []}
        with self.assertRaises(RuntimeError):
            source_transition.assert_after(self.after('8793', proof, ifm=True), '8793', proof)

    def test_partly_served_owner_opt_ins_are_refused(self):
        value = copy.deepcopy(self.value)
        with unittest.mock.patch.object(source_transition, 'OWNER_OPT_INS', {'8792': [], '8793': ['ifm', 'kenari']}):
            with self.assertRaises(RuntimeError):
                source_transition.capture_before(self.old, self.candidate)
        self.assertEqual(value, self.value)


class Gate(unittest.TestCase):
    """The real startup-gate metadata script against a private copy of the candidate build that serves ifm."""

    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='owner-opt-in-runtime-', dir=ROOT)
        cls.runtime, cls.node = test_support.runtime_with_ifm(cls.temp.name), test_support.node()
        command = 'const m=await import(process.argv[1]);process.stdout.write(JSON.stringify(m.DATA_SHARING_POLICIES));'
        cls.policies = json.loads(subprocess.check_output([cls.node, '--input-type=module', '-e', command, (cls.runtime / 'dist/local/data-sharing.js').as_uri()], env={'PATH': '/usr/bin:/bin'}))

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix='owner-opt-in-config-', dir=ROOT)
        self.addCleanup(temp.cleanup)
        self.config = Path(temp.name)
        self.config.chmod(0o700)
        self.env = {'GRUNT_CONFIG_DIR': str(self.config), 'GRUNT_PORT': '8792', 'GRUNT_SOURCES': 'opencode', 'GRUNT_DAEMON': '1',
                    'GRUNT_OPT_IN_SOURCES': 'antseed-vikey,reflection-beam', 'GRUNT_BACKGROUND_ACCOUNT_ACQUISITION': '0', 'GRUNT_SETUP_NO_DATA_SHARING': '1'}
        self.now = time.time_ns() // 1000000
        self.deadline = self.now + 180000
        write(self.config / 'automatic-pool.json', {'version': 1, 'mode': 'automatic', 'serviceSources': ['opencode'], 'selectedSources': ['opencode']})

    def prepare(self, *, ifm_receipt, ifm_entry):
        value = expectations(ifm_deferred=not ifm_receipt)
        approved = {}
        for policy in self.policies:
            if policy['provider'] in value['eligibleUnion'] and policy['provider'] not in value['consentDeferred']:
                approved[policy['provider']] = {'policy': hashlib.sha256(json.dumps(policy, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest(), 'approvedAt': '2026-11-20T12:00:00Z'}
        approved['kilo'] = {'policy': '0' * 64, 'approvedAt': '2026-11-20T12:00:00Z'}
        write(self.config / 'data-sharing-consent.json', {'version': 1, 'approved': approved})
        entries = {item: {'nextCheckAt': self.now + (1000 if item in value['consentDeferred'] else 3600000)} for item in value['eligibleUnion'] if item != 'ifm' or ifm_entry}
        self.schedule = {'version': 1, 'nextStartAt': self.now, 'entries': entries}
        write(self.config / 'maintenance.json', self.schedule)
        return value

    def capture(self, value, ports, **changes):
        args = dict(config_directory=str(self.config), candidate_runtime=str(self.runtime), node=self.node, effective_environment=self.env,
                    hard_deadline_ms=self.deadline, source_ids_per_port=ports)
        args.update(changes)
        with pinned(value):
            return StartupGate.capture(**args)

    def live(self, value, *, ifm_on_8793, extra=None):
        common = [item for item in value['eligibleUnion'] if item != 'ifm']
        return {'8792': common, '8793': sorted(common + (['ifm'] if ifm_on_8793 else []) + (extra or []))}

    def test_the_first_release_serves_ifm_on_8793_only_as_a_consent_deferred_source_and_writes_nothing(self):
        value = self.prepare(ifm_receipt=False, ifm_entry=False)
        before = {p.name: p.read_bytes() for p in self.config.iterdir()}
        with pinned(value):
            gate = self.capture(value, self.live(value, ifm_on_8793=False))
            baseline = gate.baseline
            self.assertEqual(baseline['sourceIdsPerPort']['8793'], value['eligibleUnion'])
            self.assertNotIn('ifm', baseline['sourceIdsPerPort']['8792'])
            self.assertIn('ifm', baseline['consentDeferred'])
            self.assertNotIn('ifm', baseline['potentialChecks'])
            self.assertEqual(baseline['ownerOptIns'], OWNER)
            gate.assert_ready(source_ids_per_port=self.live(value, ifm_on_8793=False))
        self.assertEqual(before, {p.name: p.read_bytes() for p in self.config.iterdir()})

    def test_a_current_receipt_before_the_release_that_adds_ifm_fails_closed_because_it_has_no_schedule_entry(self):
        value = self.prepare(ifm_receipt=True, ifm_entry=False)
        with self.assertRaises(GateError):
            self.capture(value, self.live(value, ifm_on_8793=False))

    def test_a_later_release_accepts_8793_serving_ifm_with_its_own_receipt_and_schedule_entry(self):
        value = self.prepare(ifm_receipt=True, ifm_entry=True)
        gate = self.capture(value, self.live(value, ifm_on_8793=True))
        self.assertIn('ifm', gate.baseline['potentialChecks'])
        self.assertNotIn('ifm', gate.baseline['consentDeferred'])
        self.assertNotIn('ifm', gate.baseline['sourceIdsPerPort']['8792'])
        self.schedule['entries']['ifm']['nextCheckAt'] = self.now + 1000   # a due check of the added source is a startup-window fault like any other
        write(self.config / 'maintenance.json', self.schedule)
        with self.assertRaises(MaintenanceWindowError):
            self.capture(value, self.live(value, ifm_on_8793=True), margin_ms=60000)

    def test_nothing_but_the_approved_addition_is_accepted_and_the_primary_never_serves_ifm(self):
        value = self.prepare(ifm_receipt=False, ifm_entry=False)
        common = self.live(value, ifm_on_8793=False)
        cases = {'ifm already on the primary': {**common, '8792': sorted(common['8792'] + ['ifm'])},
                 'extra source on 8793': self.live(value, ifm_on_8793=True, extra=['crowllm']),
                 'extra source on the primary': {**common, '8792': sorted(common['8792'] + ['crowllm'])},
                 'common source missing on 8793': {**common, '8793': common['8793'][1:]}}
        for name, ports in cases.items():
            with self.subTest(name), self.assertRaises(GateError):
                self.capture(value, ports)
        with self.subTest('primary unit opts ifm in'), self.assertRaises(GateError):
            self.capture(value, common, effective_environment={**self.env, 'GRUNT_OPT_IN_SOURCES': 'antseed-vikey,reflection-beam,ifm'})

    def test_pins_that_do_not_match_the_candidate_fail_closed(self):
        value = self.prepare(ifm_receipt=False, ifm_entry=False)
        stale = copy.deepcopy(value)
        stale['ownerOptIns'] = {'8792': [], '8793': []}   # pins that no longer name the owner addition cannot match what the candidate computes for both pools
        with self.assertRaises(GateError):
            self.capture(stale, self.live(value, ifm_on_8793=False))

    def test_the_metadata_script_refuses_a_malformed_or_primary_owner_scope(self):
        value = self.prepare(ifm_receipt=False, ifm_entry=False)
        base = {'runtimeDirectory': str(self.runtime), 'configDirectory': str(self.config), 'effectiveEnvironment': self.env}
        helper = ROOT / 'startup_gate_metadata.mjs'
        for name, owner in {'primary': {'8792': ['ifm'], '8793': []}, 'shape': {'8793': ['ifm']}, 'id': {'8792': [], '8793': ['IFM']}, 'type': {'8792': [], '8793': 'ifm'}}.items():
            with self.subTest(name):
                result = subprocess.run([self.node, str(helper)], input=json.dumps({**base, 'ownerOptIns': owner}).encode(), capture_output=True, env={'PATH': '/usr/bin:/bin'})
                self.assertNotEqual(result.returncode, 0)
        result = subprocess.run([self.node, str(helper)], input=json.dumps({**base, 'ownerOptIns': OWNER}).encode(), capture_output=True, env={'PATH': '/usr/bin:/bin'})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['sourceIdsPerPort']['8793'], value['eligibleUnion'])


def write(path, value):
    path.write_text(json.dumps(value, separators=(',', ':')))
    path.chmod(0o600)


if __name__ == '__main__':
    unittest.main()
