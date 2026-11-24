"""Release verification: the npm tarball, the CI artifact and a clean build must be byte-identical and file-identical to the reviewed
source. Synthetic packages and fake gh/git/npm collaborators; no network, no live host."""
import base64
import hashlib
import io
import json
import tarfile
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

import release_pins as rp

COMMIT = 'a' * 40


def make_package(files):
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode='w:gz') as package:
        for name, body in files.items():
            member = tarfile.TarInfo('package/' + name)
            member.size = len(body)
            member.mode = 0o644
            package.addfile(member, io.BytesIO(body))
    return buffer.getvalue()


def integrity(body):
    return 'sha512-' + base64.b64encode(hashlib.sha512(body).digest()).decode()


class Fixture(unittest.TestCase):
    version, previous = '0.10.1', '0.10.0'

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / 'source'
        self.evidence = self.root / 'evidence'
        self.evidence.mkdir()
        self.files = {'package.json': json.dumps({'name': 'usegrunt', 'version': self.version}).encode(), 'dist/local/main.js': b'main',
                      'dist/registry/adapters.json': b'{"a":1}', 'README.md': b'readme'}
        self.write_source(self.files)
        (self.source / 'registry').mkdir()
        (self.source / 'registry/adapters.json').write_bytes(b'{"a":1}')
        self.body = make_package(self.files)
        self.metadata = {'dist': {'integrity': integrity(self.body)}}

    def write_source(self, files):
        for name, body in files.items():
            path = self.source / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(body)

    def pins(self, **kw):
        args = dict(version=self.version, previous=self.previous, commit=COMMIT, run_id='99', pull_request=7, metadata=self.metadata, body=self.body,
                    ci_bytes=self.body, clean_bytes=self.body, source=self.source, evidence=self.evidence)
        args.update(kw)
        return rp.build_pins(**args)


class BuildPins(Fixture):
    def test_identical_tarball_ci_artifact_and_clean_build_produce_the_pins_and_the_private_archive(self):
        pins = self.pins()
        self.assertEqual((pins['version'], pins['previousVersion'], pins['sourceCommit'], pins['publishRun'], pins['pullRequest']), (self.version, self.previous, COMMIT, '99', 7))
        self.assertEqual(pins['archiveSha256'], hashlib.sha256(self.body).hexdigest())
        self.assertEqual(set(pins['packageFiles']), set(self.files))
        self.assertTrue(pins['ciArchiveIdentical'] and pins['cleanBuildIdentical'])
        archive = self.evidence / f'usegrunt-{self.version}.tgz'
        self.assertEqual(archive.read_bytes(), self.body)
        self.assertEqual(archive.stat().st_mode & 0o777, 0o600)
        self.assertEqual(json.loads((self.evidence / f'release-{self.version}-public-pins.json').read_text()), pins)

    def test_a_ci_artifact_or_clean_build_that_differs_from_npm_is_refused(self):
        other = make_package({**self.files, 'dist/local/main.js': b'tampered'})
        with self.assertRaisesRegex(rp.ReleaseError, 'CI artifact'):
            self.pins(ci_bytes=other)
        with self.assertRaisesRegex(rp.ReleaseError, 'clean build'):
            self.pins(clean_bytes=other)

    def test_a_packaged_file_that_differs_from_the_built_source_is_refused(self):
        (self.source / 'dist/local/main.js').write_bytes(b'built differently')
        with self.assertRaisesRegex(rp.ReleaseError, 'differs from the clean build: dist/local/main.js'):
            self.pins()

    def test_unsafe_or_duplicate_package_entries_are_refused(self):
        for name in ('../escape', 'other/x'):
            buffer = io.BytesIO()
            with tarfile.open(fileobj=buffer, mode='w:gz') as package:
                member = tarfile.TarInfo(name)
                member.size = 1
                package.addfile(member, io.BytesIO(b'x'))
            body = buffer.getvalue()
            with self.subTest(name), self.assertRaisesRegex(rp.ReleaseError, 'Unsafe'):
                self.pins(body=body, ci_bytes=body, clean_bytes=body, metadata={'dist': {'integrity': integrity(body)}})

    def test_wrong_package_version_is_refused(self):
        wrong = {**self.files, 'package.json': json.dumps({'name': 'usegrunt', 'version': '0.10.2'}).encode()}
        self.write_source(wrong)
        body = make_package(wrong)
        with self.assertRaisesRegex(rp.ReleaseError, 'package version'):
            self.pins(body=body, ci_bytes=body, clean_bytes=body)

    def test_downgrade_or_same_version_and_bad_versions_are_refused(self):
        for previous in ('0.10.1', '0.11.0'):
            with self.subTest(previous), self.assertRaisesRegex(rp.ReleaseError, 'not newer'):
                self.pins(previous=previous)
        for bad in ('0.10', '0.10.1-rc.1', 'latest', '1.2.3.4'):
            with self.subTest(bad), self.assertRaises(rp.ReleaseError):
                rp.version_tuple(bad)
        self.assertLess(rp.version_tuple('0.9.12'), rp.version_tuple('0.10.0'))

    def test_a_missing_packaged_registry_a_retired_adapter_or_a_removed_module_is_refused(self):
        cases = {'registry': {**self.files, 'dist/registry/adapters.json': b'{"a":2}'}, 'Clixad': {**self.files, 'dist/local/clixad-adapter.js': b'x'},
                 'Removed-feature': {**self.files, 'dist/local/worker-pool.js': b'x'}}
        for label, files in cases.items():
            self.write_source(files)
            body = make_package(files)
            with self.subTest(label), self.assertRaisesRegex(rp.ReleaseError, label):
                self.pins(body=body, ci_bytes=body, clean_bytes=body)

    def test_a_bad_commit_is_refused(self):
        with self.assertRaises(rp.ReleaseError):
            self.pins(commit='abc')


class FakeRun:
    """Records commands; answers from a table keyed by the first two words."""
    def __init__(self, answers=None):
        self.answers, self.commands = answers or {}, []

    def __call__(self, command, **kw):
        self.commands.append(command)
        key = ' '.join(command[:2]) if command[0] != 'git' else ' '.join(command[3:5]) if command[1] == '-C' else ' '.join(command[:2])
        value = self.answers.get(key, ('', 0))
        out, code = value if isinstance(value, tuple) else (value, 0)
        return SimpleNamespace(stdout=out, stderr='boom' if code else '', returncode=code)


class PublishRun(unittest.TestCase):
    def runs(self, rows):
        return json.dumps(rows)

    def test_the_newest_successful_main_dispatch_whose_commit_carries_the_version_is_chosen(self):
        rows = [{'databaseId': 3, 'headSha': 'c' * 40, 'headBranch': 'main', 'event': 'workflow_dispatch', 'createdAt': '2026-11-24T04:00:00Z'},
                {'databaseId': 2, 'headSha': 'b' * 40, 'headBranch': 'main', 'event': 'workflow_dispatch', 'createdAt': '2026-11-24T02:00:00Z'},
                {'databaseId': 1, 'headSha': 'a' * 40, 'headBranch': 'main', 'event': 'workflow_dispatch', 'createdAt': '2026-11-23T02:00:00Z'},
                {'databaseId': 9, 'headSha': 'd' * 40, 'headBranch': 'feature', 'event': 'workflow_dispatch', 'createdAt': '2026-11-25T02:00:00Z'},
                {'databaseId': 8, 'headSha': 'e' * 40, 'headBranch': 'main', 'event': 'push', 'createdAt': '2026-11-25T03:00:00Z'}]
        versions = {'c' * 40: '0.10.1', 'b' * 40: '0.10.1', 'a' * 40: '0.10.0', 'd' * 40: '0.10.1', 'e' * 40: '0.10.1'}

        def run(command, **kw):
            if command[0] == 'gh':
                return SimpleNamespace(stdout=self.runs(rows), stderr='', returncode=0)
            if command[3] == 'fetch':
                return SimpleNamespace(stdout='', stderr='', returncode=0)
            sha = command[4].split(':')[0]
            return SimpleNamespace(stdout=json.dumps({'version': versions[sha]}), stderr='', returncode=0)
        found = rp.find_publish_run('0.10.1', repo='/repo', slug='o/r', run=run)
        self.assertEqual((found['runId'], found['commit'], found['otherRunsForVersion']), ('3', 'c' * 40, ['2']))
        self.assertEqual(rp.find_publish_run('0.10.0', repo='/repo', slug='o/r', run=run)['runId'], '1')
        with self.assertRaisesRegex(rp.ReleaseError, 'No successful publish.yml run'):
            rp.find_publish_run('0.10.2', repo='/repo', slug='o/r', run=run)

    def test_a_failed_run_is_used_only_when_no_success_exists_and_its_artifact_survives(self):
        rows = [{'databaseId': 5, 'headSha': 'f' * 40, 'headBranch': 'main', 'event': 'workflow_dispatch', 'createdAt': '2026-11-24T07:00:00Z', 'conclusion': 'failure'},
                {'databaseId': 4, 'headSha': 'f' * 40, 'headBranch': 'main', 'event': 'workflow_dispatch', 'createdAt': '2026-11-24T06:00:00Z', 'conclusion': 'cancelled'}]
        artifacts = {'5': True}

        def run(command, **kw):
            if command[:3] == ['gh', 'run', 'list']:
                return SimpleNamespace(stdout=self.runs(rows), stderr='', returncode=0)
            if command[:2] == ['gh', 'api']:
                run_id = command[2].split('/')[-2]
                body = {'artifacts': [{'name': rp.ARTIFACT_NAME, 'expired': False}] if artifacts.get(run_id) else []}
                return SimpleNamespace(stdout=json.dumps(body), stderr='', returncode=0)
            if command[3] == 'fetch':
                return SimpleNamespace(stdout='', stderr='', returncode=0)
            return SimpleNamespace(stdout=json.dumps({'version': '0.10.2'}), stderr='', returncode=0)
        found = rp.find_publish_run('0.10.2', repo='/repo', slug='o/r', run=run)
        self.assertEqual((found['runId'], found['publishRunConclusion']), ('5', 'failure'))
        artifacts.clear()
        with self.assertRaisesRegex(rp.ReleaseError, 'No successful publish.yml run'):
            rp.find_publish_run('0.10.2', repo='/repo', slug='o/r', run=run)
        rows.insert(0, {'databaseId': 6, 'headSha': 'f' * 40, 'headBranch': 'main', 'event': 'workflow_dispatch', 'createdAt': '2026-11-24T08:00:00Z', 'conclusion': 'success'})
        found = rp.find_publish_run('0.10.2', repo='/repo', slug='o/r', run=run)
        self.assertEqual(found['runId'], '6')
        self.assertNotIn('publishRunConclusion', found)

    def test_slug_parsing_and_pull_request_lookup_are_best_effort(self):
        self.assertEqual(rp.repo_slug('https://github.com/owner/name.git'), 'owner/name')
        self.assertEqual(rp.repo_slug('git@github.com:owner/name.git'), 'owner/name')
        with self.assertRaises(rp.ReleaseError):
            rp.repo_slug('https://example.com/x/y.git')
        ok = lambda command, **kw: SimpleNamespace(stdout='[{"number": 42}]', stderr='', returncode=0)
        bad = lambda command, **kw: SimpleNamespace(stdout='', stderr='nope', returncode=1)
        self.assertEqual(rp.find_pull_request(COMMIT, slug='o/r', run=ok), 42)
        self.assertIsNone(rp.find_pull_request(COMMIT, slug='o/r', run=bad))


class Npm(Fixture):
    def not_found(self, url):
        import urllib.error
        error = urllib.error.HTTPError(url, 404, 'no', {}, io.BytesIO(b''))
        self.addCleanup(error.close)
        return error

    def opener(self, metadata=None, body=None, versioned=True):
        import urllib.error
        metadata = metadata or {'name': 'usegrunt', 'version': self.version, 'dist': {**self.metadata['dist'], 'tarball': f'{rp.NPM}/usegrunt/-/usegrunt-{self.version}.tgz'}}
        body = self.body if body is None else body

        def opener(request, timeout=0):
            url = request if isinstance(request, str) else request.full_url
            if url.endswith('.tgz') or '.tgz?' in url:
                return io.BytesIO(body)
            if versioned and f'/usegrunt/{self.version}?' in url:
                return io.BytesIO(json.dumps(metadata).encode())
            if f'/usegrunt/{self.version}?' in url:
                raise self.not_found(url)
            return io.BytesIO(json.dumps({'versions': {self.version: metadata}}).encode())
        return opener

    def test_metadata_tarball_url_and_integrity_must_agree(self):
        metadata, body = rp.fetch_npm(self.version, opener=self.opener())
        self.assertEqual(body, self.body)
        self.assertEqual(metadata['version'], self.version)

    def test_a_cached_404_falls_back_to_the_packument(self):
        self.assertEqual(rp.fetch_npm(self.version, opener=self.opener(versioned=False))[1], self.body)

    def test_a_tarball_that_does_not_match_the_integrity_is_refused(self):
        with self.assertRaisesRegex(rp.ReleaseError, 'integrity'):
            rp.fetch_npm(self.version, opener=self.opener(body=b'something else'))

    def test_an_unpublished_version_or_foreign_metadata_is_refused(self):
        import urllib.error

        def missing(request, timeout=0):
            url = request if isinstance(request, str) else request.full_url
            if f'/usegrunt/{self.version}?' in url:
                raise self.not_found(url)
            return io.BytesIO(b'{"versions": {}}')
        with self.assertRaisesRegex(rp.ReleaseError, 'not on npm'):
            rp.fetch_npm(self.version, opener=missing)
        with self.assertRaisesRegex(rp.ReleaseError, 'does not describe'):
            rp.fetch_npm(self.version, opener=self.opener(metadata={'name': 'other', 'version': self.version, 'dist': self.metadata['dist']}))


class Source(unittest.TestCase):
    def test_the_checkout_must_land_on_the_published_commit_on_main_and_be_clean(self):
        answers = {'git clone': '', 'git checkout': '', 'git -C': ''}
        calls = []

        def run(command, **kw):
            calls.append(command)
            if 'rev-parse' in command:
                return SimpleNamespace(stdout=COMMIT + '\n', stderr='', returncode=0)
            if 'merge-base' in command:
                return SimpleNamespace(stdout='', stderr='', returncode=self.ancestor)
            return SimpleNamespace(stdout=self.dirty if 'status' in command else '', stderr='', returncode=0)
        with tempfile.TemporaryDirectory() as temp:
            self.ancestor, self.dirty = 0, ''
            rp.acquire_source('https://github.com/o/r.git', COMMIT, Path(temp) / 'source', run=run)
            self.assertEqual(calls[0][:4], ['git', 'clone', '-q', '--no-checkout'])
            self.ancestor = 1
            with self.assertRaisesRegex(rp.ReleaseError, 'ancestor'):
                rp.acquire_source('https://github.com/o/r.git', COMMIT, Path(temp) / 'two', run=run)
            self.ancestor, self.dirty = 0, ' M package.json'
            with self.assertRaisesRegex(rp.ReleaseError, 'not clean'):
                rp.acquire_source('https://github.com/o/r.git', COMMIT, Path(temp) / 'three', run=run)
            with self.assertRaisesRegex(rp.ReleaseError, 'already exists'):
                rp.acquire_source('https://github.com/o/r.git', COMMIT, Path(temp), run=run)

    def test_clean_build_installs_with_the_lockfile_builds_and_packs_like_the_publish_workflow(self):
        commands = []
        with tempfile.TemporaryDirectory() as temp:
            def run(command, **kw):
                commands.append(command)
                if command[0] == 'npm':
                    (Path(temp) / 'out/usegrunt-0.10.1.tgz').write_bytes(b'x')
                return SimpleNamespace(stdout='', stderr='', returncode=0)
            path = rp.clean_build(Path(temp) / 'src', '0.10.1', Path(temp) / 'out', run=run)
            self.assertEqual(path.name, 'usegrunt-0.10.1.tgz')
        self.assertEqual(commands, [['pnpm', 'install', '--frozen-lockfile', '--ignore-scripts'], ['pnpm', 'build'], ['npm', 'pack', '--ignore-scripts', '--pack-destination', commands[2][4]]])

    def test_a_failing_build_step_is_a_release_error(self):
        run = lambda command, **kw: SimpleNamespace(stdout='', stderr='build exploded', returncode=1)
        with tempfile.TemporaryDirectory() as temp, self.assertRaisesRegex(rp.ReleaseError, 'build exploded'):
            rp.clean_build(Path(temp), '0.10.1', Path(temp) / 'out', run=run)


if __name__ == '__main__':
    unittest.main()
