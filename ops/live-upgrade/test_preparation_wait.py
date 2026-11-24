import importlib.util
from pathlib import Path
import tempfile
import os
import unittest

spec = importlib.util.spec_from_file_location('prepare_wait', Path(__file__).with_name('preparation.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class PreparationWaitTests(unittest.TestCase):
    def test_only_exact_natural_cache_publication_is_admitted(self):
        approved = {'version': 1, 'published': 'new', 'adapters': []}
        self.assertTrue(m.cache_matches({'registry': approved, 'etag': 'normal'}, approved))
        self.assertFalse(m.cache_matches({'registry': {**approved, 'published': 'old'}}, approved))
        self.assertFalse(m.cache_matches({'registry': approved, 'override': True}, approved))
        self.assertFalse(m.cache_matches([], approved))

    def test_wait_uses_one_absolute_budget_and_only_passive_reads(self):
        now = [0]
        reads = []
        checks = []
        approved = {'published': 'new'}
        def read():
            reads.append(now[0])
            return {'registry': approved if now[0] >= 30 else {'published': 'old'}}
        m.wait_for_normal_registry(60, approved, clock=lambda: now[0],
            sleep=lambda n: now.__setitem__(0, now[0] + n), read=read,
            check_pause=lambda: checks.append(now[0]))
        self.assertEqual(reads, [0, 15, 30])
        self.assertEqual(checks, reads)
        self.assertEqual(m.remaining_timeout(60, now[0]), 30)

    def test_expiry_never_extends_budget_or_reads_again(self):
        now = [0]
        reads = []
        with self.assertRaises(RuntimeError):
            m.wait_for_normal_registry(30, {}, clock=lambda: now[0],
                sleep=lambda n: now.__setitem__(0, now[0] + n),
                read=lambda: reads.append(now[0]) or {'registry': {'old': True}},
                check_pause=lambda: None)
        self.assertEqual(reads, [0, 15])
        self.assertEqual(now[0], 30)

    def test_pause_stops_before_cache_read(self):
        def pause():
            raise RuntimeError('deliberate pause')
        with self.assertRaisesRegex(RuntimeError, 'deliberate pause'):
            m.wait_for_normal_registry(30, {}, clock=lambda: 0, sleep=lambda _: self.fail(),
                read=lambda: self.fail(), check_pause=pause)

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
