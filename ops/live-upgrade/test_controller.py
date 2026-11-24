"""Controller outcome mapping, preflight wait and first-cycle verification, with injected collaborators only."""
import importlib.util, json, os, signal, subprocess, sys, tempfile, time, unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import stage, activate, maintenance_pause as mp
from checkpoint_gate import GateError
from startup_gate import MaintenanceWindowError
HERE = Path(__file__).resolve().parent


def load(path, name):
    sys.path.insert(0, str(HERE))
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


controller = load(HERE / 'pause-and-activate.py', 'pause_and_activate_under_test')


class Retryable(RuntimeError):
    upgrade_retry_safe = True


class Controller(unittest.TestCase):
    def refresh(self, root, raw, etag, **kw):
        self.refreshed.append((Path(root), raw, etag, kw))
        self.order.append('refresh')
        if self.refresh_error:
            raise self.refresh_error
        return {'action': 'written', 'publication': 'p'}

    def setUp(self):
        self.refreshed, self.refresh_error = [], None
        self.temp = tempfile.TemporaryDirectory(dir=HERE)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.state = self.root / 'state'
        self.state.mkdir()
        (self.root / 'approved-registry-public.json').write_text('{"published":"p"}')
        (self.root / 'attempt-preparation.json').write_text(json.dumps({'newAdmissionBudgetAuthorized': True, 'totalAdmissionBudgetSeconds': 7200,
            'publicRegistrySha256': stage.sha(self.root / 'approved-registry-public.json'), 'publicRegistryPublication': 'p', 'publicRegistryEtag': '"e1"',
            'archive': 'a', 'source': 's', 'releaseManifest': 'r', 'opencodeProfileSha256': 'f' * 64}))
        (self.root / 'old-runtime-manifests.json').write_text('[]')
        (self.root / 'runtime-stage.json').write_text('{}')
        self.config = {'deadlineMonotonic': time.monotonic() + 3000, 'checkpointWaitSeconds': 60, 'pauseSettleBudgetSeconds': 60, 'activationBudgetSeconds': 60, 'verifyBudgetSeconds': 5}
        stub = SimpleNamespace(private_json=lambda path: json.loads(Path(path).read_text()), bring_registry_current=self.refresh, preserve_pause=lambda: None)
        self.messages = []
        self.order = []
        for patcher in (patch.object(controller, 'ROOT', self.root), patch.object(controller, 'STATE', self.state), patch.object(controller, '_load', return_value=stub),
                        patch.object(controller.stage, 'stage', side_effect=lambda *a, **k: self.order.append('stage') or {}), patch.object(controller, 'preflight_when_clear', return_value={})):
            patcher.start()
            self.addCleanup(patcher.stop)

    class FakePauser:
        def __init__(self, test, after=None, before=None):
            self.test, self.after, self.before = test, after, before
            self.frozen = SimpleNamespace(pid=101)
            self.gate = SimpleNamespace(_identity=lambda pid: ('t', 'S'), verify_frozen=lambda frozen: self.verified.append(frozen))
            self.verified = []
            self.report = {'settledAfterSeconds': 7}
            self.ran = []

        def run(self, go):
            if self.before:
                raise self.before
            result = go(self.frozen, self.report)
            self.ran.append(result)
            if self.after:
                raise self.after
            return result

    def go(self, pauser, activate_fn, verify=lambda config: {'ok': True}):
        return controller.run(self.config, pauser_factory=lambda config: pauser, activate_fn=activate_fn, verify=verify, log=self.messages.append)

    def read(self, name):
        return json.loads((self.root / name).read_text())

    def test_success_records_verification_and_final_state_and_hands_the_preheld_supervisor_to_activate(self):
        seen = {}

        def activate_fn(timeout, **kw):
            seen.update(kw)
            return {'success': True, 'workResumed': True, 'startupHoldReleased': True}
        result = self.go(self.FakePauser(self), activate_fn)
        self.assertTrue(result['verification']['ok'])
        self.assertTrue(seen['retry_mode']); self.assertIsNone(seen['after_cycle']); self.assertEqual(seen['frozen_in'].pid, 101); self.assertGreater(seen['overall_deadline'], time.monotonic())
        self.assertEqual(self.read('release-state.json')['state'], 'activated_and_first_cycle_verified')
        self.assertEqual(self.read('activation-ready.json')['phase'], 'planned_pause_settled')
        self.assertFalse((self.root / 'pause-outcome.json').exists())

    def test_the_live_registry_cache_is_brought_current_before_staging_with_the_pinned_bytes_and_etag(self):
        self.go(self.FakePauser(self), lambda t, **kw: {'success': True})
        self.assertEqual(self.order, ['refresh', 'stage'])
        root, raw, etag, kw = self.refreshed[0]
        self.assertEqual((root, raw, etag), (self.root, b'{"published":"p"}', '"e1"'))
        self.assertEqual((kw['runtime'], kw['node']), (controller.stage.RUNTIMES[0], controller.stage.NODE))
        self.assertTrue(any('live registry cache: written' in m for m in self.messages))

    def test_there_is_no_wait_for_the_daemons_own_refresh(self):
        with patch.object(controller.time, 'sleep', side_effect=AssertionError('the controller must not sleep for the registry')):
            self.go(self.FakePauser(self), lambda t, **kw: {'success': True})

    def test_a_cache_that_cannot_be_made_current_is_a_clean_give_up_before_staging(self):
        self.refresh_error = controller.registry_refresh.RegistryRefreshError('the live registry cache could not be brought to the public registry after a re-fetch: x')
        self.attempt(self.FakePauser(self))
        self.assertCleanGiveUp(3, 'registry_cache_not_current')
        self.assertEqual(self.order, ['refresh'])

    def test_activated_but_first_cycle_not_confirmed_is_reported_loudly_and_not_called_clean(self):
        result = self.go(self.FakePauser(self), lambda t, **kw: {'success': True}, verify=lambda config: {'ok': False, 'working': True, 'modelRepliesRising': False})
        self.assertFalse(result['verification']['ok'])
        self.assertNotEqual(self.read('release-state.json')['state'], 'activated_and_first_cycle_verified')
        self.assertTrue(any('ACTIVATED, but first-cycle verification' in m for m in self.messages))

    def assertCleanGiveUp(self, code, kind, expect_resumed=True):
        with self.assertRaises(SystemExit) as stop:
            raise self.caught
        self.assertEqual(stop.exception.code, code)
        outcome = self.read('pause-outcome.json')
        self.assertEqual(outcome['outcome'], kind); self.assertFalse(outcome['mutated']); self.assertEqual(outcome['builderResumed'], expect_resumed); self.assertTrue(outcome['newAttemptDirectoryRequired'])
        state = self.read('release-state.json')
        self.assertEqual(state['state'], 'pause_window_ended_without_mutation'); self.assertEqual(state['reason'], kind)
        self.assertFalse((self.root / 'activation-receipt.json').exists())     # not terminal: nothing was consumed but this attempt directory

    def attempt(self, pauser, activate_fn=lambda t, **kw: self.fail('must not activate')):
        try:
            self.go(pauser, activate_fn)
        except SystemExit as stop:
            self.caught = stop
        else:
            self.fail('expected a clean give-up')

    def test_activation_rejected_before_any_mutation_is_a_clean_give_up_with_the_builder_resumed(self):
        def rejected(timeout, **kw):
            error = Retryable('synthetic socket busy'); error.admission_rejection_code = 'socket_busy'
            raise error
        self.attempt(self.FakePauser(self), rejected)
        self.assertCleanGiveUp(3, 'activation_rejected_before_mutation_socket_busy')

    def test_host_busy_and_maintenance_window_rejections_are_clean_give_ups_too(self):
        for error in (activate.HostBusyError('Execution host is not idle'), MaintenanceWindowError('perch', 1, 2)):
            with self.subTest(type(error).__name__):
                error.upgrade_retry_safe = True
                self.attempt(self.FakePauser(self), lambda t, error=error, **kw: (_ for _ in ()).throw(error))
                self.assertCleanGiveUp(3, 'activation_rejected_before_mutation_' + type(error).__name__)

    def test_settle_timeout_is_a_clean_give_up(self):
        self.attempt(self.FakePauser(self, before=mp.SettleTimeout('execution host: busy')))
        self.assertCleanGiveUp(3, 'settle_timeout')

    def test_checkpoint_that_never_arrives_is_a_clean_give_up_with_nothing_frozen(self):
        pauser = self.FakePauser(self, before=GateError('No verified idle checkpoint; activation was not admitted'))
        pauser.frozen = None
        self.attempt(pauser)
        self.assertCleanGiveUp(3, 'checkpoint_not_admitted')

    def test_state_changed_by_someone_else_exits_4_and_names_it(self):
        self.attempt(self.FakePauser(self, before=mp.PauseAborted('An execution-upgrade-hold appeared')))
        self.assertCleanGiveUp(4, 'state_changed_by_someone_else')

    def test_a_failed_freeze_reproof_is_a_clean_give_up_without_calling_activate(self):
        pauser = self.FakePauser(self)
        pauser.gate.verify_frozen = lambda frozen: (_ for _ in ()).throw(GateError('Checkpoint or pool admission changed during planned pause'))
        self.attempt(pauser)
        self.assertCleanGiveUp(3, 'checkpoint_not_admitted')

    def test_unit_stop_while_paused_unwinds_and_is_a_clean_give_up(self):
        self.attempt(self.FakePauser(self, before=controller.Terminated('SIGTERM')))
        self.assertCleanGiveUp(3, 'stopped_by_operator')

    def test_failure_to_restore_a_poller_after_a_successful_upgrade_is_a_warning_not_a_clean_failure(self):
        result = self.go(self.FakePauser(self, after=mp.PauseError('Overnight watcher timer was not restarted: x')), lambda t, **kw: {'success': True})
        self.assertTrue(result['verification']['ok'])
        self.assertIn('timer was not restarted', self.read('pause-restore-warning.json')['failure'])
        self.assertFalse((self.root / 'pause-outcome.json').exists())

    def test_a_failed_transaction_propagates_and_leaves_a_terminal_receipt_for_the_operator(self):
        with self.assertRaisesRegex(RuntimeError, 'synthetic failure after mutation began'):
            self.go(self.FakePauser(self), lambda t, **kw: (_ for _ in ()).throw(RuntimeError('synthetic failure after mutation began')))
        receipt = self.read('activation-receipt.json')
        self.assertFalse(receipt['success']); self.assertTrue(receipt['terminal']); self.assertEqual(receipt['phase'], 'planned_pause_not_completed')
        self.assertFalse((self.root / 'pause-outcome.json').exists())

    def test_sigterm_handler_is_restored_after_the_run(self):
        before = signal.getsignal(signal.SIGTERM)
        self.go(self.FakePauser(self), lambda t, **kw: {'success': True})
        self.assertEqual(signal.getsignal(signal.SIGTERM), before)

    def test_sigterm_is_ignored_only_while_the_transaction_runs(self):
        seen = []
        self.go(self.FakePauser(self), lambda t, **kw: seen.append(signal.getsignal(signal.SIGTERM)) or {'success': True})
        self.assertEqual(seen, [signal.SIG_IGN])


class PreflightAndVerification(unittest.TestCase):
    def test_preflight_waits_out_a_source_check_inside_the_startup_window_and_then_passes(self):
        outcomes = [MaintenanceWindowError('perch', 1, 2), MaintenanceWindowError('perch', 1, 2), {'readOnlyPreflightPassed': True}]
        sleeps = []

        def run():
            value = outcomes.pop(0)
            if isinstance(value, Exception):
                raise value
            return value
        self.assertTrue(controller.preflight_when_clear(10 ** 9, run=run, clock=lambda: 0, sleep=sleeps.append, log=lambda m: None)['readOnlyPreflightPassed'])
        self.assertEqual(sleeps, [15, 15])

    def test_preflight_gives_up_when_the_overall_deadline_is_near(self):
        with self.assertRaises(MaintenanceWindowError):
            controller.preflight_when_clear(10, run=lambda: (_ for _ in ()).throw(MaintenanceWindowError('perch', 1, 2)), clock=lambda: 0, sleep=lambda s: None, log=lambda m: None)

    def test_preflight_does_not_swallow_other_failures(self):
        with self.assertRaisesRegex(RuntimeError, 'Protected owner'):
            controller.preflight_when_clear(10 ** 9, run=lambda: (_ for _ in ()).throw(RuntimeError('Protected owner/config bytes changed')), clock=lambda: 0, sleep=lambda s: None, log=lambda m: None)

    def verify(self, statuses, verify_rc=0):
        clock = [0.0]
        items = list(statuses)

        def read_status():
            return items.pop(0) if len(items) > 1 else items[0]

        def sleep(seconds):
            clock[0] += seconds
        return controller.verify_first_cycle({'verifyBudgetSeconds': 60}, read_status=read_status, run_verify=lambda: SimpleNamespace(returncode=verify_rc, stdout='verified', stderr=''),
                                             clock=lambda: clock[0], sleep=sleep, log=lambda m: None)

    def working(self, replies, **kw):
        return {'phase': 'working', 'harness': 'claude-code', 'workerPid': 5, 'cycles': 400, 'modelReplies': replies, **kw}

    def test_first_cycle_must_be_working_on_claude_code_with_rising_replies_and_pass_the_existing_verification(self):
        result = self.verify([{'phase': 'paused'}, self.working(10), self.working(10), self.working(12)])
        self.assertTrue(result['ok']); self.assertEqual((result['baselineModelReplies'], result['modelReplies']), (10, 12)); self.assertTrue(result['verifySuccess'])

    def test_not_ok_when_replies_never_rise_or_the_harness_is_wrong_or_verification_fails(self):
        self.assertFalse(self.verify([self.working(10)])['ok'])
        self.assertFalse(self.verify([self.working(10, harness='pi'), self.working(12, harness='pi')])['ok'])
        self.assertFalse(self.verify([self.working(10), self.working(12)], verify_rc=1)['ok'])


class Wiring(unittest.TestCase):
    def test_build_pauser_caps_the_cycle_wait_so_it_cannot_eat_the_pause_and_activation_budget(self):
        config = {'pauseSettleBudgetSeconds': 1500, 'activationBudgetSeconds': 900, 'verifyBudgetSeconds': 900, 'checkpointWaitSeconds': 3600, 'deadlineMonotonic': time.monotonic() + 7200}
        self.assertEqual(controller.build_pauser(config, log=lambda m: None).s.freeze_timeout, 3600)
        config['deadlineMonotonic'] = time.monotonic() + 3600     # only an hour left overall: 3300 s are reserved
        self.assertTrue(0 < controller.build_pauser(config, log=lambda m: None).s.freeze_timeout <= 300)
        config['deadlineMonotonic'] = time.monotonic() + 100
        self.assertEqual(controller.build_pauser(config, log=lambda m: None).s.freeze_timeout, 0)
        self.assertEqual(controller.build_pauser(config, log=lambda m: None).s.settle_budget, 1500)

    def test_end_cycle_is_wired_only_with_the_recorded_owner_authorization(self):
        base = {'pauseSettleBudgetSeconds': 60, 'activationBudgetSeconds': 60, 'verifyBudgetSeconds': 60, 'checkpointWaitSeconds': 60, 'deadlineMonotonic': time.monotonic() + 7200}
        self.assertIsNone(controller.build_pauser(base, log=lambda m: None).end_cycle)
        self.assertIsNone(controller.build_pauser({**base, 'endCycle': {'authorized': False}}, log=lambda m: None).end_cycle)
        self.assertIsNone(controller.build_pauser({**base, 'endCycle': {'minAgeSeconds': 1}}, log=lambda m: None).end_cycle)
        authorized = controller.build_pauser({**base, 'endCycle': {'authorized': True, 'minAgeSeconds': 1}}, log=lambda m: None)
        self.assertTrue(callable(authorized.end_cycle))
