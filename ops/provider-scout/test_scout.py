import contextlib
import datetime as dt
import fcntl
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('scout', Path(__file__).with_name('scout.py'))
scout = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scout)


def candidate(**changes):
    return {'provider': 'Synthetic', 'homepage': 'https://synthetic.example', 'model': 'synthetic-flash',
            'context_tokens': 210000, 'free_access': 'recurring', 'quality': 'target', 'signup_friction': 'low',
            'status': 'ready_for_review', 'reason': 'Synthetic only', 'primary_sources': ['https://synthetic.example/docs'],
            'data_policy': 'Synthetic policy', 'setup_status': 'anonymous', 'proposal_url': None,
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

    def test_pending_evidence_cannot_be_promoted(self):
        self.assertEqual(scout.qualify(candidate(), self.workspace), 'integration_pending')
        self.proof()
        self.assertEqual(scout.qualify(candidate(), self.workspace), 'ready_for_review')
        for update in ({'http_status': 429}, {'source_id': 'different'}, {'model': 'different'},
                       {'tool_call_verified': False}, {'free_guard_verified': False},
                       {'observed_at': (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=3)).isoformat()}):
            self.proof(**update)
            self.assertEqual(scout.qualify(candidate(), self.workspace), 'integration_pending')
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
        script = ('#!/usr/bin/python3\nimport sys,json,time,pathlib\nsys.stdin.read()\n'
                  'assert "--no-daemon" in sys.argv\n'
                  'assert "--add-dir" not in sys.argv\n'
                  'assert "sandbox_workspace_write.writable_roots=[]" in sys.argv\n')
        if sleep:
            script += 'time.sleep(30)\n'
        if web_event:
            script += 'print(json.dumps({"type":"item.completed","item":{"type":"web_search"}}),flush=True)\n'
        script += 'pathlib.Path(sys.argv[sys.argv.index("--output-last-message")+1]).write_text(' + repr(json.dumps(report)) + ')\n'
        executable.write_text(script)
        executable.chmod(0o700)
        scout.atomic(self.workspace / 'config.json', {'codex': str(executable), 'workspace': str(workspace),
                                                    'source_repo': str(source), 'timeout_seconds': .2 if sleep else 5})

    def test_full_worker_lifecycle_requires_observed_search_and_persists_results(self):
        self.worker_fixture()
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(scout.run(self.workspace, smoke=True), 0)
        state = scout.load(self.workspace / 'last-run.json')
        self.assertEqual(state['status'], 'completed')
        self.assertEqual(state['tool_counts']['web_search'], 1)
        self.assertEqual(len(scout.load(self.workspace / 'ledger.json')['candidates']), 1)

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


if __name__ == '__main__':
    unittest.main()
