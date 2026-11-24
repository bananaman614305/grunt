"""The `upgrade.py` entry point: argument handling, step order, refusals, --check, --end-cycle, status and verify. The real attempt
directory code runs in a temp workspace; every host-touching or network step is replaced by a recording fake."""
import contextlib
import datetime
import io
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import attempt as at
import release_pins as rp
import upgrade as up

COMMIT = 'c' * 40


class Host(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.workspace = self.root / 'workspace'
        self.state = self.root / 'state'
        self.owner = self.root / 'owner'
        self.state.mkdir()
        self.owner.mkdir()
        self.runtimes = []
        for name in ('config-runtime', 'owner-runtime'):
            live = self.root / name
            (live / 'dist').mkdir(parents=True)
            (live / 'dist/x.js').write_text('x')
            (live / 'README.md').write_text('r')
            (live / 'package.json').write_text(json.dumps({'version': '0.10.0'}))
            (live / 'node_modules').mkdir()
            (live / 'node_modules/dep').write_text('d')
            self.runtimes.append(live)
        (self.state / 'config.json').write_text(json.dumps({'harness': 'claude-code', 'sessionFormat': 'claude-code'}))
        (self.state / 'status.json').write_text(json.dumps({'phase': 'working', 'harness': 'claude-code', 'cycles': 41}))
        self.events = []
        self.now = datetime.datetime(2026, 11, 24, 15, 0, tzinfo=datetime.timezone.utc)   # 10:00 New York: no scout nearby
        self.launched = []
        self.tests_ok = True
        self.units = []
        self.opencode_same = True

        def verify_release(version, previous, *, repo, attempt, run=None, opener=None, log=print):
            self.events.append('verify_release')
            (attempt / 'evidence').mkdir(exist_ok=True)
            (attempt / 'source').mkdir()
            (attempt / f'evidence/usegrunt-{version}.tgz').write_bytes(b'archive')
            pins = {'version': version, 'previousVersion': previous, 'sourceCommit': COMMIT, 'archiveSha256': at.sha(b'archive'), 'packageFiles': {}}
            (attempt / f'evidence/release-{version}-public-pins.json').write_text(json.dumps(pins))
            return pins

        def rehearse(attempt, pins, prep, *, node, run=None, log=print):
            self.events.append('rehearse')
            return {'stage': 'ok', 'preflight': 'ok', 'contract': 'ok'}

        def launch(attempt, **kw):
            self.events.append('launch')
            self.launched.append(kw)
            return {'activationUnit': 'u.service', 'activationPid': 7}
        patches = [
            patch.object(up.release_pins, 'verify_release', verify_release), patch.object(up.attempts_lib, 'rehearse', rehearse), patch.object(up.attempts_lib, 'launch', launch),
            patch.object(up.attempts_lib, 'run_unit_tests', lambda source, **kw: (self.events.append('tests') or self.tests_ok, ['OK'] if self.tests_ok else ['FAILED'])),
            patch.object(up.attempts_lib, 'run_metadata', lambda *a, **kw: {'eligibleUnion': ['a', 'b'], 'consentDeferred': ['b'], 'retiredPackagedSources': []}),
            patch.object(up.attempts_lib, 'fetch_public_registry', lambda **kw: (b'{"published": "p", "adapters": []}', 'https://registry', '"etag-1"')),
            patch.object(up.attempts_lib, 'supervisor_running', lambda pid: None),
            patch.object(up.attempts_lib, 'opencode_profile_unchanged', lambda *a, **kw: self.opencode_same),
            patch.object(up.release_pins, 'find_publish_run', lambda version, **kw: {'runId': '1', 'commit': 'p' * 40}),
            patch.object(up.release_pins, 'sh', lambda *a, **kw: 'https://github.com/o/r.git\n'),
            patch.object(up.activate, 'primary_environment', lambda: {'GRUNT_PORT': '8792'}),
            patch.object(up.activate, 'pid', lambda: 1),
            patch.object(up, 'LIVE_CACHE', self.root / 'no-cache.json'),
            patch.object(up, 'list_controller_units', lambda **kw: self.units),
            patch.object(up.stage, 'unit_value', lambda unit, field: 'not-found'),
            patch.object(up.attempts_lib, 'discover_node', lambda unit_value: '/managed/node'),
        ]
        for item in patches:
            item.start()
            self.addCleanup(item.stop)

    def parse(self, *argv):
        return up.build_parser().parse_args(['--workspace', str(self.workspace), *argv])

    def run_up(self, *argv, now=None):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = up.run_upgrade(self.parse(*argv), runtimes=self.runtimes, owner=self.owner, state_dir=self.state, now=now or self.now)
        return code, out.getvalue()

    def attempt_dir(self):
        return next(self.workspace.glob('runtime-upgrade-*'))


class Run(Host):
    def test_the_one_command_runs_every_step_in_order_and_launches_last(self):
        code, output = self.run_up('--version', '0.10.1')
        self.assertEqual(code, 0)
        self.assertEqual(self.events, ['verify_release', 'tests', 'rehearse', 'launch'])
        attempt = self.attempt_dir()
        self.assertEqual(json.loads((attempt / 'attempt.json').read_text())['version'], '0.10.1')
        self.assertEqual(json.loads((attempt / 'attempt.json').read_text())['previousVersion'], '0.10.0')     # derived from the installed runtime
        self.assertEqual(json.loads((attempt / 'attempt.json').read_text())['node'], '/managed/node')         # discovered from the live unit
        for name in ('attempt-preparation.json', 'approved-registry-public.json', 'old-runtime-manifests.json', 'seal.json', 'source-expectations.json', 'stage.py',
                     'pause-and-activate.py', 'verify_success.py', 'end_cycle.py'):
            self.assertTrue((attempt / name).is_file(), name)
        self.assertFalse(any(path.name.startswith('test_') for path in attempt.iterdir()))
        self.assertIn('LAUNCHED', output)
        self.assertIn('upgrade.py status --attempt', output)
        kw = self.launched[0]
        self.assertEqual((kw['version'], kw['end_cycle'], kw['status']['cycles']), ('0.10.1', None, 41))
        prep = json.loads((attempt / 'attempt-preparation.json').read_text())
        self.assertEqual((prep['version'], prep['previousVersion'], prep['sourceCommit']), ('0.10.1', '0.10.0', COMMIT))
        self.assertEqual(prep['archive'], str(attempt / 'evidence/usegrunt-0.10.1.tgz'))

    def test_check_does_everything_except_the_live_start_and_prints_the_command(self):
        code, output = self.run_up('--version', '0.10.1', '--check')
        self.assertEqual(code, 0)
        self.assertEqual(self.events, ['verify_release', 'tests', 'rehearse'])
        self.assertEqual(self.launched, [])
        self.assertIn('systemd-run --user --collect', output)
        self.assertFalse((self.attempt_dir() / 'controller-config.json').exists())

    def test_end_cycle_is_off_unless_the_flag_is_given_and_then_carries_its_authorization(self):
        self.run_up('--version', '0.10.1')
        self.assertIsNone(self.launched[0]['end_cycle'])
        self.launched.clear()
        self.run_up('--version', '0.10.1', '--end-cycle', '--end-cycle-min-age', '600', now=self.now + datetime.timedelta(minutes=5))
        end = self.launched[0]['end_cycle']
        self.assertEqual(end['minAgeSeconds'], 600.0)
        self.assertIn('Owner authorized', end['authorization'])

    def test_end_cycle_defaults_to_a_two_minute_minimum_age(self):
        self.run_up('--version', '0.10.1', '--end-cycle')
        end = self.launched[0]['end_cycle']
        self.assertEqual(end['minAgeSeconds'], 120.0)
        self.assertIn('120 s old', end['authorization'])

    def test_the_registry_etag_is_pinned_and_the_note_says_there_is_no_wait(self):
        code, output = self.run_up('--version', '0.10.1')
        prep = json.loads((self.attempt_dir() / 'attempt-preparation.json').read_text())
        self.assertEqual(prep['publicRegistryEtag'], '"etag-1"')
        self.assertIn('no wait for the 00/06/12/18 UTC refresh', output)
        self.assertTrue((self.attempt_dir() / 'registry_refresh.mjs').is_file())
        self.assertTrue((self.attempt_dir() / 'registry_refresh.py').is_file())

    def test_skip_tests_and_failing_tests(self):
        self.run_up('--version', '0.10.1', '--skip-tests')
        self.assertNotIn('tests', self.events)
        self.events.clear()
        self.tests_ok = False
        with self.assertRaisesRegex(at.AttemptError, 'helper tests failed'):
            self.run_up('--version', '0.10.1', now=self.now + datetime.timedelta(minutes=5))
        self.assertNotIn('rehearse', self.events)
        self.assertNotIn('launch', self.events)

    def test_already_installed_downgrade_and_bad_versions_are_refused_or_noops_before_anything_is_created(self):
        code, output = self.run_up('--version', '0.10.0')
        self.assertEqual(code, 0)
        self.assertIn('already installed', output)
        with self.assertRaisesRegex(at.AttemptError, 'downgrades'):
            self.run_up('--version', '0.9.12')
        with self.assertRaises(rp.ReleaseError):
            self.run_up('--version', 'latest')
        self.assertEqual(self.events, [])
        self.assertFalse(self.workspace.exists() and any(self.workspace.iterdir()))

    def test_a_running_controller_blocks_a_second_one(self):
        self.units = ['grunt-runtime-upgrade-0.10.1-old.service']
        with self.assertRaisesRegex(at.AttemptError, 'another upgrade controller'):
            self.run_up('--version', '0.10.1')
        self.assertEqual(self.events, [])

    def test_a_changed_opencode_profile_source_needs_an_explicit_review_flag(self):
        self.opencode_same = False
        with self.assertRaisesRegex(at.AttemptError, 'opencode.ts changed'):
            self.run_up('--version', '0.10.1')
        self.assertNotIn('launch', self.events)
        self.events.clear()
        code, _ = self.run_up('--version', '0.10.1', '--opencode-profile-reviewed', now=self.now + datetime.timedelta(minutes=5))
        self.assertEqual(code, 0)

    def test_an_unknown_previous_release_run_means_the_profile_cannot_be_proven_unchanged(self):
        def missing(version, **kw):
            raise rp.ReleaseError('no run')
        with patch.object(up.release_pins, 'find_publish_run', missing), self.assertRaisesRegex(at.AttemptError, 'previous release commit could not be found'):
            self.run_up('--version', '0.10.1')

    def test_the_owner_payload_is_optional_and_sealed_when_given(self):
        for name, body in {'claude/assets.json': {'files': {}}}.items():
            pass
        (self.owner / 'claude/bin').mkdir(parents=True)
        files = {'worker-brief.md': b'b', 'settings.json': b's', 'hooks/stop_gate.py': b'h', 'bin/grunt-release': b'r', 'bin/claude': b'c'}
        import hashlib
        for name, body in files.items():
            (self.owner / 'claude' / name).parent.mkdir(parents=True, exist_ok=True)
            (self.owner / 'claude' / name).write_bytes(body)
        (self.owner / 'claude/assets.json').write_text(json.dumps({'files': {n: hashlib.sha256(b).hexdigest() for n, b in files.items()}}))
        payload = self.root / 'payload'
        (payload / 'claude').mkdir(parents=True)
        (payload / 'claude/worker-brief.md').write_bytes(b'new brief')
        self.run_up('--version', '0.10.1', '--payload', str(payload))
        attempt = self.attempt_dir()
        seal = json.loads((attempt / 'seal.json').read_text())
        self.assertEqual(set(seal['payload']), {'claude/worker-brief.md', 'claude/assets.json'})

    def test_a_scout_start_inside_the_window_warns_but_does_not_block(self):
        code, output = self.run_up('--version', '0.10.1', now=datetime.datetime(2026, 11, 24, 13, 30, tzinfo=datetime.timezone.utc))
        self.assertEqual(code, 0)
        self.assertIn('WARNING: the provider scout', output)

    def test_main_turns_refusals_into_exit_code_2_with_the_nothing_changed_message(self):
        err = io.StringIO()
        with contextlib.redirect_stderr(err), patch.object(up, 'run_upgrade', side_effect=at.AttemptError('hold exists')):
            self.assertEqual(up.main(['--workspace', str(self.workspace), '--version', '0.10.1']), 2)
        self.assertIn('nothing on the live host was changed', err.getvalue())
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            up.main(['--workspace', str(self.workspace)])      # --version is required for a run


class Parser(unittest.TestCase):
    def test_default_command_is_run_and_subcommands_take_their_own_options(self):
        parser = up.build_parser()
        args = parser.parse_args(['--version', '0.10.1', '--check', '--end-cycle'])
        self.assertEqual((args.command, args.version, args.check, args.end_cycle, args.end_cycle_min_age), (None, '0.10.1', True, True, 120.0))
        self.assertFalse(args.skip_tests)
        run = parser.parse_args(['run', '--version', '0.10.2'])
        self.assertEqual((run.command, run.version, run.end_cycle), ('run', '0.10.2', False))
        status = parser.parse_args(['status', '--attempt', '/x', '--json'])
        self.assertEqual((status.command, str(status.attempt), status.json), ('status', '/x', True))
        verify = parser.parse_args(['--workspace', '/w', 'verify', '--version', '0.10.1'])
        self.assertEqual((verify.command, str(verify.workspace), verify.version), ('verify', '/w', '0.10.1'))
        self.assertEqual(parser.parse_args(['status', '--workspace', '/v']).workspace, Path('/v'))


class StatusAndVerify(Host):
    def make_attempt(self):
        path = at.new_attempt_dir(self.workspace, '0.10.1', now=self.now)
        at.write_scope(path, '0.10.1', '0.10.0', created_at=1.0)
        return path

    def test_status_summarizes_the_attempt_and_reads_only(self):
        path = self.make_attempt()
        (path / 'release-state.json').write_text(json.dumps({'state': 'activated_and_first_cycle_verified'}))
        (path / 'pause-state.json').write_text(json.dumps({'phase': 'settled'}))
        (path / 'activation-receipt.json').write_text(json.dumps({'success': True, 'workMayResume': True, 'runtimes': [1]}))
        (path / 'rollout-launched.json').write_text(json.dumps({'activationUnit': 'u.service'}))
        value = up.collect_status(path, state_dir=self.state, unit_value=lambda unit, field: 'active', get=lambda port: {'activeRequests': 0, 'sources': [1, 2], 'version': 1})
        self.assertEqual(value['receipt']['success'], True)
        self.assertNotIn('runtimes', value['receipt'])
        self.assertEqual(value['8792'], {'activeRequests': 0, 'sources': 2, 'statusSchema': 1})
        self.assertEqual(value['units']['u.service'], ['active', 'active'])
        self.assertFalse(value['hold'])
        self.assertTrue(up.summary(value).startswith('DONE: activated_and_first_cycle_verified / pause settled'))
        self.assertFalse((path / 'runtime-stage.json').exists())

    def test_status_of_an_attempt_that_has_not_started_and_with_unreachable_pools(self):
        path = self.make_attempt()
        value = up.collect_status(path, state_dir=self.state, unit_value=lambda unit, field: (_ for _ in ()).throw(RuntimeError('no bus')), get=lambda port: (_ for _ in ()).throw(OSError('refused')))
        self.assertTrue(value['8793'].startswith('unreachable'))
        self.assertTrue(up.summary(value).startswith('in progress: not started'))
        (self.state / 'execution-upgrade-hold').write_text('x')
        self.assertTrue(up.collect_status(path, state_dir=self.state, unit_value=lambda u, f: 'x', get=lambda p: {})['hold'])

    def test_attempts_are_resolved_by_path_by_version_or_latest(self):
        path = self.make_attempt()
        self.assertEqual(up.resolve_attempt(SimpleNamespace(attempt=path, workspace=self.workspace)), path.resolve())
        self.assertEqual(up.resolve_attempt(SimpleNamespace(attempt=None, workspace=self.workspace, version='0.10.1')), path)
        with self.assertRaises(at.AttemptError):
            up.resolve_attempt(SimpleNamespace(attempt=self.root, workspace=self.workspace))
        with self.assertRaises(at.AttemptError):
            up.resolve_attempt(SimpleNamespace(attempt=None, workspace=self.workspace, version='9.9.9'))

    def test_verify_runs_the_attempts_own_sealed_script_and_returns_its_exit_code(self):
        path = self.make_attempt()
        with self.assertRaises(at.AttemptError):
            up.run_verify(path)
        (path / 'verify_success.py').write_text('')
        seen = {}

        def run(command, **kw):
            seen.update(command=command, cwd=kw.get('cwd'))
            return SimpleNamespace(returncode=1, stdout='', stderr='FAILED: nope\n')
        with contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(up.run_verify(path, run=run), 1)
        self.assertEqual(seen['command'][1], str(path / 'verify_success.py'))
        self.assertIn('FAILED', out.getvalue())


if __name__ == '__main__':
    unittest.main()
