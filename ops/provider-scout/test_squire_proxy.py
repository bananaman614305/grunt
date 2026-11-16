import importlib.util
from datetime import datetime, timedelta, timezone
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('squire_proxy', Path(__file__).with_name('squire_proxy.py'))
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


class GuardTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.state = guard.SessionStore(self.root / 'state')

    def test_only_specific_metadata_summaries_are_forwarded(self):
        args = guard.validate_call('list_credentials', {'service': ['synthetic'], 'fields': 'full', 'extra': 'discard'}, set())
        self.assertEqual(args, {'service': ['synthetic'], 'fields': 'summary'})
        for invalid in ({}, {'service': ''}, {'service': '*'}, {'service': []}, {'service': ['valid', '']}):
            with self.assertRaises(guard.Denied):
                guard.validate_call('list_credentials', invalid, set())

    def test_raw_secret_vault_payment_and_side_channel_tools_are_denied(self):
        for name in ('fetch_credential', 'grant_app_access', 'inject_card', 'store_credential',
                     'edit_credential', 'delete_credential', 'operate_network', 'operate_read_inbox',
                     'operate_screenshot', 'operate_share', 'operate_upload', 'operate_solve_captcha'):
            with self.assertRaises(guard.Denied):
                guard.validate_call(name, {}, set())

    def test_extract_requires_direct_vault_storage(self):
        for args in ({'session_id': 'owned'}, {'session_id': 'owned', 'into_slot': 'slot'},
                     {'session_id': 'owned', 'store': {}},
                     {'session_id': 'owned', 'capture': {'source': {'role': 'textbox'}}}):
            with self.assertRaises(guard.Denied):
                guard.validate_call('operate_extract', args, {'owned'})
        stored = guard.validate_call('operate_extract', {'session_id': 'owned', 'store': {'service': 'synthetic'}, 'into_slot': 'slot'}, {'owned'})
        self.assertNotIn('into_slot', stored)
        captured = guard.validate_call('operate_extract', {'session_id': 'owned', 'capture': {'store': {'service': 'synthetic'}, 'source': {'role': 'textbox'}}}, {'owned'})
        self.assertEqual(captured['capture']['store']['service'], 'synthetic')

    def test_extraction_output_does_not_forward_values_or_error_payloads(self):
        raw = guard._result({'stored': True, 'session_id': 'owned', 'storage': 'stored',
                             'credentials': {'api_key': 'SYNTHETIC-SECRET'}, 'token': 'SYNTHETIC-SECRET',
                             'stored_credential': {'reference': 'vault://synthetic', 'service': 'synthetic',
                                                   'value': 'SYNTHETIC-SECRET', 'password': 'SYNTHETIC-SECRET'},
                             'error': 'upstream copied SYNTHETIC-SECRET'})
        result = guard.project_result('operate_extract', raw)
        self.assertNotIn('SYNTHETIC-SECRET', json.dumps(result))
        self.assertTrue(result['structuredContent']['stored'])
        self.assertEqual(result['structuredContent']['stored_credential'], {'reference': 'vault://synthetic', 'service': 'synthetic'})
        self.assertNotIn('SYNTHETIC-SECRET', json.dumps(guard.project_result('operate_extract', guard._result({'error': 'SYNTHETIC-SECRET'}, True))))

    def test_metadata_output_uses_only_metadata_fields(self):
        result = guard.project_result('list_credentials', guard._result({'credentials': [
            {'reference': 'vault://synthetic', 'service': 'synthetic', 'value': 'SYNTHETIC-SECRET', 'token': 'SYNTHETIC-SECRET'}]}))
        self.assertNotIn('SYNTHETIC-SECRET', json.dumps(result))
        self.assertEqual(result['structuredContent']['credentials'][0]['reference'], 'vault://synthetic')

    def test_sessions_are_owned_and_survive_a_new_proxy(self):
        with self.assertRaises(guard.Denied):
            guard.validate_call('operate_click', {'session_id': 'other-project', 'ref': 'x'}, set())
        self.state.observe('operate_start', {}, guard._result({'session_id': 'owned'}))
        reopened = guard.SessionStore(self.root / 'state')
        self.assertEqual(reopened.contains(), {'owned'})
        self.assertEqual(guard.validate_call('operate_observe', {'session_id': 'owned', 'format': 'full'}, reopened.contains())['format'], 'compact')
        reopened.observe('operate_finish', {'session_id': 'owned'}, guard._result({'closed': True}))
        self.assertEqual(reopened.contains(), set())

    def test_browser_proxy_payment_and_private_urls_are_not_allowed(self):
        for args in ({'service_url': 'http://127.0.0.1'}, {'service_url': 'https://localhost'},
                     {'service_url': 'https://user:pass@synthetic.example'},
                     {'service_url': 'https://synthetic.example', 'proxy': 'https://proxy.example'},
                     {'service_url': 'https://synthetic.example', 'facts': {'card_id': 'synthetic'}}):
            with self.assertRaises(guard.Denied):
                guard.validate_call('operate_start', args, set())
        self.assertEqual(guard.validate_call('operate_start', {'service_url': 'https://synthetic.example'}, set())['format'], 'compact')

    def test_credential_api_cannot_put_secret_into_model_prompt(self):
        good = {'reference': 'vault://synthetic', 'http': {'method': 'POST', 'url': 'https://synthetic.example/v1/chat/completions', 'headers': {'Authorization': 'Bearer ${SECRET}'}, 'body': '{"model":"synthetic","messages":[]}'}}
        self.assertEqual(guard.validate_call('use_credential', good, set()), good)
        for url, body in [('https://synthetic.example/v1/chat/completions', '${SECRET}'),
                          ('https://synthetic.example/echo', '{}'), ('https://synthetic.example/keys', '{}'),
                          ('http://localhost/api', '{}')]:
            value = {**good, 'http': {**good['http'], 'url': url, 'body': body}}
            with self.assertRaises(guard.Denied):
                guard.validate_call('use_credential', value, set())
        error = guard.project_result('use_credential', guard._result({'status': 429, 'body': 'SYNTHETIC-SECRET'}))
        self.assertNotIn('SYNTHETIC-SECRET', json.dumps(error))

    def test_catalog_advertises_only_guarded_tools(self):
        source = {'tools': [{'name': name, 'description': 'synthetic', 'inputSchema': {'type': 'object', 'properties': {}}}
                            for name in ['list_credentials', 'operate_extract', 'fetch_credential', 'inject_card']]}
        result = guard.filter_catalog(source)
        self.assertEqual([tool['name'] for tool in result['tools']], ['list_credentials', 'operate_extract'])
        branches = result['tools'][1]['inputSchema']['anyOf']
        self.assertEqual(branches[0]['required'], ['store'])
        self.assertEqual(branches[0]['properties']['store']['required'], ['service'])
        self.assertEqual(branches[1]['properties']['capture']['required'], ['store', 'source'])
        self.assertEqual(branches[1]['properties']['capture']['properties']['store']['required'], ['service'])
        self.assertIn('service', result['tools'][0]['inputSchema']['required'])

    def test_bad_or_symlinked_backend_config_is_rejected(self):
        source = self.root / 'backend.json'
        source.write_text(json.dumps({'command': sys.executable, 'args': [], 'env': {'SYNTHETIC_SQUIRE_VALUE': 'private'}}))
        source.chmod(0o600)
        argv, env = guard.backend_config(source)
        self.assertEqual(argv, [sys.executable])
        self.assertEqual(env['SYNTHETIC_SQUIRE_VALUE'], 'private')
        alias = self.root / 'alias.json'
        alias.symlink_to(source)
        with self.assertRaises(ValueError):
            guard.backend_config(alias)
        source.chmod(0o644)
        with self.assertRaises(ValueError):
            guard.backend_config(source)

    def test_install_tool_accepts_only_bounded_candidate_identity(self):
        good = {'service': 'synthetic', 'reference': 'vault://synthetic', 'source_id': 'synthetic'}
        self.assertEqual(guard.validate_call('scout_install_grant', good, set()), good)
        for change in ({'source_id': '../other'}, {'workspace': '/tmp/arbitrary'},
                       {'reference': 'raw-key'}, {'service': '*'}):
            with self.assertRaises(guard.Denied):
                guard.validate_call('scout_install_grant', {**good, **change}, set())
        catalog = guard.filter_catalog({'tools': []}, install_enabled=True)
        self.assertEqual(catalog['tools'][0]['name'], 'scout_install_grant')
        self.assertEqual(guard.filter_catalog({'tools': [guard.INSTALL_TOOL]})['tools'], [])

    def test_grant_installation_fresh_checks_metadata_and_reuses_private_grant(self):
        workspace = self.root / 'workspace'
        workspace.mkdir(mode=0o700)
        helper = self.root / 'provision.py'
        helper.write_text('''import sys,json,pathlib
request=json.load(sys.stdin)
root=pathlib.Path(request['workspace']);source=request['source_id']
directory=root/'candidate-configs'/source;directory.mkdir(parents=True,exist_ok=True)
path=directory/(source+'.json');path.write_text(json.dumps(request['grant']));path.chmod(0o600)
print(json.dumps({'installed':True,'source_id':source,'config_file':f'candidate-configs/{source}/{source}.json','discard':'SYNTHETIC-SECRET'}))
''')
        helper.chmod(0o600)
        installer = guard.GrantInstaller(workspace, helper, sys.executable, self.state.directory)
        calls = []
        def upstream(name, arguments):
            calls.append((name, arguments))
            if name == 'list_credentials':
                return {'credentials': [{'service': 'synthetic', 'reference': 'vault://synthetic',
                    'field_names': ['api_key'], 'allowed_hosts': ['api.synthetic.example']}]}
            return {'base_url': 'https://proxy.synthetic.example/provider', 'token': 'SYNTHETIC-SECRET', 'grant_id': 'tracked-grant'}
        args = {'service': 'synthetic', 'reference': 'vault://synthetic', 'source_id': 'synthetic'}
        output = installer.install(args, upstream)
        self.assertNotIn('SYNTHETIC-SECRET', json.dumps(output))
        self.assertEqual(output, {'installed': True, 'source_id': 'synthetic', 'config_file': 'candidate-configs/synthetic/synthetic.json'})
        self.assertEqual(calls[0], ('list_credentials', {'service': 'synthetic', 'fields': 'summary'}))
        self.assertEqual(calls[1], ('grant_app_access', {'reference': 'vault://synthetic'}))
        private = self.state.directory / 'grants.json'
        self.assertEqual(private.stat().st_mode & 0o777, 0o600)
        self.assertEqual(json.loads(private.read_text())['synthetic']['grant_id'], 'tracked-grant')
        self.assertIsNotNone(guard._instant(json.loads(private.read_text())['synthetic']['created_at']))
        self.assertIsNotNone(guard._instant(json.loads(private.read_text())['synthetic']['expires_at']))
        reopened = guard.GrantInstaller(workspace, helper, sys.executable, self.state.directory)
        reopened.install(args, upstream)
        self.assertEqual([name for name, _ in calls].count('grant_app_access'), 1)
        self.assertEqual([name for name, _ in calls].count('list_credentials'), 2)
        cached = json.loads(private.read_text())
        cached['synthetic']['expires_at'] = '2000-01-01T00:00:00+00:00'
        private.write_text(json.dumps(cached))
        guard.GrantInstaller(workspace, helper, sys.executable, self.state.directory).install(args, upstream)
        self.assertEqual([name for name, _ in calls].count('grant_app_access'), 2)
        self.assertFalse(any(name.startswith('revoke') for name, _ in calls))
        self.assertEqual(json.loads(private.read_text())['synthetic']['previous_grants'][0]['grant_id'], 'tracked-grant')

    def test_grant_cache_uses_twelve_hours_when_no_expiry_is_available(self):
        now = datetime(2026, 11, 16, tzinfo=timezone.utc)
        self.assertFalse(guard._grant_current({}, now))
        self.assertTrue(guard._grant_current({'created_at': (now - timedelta(hours=11)).isoformat()}, now))
        self.assertFalse(guard._grant_current({'created_at': (now - timedelta(hours=12)).isoformat()}, now))
        self.assertFalse(guard._grant_current({'created_at': (now + timedelta(hours=1)).isoformat()}, now))
        self.assertFalse(guard._grant_current({'expires_at': now.isoformat()}, now))

    def test_install_failure_diagnostics_are_fixed_codes_without_error_payloads(self):
        class Installer:
            def install(self, args, call):
                raise guard.Denied('Explicit public provider hosts are required')
        sink = io.BytesIO()
        proxy = guard.Proxy([], {}, self.state, sink=sink, installer=Installer())
        proxy.install_request(1, {})
        data = json.loads(sink.getvalue())['result']['structuredContent']
        self.assertEqual(data['code'], 'provider_hosts_invalid')
        self.assertFalse(data['installed'])

    def test_grant_metadata_rejects_identity_or_different_vault_keys(self):
        row = {'service': 'synthetic', 'reference': 'vault://synthetic', 'field_names': ['api_key'],
               'allowed_hosts': ['api.synthetic.example']}
        for change in ({'reference': 'vault://other'}, {'service': 'other'}, {'field_names': ['password']},
                       {'allowed_hosts': []}, {'allowed_hosts': ['accounts.synthetic.example']},
                       {'allowed_hosts': ['registry.npmjs.org']}, {'allowed_hosts': ['api.github.com']},
                       {'allowed_hosts': ['127.0.0.1']}, {'allowed_hosts': ['api.*.synthetic.example']},
                       {'allowed_hosts': ['*synthetic.example']}, {'allowed_hosts': ['*.github.com']}):
            with self.assertRaises(guard.Denied):
                guard._provider_metadata({'credentials': [{**row, **change}]}, 'synthetic', 'vault://synthetic')

    def test_grant_metadata_accepts_squire_single_field_api_keys(self):
        for field in ('value', 'token', 'api_key', 'apiKey', 'key'):
            row = {'service': 'tokenharbor', 'reference': 'vault://synthetic', 'field_names': [field],
                   'allowed_hosts': ['tokenharbor.ai', '*.tokenharbor.ai']}
            self.assertEqual(guard._provider_metadata({'credentials': [row]}, 'tokenharbor', 'vault://synthetic'), row)
        row = {'service': 'npm', 'reference': 'vault://synthetic', 'field_names': ['value'],
               'allowed_hosts': ['registry.npmjs.org']}
        with self.assertRaises(guard.Denied):
            guard._provider_metadata({'credentials': [row]}, 'npm', 'vault://synthetic')

    def test_grant_install_rejects_helper_inside_worker_workspace(self):
        workspace = self.root / 'workspace'
        workspace.mkdir(mode=0o700)
        helper = workspace / 'helper.py'
        helper.write_text('')
        with self.assertRaises(ValueError):
            guard.GrantInstaller(workspace, helper, sys.executable, self.state.directory)

    def test_oversized_protocol_line_fails_without_echo(self):
        with self.assertRaises(ValueError):
            list(guard.Proxy.read(io.BytesIO(b'x' * (guard.MAX_LINE + 2))))

    def test_real_stdio_round_trip_keeps_denied_calls_out_of_backend(self):
        backend = self.root / 'backend.py'
        record = self.root / 'seen.jsonl'
        backend.write_text('''import sys,json,pathlib
record=pathlib.Path(sys.argv[1])
for line in sys.stdin:
 request=json.loads(line)
 with record.open('a') as out:out.write(json.dumps(request)+'\\n')
 if 'id' not in request:continue
 method=request.get('method')
 if method=='tools/list':result={'tools':[{'name':'list_credentials','inputSchema':{'type':'object'}},{'name':'fetch_credential','inputSchema':{'type':'object'}}]}
 elif method=='tools/call':result={'content':[{'type':'text','text':json.dumps({'credentials':[{'reference':'vault://synthetic','service':'synthetic','value':'SYNTHETIC-SECRET'}]})}]}
 else:result={'protocolVersion':'2024-11-05','capabilities':{'tools':{}},'serverInfo':{'name':'synthetic','version':'1'}}
 print(json.dumps({'jsonrpc':'2.0','id':request['id'],'result':result}),flush=True)
''')
        config = self.root / 'backend.json'
        config.write_text(json.dumps({'command': sys.executable, 'args': [str(backend), str(record)]}))
        config.chmod(0o600)
        requests = [
            {'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {}},
            {'jsonrpc': '2.0', 'id': 2, 'method': 'tools/list'},
            {'jsonrpc': '2.0', 'id': 3, 'method': 'tools/call', 'params': {'name': 'list_credentials', 'arguments': {'service': 'synthetic'}}},
            {'jsonrpc': '2.0', 'id': 4, 'method': 'tools/call', 'params': {'name': 'fetch_credential', 'arguments': {'reference': 'vault://synthetic'}}},
        ]
        response = subprocess.run([sys.executable, str(Path(guard.__file__)), '--backend-config', str(config), '--state-dir', str(self.root / 'child-state')],
                                  input=''.join(json.dumps(item) + '\n' for item in requests), text=True, capture_output=True, timeout=10)
        self.assertEqual(response.returncode, 0, response.stderr)
        self.assertNotIn('SYNTHETIC-SECRET', response.stdout)
        messages = {item['id']: item for item in map(json.loads, response.stdout.splitlines())}
        self.assertEqual([item['name'] for item in messages[2]['result']['tools']], ['list_credentials'])
        self.assertIn('error', messages[4])
        seen = list(map(json.loads, record.read_text().splitlines()))
        self.assertEqual(len([item for item in seen if item.get('method') == 'tools/call']), 1)
        self.assertEqual(seen[-1]['params']['arguments'], {'service': 'synthetic', 'fields': 'summary'})

    def test_real_stdio_hidden_grant_never_reaches_model(self):
        workspace = self.root / 'workspace'
        workspace.mkdir(mode=0o700)
        backend = self.root / 'grant_backend.py'
        backend.write_text('''import sys,json
for line in sys.stdin:
 request=json.loads(line);name=request.get('params',{}).get('name')
 if request.get('method')=='tools/list':result={'tools':[]}
 elif name=='list_credentials':result={'credentials':[{'service':'synthetic','reference':'vault://synthetic','field_names':['api_key'],'allowed_hosts':['api.synthetic.example']}]}
 elif name=='grant_app_access':result={'base_url':'https://proxy.synthetic.example/provider','token':'SYNTHETIC-SECRET','grant_id':'tracked'}
 else:result={}
 print(json.dumps({'jsonrpc':'2.0','id':request['id'],'result':result}),flush=True)
''')
        helper = self.root / 'helper.py'
        helper.write_text('''import sys,json
request=json.load(sys.stdin);source=request['source_id']
print(json.dumps({'installed':True,'source_id':source,'config_file':f'candidate-configs/{source}/{source}.json'}))
''')
        config = self.root / 'backend.json'
        config.write_text(json.dumps({'command': sys.executable, 'args': [str(backend)]}))
        config.chmod(0o600)
        requests = [
            {'jsonrpc': '2.0', 'id': 1, 'method': 'tools/list'},
            {'jsonrpc': '2.0', 'id': 2, 'method': 'tools/call', 'params': {
                'name': 'scout_install_grant', 'arguments': {
                    'service': 'synthetic', 'reference': 'vault://synthetic', 'source_id': 'synthetic'}}},
            {'jsonrpc': '2.0', 'id': 3, 'method': 'tools/call', 'params': {
                'name': 'grant_app_access', 'arguments': {'reference': 'vault://synthetic'}}},
        ]
        completed = subprocess.run([sys.executable, str(Path(guard.__file__)), '--backend-config', str(config),
            '--state-dir', str(self.root / 'child-state'), '--workspace', str(workspace),
            '--provision-helper', str(helper), '--node', sys.executable],
            input=''.join(json.dumps(item)+'\n' for item in requests), text=True, capture_output=True, timeout=10)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertNotIn('SYNTHETIC-SECRET', completed.stdout + completed.stderr)
        messages = {item['id']: item for item in map(json.loads, completed.stdout.splitlines())}
        self.assertEqual([tool['name'] for tool in messages[1]['result']['tools']], ['scout_install_grant'])
        self.assertTrue(messages[2]['result']['structuredContent']['installed'])
        self.assertIn('error', messages[3])


if __name__ == '__main__':
    unittest.main()
