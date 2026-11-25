import importlib.util
import json
import os
from pathlib import Path
import tempfile
import threading
import time
import tomllib
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('scout_worker', Path(__file__).with_name('worker.py'))
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)

FAKE_CODEX = r'''#!/usr/bin/python3
import json, os, pathlib, subprocess, sys, time
args=sys.argv[1:]
cwd=pathlib.Path(args[args.index('-C')+1])
behavior=json.loads((cwd/'behavior.json').read_text())
output=pathlib.Path(args[args.index('--output-last-message')+1])
sys.stdin.read()
assert 'OPENAI_API_KEY' not in os.environ
assert 'SQUIRE_RAW_TOKEN' not in os.environ
if 'lock_fd' in behavior:
    os.fstat(behavior['lock_fd'])
if behavior.get('child'):
    child=subprocess.Popen(['/usr/bin/python3','-c','import time; time.sleep(60)'], stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    (cwd/'child.pid').write_text(str(child.pid))
if behavior.get('mcp'):
    print(json.dumps({'type':'item.started','item':{'type':'mcp_tool_call','arguments':'PRIVATE_TOOL_PAYLOAD'}}),flush=True)
if behavior.get('search',True):
    print(json.dumps({'type':'item.completed','item':{'type':'web_search','query':'PRIVATE_QUERY'}}),flush=True)
if behavior.get('rejection'):
    print(json.dumps({'type':'item.completed','item':{'type':'mcp_tool_call','error':'approval denied PRIVATE_TOOL_PAYLOAD'}}),flush=True)
if behavior.get('delay'):
    time.sleep(behavior['delay'])
if behavior.get('fail'):
    print('PRIVATE_STDERR_SECRET',file=sys.stderr)
    sys.exit(7)
if behavior.get('nooutput'):
    sys.exit(0)
output.write_text(behavior.get('raw',json.dumps(behavior.get('result',{'ok':True}))))
'''


class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.cwd = self.root / 'work'
        self.cwd.mkdir(mode=0o700)
        self.control = self.root / 'control'
        self.control.mkdir(mode=0o700)
        self.proxy = self.control / 'squire_proxy.py'
        self.proxy.write_text('# protected proxy fixture\n')
        self.proxy.chmod(0o600)
        self.helper = self.control / 'provision.mjs'
        self.helper.write_text('// protected fixture\n')
        self.helper.chmod(0o600)
        self.codex = self.root / 'fake-codex'
        self.codex.write_text(FAKE_CODEX)
        self.codex.chmod(0o700)
        home = self.root / 'codex-home'
        home.mkdir(mode=0o700)
        (home / 'config.toml').write_text('model="keep-model"\n[mcp_servers.squire]\ncommand="unused"\n[mcp_servers.other]\ncommand="unused"\n[plugins."mail@example"]\nenabled=true\n')
        self.config = {'codex': str(self.codex), 'codex_home': str(home), 'squire_proxy': str(self.proxy),
                       'provision_helper':str(self.helper)}
        self.request = {'role':'implementer','prompt':'bounded task', 'cwd':str(self.cwd),
                        'output_path':str(self.root / 'output' / 'result.json'), 'timeout_seconds':3,
                        'schema':{'type':'object','additionalProperties':False,'properties':{'ok':{'type':'boolean'}},'required':['ok']}}
        self.behavior()

    def tearDown(self):
        self.temporary.cleanup()

    def behavior(self, **values):
        (self.cwd / 'behavior.json').write_text(json.dumps(values))

    def command(self, **values):
        return worker.build_command(dict(self.request, **values), self.config, self.control / 'schema.json')

    def overrides(self, command):
        return {command[i+1].split('=',1)[0]:json.loads(command[i+1].split('=',1)[1])
                for i,arg in enumerate(command) if arg == '-c'}

    def test_full_worker_enforces_automatic_review_and_guard(self):
        args = self.command()
        self.assertIn('--approve-for-me', args)
        self.assertNotIn('-a', args)
        self.assertNotIn('--sandbox', args)
        self.assertNotIn('--model', args)
        overrides = self.overrides(args)
        self.assertEqual(overrides['mcp_servers.squire.args'],
                         [str(self.proxy),'--workspace',str(self.cwd),'--provision-helper',str(self.helper)])
        self.assertIn('scout_install_grant',overrides['mcp_servers.squire.enabled_tools'])
        self.assertEqual(overrides['mcp_servers.squire.default_tools_approval_mode'], 'prompt')
        self.assertEqual(overrides['mcp_servers.squire.tools.list_credentials.approval_mode'], 'approve')
        self.assertFalse(overrides['mcp_servers.other.enabled'])
        self.assertFalse(overrides['plugins.mail@example.enabled'])
        self.assertTrue(overrides['sandbox_workspace_write.network_access'])
        self.assertEqual(overrides['sandbox_workspace_write.writable_roots'], [])
        self.assertEqual(overrides['sandbox_mode'], 'workspace-write')
        self.assertEqual(overrides['shell_environment_policy.set.GIT_NO_REPLACE_OBJECTS'], '1')
        for forbidden in ('fetch_credential','grant_app_access','inject_card','checkout','delete_credential'):
            self.assertNotIn(forbidden, overrides['mcp_servers.squire.enabled_tools'])

    def test_smoke_has_only_summary_tool_and_never_approval(self):
        args = self.command(smoke=True)
        self.assertNotIn('--approve-for-me', args)
        self.assertEqual(args[args.index('-a')+1], 'never')
        self.assertEqual(args[args.index('--sandbox')+1], 'workspace-write')
        self.assertEqual(self.overrides(args)['mcp_servers.squire.enabled_tools'], ['list_credentials'])

    def test_reviewer_readonly_without_any_mcp_or_model_override(self):
        args = self.command(role='reviewer')
        self.assertEqual(args[args.index('--sandbox')+1], 'read-only')
        self.assertIn('--search', args)
        self.assertNotIn('--trust', args)
        self.assertNotIn('--approve-for-me', args)
        self.assertNotIn('--model', args)
        self.assertNotIn('--ignore-user-config', args)
        self.assertFalse(self.overrides(args)['mcp_servers.squire.enabled'])
        self.assertNotIn('mcp_servers.squire.command', self.overrides(args))
        self.assertEqual(self.overrides(args)['shell_environment_policy.set.GIT_NO_REPLACE_OBJECTS'], '1')

    def test_discoverer_has_live_search_without_integrations(self):
        args = self.command(role='discoverer')
        self.assertEqual(args[args.index('--sandbox')+1], 'read-only')
        self.assertIn('--search', args)
        self.assertNotIn('--approve-for-me', args)
        self.assertFalse(self.overrides(args)['mcp_servers.squire.enabled'])
        self.behavior(mcp=True, delay=30)
        with self.assertRaisesRegex(worker.WorkerError, 'reviewer_integration_violation'):
            worker.run_agent(dict(self.request, role='discoverer'), self.config)

    def test_threaded_worker_cancellation_stops_its_process(self):
        self.behavior(delay=30)
        cancel = threading.Event()
        errors = []
        def execute():
            try:
                worker.run_agent(dict(self.request, role='discoverer', cancel_event=cancel), self.config,
                                 lambda _: cancel.set())
            except worker.WorkerError as error:
                errors.append(error.reason)

        thread = threading.Thread(target=execute)
        thread.start()
        thread.join(4)
        self.assertFalse(thread.is_alive())
        self.assertEqual(errors, ['worker_cancelled'])

    def test_cli_disable_paths_do_not_embed_literal_quote_characters(self):
        args = []
        worker._disable_integrations(args,['squire','openaiDeveloperDocs'],['gmail@openai-curated'],'reviewer')
        self.assertIn('mcp_servers.openaiDeveloperDocs.enabled=false',args)
        self.assertIn('plugins.gmail@openai-curated.enabled=false',args)
        self.assertFalse(any('mcp_servers."' in item or 'plugins."' in item for item in args))

    def test_special_integration_names_use_native_toml_tables_without_transport(self):
        args = []
        worker._disable_integrations(args,['squire','provider.with.dot'],['plugin.with.dot@local'],'reviewer')
        overrides = [tomllib.loads(args[index+1]) for index,item in enumerate(args) if item == '-c']
        self.assertEqual(overrides,[{'mcp_servers':{'squire':{'enabled':False},'provider.with.dot':{'enabled':False}}},
                                    {'plugins':{'plugin.with.dot@local':{'enabled':False}}}])
        # The CLI deep-merges these tables. Adding placeholder command/url fields
        # would conflict with the existing transport and can expose config data.
        self.assertNotIn('command',' '.join(args))
        self.assertNotIn('url',' '.join(args))

    def test_guard_must_be_protected_and_outside_worker_workspace(self):
        inside = self.cwd / 'guard.py'
        inside.write_text('# no\n')
        self.config['squire_proxy'] = str(inside)
        with self.assertRaisesRegex(worker.WorkerError, 'missing_or_writable_squire_guard'):
            self.command()
        self.config['squire_proxy'] = str(self.proxy)
        self.proxy.chmod(0o666)
        with self.assertRaises(worker.WorkerError):
            self.command()

    def test_success_validates_schema_and_strips_inherited_secrets(self):
        with patch.dict(os.environ, {'OPENAI_API_KEY':'PRIVATE_API_KEY','SQUIRE_RAW_TOKEN':'PRIVATE_TOKEN'}):
            result = worker.run_agent(self.request, self.config)
        self.assertEqual(result['result'], {'ok': True})
        self.assertEqual(result['tool_counts'], {'web_search': 1})
        self.assertEqual(Path(result['output_path']).stat().st_mode & 0o777, 0o600)
        self.assertEqual(list(Path(result['output_path']).parent.glob('.worker-schema-*')), [])

    def test_bad_schema_and_json_fail_closed(self):
        for behavior in ({'result':{'ok':1}}, {'result':{'ok':True,'extra':'secret'}}, {'raw':'not-json'}):
            with self.subTest(behavior=behavior):
                Path(self.request['output_path']).unlink(missing_ok=True)
                self.behavior(**behavior)
                with self.assertRaises(worker.WorkerError):
                    worker.run_agent(self.request, self.config)

    def test_output_failures_name_a_safe_specific_reason(self):
        cases = ({'raw': 'not-json'}, 'worker_result_not_json'), ({'nooutput': True}, 'worker_result_missing'), \
                ({'result': {'ok': 1}}, 'worker_result_schema_mismatch')
        for behavior, reason in cases:
            with self.subTest(reason=reason):
                Path(self.request['output_path']).unlink(missing_ok=True)
                self.behavior(**behavior)
                with self.assertRaises(worker.WorkerError) as error:
                    worker.run_agent(self.request, self.config)
                self.assertEqual(error.exception.reason, reason)

    def test_launch_failure_and_exit_status_are_distinct_safe_codes(self):
        self.behavior(fail=True)
        with self.assertRaises(worker.WorkerError) as error:
            worker.run_agent(self.request, self.config)
        self.assertEqual((error.exception.reason, error.exception.detail), ('worker_failed', 'exit_7'))
        self.behavior()
        with patch.object(worker.subprocess, 'Popen', side_effect=OSError('/secret/path')):
            with self.assertRaises(worker.WorkerError) as error:
                worker.run_agent(self.request, self.config)
        self.assertEqual(error.exception.reason, 'worker_launch_failed')
        self.assertNotIn('secret', str(error.exception) + str(error.exception.detail))

    def test_failure_does_not_expose_stderr(self):
        self.behavior(fail=True)
        with self.assertRaises(worker.WorkerError) as error:
            worker.run_agent(self.request, self.config)
        self.assertEqual(str(error.exception), 'worker_failed')
        self.assertNotIn('PRIVATE', str(error.exception))

    def test_reviewer_detects_even_started_integration_calls(self):
        self.behavior(mcp=True, delay=30)
        with self.assertRaisesRegex(worker.WorkerError, 'reviewer_integration_violation'):
            worker.run_agent(dict(self.request, role='reviewer'), self.config)

    def test_timeout_cleans_owned_processes(self):
        self.behavior(delay=30)
        with self.assertRaisesRegex(worker.WorkerError, 'worker_timeout'):
            worker.run_agent(dict(self.request, timeout_seconds=0.15), self.config)

    def test_completed_leader_does_not_leave_background_process(self):
        self.behavior(child=True)
        worker.run_agent(self.request, self.config)
        pid = int((self.cwd / 'child.pid').read_text())
        status = Path('/proc') / str(pid) / 'stat'
        for _ in range(100):
            if not status.exists() or status.read_text().split()[2] == 'Z':
                break
            time.sleep(0.01)
        if status.exists():
            self.assertEqual(status.read_text().split()[2], 'Z')

    def test_required_web_search_must_be_observed(self):
        self.behavior(search=False)
        with self.assertRaisesRegex(worker.WorkerError, 'worker_did_not_search'):
            worker.run_agent(dict(self.request, require_web_search=True), self.config)

    def test_progress_contains_only_counts(self):
        self.behavior(delay=1.2, rejection=True)
        progress = []
        result = worker.run_agent(self.request, self.config, progress.append)
        self.assertEqual(result['approval_rejections'], 1)
        self.assertTrue(progress)
        self.assertNotIn('PRIVATE', json.dumps(progress))
        self.assertEqual(set(progress[0]), {'event','role','worker_pid','tool_counts','approval_rejections'})

    def test_existing_output_and_unsafe_directory_are_rejected(self):
        parent = Path(self.request['output_path']).parent
        parent.mkdir(mode=0o700)
        output = Path(self.request['output_path'])
        output.write_text('existing')
        with self.assertRaisesRegex(worker.WorkerError, 'worker_output_already_exists'):
            worker.run_agent(self.request, self.config)
        output.unlink()
        parent.chmod(0o755)
        with self.assertRaisesRegex(worker.WorkerError, 'unsafe_worker_output_directory'):
            worker.run_agent(self.request, self.config)

    def test_lock_descriptor_survives_worker_launch(self):
        with (self.control / 'lock').open('w') as lock:
            self.behavior(lock_fd=lock.fileno())
            result = worker.run_agent(dict(self.request, lock_fd=lock.fileno()), self.config)
        self.assertEqual(result['exit_code'], 0)

    def test_backend_configuration_is_private(self):
        backend = self.control / 'backend.json'
        backend.write_text('{}')
        backend.chmod(0o600)
        self.config['squire_backend_config'] = str(backend)
        args = self.command()
        self.assertEqual(self.overrides(args)['mcp_servers.squire.args'],
                         [str(self.proxy),'--workspace',str(self.cwd),'--provision-helper',str(self.helper),
                          '--backend-config', str(backend)])
        backend.chmod(0o644)
        with self.assertRaisesRegex(worker.WorkerError, 'unsafe_squire_backend_configuration'):
            self.command()

    def test_schema_nullable_and_bounds(self):
        self.assertTrue(worker._matches(None, {'type':['object','null']}))
        self.assertFalse(worker._matches(True, {'type':'integer'}))
        self.assertFalse(worker._matches(float('nan'), {'type':'number'}))
        self.assertFalse(worker._matches(0, {'type':'integer','minimum':1}))
        self.assertFalse(worker._matches('abc', {'type':'string','pattern':'^[0-9]+$'}))

    def test_native_preflight_checks_host_files_instead_of_claimed_output(self):
        child = Mock(pid=999999999)
        child.wait.return_value = 0
        def spawn(args, **kwargs):
            self.assertIn('--approve-for-me', args)
            self.assertIn('sandbox_mode="workspace-write"', args)
            self.assertEqual(args[args.index('--permission-profile')+1], ':workspace')
            self.assertNotIn('OPENAI_API_KEY', kwargs['env'])
            Path(args[-2]).write_text('actual inside file')
            return child
        with patch.object(worker.subprocess,'Popen',side_effect=spawn), patch.object(worker,'_stop') as stop:
            result = worker.preflight_workspace_sandbox(self.config, self.control)
        self.assertEqual(result, {'workspace_write_verified':True,'outside_write_blocked':True})
        stop.assert_called_once_with(child)

    def test_native_preflight_rejects_outside_write_even_with_success_exit(self):
        child = Mock(pid=999999999)
        child.wait.return_value = 0
        def spawn(args, **_kwargs):
            Path(args[-2]).write_text('inside')
            Path(args[-1]).write_text('unsafe outside write')
            return child
        with patch.object(worker.subprocess,'Popen',side_effect=spawn), patch.object(worker,'_stop'), \
                self.assertRaisesRegex(worker.WorkerError,'workspace_sandbox_preflight_failed'):
            worker.preflight_workspace_sandbox(self.config, self.control)


if __name__ == '__main__':
    unittest.main()
