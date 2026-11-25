"""Finish lane, reconciliation, bounded backoff and budgets. Offline and synthetic."""
import contextlib
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))
import lifecycle
from owner_policy import canonical_candidate_id

spec = importlib.util.spec_from_file_location('scout_under_test', Path(__file__).with_name('scout.py'))
scout = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scout)

STAMP = '2026-11-25T00:00:00+00:00'


def row(host='synthetic.example', model='synthetic-flash', **changes):
    value = {'provider': 'Synthetic', 'homepage': 'https://' + host, 'model': model, 'context_tokens': 210000,
             'free_access': 'recurring', 'quality': 'target', 'signup_friction': 'low', 'status': 'researched',
             'reason': 'prose', 'primary_sources': ['https://' + host + '/docs'], 'data_policy': 'policy',
             'setup_status': 'not_attempted', 'proposal_url': None, 'release_request': None,
             'qualification_blocker': None,
             'probe': {'http_status': None, 'source_id': None, 'reply_received': False, 'attribution_verified': False,
                       'tool_call_verified': False, 'free_guard_verified': False, 'evidence_file': None},
             'first_seen': STAMP, 'last_seen': STAMP, 'sightings': 3, **changes}
    return value


def ledger_of(*rows, pending=()):
    candidates = {canonical_candidate_id(item): item for item in rows}
    ledger = {'version': 1, 'candidates': candidates, 'discovery_pending': {}}
    for item in pending:
        ledger['discovery_pending'][canonical_candidate_id(item)] = {**item, 'review_id': scout.review_id(item)}
    scout.canonicalize_ledger(ledger)
    return ledger


def registry(*adapters):
    filler = [{'id': 'filler%d' % number, 'model': 'x'} for number in range(lifecycle.MIN_REGISTRY_ADAPTERS)]
    return {'version': 1, 'adapters': [*filler, *adapters]}


class GateFactTests(unittest.TestCase):
    def test_hard_failures_and_unverified_gates_are_separate_fixed_codes(self):
        self.assertEqual(lifecycle.hard_failures(row(free_access='one_time', quality='below_baseline',
                                                    signup_friction='high', context_tokens=1000)),
                         ['free_access_one_time', 'quality_below_baseline', 'signup_friction_high', 'context_below_minimum'])
        unknown = row(free_access='unclear', quality='unverified', signup_friction='unknown', context_tokens=None)
        self.assertEqual(lifecycle.hard_failures(unknown), [])
        self.assertEqual(lifecycle.unverified_gates(unknown),
                         ['free_access_unverified', 'quality_unverified', 'context_unverified', 'signup_unverified'])
        self.assertEqual(lifecycle.reason_codes(row(status='integration_pending')), ['integration_incomplete'])
        self.assertEqual(lifecycle.reason_codes(row(model='gemini-4-flash'))[0], 'google_model_barred')

    def test_fingerprint_ignores_reworded_prose_but_not_new_sources_or_facts(self):
        base = row()
        self.assertEqual(lifecycle.fingerprint(base), lifecycle.fingerprint(row(reason='completely reworded')))
        for change in ({'primary_sources': ['https://synthetic.example/docs', 'https://synthetic.example/new']},
                       {'context_tokens': 250000}, {'quality': 'above_baseline'}, {'setup_status': 'signed_up'}):
            self.assertNotEqual(lifecycle.fingerprint(base), lifecycle.fingerprint(row(**change)))


class ClaimedRejectionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.workspace = Path(self.temporary.name)

    def test_discovery_label_rejection_is_claimed_and_earns_a_verification_pass(self):
        bad = row(host='claimed.example', signup_friction='high', status='researched', sightings=1)
        key = canonical_candidate_id(bad)

        def worker(request, _config):
            result = {'web_search_used': True, 'search_queries': ['alpha query', 'beta query'],
                      'candidates': [{**bad, 'change_evidence': None}] if Path(request['output_path']).stem == 'direct' else []}
            return {'result': result, 'tool_counts': {'web_search': 1}}

        ledger = {'version': 1, 'candidates': {}}
        directory = self.workspace / 'run'
        scout.private_directory(directory)
        with patch.object(scout, 'run_agent', side_effect=worker):
            found = scout.discover_lanes(self.workspace, directory, self.workspace, {}, ledger, {}, {},
                                         scout.time.monotonic() + 10, 0)
        new = found['candidates'][0]
        self.assertEqual((new['status'], new['rejection_basis']), ('rejected', 'claimed'))
        self.assertEqual(new['reason_codes'][0], 'signup_friction_high')
        # Not permanent: it is queued for the verify lane, lowest priority.
        pending = ledger['discovery_pending'][key]
        self.assertEqual(lifecycle.lane(pending), 'verify')
        self.assertIn(new['review_id'], scout.qualification_scope(ledger))
        self.assertIn(new['review_id'], ledger['reviewed_discoveries'])  # discovery will not repeat it

    def test_qualification_rejection_is_verified_and_discovery_status_is_claimed(self):
        item = row(free_access='one_time', status='rejected')
        report = {'web_search_used': True, 'search_queries': ['one', 'two'], 'candidates': [item]}
        base = {'version': 1, 'candidates': {}}
        verified = scout.ingest(report, base, self.workspace)
        self.assertEqual(verified['candidates'][canonical_candidate_id(item)]['rejection_basis'], 'verified')
        claimed = scout.ingest(report, base, self.workspace, smoke=True)
        self.assertEqual(claimed['candidates'][canonical_candidate_id(item)]['rejection_basis'], 'claimed')

    def test_a_worker_report_cannot_claim_a_trusted_status(self):
        for status in ('released', 'retired', 'excluded'):
            errors = []
            report = {'web_search_used': True, 'search_queries': ['one', 'two'], 'candidates': [row(status=status)]}
            updated = scout.ingest(report, {'version': 1, 'candidates': {}}, self.workspace, diagnostics=errors)
            self.assertEqual(errors, [{'row': 0, 'code': 'invalid_candidate_status'}])
            self.assertEqual(updated['candidates'], {})

    def test_a_re_reported_shipped_row_keeps_its_trusted_state(self):
        shipped = row(status='released', terminal_reason='released_verified', pipeline_status='released')
        key = canonical_candidate_id(shipped)
        report = {'web_search_used': True, 'search_queries': ['one', 'two'], 'candidates': [row(status='researched')]}
        updated = scout.ingest(report, {'version': 1, 'candidates': {key: shipped}}, self.workspace)
        self.assertEqual(updated['candidates'][key]['status'], 'released')
        self.assertEqual(updated['candidates'][key]['terminal_reason'], 'released_verified')


class StaleProofTests(unittest.TestCase):
    def test_only_a_stale_proof_sends_a_ready_candidate_back_for_a_fresh_probe(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            old = (scout.dt.datetime.now(scout.UTC) - scout.dt.timedelta(days=3)).isoformat()
            scout.atomic(workspace / 'proof.json', {'version': 1, 'model': 'synthetic-flash', 'source_id': 'synthetic',
                                                    'http_status': 200, 'reply_received': True, 'attribution_verified': True,
                                                    'tool_call_verified': True, 'free_guard_verified': True, 'observed_at': old})
            (workspace / 'proof.json').chmod(0o600)
            ready = row(status='ready_for_review', setup_status='anonymous',
                        release_request={'source_id': 'synthetic', 'head_sha': 'a' * 40},
                        probe={'http_status': 200, 'source_id': 'synthetic', 'reply_received': True,
                               'attribution_verified': True, 'tool_call_verified': True,
                               'free_guard_verified': True, 'evidence_file': 'proof.json'})
            self.assertEqual(scout.evidence_state(ready, workspace), 'stale')
            report = {'web_search_used': True, 'search_queries': ['one', 'two'], 'candidates': [ready]}
            updated = scout.ingest(report, {'version': 1, 'candidates': {}}, workspace)
            stored = updated['candidates'][canonical_candidate_id(ready)]
            self.assertEqual(stored['status'], 'integration_pending')
            self.assertEqual(stored['rework']['reason'], 'proof_stale')
            self.assertEqual(lifecycle.lane(stored), 'finish')
            self.assertEqual(lifecycle.stage_rank(stored), 6)
            # The same defect without an old proof is not mislabelled as stale.
            ready['probe']['evidence_file'] = 'missing.json'
            self.assertEqual(scout.evidence_state(ready, workspace), 'invalid')


class FinishLaneTests(unittest.TestCase):
    def due(self, *items, **extra):
        return {scout.review_id(item): (canonical_candidate_id(item), {**item, 'review_id': scout.review_id(item)})
                for item in items}

    def test_furthest_along_candidate_resumes_first(self):
        rework = row('a.example', status='integration_pending', rework={'reason': 'x'}, qualification_attempts=1)
        signed = row('b.example', status='integration_pending', setup_status='signed_up', qualification_attempts=1)
        pending = row('c.example', status='integration_pending', qualification_attempts=1)
        blocked = row('d.example', status='setup_blocked', qualification_attempts=1)
        due = self.due(blocked, pending, signed, rework)
        planned = lifecycle.plan_scope(due)
        order = [item['homepage'] for _, item in planned.values()]
        self.assertEqual(order[:lifecycle.FINISH_PER_RUN], ['https://a.example', 'https://b.example'])
        self.assertEqual(len(order), lifecycle.FINISH_PER_RUN)  # the rest stay due, not dropped

    def test_equally_advanced_candidates_rotate_by_offers(self):
        first = row('a.example', status='integration_pending', setup_status='signed_up', qualification_offered=2)
        second = row('b.example', status='integration_pending', setup_status='signed_up', qualification_offered=0)
        third = row('c.example', status='integration_pending', setup_status='signed_up', qualification_offered=1)
        planned = lifecycle.plan_scope(self.due(first, second, third))
        self.assertEqual([item['homepage'] for _, item in planned.values()], ['https://b.example', 'https://c.example'])

    def test_caps_fresh_first_and_claimed_verification_last(self):
        finish = [row('f%d.example' % n, status='integration_pending', qualification_attempts=1) for n in range(4)]
        new = [row('n%d.example' % n, status='researched') for n in range(8)]
        verify = [row('v%d.example' % n, status='rejected', signup_friction='high', rejection_basis='claimed') for n in range(3)]
        due = self.due(*finish, *new, *verify)
        fresh = {scout.review_id(new[7])}
        planned = lifecycle.plan_scope(due, fresh)
        lanes = [lifecycle.lane(item) for _, item in planned.values()]
        self.assertEqual(len(planned), lifecycle.SCOPE_PER_RUN)
        self.assertEqual(lanes.count('finish'), lifecycle.FINISH_PER_RUN)
        self.assertEqual(lanes.count('verify'), lifecycle.VERIFY_PER_RUN)
        self.assertEqual(lanes[-1], 'verify')
        self.assertIn(scout.review_id(new[7]), planned)  # this run's discovery outranks the backlog


class BackoffTests(unittest.TestCase):
    def test_progress_resumes_but_unchanged_reviews_back_off_then_park(self):
        item = row(status='integration_pending', qualification_attempts=0)
        better = {**item, 'setup_status': 'signed_up'}
        progressed = lifecycle.review_outcome(item, better, STAMP)
        self.assertIsNone(progressed['qualification_retry_at'])
        self.assertEqual(progressed['qualification_no_progress'], 0)
        first = lifecycle.review_outcome(better, better, STAMP)
        self.assertEqual(first['qualification_retry_at'], '2026-11-25T12:00:00+00:00')
        second = lifecycle.review_outcome({**better, **first}, better, STAMP)
        self.assertEqual(second['qualification_parked'], 'no_new_evidence')
        self.assertEqual(second['qualification_retry_at'], '2026-12-09T00:00:00+00:00')
        self.assertEqual(second['qualification_attempts'], 2)

    def test_hold_never_backs_off_into_a_retry(self):
        held = row(status='needs_approval', setup_status='approval_needed')
        self.assertIsNone(lifecycle.review_outcome(held, held, STAMP)['qualification_retry_at'])

    def test_attempts_are_bounded_even_with_apparent_progress(self):
        item = row(status='integration_pending', qualification_attempts=lifecycle.MAX_ATTEMPTS - 1)
        outcome = lifecycle.review_outcome(item, {**item, 'context_tokens': 999999}, STAMP)
        self.assertEqual(outcome['qualification_parked'], 'attempts_exhausted')

    def test_parked_rows_leave_the_due_scope_until_their_date(self):
        item = row(status='researched')
        ledger = ledger_of(item)
        key = canonical_candidate_id(item)
        outcome = lifecycle.review_outcome(item, item, '2026-11-20T00:00:00+00:00')
        ledger['discovery_pending'][key] = {**item, 'review_id': scout.review_id(item),
                                            **lifecycle.review_outcome({**item, **outcome}, item, '2026-11-20T00:00:00+00:00')}
        with patch.object(scout, 'now', return_value='2026-11-25T00:00:00+00:00'):
            self.assertEqual(scout.qualification_scope(ledger), {})
        with patch.object(scout, 'now', return_value='2026-12-05T00:00:00+00:00'):
            self.assertIn(scout.review_id(item), scout.qualification_scope(ledger))

    def test_unreturned_offers_rotate_then_park(self):
        item = {'qualification_offered': 0}
        for number in range(lifecycle.MAX_OFFERS - 1):
            lifecycle.record_offer(item, STAMP)
        self.assertNotIn('qualification_parked', item)
        lifecycle.record_offer(item, STAMP)
        self.assertEqual(item['qualification_parked'], 'offered_without_result')
        self.assertEqual(item['qualification_offered'], 0)


class ReconcileTests(unittest.TestCase):
    def test_registry_released_retired_and_excluded_reconcile_idempotently(self):
        in_registry = row('live.example', model='live-model', status='integration_pending')
        pipeline_released = row('shipped.example', status='integration_pending', pipeline_status='released',
                                pipeline_updated_at='2026-11-20T00:00:00+00:00')
        removed = row('gone.example', status='integration_pending', pipeline_status='released')
        excluded = row('freeinference.org', status='researched')
        clixad = row('clixad.io', status='setup_blocked')
        untouched = row('other.example', status='researched')
        ledger = ledger_of(in_registry, pipeline_released, removed, excluded, clixad, untouched)
        live = registry({'id': 'live', 'signup': 'https://www.live.example/signup', 'model': 'live-model'},
                        {'id': 'shipped', 'signup': 'https://shipped.example/', 'model': 'something-else'})
        counts = lifecycle.reconcile(ledger, live, stamp=STAMP)
        by = {item['homepage']: item for item in ledger['candidates'].values()}
        self.assertEqual(by['https://live.example']['status'], 'released')
        self.assertEqual(by['https://live.example']['terminal_reason'], 'released_registry')
        self.assertEqual(by['https://shipped.example']['status'], 'released')
        self.assertEqual(by['https://shipped.example']['released_at'], '2026-11-20T00:00:00+00:00')
        self.assertEqual(by['https://gone.example']['status'], 'retired')
        self.assertEqual(by['https://gone.example']['terminal_reason'], 'removed_from_registry')
        self.assertEqual(by['https://freeinference.org']['status'], 'excluded')
        self.assertEqual(by['https://freeinference.org']['status_before'], 'researched')
        self.assertEqual(by['https://clixad.io']['status'], 'retired')
        self.assertEqual(by['https://clixad.io']['terminal_reason'], 'retired_by_operator')
        self.assertEqual(by['https://other.example']['status'], 'researched')
        self.assertEqual((counts['released'], counts['retired'], counts['excluded']), (2, 2, 1))
        again = lifecycle.reconcile(ledger, live, stamp='2027-01-01T00:00:00+00:00')
        self.assertEqual(sum(again.values()), 0)
        self.assertEqual(by['https://live.example']['terminal_at'], STAMP)

    def test_a_signupless_adapter_keeps_its_shipped_row_from_being_retired(self):
        shipped = row('builtin.example', model='built-in-model', status='integration_pending', pipeline_status='released')
        ledger = ledger_of(shipped)
        lifecycle.reconcile(ledger, registry({'id': 'builtin', 'model': 'built-in-model'}), stamp=STAMP)
        self.assertEqual(shipped['status'], 'released')
        other = row('other-builtin.example', model='built-in-model', status='researched')
        lifecycle.reconcile(ledger_of(other), registry({'id': 'builtin', 'model': 'built-in-model'}), stamp=STAMP)
        self.assertEqual(other['status'], 'researched')  # a model-only match never claims a shipment

    def test_retired_hosts_are_not_rediscovered_or_qualified(self):
        item = row('clixad.io', status='researched')
        ledger = ledger_of(item, pending=[item])
        self.assertEqual(scout.qualification_scope(ledger), {})

    def test_unusable_registry_never_retires_or_releases_anything(self):
        shipped = row('shipped.example', status='integration_pending', pipeline_status='released')
        for bad in (None, {}, {'adapters': 'nope'}, {'adapters': [{'id': 'only-one'}]}):
            ledger = ledger_of(copy.deepcopy(shipped))
            lifecycle.reconcile(ledger, bad, stamp=STAMP)
            self.assertEqual(next(iter(ledger['candidates'].values()))['status'], 'released')

    def test_lifted_owner_decisions_restore_the_previous_status(self):
        item = row('freeinference.org', status='researched')
        ledger = ledger_of(item)
        lifecycle.reconcile(ledger, registry(), stamp=STAMP)
        stored = next(iter(ledger['candidates'].values()))
        self.assertEqual(stored['status'], 'excluded')
        ledger['owner_exclusions']['freeinference.org'] = {'excluded': False, 'reason': 'reopened'}
        lifecycle.reconcile(ledger, registry(), stamp=STAMP)
        self.assertEqual((stored['status'], 'terminal_reason' in stored), ('researched', False))
        ledger['retired_sources'] = {'clixad.io': {'retired': False, 'reason': 'back'}}
        clixad = row('clixad.io', status='setup_blocked')
        ledger['candidates'][canonical_candidate_id(clixad)] = clixad
        lifecycle.reconcile(ledger, registry(), stamp=STAMP)
        self.assertEqual(clixad['status'], 'setup_blocked')


class ReworkTests(unittest.TestCase):
    def blocked(self, **changes):
        fields = dict(status='ready_for_review', setup_status='anonymous', pipeline_status='blocked',
                      pipeline_reason='local_checks_not_passed', pipeline_stage='checks',
                      release_request={'source_id': 'synthetic', 'head_sha': 'a' * 40})
        return row(**{**fields, **changes})

    def test_blocked_head_is_sent_back_to_the_worker_a_bounded_number_of_times(self):
        item = self.blocked()
        ledger = ledger_of(item)
        counts = lifecycle.plan_rework(ledger, STAMP)
        self.assertEqual(counts['rework'], 1)
        self.assertEqual(item['status'], 'integration_pending')
        self.assertEqual(item['rework'], {'reason': 'local_checks_not_passed', 'stage': 'checks', 'detail': None,
                                          'head_sha': 'a' * 40, 'at': STAMP})
        self.assertEqual(lifecycle.lane(item), 'finish')
        # Same head blocked again: bounded.
        for number in range(lifecycle.MAX_REWORK):
            item.update(status='ready_for_review', pipeline_status='blocked')
            lifecycle.plan_rework(ledger, STAMP)
        self.assertEqual(item['rework_count'], lifecycle.MAX_REWORK)
        self.assertEqual(item['status'], 'ready_for_review')  # exhausted: stays blocked, visibly

    def test_holds_and_owner_decisions_are_not_reworked(self):
        for reason in ('owner_excluded', 'qualification_held'):
            item = self.blocked(pipeline_reason=reason)
            lifecycle.plan_rework(ledger_of(item), STAMP)
            self.assertEqual(item['status'], 'ready_for_review')
        approval = self.blocked(pipeline_status='needs_approval')
        lifecycle.plan_rework(ledger_of(approval), STAMP)
        self.assertEqual(approval['status'], 'ready_for_review')

    def test_superseded_head_is_reworked_and_an_unsafe_reason_is_not_copied(self):
        item = self.blocked(pipeline_status='superseded', pipeline_reason='Provider said: SECRET text')
        lifecycle.plan_rework(ledger_of(item), STAMP)
        self.assertEqual(item['rework']['reason'], 'pipeline_blocked')


class ReworkBoundaryTests(unittest.TestCase):
    blocked = ReworkTests.blocked

    def test_promotion_publication_and_merged_blocks_are_never_reworked(self):
        for changes in ({'pipeline_stage': 'promotion', 'pipeline_reason': 'pipeline_stage_failed'},
                        {'pipeline_merge_sha': 'c' * 40}, {'pipeline_status': 'publication_pending'},
                        {'pipeline_stage': None, 'pipeline_reason': 'pipeline_stage_failed'}):  # legacy, phase unknown
            with self.subTest(changes=changes):
                item = self.blocked(**changes)
                lifecycle.plan_rework(ledger_of(item), STAMP)
                self.assertEqual(item['status'], 'ready_for_review')

    def test_safety_stops_are_not_reworked(self):
        for detail in sorted(lifecycle.SAFETY_STOPS):
            item = self.blocked(pipeline_stage='review_pre', pipeline_detail=detail)
            lifecycle.plan_rework(ledger_of(item), STAMP)
            self.assertEqual(item['status'], 'ready_for_review', detail)

    def test_main_advancing_does_not_burn_the_lifetime_rework_count_but_stays_bounded(self):
        item = self.blocked(pipeline_status='superseded', pipeline_reason='main_changed_requires_fresh_review',
                            pipeline_stage=None, rework_count=lifecycle.MAX_REWORK)
        ledger = ledger_of(item)
        for number in range(lifecycle.MAX_REBASE):
            item.update(status='ready_for_review', pipeline_status='superseded')
            lifecycle.plan_rework(ledger, STAMP)
            self.assertEqual(item['status'], 'integration_pending', number)
        self.assertEqual((item['rebase_count'], item['rework_count']), (lifecycle.MAX_REBASE, lifecycle.MAX_REWORK))
        item.update(status='ready_for_review', pipeline_status='superseded')
        lifecycle.plan_rework(ledger, STAMP)
        self.assertEqual(item['status'], 'ready_for_review')  # a loop is still stopped

    def test_outage_blocked_head_is_retried_by_the_supervisor_after_the_cooldown_a_bounded_number_of_times(self):
        item = self.blocked(pipeline_reason='stage_retries_exhausted', pipeline_stage='review_pre',
                            pipeline_updated_at='2026-11-24T00:00:00+00:00')
        ledger = ledger_of(item)
        lifecycle.retry_outage_blocks(ledger, '2026-11-24T05:00:00+00:00')
        self.assertEqual(item['pipeline_status'], 'blocked')  # still cooling down
        for number in range(lifecycle.MAX_OUTAGE_RETRIES):
            item.update(pipeline_status='blocked', pipeline_reason='stage_retries_exhausted',
                        pipeline_updated_at='2026-11-24T00:00:00+00:00')
            lifecycle.retry_outage_blocks(ledger, '2026-11-24T07:00:00+00:00')
            self.assertEqual((item['pipeline_status'], item['outage_requeues']), ('deferred', number + 1))
        item.update(pipeline_status='blocked', pipeline_reason='stage_retries_exhausted')
        lifecycle.retry_outage_blocks(ledger, '2026-11-24T07:00:00+00:00')
        self.assertEqual(item['pipeline_status'], 'blocked')
        lifecycle.plan_rework(ledger, STAMP)
        self.assertEqual(item['status'], 'ready_for_review')  # nothing for the worker to repair


class ReconcileBoundaryTests(unittest.TestCase):
    def test_non_authoritative_registry_cannot_retire_and_publication_pending_is_not_released(self):
        shipped = row('shipped.example', status='integration_pending', pipeline_status='released')
        ledger = ledger_of(shipped)
        stale = registry({'id': 'x', 'signup': 'https://other.example/', 'model': 'm'})
        lifecycle.reconcile(ledger, stale, stamp=STAMP, authoritative=False)
        self.assertEqual(shipped['status'], 'released')
        lifecycle.reconcile(ledger, stale, stamp=STAMP)
        self.assertEqual(shipped['status'], 'retired')
        merging = row('live.example', model='live-model', status='ready_for_review', pipeline_status='publication_pending')
        live = registry({'id': 'live', 'signup': 'https://live.example/', 'model': 'live-model'})
        lifecycle.reconcile(ledger_of(merging), live, stamp=STAMP)
        self.assertEqual(merging['status'], 'ready_for_review')


class FailedRunTests(unittest.TestCase):
    def test_a_failure_rotates_a_row_but_parks_only_with_proof_it_is_the_row(self):
        ledger = {'qualification_completed_runs': 0}
        item = {}
        for number in range(lifecycle.MAX_FAILED_OFFERS * 3):
            lifecycle.record_failed_offer(ledger, item, STAMP)
        self.assertNotIn('qualification_parked', item)  # a pure outage never parks
        self.assertEqual(item['qualification_failed_offers'], lifecycle.MAX_FAILED_OFFERS * 3)
        self.assertEqual(item['qualification_last_offered_at'], STAMP)
        ledger['qualification_completed_runs'] = 1  # a run completed elsewhere meanwhile
        lifecycle.record_failed_offer(ledger, item, STAMP)
        self.assertEqual(item['qualification_parked'], 'failed_with_healthy_peers')
        self.assertEqual(item['qualification_retry_at'], '2026-12-09T00:00:00+00:00')

    def test_a_streak_that_began_after_the_last_completed_run_is_not_parked(self):
        ledger = {'qualification_completed_runs': 5}
        item = {}
        for number in range(lifecycle.MAX_FAILED_OFFERS + 2):
            lifecycle.record_failed_offer(ledger, item, STAMP)
        self.assertNotIn('qualification_parked', item)

    def test_suspect_rows_run_after_healthy_ones_and_alone(self):
        def due(*items):
            return {scout.review_id(i): (canonical_candidate_id(i), {**i, 'review_id': scout.review_id(i)}) for i in items}
        healthy = row('h.example', status='integration_pending', setup_status='signed_up', qualification_attempts=1)
        sick = row('s.example', status='integration_pending', setup_status='signed_up', qualification_attempts=1,
                   qualification_failed_offers=1)
        also = row('t.example', status='integration_pending', setup_status='signed_up', qualification_attempts=1,
                   qualification_failed_offers=1)
        self.assertEqual([i['homepage'] for _, i in lifecycle.plan_scope(due(healthy, sick, also)).values()], ['https://h.example'])
        planned = lifecycle.plan_scope(due(sick, also))
        self.assertEqual(len(planned), 1)  # one suspect alone, never two together

    def test_failed_offers_count_in_rotation_and_a_review_clears_them(self):
        item = row(status='integration_pending', qualification_attempts=1, qualification_failed_offers=4,
                   qualification_failed_since_run=0)
        outcome = lifecycle.review_outcome(item, {**item, 'setup_status': 'signed_up'}, STAMP)
        self.assertEqual((outcome['qualification_failed_offers'], outcome['qualification_failed_since_run']), (0, None))


class StuckReportTests(unittest.TestCase):
    def test_terminal_and_parked_conditions_are_counted_with_ids_and_fixed_codes_only(self):
        spent = row('a.example', status='ready_for_review', pipeline_status='blocked', pipeline_reason='local_checks_not_passed',
                    release_request={'head_sha': 'a' * 40}, rework_count=lifecycle.MAX_REWORK)
        promotion = row('b.example', status='ready_for_review', pipeline_status='blocked', pipeline_stage='promotion',
                        pipeline_reason='pipeline_stage_failed', release_request={'head_sha': 'a' * 40})
        outage = row('c.example', status='ready_for_review', pipeline_status='blocked', pipeline_reason='stage_retries_exhausted',
                     outage_requeues=lifecycle.MAX_OUTAGE_RETRIES, release_request={'head_sha': 'a' * 40})
        safety = row('d.example', status='ready_for_review', pipeline_status='blocked', pipeline_detail='worker_cancelled',
                     pipeline_reason='pipeline_stage_failed', release_request={'head_sha': 'a' * 40})
        fresh = row('e.example', status='ready_for_review', pipeline_status='blocked', pipeline_reason='local_checks_not_passed',
                    release_request={'head_sha': 'a' * 40})
        parked = row('f.example', status='researched')
        ledger = ledger_of(spent, promotion, outage, safety, fresh, parked)
        key = canonical_candidate_id(parked)
        ledger['discovery_pending'][key] = {**parked, 'qualification_parked': 'no_new_evidence',
                                            'qualification_retry_at': '2026-12-09T00:00:00+00:00'}
        report = lifecycle.stuck_report(ledger, STAMP)
        self.assertEqual(report['blocked_terminal']['count'], 4)
        self.assertEqual({item['code'] for item in report['blocked_terminal']['candidates']},
                         {'rework_exhausted', 'promotion_blocked', 'outage_retries_exhausted', 'safety_stop'})
        self.assertNotIn(canonical_candidate_id(fresh), {item['id'] for item in report['blocked_terminal']['candidates']})
        self.assertEqual(report['parked'], {'count': 1, 'candidates': [{'id': key, 'code': 'no_new_evidence'}]})
        expired = lifecycle.stuck_report(ledger, '2027-01-01T00:00:00+00:00')
        self.assertEqual(expired['parked']['count'], 0)  # past its date it is due again, not stuck
        self.assertNotIn('http', json.dumps(report))


class RequeueTests(unittest.TestCase):
    def test_orphaned_unfinished_candidates_return_and_terminal_ones_leave_the_queue(self):
        orphan = row('a.example', status='researched')
        stuck = row('b.example', status='integration_pending', setup_status='signed_up')
        shipped = row('c.example', status='integration_pending', pipeline_status='released')
        rejected_on_labels = row('d.example', status='researched', signup_friction='high')
        held = row('e.example', status='setup_blocked', qualification_blocker='human_verification_required')
        excluded = row('freeinference.org', status='researched')
        google = row('antigravity.google.com', model='gemini-x-flash', status='researched')
        claimed = row('g.example', status='rejected', signup_friction='high', rejection_basis='claimed')
        verified = row('h.example', status='rejected', signup_friction='high', rejection_basis='verified')
        ledger = ledger_of(orphan, stuck, shipped, rejected_on_labels, held, excluded, google, claimed, verified, pending=[shipped])
        lifecycle.reconcile(ledger, registry(), stamp=STAMP)
        counts = lifecycle.requeue(ledger, scout.review_id)
        pending = {item['homepage'] for item in ledger['discovery_pending'].values()}
        self.assertEqual(pending, {'https://a.example', 'https://b.example', 'https://g.example'})
        self.assertEqual((counts['requeued'], counts['unqueued_terminal']), (3, 1))
        self.assertEqual(len(ledger['candidates']), 9)  # the queue shrank, no row was dropped
        self.assertEqual(sum(lifecycle.requeue(ledger, scout.review_id).values()), 0)

    def test_requeued_rows_keep_existing_retry_state_when_already_pending(self):
        item = row('a.example', status='researched')
        ledger = ledger_of(item, pending=[item])
        key = canonical_candidate_id(item)
        ledger['discovery_pending'][key]['qualification_retry_at'] = '2099-01-01T00:00:00+00:00'
        lifecycle.requeue(ledger, scout.review_id)
        self.assertEqual(ledger['discovery_pending'][key]['qualification_retry_at'], '2099-01-01T00:00:00+00:00')


class MigrationTests(unittest.TestCase):
    def audit_ledger(self):
        """Shaped like the audit: most researched rows orphaned, genuine integration work stuck."""
        rows = [row('r%d.example' % n, status='researched', free_access='unclear' if n % 2 else 'recurring')
                for n in range(18)]
        rows += [row('s%d.example' % n, status='integration_pending', setup_status='signed_up') for n in range(6)]
        rows += [row('shipped%d.example' % n, status='integration_pending', pipeline_status='released') for n in range(13)]
        rows += [row('x%d.example' % n, status='rejected', signup_friction='high', sightings=1) for n in range(5)]
        rows += [row('y%d.example' % n, status='rejected', signup_friction='high', sightings=4) for n in range(2)]
        rows += [row('freeinference.org', status='researched'), row('clixad.io', status='setup_blocked')]
        ledger = ledger_of(*rows, pending=rows[:3])
        return ledger

    def test_migration_counts_are_idempotent_and_never_drop_rows(self):
        ledger = self.audit_ledger()
        before = lifecycle.ledger_counts(ledger)
        shipped = registry(*({'id': 'shipped%d' % n, 'signup': 'https://shipped%d.example/' % n, 'model': 'synthetic-flash'}
                             for n in range(13)))
        summary = lifecycle.migrate(ledger, shipped, scout.review_id, stamp=STAMP)
        after = lifecycle.ledger_counts(ledger)
        self.assertEqual(before['candidates'], after['candidates'])
        self.assertEqual((after['by_status']['released'], after['by_status']['excluded'], after['by_status']['retired']), (13, 1, 1))
        self.assertEqual(after['by_status']['integration_pending'], 6)
        self.assertEqual(after['rejection_basis'], {'claimed': 5, 'verified': 2})
        # 18 researched - 1 excluded... all unfinished work is back in the queue (labels failing ones excluded).
        self.assertEqual(after['pending'], 18 + 6 + 5)
        self.assertEqual(summary['requeued'], 18 + 6 + 5 - 3 + 0)
        self.assertEqual(ledger['lifecycle_version'], lifecycle.LIFECYCLE_VERSION)
        snapshot = copy.deepcopy(ledger)
        self.assertEqual(sum(value for name, value in lifecycle.migrate(
            ledger, shipped, scout.review_id, stamp='2027-01-01T00:00:00+00:00').items()), 0)
        self.assertEqual(ledger, snapshot)

    def test_migration_refuses_to_lose_a_row(self):
        ledger = self.audit_ledger()
        def lose(target, _review):
            target['candidates'].pop(next(iter(target['candidates'])))
            return {}
        with patch.object(lifecycle, 'requeue', side_effect=lose):
            with self.assertRaises(ValueError):
                lifecycle.migrate(ledger, registry(), scout.review_id, stamp=STAMP)

    def test_state_migration_is_a_dry_run_unless_written_and_backs_up_first(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'state'
            scout.private_directory(root)
            scout.atomic(root / 'ledger.json', self.audit_ledger())
            registry_path = Path(directory) / 'adapters.json'
            registry_path.write_text(json.dumps(registry()))
            original = (root / 'ledger.json').read_bytes()
            dry = scout.migrate_state(root, registry_path, write=False)
            self.assertEqual((root / 'ledger.json').read_bytes(), original)
            self.assertEqual(list(root.glob('ledger.json.*')), [])
            self.assertEqual(dry['before']['candidates'], dry['after']['candidates'])
            written = scout.migrate_state(root, registry_path, write=True)
            backups = list(root.glob('ledger.json.pre-lifecycle-*'))
            self.assertEqual(len(backups), 1)
            self.assertEqual(backups[0].read_bytes(), original)
            self.assertEqual(stat.S_IMODE(backups[0].stat().st_mode), 0o600)
            self.assertEqual(written['after'], dry['after'])
            stored = scout.load(root / 'ledger.json', max_bytes=None)
            self.assertEqual(stored['lifecycle_version'], lifecycle.LIFECYCLE_VERSION)
            again = scout.migrate_state(root, registry_path, write=False)
            self.assertEqual(sum(again['changes'].values()), 0)


class BudgetTests(unittest.TestCase):
    def test_release_stages_keep_their_reserved_share(self):
        plan = lifecycle.plan_budget(9000, True)
        self.assertEqual((plan['resume'], plan['release'], plan['discovery'], plan['qualification']), (2250, 2250, 600, 2400))
        self.assertLessEqual(plan['discovery'] + plan['qualification'] + plan['resume'] + plan['release'], plan['total'] + 2250)
        self.assertGreaterEqual(plan['total'] - plan['discovery'] - plan['qualification'], plan['resume'] + plan['release'])

    def test_total_never_exceeds_the_cadence_and_legacy_budget_still_reserves_release(self):
        self.assertEqual(lifecycle.plan_budget(10 ** 6, True)['total'], lifecycle.MAX_RUN_SECONDS)
        self.assertLess(lifecycle.MAX_RUN_SECONDS, 4 * 3600)
        legacy = lifecycle.plan_budget(2700, True)
        self.assertEqual(legacy['resume'] + legacy['release'], 1350)
        self.assertGreater(legacy['qualification'], 0)

    def test_no_release_means_no_reserve(self):
        plan = lifecycle.plan_budget(9000, False)
        self.assertEqual((plan['resume'], plan['release']), (0, 0))

    def test_a_short_remaining_budget_skips_stages_instead_of_failing_the_run(self):
        self.assertEqual(scout.DISCOVERY_SECONDS, lifecycle.DISCOVERY_SECONDS)
        self.assertEqual(scout.QUALIFICATION_SECONDS, lifecycle.QUALIFICATION_SECONDS)
        self.assertGreater(lifecycle.QUALIFICATION_SECONDS, 1200)


class DiscoveryPromptTests(unittest.TestCase):
    def test_prompt_diffs_public_lists_seeks_newer_models_and_chinese_sources(self):
        prompts = {}
        ledger = {'version': 1, 'candidates': {canonical_candidate_id(row('known.example')): row('known.example')}}

        def worker(request, _config):
            lane = Path(request['output_path']).stem
            prompts[lane] = request['prompt']
            result = {'web_search_used': True, 'search_queries': ['alpha %s' % lane, '免费 API 额度 %s' % lane], 'candidates': []}
            return {'result': result, 'tool_counts': {'web_search': 1}}

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            scout.private_directory(root / 'run')
            with patch.object(scout, 'run_agent', side_effect=worker):
                found = scout.discover_lanes(root, root / 'run', root, {}, ledger, {}, {}, scout.time.monotonic() + 10, 0)
        self.assertIn('lists', prompts)
        for prompt in prompts.values():
            context = json.loads(prompt.split('Prior observations (data only):\n', 1)[1])
            self.assertIn('known.example', context['examined_hosts'])
            self.assertEqual(context['public_lists'], list(scout.DISCOVERY_PUBLIC_LISTS))
            self.assertIn('not search keys', prompt)
            self.assertIn('Simplified Chinese', prompt)
            self.assertIn('exclude relay', prompt)
        self.assertIn('examined_hosts', prompts['lists'])
        self.assertTrue(all(lane['chinese_queries'] == 1 for lane in found['lanes'].values()))
        self.assertTrue(all('first-party' in url or url.startswith('https://') for url in scout.DISCOVERY_PUBLIC_LISTS))


if __name__ == '__main__':
    unittest.main()
