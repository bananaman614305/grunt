import contextlib
import datetime as dt
import fcntl
import importlib.util
import io
import json
import os
from pathlib import Path
import signal
import tempfile
import threading
import time
import types
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('scout', Path(__file__).with_name('scout.py'))
scout = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scout)


def candidate(**changes):
    return {'provider': 'Synthetic', 'homepage': 'https://synthetic.example', 'model': 'synthetic-flash',
            'context_tokens': 210000, 'free_access': 'recurring', 'quality': 'target', 'signup_friction': 'low',
            'status': 'ready_for_review', 'reason': 'Synthetic only', 'primary_sources': ['https://synthetic.example/docs'],
            'data_policy': 'Synthetic policy', 'setup_status': 'anonymous', 'proposal_url': None, 'release_request': None,
            'probe': {'http_status': 200, 'source_id': 'synthetic', 'reply_received': True,
                      'attribution_verified': True, 'tool_call_verified': True, 'free_guard_verified': True,
                      'evidence_file': 'proof.json'}, **changes}


class ScoutTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.workspace = Path(self.temporary.name)

    def proof(self, **changes):
        value = {'version': 1, 'model': 'synthetic-flash', 'source_id': 'synthetic', 'http_status': 200,
                 'reply_received': True, 'attribution_verified': True, 'tool_call_verified': True,
                 'free_guard_verified': True, 'observed_at': scout.now(), **changes}
        scout.atomic(self.workspace / 'proof.json', value)

    def test_existing_crontab_is_preserved_and_install_is_idempotent(self):
        original = '# another project\n*/5 * * * * /other/project.sh\n'
        result = scout.cron_text(original, '/safe/scout run')
        self.assertTrue(result.startswith(original))
        self.assertEqual(result.count('0 9,21 * * *'), 1)
        self.assertEqual(scout.cron_text(result, '/safe/scout run'), result)
        replaced = scout.cron_text(result, '/safe/new-scout run')
        self.assertNotIn('/safe/scout run', replaced)
        self.assertIn(original, replaced)

    def test_ambiguous_crontab_is_not_overwritten(self):
        with self.assertRaises(ValueError):
            scout.cron_text(scout.BEGIN, '/safe/scout')

    def test_crash_leftovers_do_not_block_atomic_state_updates(self):
        leftover = self.workspace / 'last-run.json.tmp'
        leftover.write_text('interrupted earlier write')
        scout.atomic(self.workspace / 'last-run.json', {'status': 'completed'})
        self.assertEqual(scout.load(self.workspace / 'last-run.json'), {'status': 'completed'})
        self.assertEqual(leftover.read_text(), 'interrupted earlier write')
        self.assertEqual(list(self.workspace.glob('last-run.json.*.tmp')), [])

    def test_pending_evidence_cannot_be_promoted(self):
        self.assertEqual(scout.qualify(candidate(), self.workspace), 'integration_pending')
        self.proof()
        ready = candidate(release_request={'source_id':'synthetic'})
        self.assertEqual(scout.qualify(ready, self.workspace), 'ready_for_review')
        self.assertEqual(scout.qualify(candidate(), self.workspace), 'integration_pending')
        for update in ({'http_status': 429}, {'source_id': 'different'}, {'model': 'different'},
                       {'tool_call_verified': False}, {'free_guard_verified': False},
                       {'observed_at': (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=3)).isoformat()}):
            self.proof(**update)
            self.assertEqual(scout.qualify(ready, self.workspace), 'integration_pending')
        self.proof()
        self.assertEqual(scout.qualify(candidate(setup_status='approval_needed'), self.workspace), 'needs_approval')

    def test_ineligible_offers_cannot_be_promoted(self):
        self.proof()
        for update in ({'context_tokens': 42000}, {'free_access': 'one_time'},
                       {'quality': 'below_baseline'}, {'signup_friction': 'high'}):
            self.assertEqual(scout.qualify(candidate(**update), self.workspace), 'rejected')
        self.assertEqual(scout.qualify(candidate(free_access='unclear'), self.workspace), 'researched')

    def test_smoke_is_research_only(self):
        self.proof()
        self.assertEqual(scout.qualify(candidate(), self.workspace, smoke=True), 'researched')

    def test_100milionseek_context_exception_is_exact(self):
        offer = {'homepage': 'https://100milionseek.top', 'model': 'deepseek-v4.1-flash-free', 'context_tokens': 198000}
        self.assertEqual(scout.qualify(candidate(**offer), self.workspace), 'integration_pending')
        for change in ({'context_tokens': 197999}, {'homepage': 'https://mirror.example'},
                       {'model': 'deepseek-v4.1-flash'}, {'free_access': 'one_time'}):
            with self.subTest(change=change):
                self.assertEqual(scout.qualify(candidate(**(offer | change)), self.workspace), 'rejected')

    def test_private_or_tokenized_urls_are_not_accepted(self):
        for url in ('http://synthetic.example', 'https://key@synthetic.example',
                    'https://synthetic.example/?token=synthetic', 'https://synthetic.example/#secret'):
            with self.assertRaises(ValueError):
                scout.qualify(candidate(homepage=url), self.workspace)

    def test_evidence_cannot_escape_the_workspace(self):
        self.proof()
        item = candidate()
        item['probe']['evidence_file'] = '../outside.json'
        self.assertFalse(scout.ready_evidence(item, self.workspace))
        alias = self.workspace / 'alias.json'
        alias.symlink_to(self.workspace / 'proof.json')
        item['probe']['evidence_file'] = 'alias.json'
        self.assertFalse(scout.ready_evidence(item, self.workspace))

    def test_ledger_deduplicates_provider_model_and_preserves_first_seen(self):
        report = {'web_search_used': True, 'search_queries': ['one', 'two'], 'candidates': [candidate()]}
        empty = {'version': 1, 'candidates': {}}
        first = scout.ingest(report, empty, self.workspace)
        second = scout.ingest(report, first, self.workspace)
        key = scout.candidate_id(candidate())
        self.assertEqual(len(second['candidates']), 1)
        self.assertEqual(second['candidates'][key]['sightings'], 2)
        self.assertEqual(first['candidates'][key]['first_seen'], second['candidates'][key]['first_seen'])
        self.assertEqual(empty['candidates'], {})

    def test_candidate_identity_matches_discovery_alias_normalization(self):
        item = candidate(homepage='https://openrouter.ai')
        for homepage in ['https://www.openrouter.ai', 'https://docs.openrouter.ai']:
            self.assertEqual(scout.candidate_id(item), scout.candidate_id(candidate(homepage=homepage)))

    def test_owner_exclusion_cannot_be_reopened_by_new_model_or_changed_terms(self):
        item = candidate(homepage='https://freeinference.org', model='different-free-model')
        key = scout.candidate_id(item)
        ledger = {'candidates': {key: item}, 'discovery_pending': {key: item}}
        self.assertEqual(scout.qualification_scope(ledger), {})
        report = {'web_search_used': True, 'search_queries': ['one', 'two'], 'candidates': [item]}
        errors = []
        updated = scout.ingest(report, ledger, self.workspace, diagnostics=errors)
        self.assertEqual(errors, [{'row': 0, 'code': 'owner_excluded'}])
        self.assertEqual(updated['candidates'], ledger['candidates'])

    def test_unfinished_qualification_stays_pending_with_bounded_retry(self):
        item = candidate(status='researched', setup_status='not_attempted')
        review = scout.review_id(item)
        key = scout.candidate_id(item)
        ledger = {'candidates': {key: item}, 'discovery_pending': {key: {**item, 'review_id': review}}}
        report = {'candidates': [{**item, 'review_id': review}]}
        with patch.object(scout, 'now', return_value='2026-11-20T00:00:00+00:00'):
            scout.finish_reviews(ledger, report, {review: (key, item)}, [])
            self.assertIn(key, ledger['discovery_pending'])
            self.assertEqual(scout.qualification_scope(ledger), {})
        with patch.object(scout, 'now', return_value='2026-11-20T12:00:00+00:00'):
            self.assertIn(review, scout.qualification_scope(ledger))
        self.assertEqual(ledger['discovery_pending'][key]['qualification_attempts'], 1)

    def test_approval_pending_is_retained_without_automatic_retries(self):
        item = candidate(status='needs_approval', setup_status='approval_needed')
        review = scout.review_id(item); key = scout.candidate_id(item)
        ledger = {'candidates': {key: item}, 'discovery_pending': {key: item}}
        scout.finish_reviews(ledger, {'candidates': [{**item, 'review_id': review}]}, {review: (key, item)}, [])
        self.assertIn(key, ledger['discovery_pending'])
        self.assertEqual(scout.qualification_scope(ledger), {})

    def test_owner_decisions_are_durable_and_do_not_mutate_research_facts(self):
        item = candidate(homepage='https://www.freeinference.org')
        key = scout.candidate_id(item)
        scout.atomic(self.workspace / 'ledger.json', {'candidates': {key: item}, 'discovery_pending': {key: item}})
        self.assertEqual(scout.owner_decision(self.workspace, item['homepage'], excluded=True,
                                            reason='Owner opted out')['excluded'], True)
        ledger = scout.load(self.workspace / 'ledger.json')
        self.assertEqual(ledger['candidates'][key], item)
        self.assertEqual(ledger['discovery_pending'], {})
        scout.owner_decision(self.workspace, item['homepage'], excluded=False, reason='Owner explicitly reopened it')
        ledger = scout.load(self.workspace / 'ledger.json')
        self.assertIsNone(scout.owner_exclusion(item, ledger))
        scout.canonicalize_ledger(ledger)
        self.assertFalse(ledger['owner_exclusions']['freeinference.org']['excluded'])

    def test_ledger_migration_merges_aliases_and_resolved_placeholder(self):
        older = candidate(homepage='https://www.synthetic.example', model='unverified',
                          status='researched', first_seen='2026-11-01', last_seen='2026-11-02')
        exact = candidate(homepage='https://synthetic.example', status='needs_approval',
                          first_seen='2026-11-03', last_seen='2026-11-04')
        newer_alias = {**exact, 'homepage': 'https://www.synthetic.example', 'last_seen': '2026-11-05'}
        ledger = {'candidates': {'legacy-unknown': older, 'legacy-exact': exact, 'legacy-alias': newer_alias},
                  'discovery_pending': {}, 'reviewed_discoveries': {'a' * 64: {'candidate_id': 'legacy-unknown',
                                                                          'at': '2026-11-05T00:00:00+00:00'}}}
        scout.canonicalize_ledger(ledger)
        key = scout.candidate_id(exact)
        self.assertEqual(list(ledger['candidates']), [key])
        self.assertEqual(ledger['candidates'][key]['first_seen'], '2026-11-01')
        self.assertEqual(ledger['candidates'][key]['status'], 'needs_approval')
        self.assertEqual(ledger['reviewed_discoveries']['a' * 64]['candidate_id'], key)
        scout.resume_unfinished_reviews(ledger)
        self.assertIn(key, ledger['discovery_pending'])
        self.assertEqual(scout.qualification_scope(ledger), {})

    def test_ledger_migration_preserves_promotion_and_distinct_exact_models(self):
        released = candidate(pipeline_status='released', release_request={'head_sha': 'a' * 40}, last_seen='old')
        alias = candidate(homepage='https://www.synthetic.example', last_seen='new')
        different = candidate(model='another-model')
        ledger = {'candidates': {'old': released, 'alias': alias, 'other': different}}
        scout.canonicalize_ledger(ledger)
        self.assertEqual(len(ledger['candidates']), 2)
        self.assertEqual(ledger['candidates'][scout.candidate_id(released)]['release_request']['head_sha'], 'a' * 40)
        self.assertEqual(ledger['candidates'][scout.candidate_id(released)]['pipeline_status'], 'released')

    def test_placeholder_migration_preserves_holds_in_either_insertion_order(self):
        for human in (False, True):
            for reverse_candidates in (False, True):
                for reverse_pending in (False, True):
                    with self.subTest(human=human, candidates=reverse_candidates, pending=reverse_pending):
                        exact = candidate(status='researched', setup_status='not_attempted',
                                          last_seen='2026-11-19T00:00:00+00:00', reason='Older research')
                        held = candidate(model='unverified', status='setup_blocked' if human else 'needs_approval',
                                         setup_status='blocked' if human else 'approval_needed',
                                         reason='human_verification_required' if human else 'New source-code sale condition',
                                         last_seen='2026-11-20T00:00:00+00:00',
                                         primary_sources=['https://synthetic.example/new-policy'])
                        if human:
                            held['qualification_blocker'] = 'human_verification_required'
                        exact_key, held_key = scout.candidate_id(exact), scout.candidate_id(held)
                        entries = [(exact_key, exact), (held_key, held)]
                        pending = [(held_key, {**held, 'review_id': 'a' * 64, 'qualification_retry_at': None}),
                                   (exact_key, {**exact, 'review_id': 'b' * 64,
                                                'qualification_retry_at': '2026-11-19T12:00:00+00:00'})]
                        ledger = {'candidates': dict(reversed(entries) if reverse_candidates else entries),
                                  'discovery_pending': dict(reversed(pending) if reverse_pending else pending)}
                        scout.canonicalize_ledger(ledger)
                        current = ledger['candidates'][exact_key]
                        self.assertEqual(current['model'], exact['model'])
                        self.assertEqual(current['status'], held['status'])
                        self.assertEqual(current['setup_status'], held['setup_status'])
                        self.assertEqual(current['reason'], held['reason'])
                        self.assertEqual(current['primary_sources'], held['primary_sources'])
                        self.assertEqual(len(ledger['candidates']), 1)
                        self.assertIsNone(ledger['discovery_pending'][exact_key]['qualification_retry_at'])
                        self.assertEqual(ledger['discovery_pending'][exact_key]['reason'], held['reason'])
                        self.assertEqual(scout.qualification_scope(ledger), {})
                        before = json.loads(json.dumps(ledger))
                        scout.canonicalize_ledger(ledger)
                        self.assertEqual(ledger, before)

    def test_alias_hold_preserves_release_identity_and_skips_legacy_held_scope(self):
        released = candidate(pipeline_status='publication_pending', release_request={'head_sha': 'a' * 40},
                             last_seen='2026-11-19T00:00:00+00:00')
        held = candidate(homepage='https://www.synthetic.example', status='needs_approval',
                         setup_status='approval_needed', reason='New material condition',
                         last_seen='2026-11-20T00:00:00+00:00')
        key = scout.candidate_id(released)
        ledger = {'candidates': {'old': released, 'new': held},
                  'discovery_pending': {'new': {**held, 'review_id': 'a' * 64}}}
        scout.canonicalize_ledger(ledger)
        self.assertEqual(ledger['candidates'][key]['release_request']['head_sha'], 'a' * 40)
        self.assertEqual(ledger['candidates'][key]['pipeline_status'], 'publication_pending')
        self.assertEqual(ledger['candidates'][key]['status'], 'needs_approval')
        self.assertEqual(scout.qualification_scope(ledger), {})

    def test_freeform_mentions_of_completed_or_absent_challenges_do_not_hold_work(self):
        for reason in ['No CAPTCHA required; usable context still needs verification',
                       'Human verification completed; SDK entitlement pending',
                       'CAPTCHA solved; remaining SDK entitlement pending']:
            with self.subTest(reason=reason):
                item = candidate(status='researched', setup_status='not_attempted', reason=reason,
                                 qualification_blocker=None)
                self.assertEqual(scout.qualification_retry(item, 1, '2026-11-20T00:00:00+00:00'),
                                 '2026-11-20T12:00:00+00:00')
                key = scout.candidate_id(item)
                # Migrate a null retry left by the former prose regex: the
                # structured state, not an old null, determines the hold.
                pending = {**item, 'review_id': 'a' * 64, 'qualification_retry_at': None}
                ledger = {'candidates': {key: item}, 'discovery_pending': {key: pending}}
                scout.canonicalize_ledger(ledger)
                self.assertIn('a' * 64, scout.qualification_scope(ledger))

    def test_structured_unresolved_gate_cannot_be_queued_for_release(self):
        self.proof()
        item = candidate(qualification_blocker='human_verification_required',
                         release_request={'source_id': 'synthetic', 'head_sha': 'a' * 40})
        self.assertEqual(scout.qualify(item, self.workspace), 'needs_approval')
        key = scout.candidate_id(item)
        ledger = {'candidates': {key: {**item, 'pipeline_status': 'deferred'}}}
        self.assertEqual(scout.queue_candidates(ledger, {'candidates': []}, {'candidates': []}, [], []), [])

    def test_resume_uses_latest_review_and_human_gate_is_not_retried(self):
        item = candidate(status='setup_blocked', setup_status='blocked', reason='human_verification_required',
                         qualification_blocker='human_verification_required')
        key = scout.candidate_id(item)
        ledger = {'candidates': {key: item}, 'reviewed_discoveries': {
            'a' * 64: {'candidate_id': key, 'at': '2026-11-01T00:00:00+00:00'},
            'b' * 64: {'candidate_id': key, 'at': '2026-11-20T00:00:00+00:00'}}}
        scout.resume_unfinished_reviews(ledger)
        self.assertEqual(ledger['discovery_pending'][key]['review_id'], 'b' * 64)
        self.assertIsNone(ledger['discovery_pending'][key]['qualification_retry_at'])
        self.assertEqual(scout.qualification_scope(ledger), {})
        self.assertEqual(scout.qualification_retry(candidate(status='researched'), 1000,
                                                 '2026-11-20T00:00:00+00:00'), '2026-11-27T00:00:00+00:00')

    def test_discovery_owner_exclusion_overrides_a_claimed_material_change(self):
        directory = self.workspace / 'run'; scout.private_directory(directory)
        old = candidate(homepage='https://freeinference.org', status='rejected')
        changed = {**old, 'status': 'researched', 'change_evidence': {
            'field': 'signup', 'before': 'academic-only', 'after': 'public signup',
            'source': old['primary_sources'][0]}}
        ledger = {'candidates': {scout.candidate_id(old): old}}
        def worker(*_args):
            return {'result': {'web_search_used': True, 'search_queries': ['one', 'two'], 'candidates': [changed]},
                    'tool_counts': {'web_search': 2}}
        with patch.object(scout, 'run_agent', side_effect=worker):
            result = scout.discover_lanes(self.workspace, directory, self.workspace, {}, ledger, {}, {},
                                          time.monotonic() + 10, 0)
        self.assertEqual(result['candidates'], [])
        self.assertEqual(scout.qualification_scope(ledger), {})
        self.assertTrue(all(lane['owner_excluded_offers'] == 1 for lane in result['lanes'].values()))

    def test_supervisor_release_state_survives_worker_ingests(self):
        report = {'web_search_used': True, 'search_queries': ['one', 'two'], 'candidates': [candidate()]}
        key = scout.candidate_id(candidate())
        for status in ('released', 'publication_pending'):
            ledger = {'version':1, 'candidates':{key:{**candidate(), 'pipeline_status':status,
                                                    'pipeline_reason':'trusted result','pipeline_updated_at':'old'}}}
            updated = scout.ingest(report, ledger, self.workspace)
            self.assertEqual(updated['candidates'][key]['pipeline_status'], status)
            self.assertEqual(updated['candidates'][key]['pipeline_reason'], 'trusted result')

    def test_merged_candidate_retains_its_pending_publication_identity(self):
        self.proof()
        request = {'source_id':'synthetic','head_sha':'a'*40}
        pending = candidate(release_request=request, pipeline_status='publication_pending')
        key = scout.candidate_id(pending)
        newer = candidate(release_request={**request,'head_sha':'b'*40})
        report = {'web_search_used': True, 'search_queries': ['one', 'two'], 'candidates': [newer]}
        updated = scout.ingest(report, {'candidates':{key:pending}}, self.workspace)
        self.assertEqual(updated['candidates'][key]['release_request'], request)
        scout.record_pipeline_result(updated, {**request,'status':'released'})
        self.assertEqual(updated['candidates'][key]['pipeline_status'], 'released')

    def test_current_ready_resubmission_can_reopen_blocked_head(self):
        self.proof()
        item = candidate(release_request={'source_id':'synthetic','head_sha':'a'*40})
        key = scout.candidate_id(item)
        ledger = {'candidates':{key:{**item,'pipeline_status':'blocked'}}}
        report = {'candidates':[item]}
        self.assertEqual(scout.queue_candidates(ledger, {'candidates':[]}, report, [], []), [])
        self.assertEqual(scout.queue_candidates(ledger, report, report, [], []), [ledger['candidates'][key]])
        self.assertEqual(ledger['candidates'][key]['pipeline_status'], 'deferred')

    def test_full_run_accepts_many_integrations_and_smoke_accepts_none(self):
        item = candidate(release_request={'source_id':'synthetic'})
        report = {'web_search_used':True,'search_queries':['one','two'],
                  'candidates':[item, *[candidate(homepage=f'https://source{index}.example',
                                                release_request={'source_id':f'source{index}'}) for index in range(25)]]}
        self.assertEqual(len(scout.ingest(report, {'candidates':{}}, self.workspace)['candidates']), 26)
        report['candidates'] = [item]
        with self.assertRaisesRegex(ValueError, 'Integration budget'):
            scout.ingest(report, {'candidates':{}}, self.workspace, smoke=True)

    def test_report_and_summary_use_operator_validated_statuses(self):
        report = {'summary': 'Synthetic provider ready for review', 'web_search_used': True,
                  'search_queries': ['one', 'two'], 'candidates': [candidate()], 'blockers': []}
        updated = scout.ingest(report, {'version': 1, 'candidates': {}}, self.workspace)
        normalized = scout.normalized_report(report, updated)
        self.assertEqual(normalized['candidates'][0]['status'], 'integration_pending')
        self.assertIn('0 ready for review', normalized['summary'])
        self.assertEqual(report['candidates'][0]['status'], 'ready_for_review')

    def test_public_doc_navigation_keeps_nineteen_offer_batch_intact(self):
        selectors = ['models','pricing','limits','rate-limits','privacy','terms','docs']
        rows = [candidate(provider=f'Synthetic {index}', homepage=f'https://provider{index}.example',
                          primary_sources=[f'https://provider{index}.example/docs?section={selectors[index%len(selectors)]}'],
                          status='researched') for index in range(19)]
        rows[7]['primary_sources'] = ['https://ony.synthetic.example/?section=models']
        rows[12]['context_tokens'] = 42000
        report = {'summary':'Synthetic nineteen-offer mirror','web_search_used':True,
                  'search_queries':['synthetic free models','synthetic recurring limits'],'candidates':rows,'blockers':[]}
        errors = []
        ledger = scout.ingest(report,{'version':1,'candidates':{}},self.workspace,diagnostics=errors)
        normalized = scout.normalized_report(report,ledger,errors)
        self.assertEqual(errors,[])
        self.assertEqual(len(ledger['candidates']),19)
        self.assertEqual(len(normalized['candidates']),19)
        self.assertEqual(ledger['candidates'][scout.candidate_id(rows[12])]['status'],'rejected')

    def test_bad_row_is_quarantined_without_payload_or_loss_of_good_rows(self):
        secret = 'PRIVATE_SIGNED_URL_PAYLOAD'
        bad = candidate(provider=secret,homepage='https://bad.example/?token='+secret,reason=secret)
        good = candidate(homepage='https://good.example',status='researched')
        report = {'summary':secret,'web_search_used':True,'search_queries':[secret,secret],
                  'candidates':[bad,good],'blockers':[secret]}
        errors = []
        ledger = scout.ingest(report,{'version':1,'candidates':{}},self.workspace,diagnostics=errors)
        normalized = scout.normalized_report(report,ledger,errors)
        self.assertEqual(errors,[{'row':0,'code':'invalid_homepage_url'}])
        self.assertEqual(len(ledger['candidates']),1)
        self.assertEqual(normalized['validation']['quarantined'],1)
        self.assertNotIn(secret,json.dumps({'ledger':ledger,'report':normalized}))
        self.assertEqual(normalized['candidates'][0]['homepage'],good['homepage'])

    def test_ambiguous_duplicate_ids_quarantine_all_rows_and_preserve_old_record(self):
        old = candidate(reason='Historical valid record')
        key = scout.candidate_id(old)
        ledger = {'version':1,'candidates':{key:old}}
        duplicate_bad = candidate(primary_sources=['https://synthetic.example/?signature=PRIVATE'])
        report = {'summary':'Duplicates','web_search_used':True,'search_queries':['one','two'],
                  'candidates':[candidate(),duplicate_bad],'blockers':[]}
        errors = []
        updated = scout.ingest(report,ledger,self.workspace,diagnostics=errors)
        self.assertEqual(updated,ledger)
        self.assertEqual({item['row'] for item in errors},{0,1})
        self.assertEqual(scout.normalized_report(report,updated,errors)['candidates'],[])

    def test_malformed_candidate_is_isolated_but_invalid_envelope_still_fails(self):
        report = {'web_search_used':True,'search_queries':['one','two'],
                  'candidates':[None,candidate(status='researched')]}
        errors = []
        updated = scout.ingest(report,{'candidates':{}},self.workspace,diagnostics=errors)
        self.assertEqual(len(updated['candidates']),1)
        self.assertEqual(errors,[{'row':0,'code':'invalid_candidate_shape'}])
        with self.assertRaises(ValueError):
            scout.ingest({**report,'search_queries':'not-a-search-list'},updated,self.workspace)

    def test_overlapping_run_never_starts_a_worker(self):
        with open(self.workspace / 'run.lock', 'w') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with contextlib.redirect_stdout(io.StringIO()) as output:
                self.assertEqual(scout.run(self.workspace), 0)
            self.assertIn('already running', output.getvalue())

    def test_failed_research_cannot_mutate_the_ledger(self):
        ledger = {'version': 1, 'candidates': {}}
        with self.assertRaises(ValueError):
            scout.ingest({'web_search_used': False, 'search_queries': [], 'candidates': []}, ledger, self.workspace)
        self.assertEqual(ledger['candidates'], {})

    def worker_fixture(self, web_event=True, sleep=False):
        source = self.workspace / 'source'
        (source / 'registry').mkdir(parents=True)
        scout.atomic(source / 'registry/adapters.json', {'version': 1, 'adapters': []})
        workspace = self.workspace / 'work'
        scout.private_directory(workspace)
        scout.private_directory(self.workspace / 'runs')
        scout.private_directory(self.workspace / 'reports')
        executable = self.workspace / 'fake-codex'
        report = {'summary': 'Synthetic scout run', 'web_search_used': True,
                  'search_queries': ['synthetic one', 'synthetic two'], 'candidates': [candidate()], 'blockers': []}
        script = ('#!/usr/bin/python3\nimport sys,json,time,pathlib\nprompt=sys.stdin.read()\n'
                  'assert "--no-daemon" in sys.argv\n'
                  'assert "--add-dir" not in sys.argv\n'
                  'if "--approve-for-me" in sys.argv:\n'
                  ' assert "-a" not in sys.argv and "--sandbox" not in sys.argv\n'
                  ' assert "sandbox_workspace_write.writable_roots=[]" in sys.argv\n'
                  ' assert \'mcp_servers.squire.tools.list_credentials.approval_mode="approve"\' in sys.argv\n'
                  'else:\n'
                  ' assert sys.argv[sys.argv.index("-a")+1] == "never"\n'
                  ' assert sys.argv[sys.argv.index("--sandbox")+1] == "read-only"\n'
                  ' assert "mcp_servers.squire.enabled=false" in sys.argv\n'
                  'assert "--dangerously-bypass-approvals-and-sandbox" not in sys.argv\n')
        if sleep:
            script += 'time.sleep(30)\n'
        if web_event:
            script += 'print(json.dumps({"type":"item.completed","item":{"type":"web_search"}}),flush=True)\n'
        script += 'report=json.loads(' + repr(json.dumps(report)) + ')\n'
        script += ('if "--approve-for-me" in sys.argv:\n'
                   ' context=json.loads(prompt.split("## This run\\n",1)[1])\n'
                   ' report["candidates"][0]["review_id"]=context["new_or_changed_offers"][0]["review_id"]\n'
                   'else:\n'
                   ' report["candidates"][0]["change_evidence"]=None\n'
                   'pathlib.Path(sys.argv[sys.argv.index("--output-last-message")+1]).write_text(json.dumps(report))\n')
        executable.write_text(script)
        executable.chmod(0o700)
        proxy = self.workspace / 'squire_proxy.py'
        proxy.write_text('# protected proxy fixture\n')
        proxy.chmod(0o600)
        helper = self.workspace / 'provision.mjs'
        helper.write_text('// protected helper fixture\n')
        helper.chmod(0o600)
        codex_home = self.workspace / 'codex-home'
        scout.private_directory(codex_home)
        (codex_home / 'config.toml').write_text('')
        scout.atomic(self.workspace / 'config.json', {'codex': str(executable), 'workspace': str(workspace),
                                                    'source_repo': str(source), 'timeout_seconds': .2 if sleep else 5,
                                                    'squire_proxy': str(proxy), 'codex_home': str(codex_home),
                                                    'provision_helper':str(helper)})

    def test_parallel_discovery_uses_common_history_and_deduplicates_offers(self):
        root = self.workspace
        prior = root / 'runs' / 'older'
        directory = root / 'runs' / 'recent'
        scout.private_directory(prior)
        scout.private_directory(directory)
        scout.atomic(prior / 'discovery.json', {'search_queries': ['An earlier hosted model query']})
        old = candidate(homepage='https://openrouter.ai', model='known-flash')
        ledger = {'version': 1, 'candidates': {scout.candidate_id(old): old}}
        shared = candidate(homepage='https://new-provider.example')
        barrier = threading.Barrier(3)

        def worker(request, _config):
            lane = Path(request['output_path']).stem
            self.assertEqual(request['role'], 'discoverer')
            self.assertIn('An earlier hosted model query', request['prompt'])
            self.assertIn('known-flash', request['prompt'])
            barrier.wait(2)
            if lane == 'tools':
                rows = [{**shared, 'homepage': 'https://www.new-provider.example'}]
            elif lane == 'gateways':
                rows = [old, candidate(homepage='https://another-gateway.example')]
            else:
                rows = [shared, {**old, 'homepage': 'https://docs.openrouter.ai'}]
            result = {'web_search_used': True, 'search_queries': ['An EARLIER hosted model query', f'new {lane} query'], 'candidates': rows}
            scout.atomic(Path(request['output_path']), result)
            return {'result': result, 'tool_counts': {'web_search': 2}}

        with patch.object(scout, 'run_agent', side_effect=worker):
            result = scout.discover_lanes(root, directory, root, {}, ledger, {}, {}, time.monotonic()+10, 0)
        self.assertEqual(result['status'], 'completed')
        self.assertEqual(result['tool_counts'], {'web_search': 6})
        self.assertEqual([row['homepage'] for row in result['candidates']], ['https://new-provider.example', 'https://another-gateway.example'])
        self.assertEqual(result['lanes']['tools']['duplicate_offers'], 1)
        self.assertEqual(result['lanes']['direct']['repeat_queries'], 1)
        self.assertEqual(result['lanes']['gateways']['duplicate_offers'], 1)
        self.assertEqual(len(result['search_queries']), 4)
        self.assertEqual(ledger['candidates'][scout.candidate_id(old)], old)
        self.assertEqual(set(row['status'] for row in result['candidates']), {'researched'})
        self.assertTrue(all(not row['probe']['reply_received'] for row in result['candidates']))
        self.assertEqual([path.name for path in directory.glob('*.json')], ['discovery.json'])

    def test_discovery_persists_partial_success_before_qualification_failure(self):
        self.worker_fixture()
        root = self.workspace
        fresh = candidate(homepage='https://new-sdk.example')
        invalid = candidate(homepage='https://sensitive.example?token=secret')
        def worker(request, _config, _progress=None):
            lane = Path(request['output_path']).stem
            if lane == 'direct' or request['role'] == 'implementer':
                if request['role'] == 'implementer':
                    self.assertIn('new-sdk.example', request['prompt'])
                    self.assertIn(scout.candidate_id(fresh), scout.load(root / 'ledger.json')['candidates'])
                raise scout.WorkerError('worker_timeout')
            result = {'web_search_used': True, 'search_queries': [f'first {lane}', f'next {lane}'],
                      'candidates': [fresh, invalid] if lane == 'tools' else []}
            scout.atomic(Path(request['output_path']), result)
            return {'result': result, 'tool_counts': {'web_search': 1}}

        with patch.object(scout, 'run_agent', side_effect=worker), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(scout.run(root), 1)
        state = scout.load(root / 'last-run.json')
        self.assertEqual(state['discovery']['status'], 'partial')
        self.assertEqual(state['discovery']['lanes']['direct']['reason'], 'worker_timeout')
        self.assertEqual(state['discovery']['lanes']['tools']['quarantined'], 1)
        saved = root / 'runs' / state['id'] / 'discovery.json'
        self.assertNotIn('secret', saved.read_text())
        self.assertEqual(scout.load(saved)['candidates'][0]['homepage'], fresh['homepage'])

    def test_changed_offer_keeps_unfinished_work_without_immediate_research(self):
        self.worker_fixture()
        root = self.workspace
        old = candidate(context_tokens=210000)
        changed = candidate(context_tokens=500000, homepage='https://www.synthetic.example', change_evidence={
            'field': 'usable_context', 'before': '210,000 tokens', 'after': '500,000 tokens',
            'source': old['primary_sources'][0],
        })
        key = scout.candidate_id(old)
        scout.atomic(root / 'ledger.json', {'version': 1, 'candidates': {key: old}})
        supplied = []

        def worker(request, _config, _progress=None):
            lane = Path(request['output_path']).stem
            if request['role'] == 'implementer':
                context = json.loads(request['prompt'].split('## This run\n', 1)[1])
                supplied.append(context['new_or_changed_offers'])
                rows = [] if len(supplied) == 1 else [{**old, 'review_id': supplied[-1][0]['review_id']}]
            else:
                rows = [changed] if lane == 'tools' else [old]
            report = {'summary': 'fixture', 'web_search_used': True, 'search_queries': [f'first {lane}', f'next {lane}'],
                      'candidates': rows, 'blockers': []}
            return {'result': report, 'tool_counts': {'web_search': 1}}

        with patch.object(scout, 'run_agent', side_effect=worker), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(scout.run(root), 0)
            self.assertEqual(scout.load(root / 'ledger.json')['discovery_pending'][key]['context_tokens'], 500000)
            self.assertEqual(scout.run(root), 0)
            self.assertEqual(scout.run(root), 0)
        self.assertEqual([[row['context_tokens'] for row in offers] for offers in supplied], [[500000], [500000]])
        self.assertEqual(supplied[0][0]['homepage'], old['homepage'])
        stored = scout.load(root / 'ledger.json')
        self.assertEqual(stored['discovery_pending'][key]['status'], 'integration_pending')
        self.assertEqual(stored['discovery_pending'][key]['qualification_attempts'], 1)
        self.assertEqual(scout.qualification_scope(stored), {})
        self.assertIn(supplied[0][0]['review_id'], stored['reviewed_discoveries'])
        self.assertEqual(stored['candidates'][key]['context_tokens'], 210000)
        self.assertEqual(scout.load(root / 'last-run.json')['qualification'], 'skipped_no_pending_offers')

    def test_previously_rejected_alias_with_relabelled_facts_does_not_restart_qualification(self):
        self.worker_fixture()
        root = self.workspace
        old = candidate(context_tokens=42000, homepage='https://openrouter.ai', status='rejected')
        changed = candidate(context_tokens=900000, homepage='https://docs.openrouter.ai')
        key = scout.candidate_id(old)
        scout.atomic(root / 'ledger.json', {'version': 1, 'candidates': {key: old}})

        def worker(request, *_args):
            self.assertEqual(request['role'], 'discoverer')
            result = {'web_search_used': True, 'search_queries': ['one safe query', 'another safe query'],
                      'candidates': [changed]}
            return {'result': result, 'tool_counts': {'web_search': 1}}

        with patch.object(scout, 'run_agent', side_effect=worker) as agent, contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(scout.run(root), 0)
        self.assertEqual(agent.call_count, 3)
        saved = scout.load(root / 'ledger.json')
        self.assertEqual(saved['candidates'], {key: old})
        self.assertEqual(saved['discovery_pending'], {})
        self.assertEqual(scout.load(root / 'last-run.json')['qualification_offers'], 0)

    def test_search_record_backfills_old_runs_and_deduplicates_manual_qualification_queries(self):
        root = self.workspace
        scout.private_directory(root / 'reports')
        for index in range(14):
            scout.atomic(root / 'reports' / f'{index:02}.json', {'search_queries': [f'Offer {index}']})
        scout.atomic(root / 'reports' / '14.json', {'search_queries': [' offer   0 ', 'x bearer secret']})
        ledger = {'version': 1, 'candidates': {}}
        scout.archive_history(root, ledger)
        self.assertEqual(len(ledger['search_queries']), 14)
        self.assertEqual(ledger['search_queries']['offer 0'], 'Offer 0')
        report = {'web_search_used': True, 'search_queries': ['OFFER 0', 'manual provider inquiry'],
                  'candidates': []}
        updated = scout.ingest(report, ledger, root)
        self.assertEqual(len(updated['search_queries']), 15)
        self.assertEqual(updated['search_queries']['manual provider inquiry'], 'manual provider inquiry')
        scout.atomic(root / 'reports' / '15.json', {'search_queries': ['later standalone report']})
        scout.archive_history(root, updated)
        self.assertEqual(len(updated['search_queries']), 16)
        self.assertIn('later standalone report', updated['search_queries'])

    def test_qualification_may_resolve_unknown_model_but_cannot_reopen_another_provider(self):
        pending = candidate(model='unverified', homepage='https://synthetic.example')
        review = scout.review_id(pending)
        rows = [candidate(review_id=review), candidate(homepage='https://outside.example', review_id=review)]
        report = {'summary': 'fixture', 'web_search_used': True, 'search_queries': ['one', 'two'],
                  'candidates': rows, 'blockers': []}
        key = scout.candidate_id(pending)
        ledger = {'version': 1, 'candidates': {}, 'discovery_pending': {key: pending}}
        errors = []
        updated = scout.ingest(report, ledger, self.workspace, diagnostics=errors, scope={review: pending})
        self.assertEqual(errors, [{'row': 1, 'code': 'outside_qualification_scope'}])
        scout.finish_reviews(updated, report, {review: (key, pending)}, errors)
        self.assertIn(scout.candidate_id(rows[0]), updated['discovery_pending'])
        self.assertNotIn(key, updated['discovery_pending'])
        self.assertNotIn('review_id', updated['candidates'][scout.candidate_id(rows[0])])
        self.assertEqual(len(updated['candidates']), 1)

    def test_full_worker_lifecycle_requires_observed_search_and_persists_results(self):
        self.worker_fixture()
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(scout.run(self.workspace, smoke=True), 0)
        state = scout.load(self.workspace / 'last-run.json')
        self.assertEqual(state['status'], 'completed')
        self.assertEqual(state['tool_counts']['web_search'], 3)
        self.assertEqual(set(state['discovery']['lanes']), {'direct', 'tools', 'gateways'})
        self.assertEqual(len(scout.load(self.workspace / 'ledger.json')['candidates']), 1)
        saved = scout.load(Path(state['report']))
        self.assertEqual(saved['candidates'][0]['status'], 'researched')
        self.assertIn('0 ready for review', state['summary'])

    def test_model_claiming_search_without_a_search_event_fails(self):
        self.worker_fixture(web_event=False)
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(scout.run(self.workspace), 1)
        self.assertFalse((self.workspace / 'ledger.json').exists())
        self.assertEqual(scout.load(self.workspace / 'last-run.json')['status'], 'failed')

    def test_deadline_stops_owned_worker_and_records_failure(self):
        self.worker_fixture(sleep=True)
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(scout.run(self.workspace), 1)
        state = scout.load(self.workspace / 'last-run.json')
        self.assertEqual(state['status'], 'failed')
        self.assertEqual(state['reason'], 'worker timeout')
        self.assertFalse((self.workspace / 'ledger.json').exists())

    def enabled_pipeline_fixture(self):
        refresher = patch.object(scout, 'refresh_source_main')
        self.refresher = refresher.start()
        self.addCleanup(refresher.stop)
        snapshot = patch.object(scout,'read_source_snapshot',return_value={
            'base_sha':'b'*40,'registry':{'version':1,'adapters':[{'id':'fresh-canonical-provider'}]}})
        self.snapshot = snapshot.start()
        self.addCleanup(snapshot.stop)
        def discover(_root, _directory, _workspace, _registry, ledger, *_args):
            pending = ledger.setdefault('discovery_pending', {})
            for row in self.discovered:
                if row['review_id'] not in ledger.get('reviewed_discoveries', {}):
                    pending[scout.candidate_id(row)] = row
            return {'status': 'completed', 'lanes': {}, 'tool_counts': {}, 'candidates': [], 'search_queries': []}

        discovery = patch.object(scout, 'discover_lanes', side_effect=discover)
        discovery.start()
        self.addCleanup(discovery.stop)
        self.worker_fixture()
        config = scout.load(self.workspace / 'config.json')
        config['release_enabled'] = True
        scout.atomic(self.workspace / 'config.json', config)
        source = {'checkout':'candidates/synthetic','head_sha':'a'*40,'base_sha':'b'*40,
                  'source_id':'synthetic','model':'synthetic-flash','evidence_file':'proof.json',
                  'config_dir':None,'pr_number':None}
        item = candidate(release_request=source)
        item['review_id'] = scout.review_id(item)
        self.discovered = [item]
        self.proof()
        scout.atomic(Path(config['workspace']) / 'proof.json', scout.load(self.workspace / 'proof.json'))
        report = {'summary':'Synthetic integration','web_search_used':True,'search_queries':['one','two'],
                  'candidates':[item],'blockers':[]}
        return config, item, {'result':report,'tool_counts':{'web_search':1},'exit_code':0}

    def test_full_run_resumes_then_promotes_one_exact_candidate(self):
        config, item, result = self.enabled_pipeline_fixture()
        calls = []
        class Pipeline:
            def __init__(self, supplied, root):
                self.supplied = supplied
                calls.append(('init', supplied, root))
            def set_qualification_holds(self, holds):
                self.supplied['_qualification_holds'] = dict(holds)
            def resume_pending(self, *, reserve_seconds):
                self.reserve_seconds = reserve_seconds
                calls.append(('resume',))
                return []
            def process(self, supplied):
                calls.append(('process', supplied))
                return {'status':'released','reason':'verified','source_id':'synthetic','head_sha':'a'*40}
        agent = Mock(return_value=result)
        with patch.dict('sys.modules', {'pipeline':types.SimpleNamespace(Pipeline=Pipeline)}), \
                patch.object(scout, 'run_agent', agent), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(scout.run(self.workspace), 0)
        self.assertEqual([call[0] for call in calls], ['init','resume','process'])
        self.refresher.assert_called_once()
        self.assertEqual(self.refresher.call_args.args[0], config['source_repo'])
        self.snapshot.assert_called_once()
        self.assertIn('_deadline_monotonic', calls[0][1])
        self.assertIsInstance(calls[0][1]['_lock_fd'], int)
        self.assertNotIn('_deadline_monotonic', scout.load(self.workspace / 'config.json'))
        self.assertNotIn('_lock_fd', scout.load(self.workspace / 'config.json'))
        request = agent.call_args.args[0]
        context = json.loads(request['prompt'].split('## This run\n',1)[1])
        self.assertEqual(context['base_sha'],'b'*40)
        self.assertEqual(context['curated_registry']['adapters'],[{'id':'fresh-canonical-provider'}])
        self.assertLessEqual(request['timeout_seconds'], 1200)
        self.assertTrue(request['require_web_search'])
        ledger = scout.load(self.workspace / 'ledger.json')
        self.assertEqual(ledger['candidates'][scout.candidate_id(item)]['pipeline_status'], 'released')
        self.assertEqual(scout.load(self.workspace / 'last-run.json')['pipeline_results'][0]['status'], 'released')

    def test_smoke_never_runs_release_controller_even_when_enabled(self):
        self.worker_fixture()
        config = scout.load(self.workspace / 'config.json')
        config['release_enabled'] = True
        scout.atomic(self.workspace / 'config.json', config)
        controller = Mock(side_effect=AssertionError('Smoke attempted release'))
        with patch.dict('sys.modules', {'pipeline':types.SimpleNamespace(Pipeline=controller)}), \
                patch.object(scout,'refresh_source_main') as refresh, \
                patch.object(scout,'read_source_snapshot') as snapshot, \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(scout.run(self.workspace, smoke=True), 0)
        controller.assert_not_called()
        refresh.assert_not_called()
        snapshot.assert_not_called()

    def test_resumed_publication_is_durable_when_later_research_fails(self):
        config, item, _ = self.enabled_pipeline_fixture()
        item['pipeline_status'] = 'publication_pending'
        key = scout.candidate_id(item)
        scout.atomic(self.workspace / 'ledger.json', {'version':1,'candidates':{key:item}})
        pipeline = Mock()
        pipeline.resume_pending.return_value = [{'status':'released','source_id':'synthetic','reason':'verified'}]
        with patch.dict('sys.modules', {'pipeline':types.SimpleNamespace(Pipeline=Mock(return_value=pipeline))}), \
                patch.object(scout,'run_agent',side_effect=scout.WorkerError('worker_did_not_search')), \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(scout.run(self.workspace), 1)
        self.assertEqual(scout.load(self.workspace / 'ledger.json')['candidates'][key]['pipeline_status'], 'released')
        pipeline.process.assert_not_called()

    def test_resuming_a_publication_still_allows_a_fresh_candidate(self):
        _, _, result = self.enabled_pipeline_fixture()
        pipeline = Mock()
        pipeline.resume_pending.return_value = [{'status':'publication_pending','source_id':'other','head_sha':'c'*40,'reason':'waiting'}]
        pipeline.process.return_value = {'status':'released','source_id':'synthetic','head_sha':'a'*40}
        agent = Mock(return_value=result)
        with patch.dict('sys.modules',{'pipeline':types.SimpleNamespace(Pipeline=Mock(return_value=pipeline))}), \
                patch.object(scout,'run_agent',agent), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(scout.run(self.workspace),0)
        pipeline.process.assert_called_once()
        prompt = agent.call_args.args[0]['prompt']
        context = json.loads(prompt.split('## This run\n',1)[1])
        self.assertNotIn('max_integrations',context)

    def test_blocked_head_does_not_prevent_another_qualified_candidate_from_releasing(self):
        config, first, result = self.enabled_pipeline_fixture()
        proof = scout.load(Path(config['workspace']) / 'proof.json')
        scout.atomic(Path(config['workspace']) / 'second-proof.json', {**proof, 'source_id':'second'})
        second = candidate(homepage='https://second.example', probe={
            **first['probe'], 'source_id':'second','evidence_file':'second-proof.json'
        }, release_request={
            **first['release_request'], 'source_id':'second','head_sha':'d'*40
        })
        second['review_id'] = scout.review_id(second)
        self.discovered.append(second)
        result['result']['candidates'].append(second)
        pipeline = Mock()
        pipeline.resume_pending.return_value = []
        pipeline.process.side_effect = [
            {'status':'blocked','reason':'candidate_validation_failed'},
            {'status':'released','source_id':'second','head_sha':'d'*40}
        ]
        with patch.dict('sys.modules', {'pipeline':types.SimpleNamespace(Pipeline=Mock(return_value=pipeline))}), \
                patch.object(scout,'run_agent',return_value=result), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(scout.run(self.workspace),0)
        self.assertEqual([call.args[0]['release_request']['source_id'] for call in pipeline.process.call_args_list],
                         ['synthetic','second'])
        ledger = scout.load(self.workspace/'ledger.json')['candidates']
        self.assertEqual(ledger[scout.candidate_id(first)]['pipeline_status'],'blocked')
        self.assertEqual(ledger[scout.candidate_id(second)]['pipeline_status'],'released')

    def test_qualified_candidate_waiting_at_deadline_resumes_from_ledger(self):
        _, item, result = self.enabled_pipeline_fixture()
        pipeline = Mock()
        pipeline.resume_pending.return_value = []
        followup = {**result, 'result': {**result['result'], 'candidates':[]}}
        pipeline.process.side_effect = [
            {'status':'deferred','reason':'pipeline_budget_exhausted'},
            {'status':'released','source_id':'synthetic','head_sha':'a'*40}
        ]
        with patch.dict('sys.modules', {'pipeline':types.SimpleNamespace(Pipeline=Mock(return_value=pipeline))}), \
                patch.object(scout,'run_agent',side_effect=[result, followup]), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(scout.run(self.workspace),0)
            self.assertEqual(scout.run(self.workspace),0)
        self.assertEqual(pipeline.process.call_count,2)
        ledger = scout.load(self.workspace/'ledger.json')['candidates']
        self.assertEqual(ledger[scout.candidate_id(item)]['pipeline_status'],'released')

    def test_old_blocked_candidate_does_not_starve_fresh_report_candidate(self):
        _, fresh, result = self.enabled_pipeline_fixture()
        stale = candidate(provider='Old', homepage='https://old.synthetic.example',
                          release_request={**fresh['release_request'],'source_id':'old','head_sha':'c'*40})
        stale.update(pipeline_status='blocked',pipeline_reason='previous attempt failed')
        scout.atomic(self.workspace / 'ledger.json', {'version':1,'candidates':{scout.candidate_id(stale):stale}})
        pipeline = Mock()
        pipeline.resume_pending.return_value = []
        pipeline.process.return_value = {'status':'released','source_id':'synthetic','head_sha':'a'*40,'reason':'verified'}
        with patch.dict('sys.modules',{'pipeline':types.SimpleNamespace(Pipeline=Mock(return_value=pipeline))}), \
                patch.object(scout,'run_agent',return_value=result), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(scout.run(self.workspace),0)
        pipeline.process.assert_called_once()
        self.assertEqual(pipeline.process.call_args.args[0]['provider'],'Synthetic')
        ledger = scout.load(self.workspace / 'ledger.json')['candidates']
        self.assertEqual(ledger[scout.candidate_id(stale)]['pipeline_status'],'blocked')
        self.assertEqual(ledger[scout.candidate_id(fresh)]['pipeline_status'],'released')

    def test_run_never_promotes_quarantined_historical_row_or_retains_raw_payload(self):
        _, fresh, result = self.enabled_pipeline_fixture()
        secret = 'PRIVATE_URL_CANARY_NEVER_RETAIN'
        historical = candidate(homepage='https://historical.example',reason='Earlier accepted record',
                               release_request={**fresh['release_request'],'source_id':'old','head_sha':'c'*40})
        key = scout.candidate_id(historical)
        scout.atomic(self.workspace/'ledger.json',{'version':1,'candidates':{key:historical}})
        bad = candidate(homepage=historical['homepage'],provider=secret,
                        primary_sources=['https://historical.example/?signature='+secret])
        result['result'].update(summary=secret,search_queries=[secret,secret],blockers=[secret],candidates=[bad,fresh])
        def execute(request,*_args):
            scout.atomic(Path(request['output_path']),result['result'])
            return result
        pipeline = Mock()
        pipeline.resume_pending.return_value = []
        pipeline.process.return_value = {'status':'released','source_id':'synthetic','head_sha':'a'*40,'reason':'verified'}
        with patch.dict('sys.modules',{'pipeline':types.SimpleNamespace(Pipeline=Mock(return_value=pipeline))}), \
                patch.object(scout,'run_agent',side_effect=execute),contextlib.redirect_stdout(io.StringIO()) as printed:
            self.assertEqual(scout.run(self.workspace),0)
        pipeline.process.assert_called_once()
        self.assertEqual(pipeline.process.call_args.args[0]['homepage'],fresh['homepage'])
        for path in self.workspace.rglob('*.json'):
            self.assertNotIn(secret,path.read_text(),str(path))
        self.assertNotIn(secret,printed.getvalue())
        state = scout.load(self.workspace/'last-run.json')
        self.assertEqual(state['candidate_errors'],[{'row':0,'code':'invalid_primary_source_url'}])
        self.assertEqual(scout.load(self.workspace/'ledger.json')['candidates'][key]['reason'],'Earlier accepted record')

    def test_superseded_resume_does_not_consume_fresh_integration_budget(self):
        _, item, result = self.enabled_pipeline_fixture()
        stale = candidate(homepage='https://old.synthetic.example',
                          release_request={**item['release_request'],'source_id':'old','head_sha':'c'*40})
        scout.atomic(self.workspace / 'ledger.json', {'version':1,'candidates':{scout.candidate_id(stale):stale}})
        pipeline = Mock()
        pipeline.resume_pending.return_value = [{'status':'superseded','source_id':'old','head_sha':'c'*40,
                                                 'reason':'main_changed_requires_fresh_review'}]
        pipeline.process.return_value = {'status':'released','source_id':'synthetic','head_sha':'a'*40,'reason':'verified'}
        agent = Mock(return_value=result)
        with patch.dict('sys.modules',{'pipeline':types.SimpleNamespace(Pipeline=Mock(return_value=pipeline))}), \
                patch.object(scout,'run_agent',agent), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(scout.run(self.workspace),0)
        pipeline.process.assert_called_once()
        context = json.loads(agent.call_args.args[0]['prompt'].split('## This run\n',1)[1])
        self.assertNotIn('max_integrations',context)
        ledger = scout.load(self.workspace / 'ledger.json')['candidates']
        self.assertEqual(ledger[scout.candidate_id(stale)]['pipeline_status'],'superseded')
        self.assertEqual(ledger[scout.candidate_id(item)]['pipeline_status'],'released')

    def test_release_disabled_run_does_not_refresh_source(self):
        self.worker_fixture()
        with patch.object(scout,'refresh_source_main') as refresh, contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(scout.run(self.workspace),0)
        refresh.assert_not_called()

    def test_source_refresh_only_fetches_canonical_main_with_bounded_safe_process(self):
        process = Mock(pid=999999999)
        process.wait.return_value = 0
        with patch.object(scout.subprocess,'Popen',return_value=process) as launch, \
                patch.object(scout.os,'killpg') as kill, \
                patch.dict(os.environ,{'GITHUB_TOKEN':'must-not-inherit','GIT_CONFIG_COUNT':'99'}):
            scout.refresh_source_main(self.workspace,timeout=300)
        args = launch.call_args.args[0]
        env = launch.call_args.kwargs['env']
        self.assertIn('core.hooksPath=/dev/null',args)
        self.assertIn('core.fsmonitor=false',args)
        helpers = [arg for arg in args if arg.startswith('credential.')]
        executable = str(Path(scout.shutil.which('gh')).resolve())
        self.assertEqual(helpers,['credential.helper=',
                                 'credential.https://github.com.helper=!' + scout.shlex.quote(executable) + ' auth git-credential'])
        self.assertEqual(args[-2:],['https://github.com/bananaman614305/grunt.git',
                                    '+refs/heads/main:refs/remotes/origin/main'])
        self.assertIn('--no-write-fetch-head',args)
        self.assertNotIn('checkout',args)
        self.assertNotIn('reset',args)
        self.assertNotIn('GITHUB_TOKEN',env)
        self.assertNotIn('GIT_CONFIG_COUNT',env)
        self.assertEqual(env['GIT_CONFIG_GLOBAL'],'/dev/null')
        self.assertEqual(env['GIT_TERMINAL_PROMPT'],'0')
        self.assertTrue(launch.call_args.kwargs['start_new_session'])
        process.wait.assert_any_call(timeout=60)
        self.assertEqual(kill.call_count,2)

    def test_source_snapshot_reads_registry_at_pinned_canonical_commit(self):
        head = 'a'*40
        processes = []
        def launch(args, **kwargs):
            process = Mock(pid=999999999,returncode=0)
            process.communicate.return_value = ((head+'\n').encode() if args[-3:-1] == ['rev-parse','--verify']
                                                 else b'{"version":1,"adapters":[{"id":"canonical"}]}', None)
            processes.append((args,kwargs,process))
            return process
        with patch.object(scout.subprocess,'Popen',side_effect=launch), patch.object(scout.os,'killpg'):
            snapshot = scout.read_source_snapshot(self.workspace)
        self.assertEqual(snapshot,{'base_sha':head,'registry':{'version':1,'adapters':[{'id':'canonical'}]}})
        self.assertEqual(processes[0][0][-3:],['rev-parse','--verify','refs/remotes/origin/main^{commit}'])
        self.assertEqual(processes[1][0][-2:],['show',head+':registry/adapters.json'])
        for args,kwargs,process in processes:
            self.assertIn('core.hooksPath=/dev/null',args)
            self.assertIn('core.fsmonitor=false',args)
            self.assertEqual(kwargs['env']['GIT_NO_REPLACE_OBJECTS'],'1')
            self.assertTrue(kwargs['start_new_session'])
            process.stdout.close.assert_called_once()

    def test_pipeline_cancellation_records_status_and_restores_handlers(self):
        _, _, result = self.enabled_pipeline_fixture()
        pipeline = Mock()
        pipeline.resume_pending.return_value = []
        pipeline.process.side_effect = scout.ScoutCancelled()
        before = {number:signal.getsignal(number) for number in (signal.SIGTERM,signal.SIGINT)}
        with patch.dict('sys.modules',{'pipeline':types.SimpleNamespace(Pipeline=Mock(return_value=pipeline))}), \
                patch.object(scout,'run_agent',return_value=result), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(scout.run(self.workspace),1)
        self.assertEqual(scout.load(self.workspace / 'last-run.json')['status'],'cancelled')
        self.assertEqual(before,{number:signal.getsignal(number) for number in before})

    def test_install_copies_all_runtime_modules_and_preserves_configuration(self):
        state = self.workspace / 'state'
        scout.private_directory(state)
        checkout = state / 'workspace' / 'repo'
        checkout.mkdir(parents=True, mode=0o700)
        (state / 'workspace').chmod(0o700)
        scout.atomic(state / 'config.json', {'version':1,'release_enabled':False,'npm_ref':'squire:existing',
                                            'timeout_seconds':2400,'custom_setting':'preserved'})
        source = self.workspace / 'source'
        source.mkdir()
        installed_cron = {}
        def run(args, **kwargs):
            if args == ['crontab','-l']:
                return types.SimpleNamespace(returncode=0,stdout='# other job\n',stderr='')
            if args == ['crontab','-']:
                installed_cron['text'] = kwargs['input']
                return types.SimpleNamespace(returncode=0)
            raise AssertionError(args)
        def output(args, **_kwargs):
            if args[0] == 'timedatectl':
                return 'America/New_York\n'
            if args[0] == 'git':
                return 'https://github.com/bananaman614305/grunt.git\n'
            if args == ['crontab','-l']:
                return installed_cron['text']
            raise AssertionError(args)
        with patch.object(Path,'home',return_value=self.workspace), \
                patch.object(scout.shutil,'which',side_effect=lambda name:'/usr/bin/'+name), \
                patch.object(scout.subprocess,'run',side_effect=run), \
                patch.object(scout.subprocess,'check_output',side_effect=output), \
                contextlib.redirect_stdout(io.StringIO()):
            scout.install(state, source)
        config = scout.load(state / 'config.json')
        self.assertEqual(config['version'], 2)
        self.assertEqual(config['repository'], 'bananaman614305/grunt')
        self.assertFalse(config['release_enabled'])
        self.assertEqual(config['npm_ref'], 'squire:existing')
        self.assertEqual(config['custom_setting'], 'preserved')
        self.assertEqual(config['timeout_seconds'], 2400)
        target = self.workspace / '.local/lib/usegrunt-scout'
        for name in ('worker.py','validation.py','promotion.py','squire_proxy.py','probe.mjs','publish.mjs','sandbox.py'):
            self.assertTrue((target / name).is_file(), name)
            self.assertEqual((target / name).stat().st_mode & 0o777, 0o600)
        self.assertEqual(list(target.glob('test_*')), [])
        self.assertEqual(config['squire_proxy'], str(target / 'squire_proxy.py'))


if __name__ == '__main__':
    unittest.main()
