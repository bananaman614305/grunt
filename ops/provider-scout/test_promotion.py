import copy
import datetime as dt
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('promotion', Path(__file__).with_name('promotion.py'))
promotion = importlib.util.module_from_spec(spec)
spec.loader.exec_module(promotion)


class Fixture:
    def __init__(self, base):
        self.workspace = base / 'workspace'
        self.checkout = self.workspace / 'candidates/synthetic'
        self.checkout.mkdir(parents=True, mode=0o700)
        self.state = base / 'supervisor'
        self.state.mkdir(mode=0o700)
        self.git('init', '-q')
        self.git('config', 'user.name', 'Synthetic')
        self.git('config', 'user.email', 'synthetic@example.test')
        self.git('remote', 'add', 'origin', promotion.ORIGIN)
        self.package = {'name': 'usegrunt', 'version': '0.6.10', 'type': 'module', 'files': ['dist', 'README.md']}
        (self.checkout / 'registry').mkdir()
        self.registry = {'version': 1, 'published': (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=1)).isoformat().replace('+00:00', 'Z'),
                         'adapters': [{'id': 'opencode', 'model': 'big-pickle'}]}
        self.save('package.json', self.package)
        self.save('registry/adapters.json', self.registry)
        (self.checkout / 'README.md').write_text('Synthetic release only.\n')
        self.git('add', '.')
        self.git('commit', '-qm', 'base')
        self.base_sha = self.git('rev-parse', 'HEAD').strip()
        self.git('checkout', '-qb', 'scout/synthetic-vetted')
        self.package['version'] = '0.6.11'
        self.registry['published'] = dt.datetime.now(dt.timezone.utc).isoformat().replace('+00:00', 'Z')
        self.registry['adapters'].append({'id': 'synthetic', 'model': 'synthetic-flash'})
        self.save('package.json', self.package)
        self.save('registry/adapters.json', self.registry)
        self.git('add', '.')
        self.git('commit', '-qm', 'add synthetic source')
        head = self.git('rev-parse', 'HEAD').strip()
        registry_sha = promotion._digest(self.checkout / 'registry/adapters.json')
        self.evidence = self.workspace / 'preliminary.json'
        promotion._write(self.evidence, {'synthetic': True})
        self.trusted = self.state / 'trusted-probe.json'
        promotion._write(self.trusted, {'head_sha': head, 'registry_sha256': registry_sha, 'source_id': 'synthetic', 'model': 'synthetic-flash',
                                       'http_status': 200, 'reply_received': True, 'attribution_verified': True,
                                       'tool_call_verified': True, 'free_guard_verified': True})
        self.receipt = {'version': 1, 'qualified': True, 'head_sha': head, 'base_sha': self.base_sha,
                        'checkout': str(self.checkout), 'source_id': 'synthetic', 'model': 'synthetic-flash',
                        'registry_sha256': registry_sha, 'evidence_file': str(self.evidence), 'evidence_sha256': promotion._digest(self.evidence),
                        'trusted_evidence_file': str(self.trusted), 'trusted_evidence_sha256': promotion._digest(self.trusted),
                        'probe_verified_by_supervisor': True, 'checks': {'passed': True, 'head_sha': head},
                        'reviews': [{'verdict': 'approve', 'head_sha': head, 'base_sha': self.base_sha, 'independent': True,
                                     'review_id': phase, 'phase': phase, 'checks': {key: True for key in promotion.REVIEW_CHECKS}}
                                    for phase in ['pre_execution', 'post_validation']]}
        self.module = self.state / 'trusted-runtime.mjs'
        self.module.write_text('export class BrowserSquire {}\n')
        self.module.chmod(0o600)
        self.config = {'release_enabled': True, 'workspace': str(self.workspace), 'source_repo': str(self.checkout),
                       'npm_credential_reference': 'vault://synthetic/capture/npm', 'squire_module': str(self.module),
                       'publication_poll_attempts': 1, 'publication_poll_seconds': 0, 'release_check_runner': self.check_run}
        self.calls = []
        self.pr = None
        self.actions = False
        self.merged = False
        self.public = False
        self.immediate_publication = True
        self.latest_override = None
        self.main_ref = self.base_sha
        self.uploads = 0
        self.tarball = None
        self.merge_sha = head
        self.merged_tree_override = None

    def save(self, name, value):
        (self.checkout / name).write_text(json.dumps(value))

    def git(self, *args, cwd=None):
        return subprocess.run(['git', *args], cwd=cwd or self.checkout, text=True, capture_output=True, check=True).stdout

    def run(self, args, cwd=None, timeout=60):
        self.calls.append(args)
        binary = Path(args[0]).name
        if binary == 'git':
            if args[1] in ('push', 'fetch'):
                return ''
            if self.merged_tree_override and args[1:] == ['rev-parse', self.merge_sha + '^{tree}']:
                return self.merged_tree_override
            return subprocess.run(args, cwd=cwd, text=True, capture_output=True, check=True).stdout
        if binary == 'npx':
            return ''
        if binary == 'npm' and args[1] == 'pack':
            stage = Path(cwd)
            files = {'package/package.json': (stage / 'package.json').read_bytes(), 'package/README.md': b'Synthetic',
                     'package/dist/local/main.js': b'export const synthetic=true;',
                     'package/dist/registry/adapters.json': (stage / 'registry/adapters.json').read_bytes()}
            self.tarball = Path(args[args.index('--pack-destination') + 1]) / 'usegrunt-0.6.11.tgz'
            with tarfile.open(self.tarball, 'w:gz') as archive:
                for name, body in files.items():
                    item = tarfile.TarInfo(name)
                    item.size = len(body)
                    archive.addfile(item, io.BytesIO(body))
            return json.dumps([{'filename': self.tarball.name}])
        if binary in ('gh', 'gh-axi'):
            if args[1] == 'api':
                endpoint = args[-1]
                if '--method' in args and 'enabled=false' in args:
                    self.actions = False
                    return ''
                if endpoint.endswith('/actions/permissions'):
                    return json.dumps({'enabled': self.actions})
                if endpoint.endswith('/git/ref/heads/main'):
                    return json.dumps({'object': {'sha': self.main_ref}})
                if '/pulls?' in endpoint:
                    return json.dumps([self.pr] if self.pr else [])
                if '/pulls/' in endpoint:
                    return json.dumps(self.pr)
            if args[1:3] == ['pr', 'create']:
                self.pr = {'number': 123, 'state': 'open', 'draft': True, 'merged': False, 'merged_at': None,
                           'merge_commit_sha': None, 'head': {'sha': self.receipt['head_sha'], 'repo': {'full_name': promotion.REPOSITORY}},
                           'base': {'ref': 'main', 'sha': self.base_sha}}
                return 'created'
            if args[1:3] == ['pr', 'ready']:
                self.pr['draft'] = False
                return ''
            if args[1:3] == ['pr', 'merge']:
                assert args[-2:] == ['--match-head-commit', self.receipt['head_sha']]
                assert '--admin' not in args and not self.actions
                self.merged = True
                self.pr.update(merged=True, merged_at='synthetic', merge_commit_sha=self.merge_sha)
                return ''
        if binary == 'node':
            output = Path(args[args.index('--output') + 1])
            if '--preflight' in args:
                promotion._write(output, {'status': 'authenticated', 'grantRevoked': True})
            else:
                self.uploads += 1
                self.public = self.immediate_publication
                promotion._write(output, {'status': 'accepted', 'grantRevoked': True, 'requestSent': True})
            return ''
        raise AssertionError('Unexpected fixture command')

    def check_run(self, args, cwd, timeout, env, network):
        assert network is ('install' in args)
        return {'returncode': 0, 'stdout': self.run(args, cwd, timeout)}

    def fetch(self, url):
        if self.tarball and not self.tarball.exists():
            self.tarball = self.tarball.parent.parent / self.tarball.name
        if url.endswith('/latest'):
            return {'name': 'usegrunt', 'version': self.latest_override or ('0.6.11' if self.public else '0.6.10')}
        if not self.public:
            return None
        if url.endswith('.tgz'):
            return self.tarball.read_bytes()
        artifact = promotion._artifact(self.tarball, '0.6.11', self.receipt['registry_sha256'])
        return {'name': 'usegrunt', 'version': '0.6.11', 'dist': {'integrity': artifact['integrity'],
                'tarball': promotion.NPM + '/-/usegrunt-0.6.11.tgz'}}

    def promote(self, receipt=None):
        return promotion.promote_candidate(receipt or self.receipt, self.config, self.state, self.run, self.fetch)


class PromotionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.fixture = Fixture(Path(self.temporary.name))

    def test_released_only_after_two_reviews_checks_probe_merge_and_public_integrity(self):
        fixture = self.fixture
        fixture.actions = True
        result = fixture.promote()
        self.assertEqual(result['status'], 'released', result)
        self.assertTrue(result['default_pool_verified'])
        self.assertEqual(fixture.uploads, 1)
        self.assertTrue(fixture.merged)
        self.assertFalse(fixture.actions)
        self.assertTrue(any(call[:2] == ['npm', 'pack'] for call in fixture.calls))
        self.assertTrue(any('build' in call for call in fixture.calls))

    def test_missing_review_or_probe_cannot_merge_or_publish(self):
        for mutate in (lambda value: value['reviews'].pop(),
                       lambda value: value.update(probe_verified_by_supervisor=False),
                       lambda value: value['checks'].update(passed=False),
                       lambda value: value['reviews'][1].update(review_id='pre_execution')):
            receipt = copy.deepcopy(self.fixture.receipt)
            mutate(receipt)
            self.assertEqual(self.fixture.promote(receipt)['status'], 'blocked')
        self.assertFalse(self.fixture.merged)
        self.assertEqual(self.fixture.uploads, 0)

    def test_changed_source_or_supervisor_evidence_is_rejected(self):
        self.fixture.trusted.write_text('{}')
        self.assertEqual(self.fixture.promote()['reason'], 'untrusted_supervisor_evidence')
        self.assertFalse(self.fixture.merged)

    def test_base_drift_defers_before_remote_writes(self):
        self.fixture.main_ref = 'f' * 40
        result = self.fixture.promote()
        self.assertEqual(result['reason'], 'main_changed_requires_fresh_review')
        self.assertFalse(self.fixture.merged)
        self.assertEqual(self.fixture.uploads, 0)
        self.assertFalse(any(call[:2] == ['git', 'push'] for call in self.fixture.calls))

    def test_existing_npm_version_requires_fresh_version_before_merge(self):
        self.fixture.latest_override = '0.6.11'
        self.assertEqual(self.fixture.promote()['reason'], 'npm_version_requires_fresh_review')
        self.assertFalse(self.fixture.merged)

    def test_pending_publication_resumes_without_worker_files_or_second_upload(self):
        fixture = self.fixture
        fixture.immediate_publication = False
        first = fixture.promote()
        self.assertEqual(first['status'], 'publication_pending', first)
        shutil.rmtree(fixture.workspace)
        fixture.trusted.unlink()
        fixture.public = True
        second = fixture.promote()
        self.assertEqual(second['status'], 'released', second)
        self.assertEqual(fixture.uploads, 1)

    def test_merged_tree_difference_prevents_publication(self):
        fixture = self.fixture
        fixture.merge_sha = 'f' * 40
        fixture.merged_tree_override = 'e' * 40
        result = fixture.promote()
        self.assertEqual(result['reason'], 'merged_tree_differs_from_reviewed_tree')
        self.assertTrue(fixture.merged)
        self.assertEqual(fixture.uploads, 0)

    def test_release_disabled_is_side_effect_free(self):
        self.fixture.config['release_enabled'] = False
        self.assertEqual(self.fixture.promote()['status'], 'disabled')
        self.assertEqual(self.fixture.calls, [])

    def test_release_requires_sandboxed_build_runner(self):
        self.fixture.config.pop('release_check_runner')
        result = self.fixture.promote()
        self.assertEqual(result['reason'], 'sandboxed_release_check_runner_required')
        self.assertFalse(self.fixture.merged)
        self.assertEqual(self.fixture.uploads, 0)

    def test_premerge_checkpoint_survives_erased_worker_workspace(self):
        fixture = self.fixture
        fixture.main_ref = 'f' * 40
        self.assertEqual(fixture.promote()['reason'], 'main_changed_requires_fresh_review')
        shutil.rmtree(fixture.workspace)
        fixture.trusted.unlink()
        fixture.main_ref = fixture.base_sha
        self.assertEqual(fixture.promote()['status'], 'released')
        self.assertEqual(fixture.uploads, 1)

    def test_release_must_claim_next_published_npm_patch(self):
        with self.assertRaisesRegex(promotion.PromotionError, 'npm_version_requires_fresh_review'):
            promotion._next_npm_patch({'version': '0.6.12'}, '0.6.15')
        promotion._next_npm_patch({'version': '0.6.12'}, '0.6.13')

    def test_host_command_cancellation_reaps_its_process_group(self):
        class Cancellation(BaseException):
            pass
        marker = Path(self.temporary.name) / 'child-pid'
        real_popen = subprocess.Popen
        def start(*args, **kwargs):
            process = real_popen(*args, **kwargs)
            def cancel(timeout):
                deadline = time.monotonic() + 3
                while not marker.exists() and time.monotonic() < deadline:
                    time.sleep(0.01)
                raise Cancellation()
            process.communicate = cancel
            return process
        script = ('import subprocess,sys,time;from pathlib import Path;'
                  'child=subprocess.Popen([sys.executable,"-c","import time;time.sleep(60)"]);'
                  'Path(sys.argv[1]).write_text(str(child.pid));time.sleep(60)')
        with patch.object(promotion.subprocess, 'Popen', side_effect=start):
            with self.assertRaises(Cancellation):
                promotion._default_run([sys.executable, '-c', script, str(marker)])
        child = int(marker.read_text())
        state = Path('/proc') / str(child) / 'stat'
        if state.exists():
            self.assertEqual(state.read_text().split()[2], 'Z')


class PublisherTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / ('release-' + 'a' * 40)
        self.root.mkdir(mode=0o700)

    def invoke(self, request, *flags):
        if '--preflight' not in flags and 'authorization_file' not in request:
            head, base = 'a' * 40, 'b' * 40
            proof = {'head_sha': head, 'registry_sha256': 'c' * 64, 'source_id': 'synthetic', 'model': 'synthetic-flash',
                     'http_status': 200, 'reply_received': True, 'attribution_verified': True, 'tool_call_verified': True, 'free_guard_verified': True}
            raw = json.dumps(proof)
            receipt = {'version': 1, 'qualified': True, 'head_sha': head, 'base_sha': base,
                       'checkout': str(self.root.parent / 'workspace/candidates/synthetic'), 'registry_sha256': 'c' * 64,
                       'source_id': 'synthetic', 'model': 'synthetic-flash', 'probe_verified_by_supervisor': True,
                       'trusted_evidence_sha256': hashlib.sha256(raw.encode()).hexdigest(), 'checks': {'passed': True, 'head_sha': head},
                       'reviews': [{'verdict': 'approve', 'head_sha': head, 'base_sha': base, 'independent': True,
                                    'review_id': phase, 'phase': phase, 'checks': {key: True for key in promotion.REVIEW_CHECKS}}
                                   for phase in ['pre_execution', 'post_validation']]}
            path = self.root / 'publish-authorization.json'
            promotion._write(path, {'version': 1, 'workspace': str(self.root.parent / 'workspace'), 'release_root': str(self.root),
                                    'merge_sha': 'd' * 40, 'receipt': receipt, 'trusted_evidence_raw': raw,
                                    'artifact': {key: request[key] for key in ['version', 'tarball', 'sha256', 'integrity', 'bytes']}})
            request['authorization_file'] = str(path)
        promotion._write(self.root / 'publish-request.json', request)
        result = subprocess.run(['node', str(Path(__file__).with_name('publish.mjs')), '--request', str(self.root / 'publish-request.json'),
                                 '--output', str(self.root / 'result.json'), *flags], text=True, capture_output=True, timeout=15)
        output = promotion._json_file(self.root / 'result.json')
        self.assertNotIn('synthetic-never-print', result.stdout + result.stderr + json.dumps(output))
        return result, output

    def fake_module(self, fail=False):
        marker = self.root / 'revoked.json'
        module = self.root / 'squire.mjs'
        module.write_text("import {writeFile} from 'node:fs/promises';\nexport class BrowserSquire {\n"
                          "constructor(){globalThis.fetch=async()=>new Response(" + ("'synthetic-never-print',{status:403}" if fail else "JSON.stringify({username:'synthetic'}),{status:200}") + ");}\n"
                          "async connect(){}\nasync call(name){if(name==='grant_app_access')return {base_url:'https://proxy.example/npm',token:'synthetic-never-print',grant_id:'synthetic'};"
                          "if(name==='revoke_app_access'){await writeFile(" + json.dumps(str(marker)) + ",JSON.stringify({revoked:true}));return {};}}\nasync close(){}}\n")
        module.chmod(0o600)
        return module, marker

    def test_readonly_authenticated_preflight_revokes_grant_and_hides_token(self):
        module, marker = self.fake_module()
        result, output = self.invoke({'credential_reference': 'vault://synthetic/capture/npm', 'squire_module': str(module)}, '--preflight')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(output['status'], 'authenticated')
        self.assertTrue(output['authenticated'])
        self.assertFalse(output['requestSent'])
        self.assertTrue(output['grantRevoked'])
        self.assertTrue(json.loads(marker.read_text())['revoked'])

    def test_auth_failure_still_revokes_and_never_retains_upstream_body(self):
        module, marker = self.fake_module(fail=True)
        result, output = self.invoke({'credential_reference': 'vault://synthetic/capture/npm', 'squire_module': str(module)}, '--preflight')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(output['status'], 'blocked')
        self.assertTrue(output['grantRevoked'])
        self.assertTrue(marker.exists())

    def test_dry_run_verifies_archive_without_squire_or_network(self):
        result, output = self.invoke(self.artifact_request(), '--dry-run')
        self.assertEqual(result.returncode, 0)
        self.assertEqual(output['status'], 'dry_run')
        self.assertFalse(output['requestSent'])

    def artifact_request(self):
        package = {'name': 'usegrunt', 'version': '0.6.11', 'type': 'module'}
        stage = self.root / 'checkout'
        stage.mkdir(exist_ok=True)
        (stage / 'package.json').write_text(json.dumps(package))
        (stage / 'README.md').write_text('Synthetic')
        archive = self.root / 'usegrunt-0.6.11.tgz'
        archive.write_bytes(b'synthetic verified archive bytes')
        import base64
        return {'version': '0.6.11', 'package_file': str(stage / 'package.json'),
                'readme_file': str(stage / 'README.md'), 'tarball': str(archive), 'bytes': archive.stat().st_size,
                'sha256': promotion._digest(archive),
                'integrity': 'sha512-' + base64.b64encode(hashlib.sha512(archive.read_bytes()).digest()).decode()}

    def publication_module(self, latest='0.6.10'):
        module = self.root / 'publisher.mjs'
        marker = self.root / 'upload.json'
        module.write_text("import {writeFile} from 'node:fs/promises';\nexport class BrowserSquire {\n"
                          "constructor(){globalThis.fetch=async(url,options)=>{if(url==='https://registry.npmjs.org/usegrunt/latest')"
                          "return new Response(JSON.stringify({name:'usegrunt',version:" + json.dumps(latest) + "}),{status:200});"
                          "if(url!=='https://proxy.example/npm/usegrunt'||options.method!=='PUT'||options.headers.Authorization!=='Bearer synthetic-never-print')throw new Error('unexpected');"
                          "const doc=JSON.parse(options.body);await writeFile(" + json.dumps(str(marker)) + ",JSON.stringify({name:doc.name,version:doc['dist-tags'].latest,integrity:doc.versions['0.6.11'].dist.integrity,attachment:Object.keys(doc._attachments)[0]}));"
                          "return new Response('synthetic-never-print',{status:202});};}\n"
                          "async connect(){}\nasync call(name){if(name==='grant_app_access')return {base_url:'https://proxy.example/npm',token:'synthetic-never-print',grant_id:'synthetic'};return {};}\nasync close(){}}\n")
        module.chmod(0o600)
        return module, marker

    def test_publisher_canonical_document_and_accepted_response(self):
        request = self.artifact_request()
        module, marker = self.publication_module()
        request.update(credential_reference='vault://synthetic/capture/npm', squire_module=str(module), expected_latest_version='0.6.10')
        result, output = self.invoke(request)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(output['status'], 'accepted')
        self.assertTrue(output['requestSent'])
        self.assertTrue(output['grantRevoked'])
        uploaded = json.loads(marker.read_text())
        self.assertEqual(uploaded, {'name': 'usegrunt', 'version': '0.6.11', 'integrity': request['integrity'], 'attachment': 'usegrunt-0.6.11.tgz'})

    def test_publisher_changed_latest_never_uploads_and_revokes_grant(self):
        request = self.artifact_request()
        module, marker = self.publication_module('0.6.12')
        request.update(credential_reference='vault://synthetic/capture/npm', squire_module=str(module), expected_latest_version='0.6.10')
        result, output = self.invoke(request)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(output['reason'], 'npm_latest_changed_before_publication')
        self.assertFalse(output['requestSent'])
        self.assertTrue(output['grantRevoked'])
        self.assertFalse(marker.exists())

    def test_publisher_requires_authorization_before_grant_access(self):
        request = self.artifact_request()
        module, marker = self.fake_module()
        request.update(credential_reference='vault://synthetic/capture/npm', squire_module=str(module),
                       authorization_file=str(self.root / 'does-not-exist.json'))
        result, output = self.invoke(request)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(output['requestSent'])
        self.assertFalse(marker.exists())

    def test_publisher_rejects_changed_reviews_in_protected_authorization(self):
        request = self.artifact_request()
        self.assertEqual(self.invoke(request, '--dry-run')[1]['status'], 'dry_run')
        path = Path(request['authorization_file'])
        authority = promotion._json_file(path)
        authority['receipt']['reviews'].pop()
        promotion._write(path, authority)
        result, output = self.invoke(request, '--dry-run')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(output['reason'], 'independent_reviews_required')
        self.assertFalse(output['requestSent'])


if __name__ == '__main__':
    unittest.main()
