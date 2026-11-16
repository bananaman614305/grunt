"""Offline supervisor lifecycle tests: no signup, network, merge or publish."""
import copy
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))
import pipeline
from validation import REVIEW_CHECKS


class PipelineTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.workspace = self.base / 'worker-workspace'
        self.workspace.mkdir(mode=0o700)
        self.root = self.base / 'supervisor'
        self.config = {'release_enabled': True, 'workspace': str(self.workspace),
                       'source_repo': str(self.base / 'source'), 'timeout_seconds': 60}
        self.candidate = {'provider': 'Synthetic', 'release_request': {'head_sha': 'a' * 40}}
        self.receipt = {'head_sha': 'a' * 40, 'base_sha': 'b' * 40,
                        'registry_sha256': 'c' * 64, 'evidence_sha256': 'd' * 64,
                        'checkout': str(self.workspace / 'candidates/synthetic'),
                        'source_id': 'synthetic', 'model': 'synthetic-flash',
                        'config_dir': str(self.workspace / 'isolated-config'),
                        'checks': {'passed': False}, 'reviews': []}
        self.calls = []
        self.sandbox_calls = []
        self.runner = self.sandbox_run
        self.review_count = 0
        self.proof_changes = {}
        self.probe_outcome = 'passed'
        self.promotion_status = 'released'
        self.pre_verdict = 'approve'
        self.post_verdict = 'approve'
        self.same_review = False

    def validate(self, candidate, workspace, source):
        self.calls.append('validate')
        self.assertEqual(candidate, self.candidate)
        self.assertEqual(workspace, self.workspace)
        self.assertEqual(source, Path(self.config['source_repo']))
        return copy.deepcopy(self.receipt)

    def review(self, receipt, directory, agent):
        self.review_count += 1
        phase = 'pre' if not receipt['reviews'] else 'post'
        self.calls.append(phase + '-review')
        answer = agent({'prompt': 'Review exact candidate', 'timeout_seconds': 30})
        if phase == 'post':
            self.assertIn('Post-validation review', answer['prompt'])
            self.assertIn(receipt['trusted_evidence_sha256'], answer['prompt'])
            self.assertIn(receipt['trusted_evidence_file'], answer['prompt'])
        return {'review_id': 'shared' if self.same_review else 'review-' + str(self.review_count),
                'verdict': self.pre_verdict if phase == 'pre' else self.post_verdict,
                'head_sha': receipt['head_sha'], 'independent': True}

    def checks(self, receipt, *, run):
        self.calls.append('checks')
        self.assertEqual(run(['synthetic-check'], cwd=receipt['checkout'], timeout=600,
                             env={}, network=False), 'synthetic-check-passed')
        self.assertLessEqual(self.sandbox_calls[-1]['timeout'], 60)
        self.assertEqual(len(receipt['reviews']), 1)
        self.assertEqual(receipt['reviews'][0]['phase'], 'pre_execution')
        result = copy.deepcopy(receipt)
        result['checks'] = {'passed': True, 'head_sha': receipt['head_sha']}
        return result

    def sandbox_run(self, argv, **kwargs):
        self.sandbox_calls.append({'argv': argv, **kwargs})
        return 'synthetic-check-passed'

    def probe(self, receipt, directory):
        self.calls.append('probe')
        self.assertTrue(receipt['checks']['passed'])
        if self.probe_outcome != 'passed':
            return {'outcome': self.probe_outcome, 'code': 'safe_probe_status'}
        proof = {key: receipt[key] for key in ('head_sha', 'registry_sha256', 'source_id', 'model')}
        proof.update(http_status=200, reply_received=True, attribution_verified=True,
                     tool_call_verified=True, free_guard_verified=True)
        proof.update(self.proof_changes)
        output = directory / 'synthetic-trusted-proof.json'
        pipeline._write(output, proof)
        return {'outcome': 'passed', 'evidence_file': str(output)}

    def promote(self, receipt, config, directory):
        self.calls.append('promote')
        self.assertTrue(receipt['checks']['passed'])
        self.assertTrue(receipt['probe_verified_by_supervisor'])
        self.assertEqual([r['phase'] for r in receipt['reviews']], ['pre_execution', 'post_validation'])
        self.assertNotEqual(receipt['reviews'][0]['review_id'], receipt['reviews'][1]['review_id'])
        self.assertTrue(callable(config['release_check_runner']))
        self.assertEqual(directory, self.root / 'releases')
        raw = Path(receipt['trusted_evidence_file']).read_bytes()
        self.assertEqual(receipt['trusted_evidence_sha256'], hashlib.sha256(raw).hexdigest())
        return {'status': self.promotion_status, 'source_id': receipt['source_id'],
                'head_sha': receipt['head_sha'], 'version': '0.0.0-synthetic'}

    def make(self, **overrides):
        stages = dict(validate=self.validate, review=self.review, checks=self.checks,
                      probe=self.probe, promote=self.promote, agent=lambda request: request,
                      check_runner=self.runner)
        stages.update(overrides)
        return pipeline.Pipeline(self.config, self.root, **stages)

    def checkpoint(self):
        return self.root / 'releases' / ('pipeline-' + self.receipt['head_sha']) / 'checkpoint.json'

    def test_exact_lifecycle_and_private_protected_receipts(self):
        result = self.make().process(self.candidate)
        self.assertEqual(result['status'], 'released')
        self.assertEqual(self.calls, ['validate', 'validate', 'pre-review', 'checks', 'probe', 'post-review', 'promote'])
        checkpoint = pipeline._read(self.checkpoint())
        self.assertEqual(checkpoint['phase'], 'promotion')
        for path in (self.root, self.root / 'releases', self.checkpoint().parent):
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o700)
        for path in self.root.rglob('*.json'):
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        self.assertFalse(self.root.is_relative_to(self.workspace))

    def test_released_head_is_idempotent(self):
        supervisor = self.make()
        first = supervisor.process(self.candidate)
        self.calls.clear()
        self.assertEqual(supervisor.process(self.candidate), first)
        self.assertEqual(self.calls, ['validate'])
        self.assertEqual(supervisor.resume_pending(), [])

    def test_disabled_never_calls_any_stage_or_resumes(self):
        self.config['release_enabled'] = False
        supervisor = self.make()
        self.assertEqual(supervisor.process(self.candidate)['status'], 'disabled')
        self.assertEqual(supervisor.resume_pending(), [])
        self.assertEqual(self.calls, [])

    def test_validation_failure_is_safe_and_cannot_promote(self):
        def fail(*args):
            raise ValueError('SECRET_UPSTREAM_BODY')
        result = self.make(validate=fail).process(self.candidate)
        self.assertEqual(result, {'status': 'blocked', 'reason': 'candidate_validation_failed'})
        self.assertNotIn('SECRET', json.dumps(result))
        self.assertEqual(self.calls, [])

    def test_stage_exceptions_never_reach_later_stages_or_leak_errors(self):
        for stage in ('review', 'checks', 'probe', 'promote'):
            with self.subTest(stage=stage):
                with tempfile.TemporaryDirectory(dir=self.base) as root:
                    self.root = Path(root)
                    self.calls.clear()
                    def fail(*args, **kwargs):
                        raise RuntimeError('SECRET_CREDENTIAL_AND_RAW_PROVIDER_BODY')
                    result = self.make(**{stage: fail}).process(self.candidate)
                    self.assertEqual(result['status'], 'blocked')
                    self.assertEqual(result['reason'], 'pipeline_stage_failed')
                    self.assertNotIn('SECRET', self.checkpoint().read_text())
                    self.assertNotIn('promote', self.calls)

    def test_both_reviews_must_approve_and_are_independent(self):
        for phase, verdict in (('pre', 'reject'), ('pre', 'needs_approval'),
                               ('post', 'reject'), ('post', 'needs_approval')):
            with self.subTest(phase=phase, verdict=verdict):
                with tempfile.TemporaryDirectory(dir=self.base) as root:
                    self.root = Path(root)
                    self.calls.clear()
                    self.pre_verdict = verdict if phase == 'pre' else 'approve'
                    self.post_verdict = verdict if phase == 'post' else 'approve'
                    result = self.make().process(self.candidate)
                    self.assertEqual(result['status'], 'needs_approval' if verdict == 'needs_approval' else 'blocked')
                    self.assertEqual(result['reason'], phase + '_execution_review_not_approved' if phase == 'pre' else 'post_validation_review_not_approved')
                    self.assertNotIn('promote', self.calls)
                    if phase == 'pre':
                        self.assertNotIn('checks', self.calls)
        self.pre_verdict = self.post_verdict = 'approve'
        self.same_review = True
        self.root = self.base / 'same-review-state'
        result = self.make().process(self.candidate)
        self.assertEqual(result['reason'], 'reviews_not_independent')

    def test_every_trusted_probe_binding_and_guard_is_required(self):
        for field, value in [('head_sha', 'e' * 40), ('registry_sha256', 'f' * 64),
                             ('source_id', 'wrong'), ('model', 'wrong'), ('http_status', 429),
                             ('reply_received', False), ('attribution_verified', False),
                             ('tool_call_verified', False), ('free_guard_verified', False)]:
            with self.subTest(field=field):
                with tempfile.TemporaryDirectory(dir=self.base) as root:
                    self.root = Path(root)
                    self.calls.clear()
                    self.proof_changes = {field: value}
                    result = self.make().process(self.candidate)
                    self.assertEqual(result['reason'], 'trusted_probe_binding_failed')
                    self.assertNotIn('post-review', self.calls)
                    self.assertNotIn('promote', self.calls)

    def test_worker_owned_evidence_cannot_authorize_release(self):
        outside = self.workspace / 'worker-proof.json'
        pipeline._write(outside, {'http_status': 200})
        result = self.make(probe=lambda *args: {'outcome': 'passed', 'evidence_file': str(outside)}).process(self.candidate)
        self.assertEqual(result['status'], 'blocked')
        self.assertNotIn('promote', self.calls)

    def test_probe_evidence_symlink_is_rejected(self):
        outside = self.workspace / 'worker-proof.json'
        pipeline._write(outside, {})
        def probe(receipt, directory):
            link = directory / 'proof-link.json'
            link.symlink_to(outside)
            return {'outcome': 'passed', 'evidence_file': str(link)}
        self.assertEqual(self.make(probe=probe).process(self.candidate)['status'], 'blocked')
        self.assertNotIn('promote', self.calls)

    def test_deferred_probe_resume_skips_completed_review_and_checks(self):
        self.probe_outcome = 'deferred'
        first = self.make().process(self.candidate)
        self.assertEqual(first['status'], 'deferred')
        self.calls.clear()
        self.probe_outcome = 'passed'
        resumed = self.make().resume_pending()
        self.assertEqual(resumed[0]['status'], 'released')
        self.assertEqual(self.calls, ['validate', 'probe', 'post-review', 'promote'])

    def test_pending_publication_resume_does_not_repeat_signup_probe_or_checks(self):
        self.promotion_status = 'pending_publication'
        self.assertEqual(self.make().process(self.candidate)['status'], 'pending_publication')
        self.calls.clear()
        self.promotion_status = 'released'
        self.assertEqual(self.make().resume_pending()[0]['status'], 'released')
        self.assertEqual(self.calls, ['promote'])

    def test_promotion_auth_failure_resumes_without_repeating_onboarding(self):
        self.promotion_status = 'blocked'
        self.assertEqual(self.make().process(self.candidate)['status'], 'blocked')
        self.calls.clear()
        self.promotion_status = 'released'
        self.assertEqual(self.make().resume_pending()[0]['status'], 'released')
        self.assertEqual(self.calls, ['promote'])

    def test_changed_candidate_cannot_reuse_reviews_on_resume(self):
        self.probe_outcome = 'deferred'
        self.make().process(self.candidate)
        self.calls.clear()
        self.receipt['registry_sha256'] = 'e' * 64
        result = self.make().resume_pending()[0]
        self.assertEqual(result['reason'], 'candidate_changed_requires_fresh_review')
        self.assertEqual(self.calls, ['validate'])

    def test_blocked_and_needs_approval_are_not_automatically_retried(self):
        self.pre_verdict = 'needs_approval'
        self.make().process(self.candidate)
        self.calls.clear()
        self.assertEqual(self.make().resume_pending(), [])
        self.assertEqual(self.calls, [])

    def test_expired_deadline_never_starts_candidate(self):
        self.config['_deadline_monotonic'] = time.monotonic() - 1
        result = self.make().process(self.candidate)
        self.assertEqual(result, {'status': 'deferred', 'reason': 'pipeline_budget_exhausted'})
        self.assertEqual(self.calls, [])

    def test_budget_exhaustion_between_stages_is_checkpointed(self):
        def checks(receipt, *, run):
            result = self.checks(receipt, run=run)
            supervisor.deadline = time.monotonic() - 1
            return result
        supervisor = self.make(checks=checks)
        result = supervisor.process(self.candidate)
        self.assertEqual(result['status'], 'deferred')
        self.assertEqual(result['reason'], 'pipeline_budget_exhausted')
        self.assertNotIn('probe', self.calls)
        self.assertTrue(pipeline._read(self.checkpoint())['receipt']['checks']['passed'])

    def test_resume_promotion_respects_expired_deadline(self):
        self.promotion_status = 'pending_publication'
        self.make().process(self.candidate)
        self.calls.clear()
        self.config['_deadline_monotonic'] = time.monotonic() - 1
        result = self.make().resume_pending()[0]
        self.assertEqual(result['status'], 'deferred')
        self.assertEqual(result['reason'], 'pipeline_budget_exhausted')
        self.assertEqual(self.calls, [])

    def test_failed_check_receipt_cannot_run_live_probe_or_promote(self):
        def failed_checks(receipt, *, run):
            self.calls.append('checks')
            return copy.deepcopy(receipt)
        result = self.make(checks=failed_checks).process(self.candidate)
        self.assertEqual(result['status'], 'blocked')
        self.assertNotIn('probe', self.calls)
        self.assertNotIn('promote', self.calls)

    def test_unsafe_state_and_checkpoint_permissions_are_rejected(self):
        with self.assertRaisesRegex(ValueError, 'supervisor_state_inside_workspace'):
            pipeline.Pipeline(self.config, self.workspace / 'unsafe-authority')
        self.make().process(self.candidate)
        self.checkpoint().chmod(0o644)
        self.calls.clear()
        self.assertEqual(self.make().resume_pending(), [{'status': 'blocked', 'reason': 'invalid_pipeline_checkpoint'}])
        self.assertEqual(self.calls, [])

    def test_default_probe_creates_private_empty_config_for_anonymous_source(self):
        supervisor = self.make()
        receipt = copy.deepcopy(self.receipt)
        receipt['config_dir'] = None
        receipt['reviews'] = [{'review_id': 'synthetic-pre-approved', 'verdict': 'approve',
                               'head_sha': receipt['head_sha'], 'base_sha': receipt['base_sha'],
                               'independent': True, 'phase': 'pre_execution',
                               'checks': {key: True for key in REVIEW_CHECKS},
                               'reasons': []}]
        with patch.object(pipeline.subprocess, 'Popen') as spawn, \
             patch.object(pipeline.os, 'killpg'):
            spawn.return_value.wait.return_value = 1
            result = supervisor._probe(receipt, self.root)
        self.assertEqual(result, {'outcome': 'failed', 'code': 'probe_no_protected_evidence'})
        spawn.assert_called_once()
        config = self.workspace / 'probe-configs' / receipt['head_sha']
        self.assertEqual(receipt['config_dir'], str(config))
        self.assertEqual(list(config.iterdir()), [])
        for directory in (config.parent, config):
            self.assertEqual(stat.S_IMODE(directory.stat().st_mode), 0o700)
        command = spawn.call_args.args[0]
        self.assertEqual(command[command.index('--config-dir') + 1], str(config))
        self.assertEqual(command[command.index('--sandbox-state') + 1], str(self.root))
        self.assertEqual(pipeline._read(self.root / 'probe-review.json'), receipt['reviews'][0])

    def test_default_probe_deletes_stale_success_and_filters_host_secrets(self):
        supervisor = self.make()
        receipt = copy.deepcopy(self.receipt)
        receipt['reviews'] = [{'review_id': 'pre-approved'}]
        output = self.root / 'trusted-proof.json'
        pipeline._write(output, {'outcome': 'passed', 'http_status': 200})
        with patch.dict(os.environ, {'NPM_TOKEN': 'SECRET_HOST_TOKEN'}), \
             patch.object(pipeline.subprocess, 'Popen') as spawn, \
             patch.object(pipeline.os, 'killpg'):
            spawn.return_value.wait.return_value = 1
            result = supervisor._probe(receipt, self.root)
        self.assertEqual(result, {'outcome': 'failed', 'code': 'probe_no_protected_evidence'})
        self.assertFalse(output.exists())
        env = spawn.call_args.kwargs['env']
        self.assertNotIn('NPM_TOKEN', env)
        self.assertEqual(env['NPM_CONFIG_USERCONFIG'], '/dev/null')
        self.assertEqual(spawn.call_args.kwargs['stdout'], pipeline.subprocess.DEVNULL)
        self.assertEqual(spawn.call_args.kwargs['stderr'], pipeline.subprocess.DEVNULL)

    def test_sandbox_commands_are_bounded_by_remaining_global_deadline(self):
        self.config['_deadline_monotonic'] = 107
        supervisor = self.make()
        with patch.object(pipeline.time, 'monotonic', return_value=100):
            supervisor._runner()(['synthetic-check'], cwd=self.workspace, timeout=600,
                                 env={}, network=False)
        self.assertEqual(self.sandbox_calls[-1]['timeout'], 7)
        self.sandbox_calls.clear()
        with patch.object(pipeline.time, 'monotonic', return_value=108):
            with self.assertRaises(TimeoutError):
                supervisor._runner()(['synthetic-check'], cwd=self.workspace, timeout=600,
                                     env={}, network=False)
        self.assertEqual(self.sandbox_calls, [])


if __name__ == '__main__':
    unittest.main()
