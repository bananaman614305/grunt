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

    def test_supervisor_release_state_survives_worker_ingests(self):
        report = {'web_search_used': True, 'search_queries': ['one', 'two'], 'candidates': [candidate()]}
        key = scout.candidate_id(candidate())
        for status in ('released', 'publication_pending'):
            ledger = {'version':1, 'candidates':{key:{**candidate(), 'pipeline_status':status,
                                                    'pipeline_reason':'trusted result','pipeline_updated_at':'old'}}}
            updated = scout.ingest(report, ledger, self.workspace)
            self.assertEqual(updated['candidates'][key]['pipeline_status'], status)
            self.assertEqual(updated['candidates'][key]['pipeline_reason'], 'trusted result')

    def test_one_integration_per_run_and_none_in_smoke(self):
        item = candidate(release_request={'source_id':'synthetic'})
        report = {'web_search_used':True,'search_queries':['one','two'],
                  'candidates':[item, candidate(homepage='https://second.example',release_request={'source_id':'second'})]}
        with self.assertRaisesRegex(ValueError, 'Integration budget'):
            scout.ingest(report, {'candidates':{}}, self.workspace)
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
                  'assert "sandbox_workspace_write.writable_roots=[]" in sys.argv\n'
                  'if "--approve-for-me" in sys.argv:\n'
                  ' assert "-a" not in sys.argv and "--sandbox" not in sys.argv\n'
                  'else:\n'
                  ' assert sys.argv[sys.argv.index("-a")+1] == "never"\n'
                  ' assert sys.argv[sys.argv.index("--sandbox")+1] == "workspace-write"\n'
                  'assert \'mcp_servers.squire.tools.list_credentials.approval_mode="approve"\' in sys.argv\n'
                  'assert "--dangerously-bypass-approvals-and-sandbox" not in sys.argv\n')
        if sleep:
            script += 'time.sleep(30)\n'
        if web_event:
            script += 'print(json.dumps({"type":"item.completed","item":{"type":"web_search"}}),flush=True)\n'
        script += 'pathlib.Path(sys.argv[sys.argv.index("--output-last-message")+1]).write_text(' + repr(json.dumps(report)) + ')\n'
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

    def test_full_worker_lifecycle_requires_observed_search_and_persists_results(self):
        self.worker_fixture()
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(scout.run(self.workspace, smoke=True), 0)
        state = scout.load(self.workspace / 'last-run.json')
        self.assertEqual(state['status'], 'completed')
        self.assertEqual(state['tool_counts']['web_search'], 1)
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
        self.worker_fixture()
        config = scout.load(self.workspace / 'config.json')
        config['release_enabled'] = True
        scout.atomic(self.workspace / 'config.json', config)
        source = {'checkout':'candidates/synthetic','head_sha':'a'*40,'base_sha':'b'*40,
                  'source_id':'synthetic','model':'synthetic-flash','evidence_file':'proof.json',
                  'config_dir':None,'pr_number':None}
        item = candidate(release_request=source)
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
            def resume_pending(self):
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
        self.assertIn('_deadline_monotonic', calls[0][1])
        self.assertIsInstance(calls[0][1]['_lock_fd'], int)
        self.assertNotIn('_deadline_monotonic', scout.load(self.workspace / 'config.json'))
        self.assertNotIn('_lock_fd', scout.load(self.workspace / 'config.json'))
        request = agent.call_args.args[0]
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
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(scout.run(self.workspace, smoke=True), 0)
        controller.assert_not_called()

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

    def test_resume_consumes_integration_budget_before_fresh_candidate(self):
        _, _, result = self.enabled_pipeline_fixture()
        pipeline = Mock()
        pipeline.resume_pending.return_value = [{'status':'publication_pending','source_id':'other','head_sha':'c'*40,'reason':'waiting'}]
        agent = Mock(return_value=result)
        with patch.dict('sys.modules',{'pipeline':types.SimpleNamespace(Pipeline=Mock(return_value=pipeline))}), \
                patch.object(scout,'run_agent',agent), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(scout.run(self.workspace),0)
        pipeline.process.assert_not_called()
        prompt = agent.call_args.args[0]['prompt']
        context = json.loads(prompt.split('## This run\n',1)[1])
        self.assertEqual(context['max_integrations'],0)

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
                return 'https://github.com/bananaman614305/milo.git\n'
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
