import importlib.util
from pathlib import Path
import hashlib
import json
import sys
import tempfile
import os
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
spec = importlib.util.spec_from_file_location('prepare_wait', Path(__file__).with_name('preparation.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


NEW = {'version': 1, 'published': 'new', 'adapters': []}
OLD = {'version': 1, 'published': 'old', 'adapters': []}


def cache_bytes(body, etag):
    return json.dumps({'registry': json.loads(body), 'etag': etag}, separators=(',', ':')).encode()


class PreparationWaitTests(unittest.TestCase):
    def test_only_exact_natural_cache_publication_is_admitted(self):
        approved = {'version': 1, 'published': 'new', 'adapters': []}
        self.assertTrue(m.cache_matches({'registry': approved, 'etag': 'normal'}, approved))
        self.assertFalse(m.cache_matches({'registry': {**approved, 'published': 'old'}}, approved))
        self.assertFalse(m.cache_matches({'registry': approved, 'override': True}, approved))
        self.assertFalse(m.cache_matches([], approved))

    def test_the_registry_wait_is_gone(self):
        self.assertFalse(hasattr(m, 'wait_for_normal_registry'))

    def fixture(self, *, cache, write=None, fetch=None, etag='"e1"', raw=None):
        """bring_registry_current with every collaborator injected: `cache` is the cache's initial content (bytes or None) as a one-item list."""
        directory = Path(tempfile.mkdtemp(dir=Path(__file__).parent))
        self.addCleanup(lambda: __import__('shutil').rmtree(directory, ignore_errors=True))
        self.cache = cache[0]
        self.writes, self.fetches, self.pauses = [], [], []

        def read_cache():
            return self.cache

        def default_write(runtime, target, body, tag, *, node):
            self.writes.append((runtime, target, body, tag, node))
            self.cache = cache_bytes(body, tag)
            return {'published': json.loads(body)['published'], 'previousPublished': 'old', 'rawSha256': hashlib.sha256(self.cache).hexdigest()}
        raw = raw or json.dumps(NEW).encode()
        return directory, lambda: m.bring_registry_current(directory, raw, etag, runtime='/rt', node='/node', directory='/cfg', check_pause=lambda: self.pauses.append(1),
                                                             read_cache=read_cache, write=write or default_write, fetch=fetch or (lambda: self.fetches.append(1) or (raw, 'https://r', '"e2"')),
                                                             log=lambda text: None, now=lambda: 5.0)

    def test_a_stale_cache_is_written_once_with_the_pinned_bytes_and_a_backup_of_the_old_bytes(self):
        old = cache_bytes(json.dumps(OLD).encode(), '"old"')
        directory, run = self.fixture(cache=[old])
        receipt = run()
        self.assertEqual(self.writes, [('/rt', '/cfg', json.dumps(NEW).encode(), '"e1"', '/node')])
        self.assertEqual((receipt['action'], receipt['publication'], receipt['previousPublication'], receipt['refetched']), ('written', 'new', 'old', False))
        self.assertEqual((directory / 'registry-cache-before-refresh.json').read_bytes(), old)
        self.assertEqual(oct((directory / 'registry-cache-before-refresh.json').stat().st_mode & 0o777), '0o600')
        self.assertEqual(json.loads((directory / 'registry-refresh.json').read_text())['action'], 'written')
        self.assertEqual(receipt['originalRawSha256'], hashlib.sha256(old).hexdigest())
        self.assertTrue(self.pauses)           # the deliberate-pause guard still runs first
        self.assertEqual(self.fetches, [])

    def test_a_cache_that_already_equals_the_approved_registry_is_left_alone(self):
        directory, run = self.fixture(cache=[cache_bytes(json.dumps(NEW).encode(), '"other-etag"')])
        self.assertEqual(run()['action'], 'none')
        self.assertEqual(self.writes, [])
        self.assertFalse((directory / 'registry-cache-before-refresh.json').exists())

    def test_a_missing_cache_is_written_without_a_backup(self):
        directory, run = self.fixture(cache=[None])
        self.assertEqual(run()['action'], 'written')
        self.assertFalse((directory / 'registry-cache-before-refresh.json').exists())

    def test_a_pause_stops_everything_before_any_cache_access(self):
        def pause():
            raise RuntimeError('deliberate pause')
        with self.assertRaisesRegex(RuntimeError, 'deliberate pause'):
            m.bring_registry_current('/nowhere', b'{}', None, runtime='/rt', node='/n', check_pause=pause, read_cache=lambda: self.fail(), write=lambda *a, **k: self.fail())

    def test_a_cache_rewritten_by_someone_else_after_the_write_is_retried_once_with_a_fresh_fetch(self):
        old = cache_bytes(json.dumps(OLD).encode(), '"old"')
        newer = dict(NEW, published='newer')
        fresh = json.dumps(newer).encode()
        calls = []

        def write(runtime, target, body, tag, *, node):
            calls.append(body)
            # first write: the daemon refreshed meanwhile to a newer publication; the second write lands
            written = cache_bytes(body, tag)
            self.cache = cache_bytes(fresh if len(calls) == 1 else body, tag)
            return {'published': json.loads(body)['published'], 'previousPublished': 'old', 'rawSha256': hashlib.sha256(written).hexdigest()}
        directory, run = self.fixture(cache=[old], write=write, fetch=lambda: (fresh, 'https://r', '"e2"'))
        receipt = run()
        self.assertEqual(receipt['action'], 'written')   # the fresh fetch is already in the cache: no second write needed
        self.assertTrue(receipt['refetched'])
        self.assertEqual(receipt['publication'], 'newer')
        self.assertEqual(len(calls), 1)
        self.assertEqual(len(receipt['attempts']), 1)
        self.assertIn('rewritten meanwhile', receipt['attempts'][0]['error'])

    def test_a_second_failure_after_the_refetch_fails_cleanly_and_is_recorded(self):
        old = cache_bytes(json.dumps(OLD).encode(), '"old"')

        def rejected(runtime, target, body, tag, *, node):
            raise m.registry_refresh.RegistryRefreshError('Registry cache refresh refused: rejected')
        directory, run = self.fixture(cache=[old], write=rejected)
        with self.assertRaisesRegex(m.registry_refresh.RegistryRefreshError, 'after a re-fetch'):
            run()
        self.assertEqual(self.fetches, [1])
        record = json.loads((directory / 'registry-refresh.json').read_text())
        self.assertEqual((record['action'], len(record['attempts'])), ('failed', 2))
        self.assertEqual((directory / 'registry-cache-before-refresh.json').read_bytes(), old)

    def test_a_failed_fetch_is_a_clean_refusal(self):
        old = cache_bytes(json.dumps(OLD).encode(), '"old"')

        def rejected(runtime, target, body, tag, *, node):
            raise m.registry_refresh.RegistryRefreshError('Registry cache refresh refused: rejected')

        def down():
            raise m.registry_refresh.RegistryRefreshError('The public registry could not be fetched: down')
        directory, run = self.fixture(cache=[old], write=rejected, fetch=down)
        with self.assertRaisesRegex(m.registry_refresh.RegistryRefreshError, 'could not be fetched'):
            run()

    def test_private_metadata_rejects_symlink_and_nonprivate_mode(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'metadata'
            path.write_text('{}')
            path.chmod(0o600)
            self.assertEqual(m.private_json(path), {})
            link = Path(directory) / 'link'
            link.symlink_to(path)
            with self.assertRaises(OSError):
                m.private_json(link)
            path.chmod(0o644)
            with self.assertRaises(ValueError):
                m.private_json(path)

    def test_invalid_or_exhausted_budget_is_rejected(self):
        for deadline, now in [(0, 0), (7201, 0), (float('inf'), 0), (1, float('nan'))]:
            with self.subTest(deadline=deadline, now=now), self.assertRaises((RuntimeError, ValueError)):
                m.remaining_timeout(deadline, now)


if __name__ == '__main__':
    unittest.main()
