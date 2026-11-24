"""Attempt directories: scope, sealing, payload, expectations, launch preconditions and the transient-unit command. Temp dirs and fake
collaborators only; nothing here starts a unit or touches the live host."""
import datetime
import hashlib
import io
import json
import os
import shutil
import subprocess
import tempfile
import unittest
import unittest.mock
from pathlib import Path
from types import SimpleNamespace

import attempt as at
import rollout_config as rc


class Base(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.workspace = self.root / 'workspace'
        self.now = datetime.datetime(2026, 11, 24, 12, 30, 5, tzinfo=datetime.timezone.utc)

    def attempt(self, version='0.10.1', previous='0.10.0'):
        path = at.new_attempt_dir(self.workspace, version, now=self.now)
        at.write_scope(path, version, previous, created_at=1.0)
        return path


class Scope(Base):
    def test_fresh_private_attempt_directories_never_collide(self):
        first = at.new_attempt_dir(self.workspace, '0.10.1', now=self.now)
        second = at.new_attempt_dir(self.workspace, '0.10.1', now=self.now)
        self.assertNotEqual(first, second)
        self.assertEqual(first.name, 'runtime-upgrade-0.10.1-20261124T123005Z')
        self.assertEqual(first.stat().st_mode & 0o777, 0o700)

    def test_unit_names_are_unique_per_attempt_and_carry_the_version(self):
        a, b = at.new_attempt_dir(self.workspace, '0.10.1', now=self.now), at.new_attempt_dir(self.workspace, '0.10.1', now=self.now)
        self.assertEqual(at.unit_name(a), 'grunt-runtime-upgrade-0.10.1-20261124t123005z')
        self.assertNotEqual(at.unit_name(a), at.unit_name(b))
        with self.assertRaises(at.AttemptError):
            at.unit_name(self.root)

    def test_the_version_pair_comes_from_attempt_json_through_rollout_config_not_from_a_constant(self):
        path = self.attempt('0.10.4', '0.10.3')
        self.assertEqual(rc.load_scope(path), ('0.10.4', '0.10.3'))
        self.assertEqual(path.joinpath('attempt.json').stat().st_mode & 0o777, 0o600)
        self.assertEqual(rc.load_scope(self.root), (rc.UNSCOPED_VERSION, rc.UNSCOPED_PREVIOUS_VERSION))   # the repository checkout can never match a real release
        for value in ({'version': '0.10', 'previousVersion': '0.9.1'}, {'version': '1.0.0', 'previousVersion': '1.0.0'}, {'version': 'x.y.z', 'previousVersion': '0.1.0'}):
            (path / 'attempt.json').write_text(json.dumps(value))
            with self.subTest(value), self.assertRaises(ValueError):
                rc.load_scope(path)

    def test_a_copied_attempt_resolves_its_own_scope_when_imported_from_inside_it(self):
        path = self.attempt('0.10.7', '0.10.6')
        at.install_helpers(path)
        result = subprocess.run(['python3', '-c', 'import rollout_config, stage; print(rollout_config.VERSION, stage.PREVIOUS_VERSION)'], cwd=path, capture_output=True, text=True,
                                env={'PATH': os.environ['PATH'], 'PYTHONDONTWRITEBYTECODE': '1'})
        self.assertEqual(result.stdout.strip(), '0.10.7 0.10.6', result.stderr)

    def test_latest_attempt_orders_by_creation_and_filters_by_version(self):
        a = at.new_attempt_dir(self.workspace, '0.10.1', now=self.now)
        at.write_scope(a, '0.10.1', '0.10.0', created_at=10)
        b = at.new_attempt_dir(self.workspace, '0.10.2', now=self.now)
        at.write_scope(b, '0.10.2', '0.10.1', created_at=20)
        c = at.new_attempt_dir(self.workspace, '0.10.1', now=self.now)
        at.write_scope(c, '0.10.1', '0.10.0', created_at=30)
        (self.workspace / 'runtime-upgrade-0.9.9-old').mkdir()      # no attempt.json: not one of ours
        self.assertEqual(at.latest_attempt(self.workspace), c)
        self.assertEqual(at.latest_attempt(self.workspace, '0.10.2'), b)
        with self.assertRaises(at.AttemptError):
            at.latest_attempt(self.workspace, '9.9.9')

    def test_installed_runtimes_must_agree_on_one_version(self):
        for name, version in (('a', '0.10.0'), ('b', '0.10.0')):
            (self.root / name).mkdir()
            (self.root / name / 'package.json').write_text(json.dumps({'version': version}))
        self.assertEqual(at.installed_version([self.root / 'a', self.root / 'b']), '0.10.0')
        (self.root / 'b' / 'package.json').write_text(json.dumps({'version': '0.9.12'}))
        with self.assertRaises(at.AttemptError):
            at.installed_version([self.root / 'a', self.root / 'b'])


class NodeDiscovery(Base):
    def exec_start(self, node):
        return '{ path=%s ; argv[]=%s /srv/runtime/dist/local/main.js ; ignore_errors=no ; start_time=[n/a] }' % (node, node)

    def test_the_managed_node_comes_from_the_primary_units_exec_start(self):
        node = self.root / 'bin/node'
        node.parent.mkdir()
        node.write_text('#!/bin/sh\n')
        node.chmod(0o755)
        self.assertEqual(at.discover_node(lambda unit, field: self.exec_start(node)), str(node))

    def test_a_missing_relative_or_non_executable_node_is_refused(self):
        plain = self.root / 'node'
        plain.write_text('x')
        for value in ('', '{ path=node ; argv[]=node main.js }', self.exec_start(self.root / 'absent'), self.exec_start(plain)):
            with self.subTest(value), self.assertRaises(at.AttemptError):
                at.discover_node(lambda unit, field: value)

    def test_a_symlinked_node_is_refused_because_the_daemon_checks_compare_resolved_binaries(self):
        real = self.root / 'real-node'
        real.write_text('#!/bin/sh\n')
        real.chmod(0o755)
        link = self.root / 'link-node'
        link.symlink_to(real)
        with self.assertRaisesRegex(at.AttemptError, 'symlink'):
            at.discover_node(lambda unit, field: self.exec_start(link))

    def test_helpers_inside_an_attempt_use_the_recorded_node_and_a_relative_one_is_refused(self):
        path = self.attempt()
        (path / 'attempt.json').unlink()
        at.write_scope(path, '0.10.1', '0.10.0', node='/recorded/node')
        self.assertEqual(rc.load_node(path), '/recorded/node')
        self.assertEqual(rc.load_scope(path), ('0.10.1', '0.10.0'))
        (path / 'attempt.json').write_text(json.dumps({'version': '0.10.1', 'previousVersion': '0.10.0', 'node': 'node'}))
        with self.assertRaises(ValueError):
            rc.load_node(path)


class Helpers(Base):
    def test_only_production_helpers_are_copied_never_tests_or_the_tooling(self):
        names = at.helper_names()
        for required in ('stage.py', 'activate.py', 'pause-and-activate.py', 'maintenance_pause.py', 'end_cycle.py', 'verify_success.py', 'rollout_config.py', 'preflight.py',
                         'check_runtime_contract.mjs', 'startup_gate_metadata.mjs', 'seed-routing-history.mjs', 'preparation.py'):
            self.assertIn(required, names)
        for forbidden in ('upgrade.py', 'attempt.py', 'release_pins.py', 'test_support.py', 'attempt.json', 'source-expectations.json'):
            self.assertNotIn(forbidden, names)
        self.assertFalse([name for name in names if name.startswith('test_')])

    def test_every_non_test_module_in_the_directory_is_either_a_helper_or_declared_tooling(self):
        found = {path.name for path in at.HERE.iterdir() if path.is_file() and path.suffix in ('.py', '.mjs') and not path.name.startswith('test_')}
        self.assertEqual(found, set(at.helper_names()) | set(at.TOOLING))

    def test_seal_pins_helpers_and_payload_and_launch_refuses_any_change(self):
        path = self.attempt()
        at.install_helpers(path)
        sealed = at.seal(path)
        self.assertEqual(set(sealed['helpers']), set(at.helper_names()) | {'attempt.json'})
        self.assertEqual(sealed['payload'], {})
        self.assertEqual(sealed, json.loads((path / 'seal.json').read_text()))
        (path / 'stage.py').write_text('# edited')
        current = {p.name: at.sha(p) for p in rc.helper_files(path)}
        self.assertNotEqual(current['stage.py'], sealed['helpers']['stage.py'])


class Payload(Base):
    def setUp(self):
        super().setUp()
        self.owner = self.root / 'owner'
        assets = {'worker-brief.md': b'brief', 'settings.json': b's', 'hooks/stop_gate.py': b'h', 'bin/grunt-release': b'cli', 'bin/claude': b'c'}
        for name, body in assets.items():
            (self.owner / 'claude' / name).parent.mkdir(parents=True, exist_ok=True)
            (self.owner / 'claude' / name).write_bytes(body)
        (self.owner / 'claude/assets.json').write_text(json.dumps({'files': {n: hashlib.sha256(b).hexdigest() for n, b in assets.items()}}))
        self.payload = self.root / 'payload'
        (self.payload / 'claude').mkdir(parents=True)
        (self.payload / 'claude/worker-brief.md').write_bytes(b'new brief')
        (self.payload / 'free-pool.mjs').write_text('export {}')

    def test_assets_manifest_is_derived_from_the_live_one_and_only_the_shipped_files_are_rehashed(self):
        path = self.attempt()
        built = at.build_payload(path, self.payload, self.owner)
        self.assertEqual(built, ['claude/assets.json', 'claude/worker-brief.md', 'free-pool.mjs'])
        files = json.loads((path / 'payload/claude/assets.json').read_text())['files']
        live = json.loads((self.owner / 'claude/assets.json').read_text())['files']
        self.assertEqual(files['worker-brief.md'], hashlib.sha256(b'new brief').hexdigest())
        self.assertEqual({k: v for k, v in files.items() if k != 'worker-brief.md'}, {k: v for k, v in live.items() if k != 'worker-brief.md'})
        import stage
        with unittest.mock.patch.object(stage, 'OWNER', self.owner):
            self.assertEqual((path / 'payload/claude/assets.json').read_bytes(), stage.expected_assets(self.owner, path / 'payload'))

    def test_a_launcher_only_payload_needs_no_assets_manifest(self):
        only = self.root / 'only'
        only.mkdir()
        (only / 'free-pool.mjs').write_text('export {}')
        path = self.attempt()
        self.assertEqual(at.build_payload(path, only, self.owner), ['free-pool.mjs'])
        self.assertFalse((path / 'payload/claude/assets.json').exists())

    def test_foreign_empty_or_symlinked_payloads_are_refused(self):
        (self.payload / 'extra.txt').write_text('x')
        with self.assertRaises(at.AttemptError):
            at.build_payload(self.attempt(), self.payload, self.owner)
        (self.payload / 'extra.txt').unlink()
        empty = self.root / 'empty'
        empty.mkdir()
        with self.assertRaises(at.AttemptError):
            at.build_payload(self.attempt(), empty, self.owner)
        (self.payload / 'free-pool.mjs').unlink()
        (self.payload / 'free-pool.mjs').symlink_to(self.root / 'elsewhere')
        with self.assertRaises(at.AttemptError):
            at.build_payload(self.attempt(), self.payload, self.owner)


class Expectations(Base):
    metadata = {'eligibleUnion': ['b', 'a'], 'consentDeferred': ['b'], 'retiredPackagedSources': [], 'sourceIdsPerPort': {}}

    def test_the_provider_pins_are_derived_from_the_candidate_and_validated(self):
        path = self.attempt()
        value = at.write_expectations(path, at.derive_expectations(self.metadata))
        self.assertEqual((value['eligibleUnion'], value['consentDeferred'], value['retiredPackagedSources']), (['a', 'b'], ['b'], []))
        self.assertEqual(rc.load_expectations(path), value)
        self.assertIn('source-expectations.json', [p.name for p in rc.helper_files(path)])

    def test_malformed_pins_are_refused(self):
        path = self.attempt()
        for bad in ({'eligibleUnion': ['a', 'a']}, {'eligibleUnion': ['a'], 'consentDeferred': ['z']}, {'eligibleUnion': []}):
            value = {**rc.DEFAULT_EXPECTATIONS, **bad}
            (path / 'source-expectations.json').write_text(json.dumps(value))
            with self.subTest(bad), self.assertRaises(ValueError):
                rc.load_expectations(path)
        (path / 'source-expectations.json').write_text(json.dumps({'eligibleUnion': ['a']}))
        with self.assertRaises(ValueError):
            rc.load_expectations(path)

    def test_defaults_are_the_reviewed_set_and_not_shared_mutable_state(self):
        a, b = rc.load_expectations(self.root), rc.load_expectations(self.root)
        a['eligibleUnion'].append('zz')
        self.assertNotIn('zz', b['eligibleUnion'])
        self.assertIn('clixad', rc.DEFAULT_EXPECTATIONS['retiredPackagedSources'])

    def test_a_scoped_attempt_directory_loads_its_own_pins_into_the_startup_gate(self):
        path = self.attempt()
        at.install_helpers(path)
        at.write_expectations(path, {'eligibleUnion': ['a', 'b'], 'consentDeferred': ['b'], 'retiredPackagedSources': [], 'legacyAdvertisements': {'8792': [], '8793': []}})
        result = subprocess.run(['python3', '-c', 'import startup_gate, source_transition as s; print(startup_gate.EXPECTED_UNION, startup_gate.EXPECTED_DEFERRED, s.RETIRED, s.PREVIOUS_ELIGIBLE)'],
                                cwd=path, capture_output=True, text=True, env={'PATH': os.environ['PATH'], 'PYTHONDONTWRITEBYTECODE': '1'})
        self.assertEqual(result.stdout.strip(), "['a', 'b'] ['b'] [] ['a', 'b']", result.stderr)

    def test_the_candidate_metadata_runner_uses_the_gate_input_and_fails_closed(self):
        seen = {}

        def run(command, **kw):
            seen.update(command=command, input=json.loads(kw['input']), env=kw['env'])
            return SimpleNamespace(returncode=0, stdout=json.dumps(self.metadata).encode(), stderr=b'')
        self.assertEqual(at.run_metadata('/node', '/src', '/cfg', {'GRUNT_PORT': '8792'}, run=run), self.metadata)
        self.assertEqual(seen['input'], {'runtimeDirectory': '/src', 'configDirectory': '/cfg', 'effectiveEnvironment': {'GRUNT_PORT': '8792'}})
        self.assertEqual(seen['env']['HOME'], '/nonexistent')
        with self.assertRaises(at.AttemptError):
            at.run_metadata('/node', '/src', '/cfg', {}, run=lambda c, **kw: SimpleNamespace(returncode=1, stdout=b'', stderr=b''))


class Preparation(Base):
    def test_old_runtime_manifests_hash_both_trees_and_refuse_the_wrong_version(self):
        for name in ('a', 'b'):
            live = self.root / name
            (live / 'dist').mkdir(parents=True)
            (live / 'dist/x.js').write_text('x')
            (live / 'README.md').write_text('r')
            (live / 'package.json').write_text(json.dumps({'version': '0.10.0'}))
            (live / 'node_modules').mkdir()
            (live / 'node_modules/dep').write_text('d')
        path = self.attempt()
        rows = at.old_runtime_manifests(path, [self.root / 'a', self.root / 'b'], '0.10.0')
        self.assertEqual([count for _, count in rows], [3, 3])
        value = json.loads((path / 'old-runtime-manifests.json').read_text())
        self.assertEqual(set(value[0]['oldFiles']), {'package.json', 'README.md', 'dist/x.js'})
        self.assertEqual(len(value[0]['dependenciesSha256']), 64)
        with self.assertRaises(at.AttemptError):
            at.old_runtime_manifests(self.attempt(), [self.root / 'a'], '0.9.12')

    def test_public_registry_falls_back_to_the_second_host_like_the_daemon(self):
        urls = []

        def opener(url, timeout=0):
            urls.append(url)
            if 'api.grunt.run' in url:
                raise OSError('no such host')
            response = io.BytesIO(b'{"published": "x", "adapters": []}')
            response.headers = {'ETag': '"abc"'}
            return response
        raw, url, etag = at.fetch_public_registry(opener=opener)
        self.assertEqual(etag, '"abc"')
        self.assertEqual(urls, list(at.REGISTRY_URLS))
        self.assertIn('milo-gateway', url)
        with self.assertRaises(at.AttemptError):
            at.fetch_public_registry(opener=lambda url, timeout=0: (_ for _ in ()).throw(OSError('down')))

    def test_preparation_pins_registry_archive_and_the_bounded_authorization_privately(self):
        path = self.attempt()
        (path / 'evidence').mkdir()
        raw = b'{"published": "2026-11-24T00:00:00Z", "adapters": []}'
        prep = at.write_preparation(path, version='0.10.1', previous='0.10.0', pins={'sourceCommit': 'a' * 40}, pins_path=path / 'evidence/p.json', source=path / 'source',
                                    registry_raw=raw, registry_url='https://x', opencode_sha=at.opencode_profile_pin(), opencode_note='n', live_cache_equal=True, authorization='ok', registry_etag='"abc"')
        self.assertEqual(prep['publicRegistryEtag'], '"abc"')
        self.assertTrue(prep['newAdmissionBudgetAuthorized'])
        self.assertEqual(prep['totalAdmissionBudgetSeconds'], 7200)
        self.assertEqual(prep['publicRegistrySha256'], hashlib.sha256(raw).hexdigest())
        self.assertEqual(prep['opencodeProfileSha256'], hashlib.sha256(b'{"permission":{"external_directory":"deny"}}').hexdigest())
        for name in ('attempt-preparation.json', 'approved-registry-public.json'):
            self.assertEqual((path / name).stat().st_mode & 0o777, 0o600)
        with self.assertRaises(FileExistsError):   # never overwrites an earlier preparation
            at.write_preparation(path, version='0.10.1', previous='0.10.0', pins={'sourceCommit': 'a' * 40}, pins_path=path, source=path, registry_raw=raw, registry_url='x',
                                 opencode_sha='f' * 64, opencode_note='n', live_cache_equal=False, authorization='ok')

    def test_live_cache_comparison_is_exact_and_tolerates_a_missing_cache(self):
        cache = self.root / 'registry.json'
        self.assertFalse(at.live_cache_equals(b'{"a":1}', cache))
        cache.write_text(json.dumps({'registry': {'a': 1}, 'etag': 'e'}))
        self.assertTrue(at.live_cache_equals(b'{"a": 1}', cache))
        self.assertFalse(at.live_cache_equals(b'{"a": 2}', cache))

    def test_opencode_profile_is_compared_between_the_two_release_commits(self):
        seen = []

        def run(command, **kw):
            seen.append(command)
            return SimpleNamespace(returncode=self.code)
        self.code = 0
        self.assertTrue(at.opencode_profile_unchanged('/src', 'p' * 40, 'n' * 40, run=run))
        self.assertEqual(seen[0][-4:-1], ['p' * 40, 'n' * 40, '--'])
        self.assertEqual(seen[0][-1], 'src/local/opencode.ts')
        self.code = 1
        self.assertFalse(at.opencode_profile_unchanged('/src', 'p' * 40, 'n' * 40, run=run))
        self.code = 128
        with self.assertRaises(at.AttemptError):
            at.opencode_profile_unchanged('/src', 'p' * 40, 'n' * 40, run=run)


class Scout(unittest.TestCase):
    def test_a_scout_start_inside_the_upgrade_window_is_called_out(self):
        utc = datetime.timezone.utc
        # 2026-11-24 13:30 UTC = 08:30 EST: the 09:00 scout is 30 minutes away
        self.assertIn('09:00', at.scout_warning(datetime.datetime(2026, 11, 24, 13, 30, tzinfo=utc)))
        # 2026-11-24 15:00 UTC = 10:00 EST: the next scout (21:00) is 11 h away
        self.assertIsNone(at.scout_warning(datetime.datetime(2026, 11, 24, 15, 0, tzinfo=utc)))
        # 20:00 EST = 01:00 UTC next day: 21:00 is an hour away
        self.assertIn('21:00', at.scout_warning(datetime.datetime(2026, 11, 25, 1, 0, tzinfo=utc)))


class Launch(Base):
    def setUp(self):
        super().setUp()
        self.state = self.root / 'state'
        self.state.mkdir()
        (self.state / 'config.json').write_text(json.dumps({'harness': 'claude-code', 'sessionFormat': 'claude-code'}))
        self.write_status({'phase': 'working', 'harness': 'claude-code', 'cycles': 5})
        self.runtime = self.root / 'runtime'
        (self.runtime / 'dist').mkdir(parents=True)
        (self.runtime / 'dist/x.js').write_text('x')
        (self.runtime / 'package.json').write_text(json.dumps({'version': '0.10.0'}))
        self.path = self.attempt()
        at.install_helpers(self.path)
        (self.path / 'evidence').mkdir()
        (self.path / 'evidence/pins.json').write_text(json.dumps({'archiveSha256': at.sha(b'archive')}))
        (self.path / 'evidence/a.tgz').write_bytes(b'archive')
        (self.path / 'source').mkdir()
        raw = b'{"published": "p"}'
        at.write_preparation(self.path, version='0.10.1', previous='0.10.0', pins={'sourceCommit': 'a' * 40}, pins_path=self.path / 'evidence/pins.json', source=self.path / 'source',
                             registry_raw=raw, registry_url='u', opencode_sha='f' * 64, opencode_note='n', live_cache_equal=True, authorization='ok')
        prep = json.loads((self.path / 'attempt-preparation.json').read_text())
        prep['archive'] = str(self.path / 'evidence/a.tgz')
        (self.path / 'attempt-preparation.json').write_text(json.dumps(prep))
        (self.path / 'old-runtime-manifests.json').write_text(json.dumps([{'live': str(self.runtime), 'oldFiles': {'dist/x.js': at.sha(self.runtime / 'dist/x.js')}, 'dependenciesSha256': 'x'}]))
        at.seal(self.path)

    def write_status(self, value):
        (self.state / 'status.json').write_text(json.dumps(value))

    def check(self, **kw):
        args = dict(unit_value=lambda unit, field: 'not-found', state_dir=self.state, runtimes=[self.runtime], previous='0.10.0', owner=self.root, list_units=lambda: [], version='0.10.1')
        args.update(kw)
        return at.assertions(self.path, **args)

    def test_a_prepared_sealed_attempt_passes_every_precondition(self):
        self.assertEqual(self.check()['cycles'], 5)

    def test_each_precondition_refuses_with_its_own_reason(self):
        cases = []
        cases.append(('execution-upgrade-hold', lambda: (self.state / 'execution-upgrade-hold').write_text('x'), {}))
        cases.append(('another upgrade controller', lambda: None, {'list_units': lambda: ['grunt-runtime-upgrade-0.10.1-x.service']}))
        cases.append(('unit name already in use', lambda: None, {'unit_value': lambda unit, field: 'loaded'}))
        cases.append(('different release', lambda: None, {'version': '0.10.2'}))
        cases.append(('not on Claude Code', lambda: (self.state / 'config.json').write_text('{"harness":"pi"}'), {}))
        cases.append(('deliberate worker pause', lambda: self.write_status({'phase': 'paused', 'harness': 'claude-code', 'cycles': 1}), {}))
        cases.append(('is not 0.10.0', lambda: (self.runtime / 'package.json').write_text(json.dumps({'version': '0.9.12'})), {}))
        cases.append(('differs from old-runtime', lambda: (self.runtime / 'dist/x.js').write_text('changed'), {}))
        cases.append(('differ from the seal', lambda: (self.path / 'stage.py').write_text('# edited'), {}))
        cases.append(('already present', lambda: (self.path / 'runtime-stage.json').write_text('{}'), {}))
        cases.append(('pinned public registry changed', lambda: (self.path / 'approved-registry-public.json').write_text('{"published":"other"}'), {}))
        for reason, mutate, kw in cases:
            with self.subTest(reason):
                self.setUp()      # a pristine prepared attempt for every case
                mutate()
                with self.assertRaisesRegex(at.AttemptError, reason):
                    self.check(**kw)

    def test_a_frozen_supervisor_is_refused(self):
        proc = self.root / 'proc'
        (proc / '77').mkdir(parents=True)
        for state, frozen in (('S', False), ('T', True), ('Z', True)):
            (proc / '77/stat').write_text(f'77 (x) {state} 1 ' + ' '.join(['0'] * 17))
            if frozen:
                with self.assertRaises(at.AttemptError):
                    at.supervisor_running(lambda: 77, proc=proc)
            else:
                at.supervisor_running(lambda: 77, proc=proc)

    def test_the_controller_command_is_a_transient_user_unit_in_the_attempt_directory(self):
        command = at.launch_command(self.path, 'grunt-runtime-upgrade-x')
        self.assertEqual(command[:3], ['systemd-run', '--user', '--collect'])
        self.assertIn('--unit=grunt-runtime-upgrade-x', command)
        self.assertIn('--property=WorkingDirectory=' + str(self.path), command)
        self.assertEqual(command[-2:], ['/usr/bin/python3', str(self.path / 'pause-and-activate.py')])

    def test_launch_writes_the_config_with_the_budgets_and_only_records_end_cycle_when_authorized(self):
        started = []
        run = lambda command, **kw: started.append(command) or SimpleNamespace(returncode=0, stderr='')
        status = self.check()
        receipt = at.launch(self.path, version='0.10.1', status=status, authorization='ok', end_cycle=None, run=run, now=lambda: 100.0, monotonic=lambda: 5000.0,
                            unit_value=lambda unit, field: '4242', env={})
        config = json.loads((self.path / 'controller-config.json').read_text())
        self.assertEqual((config['deadlineMonotonic'], config['mode'], config['checkpointWaitSeconds'], config['pauseSettleBudgetSeconds']), (12200.0, 'planned_pause', 3600, 1500))
        self.assertNotIn('endCycle', config)
        self.assertEqual((receipt['activationPid'], receipt['afterCycle'], receipt['endCycle']), (4242, 5, None))
        self.assertEqual(len(started), 1)
        self.assertEqual((self.path / 'controller-config.json').stat().st_mode & 0o777, 0o600)

    def test_end_cycle_authorization_is_recorded_in_the_controller_config(self):
        config = at.controller_config(now=1.0, monotonic=2.0, authorization='ok', end_cycle={'minAgeSeconds': 600.0, 'authorization': 'owner said so'})
        self.assertEqual(config['endCycle'], {'authorized': True, 'minAgeSeconds': 600.0, 'authorization': 'owner said so'})

    def test_a_failed_systemd_run_is_an_error_and_a_second_launch_in_the_same_directory_is_refused(self):
        status = self.check()
        bad = lambda command, **kw: SimpleNamespace(returncode=1, stderr='no bus')
        with self.assertRaisesRegex(at.AttemptError, 'no bus'):
            at.launch(self.path, version='0.10.1', status=status, authorization='ok', end_cycle=None, run=bad, unit_value=lambda u, f: '1', env={})
        with self.assertRaises(FileExistsError):
            at.launch(self.path, version='0.10.1', status=status, authorization='ok', end_cycle=None, run=bad, unit_value=lambda u, f: '1', env={})


class Rehearsal(Base):
    def test_the_rehearsal_stages_and_preflights_in_a_private_copy_then_drops_the_node_modules(self):
        path = self.attempt()
        at.install_helpers(path)
        calls = []

        def run(command, **kw):
            calls.append(command)
            name = Path(command[1]).name
            if name == 'stage.py':
                (Path(kw['cwd']) / 'staged/1/node_modules').mkdir(parents=True)
                (Path(kw['cwd']) / 'staged/1/node_modules/dep').write_text('d')
            return SimpleNamespace(returncode=0, stdout='CONTRACT OK' if 'check_runtime_contract' in command[1] else '', stderr='')
        prep = {'archive': 'a', 'source': 's', 'releaseManifest': 'r', 'opencodeProfileSha256': 'f' * 64}
        result = at.rehearse(path, {}, prep, node='/node', run=run, log=lambda m: None)
        self.assertEqual((result['stage'], result['preflight'], result['contract']), ('ok', 'ok', 'ok'))
        self.assertEqual([Path(c[1]).name for c in calls], ['stage.py', 'preflight.py', 'check_runtime_contract.mjs'])
        self.assertFalse((path / 'rehearsal/staged/1/node_modules').exists())
        self.assertTrue((path / 'check.json').exists())
        self.assertFalse((path / 'runtime-stage.json').exists())      # the real stage is made by the controller

    def test_a_source_check_inside_the_startup_window_is_not_a_failure(self):
        path = self.attempt()
        at.install_helpers(path)

        def run(command, **kw):
            name = Path(command[1]).name
            if name == 'preflight.py':
                return SimpleNamespace(returncode=1, stdout='', stderr='Startup admission preflight failed closed: a source maintenance check is due inside the startup window')
            return SimpleNamespace(returncode=0, stdout='CONTRACT OK', stderr='')
        result = at.rehearse(path, {}, {'archive': 'a', 'source': 's', 'releaseManifest': 'r', 'opencodeProfileSha256': 'f' * 64}, node='/node', run=run, log=lambda m: None)
        self.assertEqual(result['preflight'], 'maintenance_window')

    def test_other_stage_preflight_or_contract_failures_stop_the_upgrade(self):
        prep = {'archive': 'a', 'source': 's', 'releaseManifest': 'r', 'opencodeProfileSha256': 'f' * 64}
        for failing in ('stage.py', 'preflight.py', 'check_runtime_contract.mjs'):
            path = self.attempt()
            at.install_helpers(path)

            def run(command, **kw):
                bad = Path(command[1]).name == failing
                return SimpleNamespace(returncode=1 if bad else 0, stdout='' if bad else 'CONTRACT OK', stderr='boom' if bad else '')
            with self.subTest(failing), self.assertRaises(at.AttemptError):
                at.rehearse(path, {}, prep, node='/node', run=run, log=lambda m: None)
            self.now += datetime.timedelta(seconds=1)


class UnitTests(unittest.TestCase):
    def test_the_repository_tests_run_against_the_candidate_build_with_a_private_umask(self):
        seen = {}

        def run(command, **kw):
            seen.update(command=command, env=kw['env'], umask=kw.get('preexec_fn'))
            return SimpleNamespace(returncode=0, stdout='', stderr='Ran 5 tests\n\nOK\n')
        ok, tail = at.run_unit_tests('/candidate', run=run)
        self.assertTrue(ok)
        self.assertEqual(seen['env']['GRUNT_UPGRADE_TEST_RUNTIME'], '/candidate')
        self.assertIn('discover', seen['command'])
        self.assertEqual(tail[-1], 'OK')
        self.assertFalse(at.run_unit_tests('/candidate', run=lambda c, **kw: SimpleNamespace(returncode=1, stdout='', stderr='FAILED'))[0])


if __name__ == '__main__':
    unittest.main()
