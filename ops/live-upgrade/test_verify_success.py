"""The read-only success verification. Pieces are tested directly; the full check runs on the live host after an upgrade."""
import datetime
import tempfile
import unittest
from pathlib import Path

import verify_success as vs


class PoolStatus(unittest.TestCase):
    def test_the_status_schema_number_is_accepted_not_compared_with_the_package_version(self):
        vs.assert_pool_status(8792, {'version': 1, 'activeRequests': 0, 'sources': []})     # what the daemons really report; the old check demanded '0.10.0'

    def test_a_non_integer_schema_or_a_removed_worker_slot_is_rejected(self):
        for status in ({'version': '0.10.1'}, {'version': True}, {}, {'version': None}):
            with self.subTest(status), self.assertRaises(AssertionError):
                vs.assert_pool_status(8793, status)
        with self.assertRaisesRegex(AssertionError, 'worker slots'):
            vs.assert_pool_status(8793, {'version': 1, 'workers': {'active': []}})


class Processes(unittest.TestCase):
    def test_process_start_time_comes_from_the_kernel_start_ticks(self):
        with tempfile.TemporaryDirectory() as temp:
            proc = Path(temp)
            (proc / '42').mkdir()
            (proc / '42/stat').write_text('42 (milo) S 1 ' + ' '.join(['0'] * 17) + ' 5000 0')     # field 22 (index 19 after the command) = 5000 ticks since boot
            (proc / 'uptime').write_text('100.0 50.0\n')
            started = vs.process_started_at(42, proc=temp, now=lambda: 10000.0, ticks=100)
            self.assertEqual(started, 10000.0 - 100.0 + 50.0)

    def test_the_receipt_start_stamp_is_utc(self):
        stamp = datetime.datetime(2026, 11, 24, 5, 45, 6, tzinfo=datetime.timezone.utc).timestamp()
        self.assertEqual(vs.receipt_start({'startedAt': '20261124T054506Z'}), stamp)


class Verify(unittest.TestCase):
    def test_a_directory_without_a_successful_receipt_fails_with_an_assertion_not_a_crash(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'runtime-stage.json').write_text('{"version": "0.0.0-unscoped", "previousVersion": "0.0.0-unscoped-previous"}')
            (root / 'activation-receipt.json').write_text('{"version": "0.0.0-unscoped", "success": false, "workMayResume": false}')
            with self.assertRaisesRegex(AssertionError, 'did not succeed'):
                vs.verify(root)

    def test_a_stage_for_another_release_is_refused(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'runtime-stage.json').write_text('{"version": "9.9.9", "previousVersion": "9.9.8"}')
            (root / 'activation-receipt.json').write_text('{}')
            with self.assertRaisesRegex(AssertionError, 'different release'):
                vs.verify(root)


if __name__ == '__main__':
    unittest.main()
