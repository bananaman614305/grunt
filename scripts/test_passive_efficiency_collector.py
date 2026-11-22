"""Offline tests: no live paths, provider calls or service mutation."""
import concurrent.futures
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
import uuid

spec = importlib.util.spec_from_file_location('collector', Path(__file__).with_name('passive-efficiency-collector.py'))
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)
NOW = 1795360000000


class PassiveCollectorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / 'source.db'
        self.state = self.root / 'state'
        self.package = self.root / 'package.json'
        self.package.write_text(json.dumps({'version': '0.9.6'}))
        self.stream = str(uuid.uuid4())
        with contextlib.closing(sqlite3.connect(self.source)) as con, con:
            con.executescript('CREATE TABLE diagnostic_meta(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE diagnostic_events(seq INTEGER PRIMARY KEY,id TEXT,at INTEGER,data TEXT);')
            con.execute('INSERT INTO diagnostic_meta VALUES(?,?)', ('stream_id', self.stream))
        self.source.chmod(0o600)

    def add(self, seq, at=None, event_id=None, **extra):
        at = NOW - 1000 if at is None else at
        event_id = event_id or str(uuid.uuid4())
        value = {'version': 1, 'id': event_id, 'at': at, 'requestId': str(uuid.uuid4()), 'kind': 'user',
                 'actor': 'client', 'source': 'runcrate', 'type': 'request.finish', 'outcome': 'passed', 'durationMs': 120, **extra}
        with contextlib.closing(sqlite3.connect(self.source)) as con, con:
            con.execute('INSERT INTO diagnostic_events VALUES(?,?,?,?)', (seq, event_id, at, json.dumps(value)))
        return event_id

    def run_tick(self, **kwargs):
        return collector.collect(self.source, self.state, self.package, now=kwargs.pop('now', NOW), **kwargs)

    def result(self):
        return collector.report(self.state)

    def total(self):
        return sum(row['events'] for row in self.result()['hourly'])

    def test_source_read_only_and_private_output(self):
        self.add(1)
        before = hashlib.sha256(self.source.read_bytes()).hexdigest()
        self.assertEqual(self.run_tick()['processedEvents'], 1)
        self.assertEqual(hashlib.sha256(self.source.read_bytes()).hexdigest(), before)
        self.assertEqual(self.state.stat().st_mode & 0o777, 0o700)
        self.assertEqual((self.state / 'efficiency.sqlite').stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.result()['hourly'][0]['runtimeVersion'], 'unknown')

    def test_batch_restart_and_pruned_raw_keep_aggregates(self):
        for i in range(1, 6):
            self.add(i)
        self.assertTrue(self.run_tick(max_events=2)['backlogRemaining'])
        self.assertEqual(self.total(), 2)
        self.run_tick(max_events=2)
        self.run_tick(max_events=2)
        with contextlib.closing(sqlite3.connect(self.source)) as con, con:
            con.execute('DELETE FROM diagnostic_events')
        self.assertEqual(self.run_tick()['processedEvents'], 0)
        self.assertEqual(self.total(), 5)
        self.assertEqual(self.run_tick()['processedEvents'], 0)

    def test_duplicate_id_and_repeat_ticks_count_once(self):
        event_id = self.add(1)
        self.add(2, event_id=event_id)
        self.assertEqual(self.run_tick()['duplicateEvents'], 1)
        self.assertEqual(self.run_tick()['processedEvents'], 0)
        self.assertEqual(self.total(), 1)

    def test_retention_gap_is_explicit_and_not_a_zero_baseline(self):
        self.add(80)
        self.run_tick()
        self.assertEqual(self.result()['coverageGaps'][0]['reason'], 'startup_history_unavailable')
        self.add(100)
        with contextlib.closing(sqlite3.connect(self.source)) as con, con:
            con.execute('DELETE FROM diagnostic_events WHERE seq=80')
        self.run_tick(now=NOW + 100)
        gaps = self.result()['coverageGaps']
        self.assertEqual(gaps[-1]['reason'], 'unobserved_sequence_range')
        self.assertEqual((gaps[-1]['fromSeq'], gaps[-1]['toSeq']), (81, 99))
        self.assertEqual(self.total(), 2)

    def test_stream_change_resets_cursor_and_records_boundary(self):
        self.add(50)
        self.run_tick()
        with contextlib.closing(sqlite3.connect(self.source)) as con, con:
            con.execute('DELETE FROM diagnostic_events')
            con.execute('UPDATE diagnostic_meta SET value=?', (str(uuid.uuid4()),))
        self.add(1)
        self.run_tick()
        self.assertEqual(self.total(), 2)
        self.assertIn('source_stream_changed', [g['reason'] for g in self.result()['coverageGaps']])

    def test_sequence_reset_replayed_ids_are_not_double_counted(self):
        event_id = self.add(50)
        self.run_tick()
        with contextlib.closing(sqlite3.connect(self.source)) as con, con:
            con.execute('DELETE FROM diagnostic_events')
        self.add(1, event_id=event_id)
        self.add(2)
        result = self.run_tick()
        self.assertEqual(result['duplicateEvents'], 1)
        self.assertEqual(self.total(), 2)
        self.assertIn('source_sequence_reset', [g['reason'] for g in self.result()['coverageGaps']])

    def test_same_stream_replacement_refilled_past_cursor_is_detected(self):
        for i in range(1, 6):
            self.add(i)
        self.run_tick()
        with contextlib.closing(sqlite3.connect(self.source)) as con, con:
            con.execute('DELETE FROM diagnostic_events')
        for i in range(1, 11):
            self.add(i)
        result = self.run_tick()
        self.assertEqual(result['processedEvents'], 10)
        self.assertEqual(self.total(), 15)
        self.assertIn('source_cursor_identity_changed', [g['reason'] for g in self.result()['coverageGaps']])

    def test_corrupt_nested_enum_fields_skip_required_or_collapse_optional(self):
        self.add(1, type={})
        self.add(2, kind=[])
        self.add(3, actor={}, source=[], outcome={}, errorCode=[], stage={},
                 failureReason=[], workDisposition={}, workOperation=[])
        result = self.run_tick()
        self.assertEqual((result['invalidEvents'], result['processedEvents'], result['cursor']), (2, 1, 3))
        self.assertEqual(self.total(), 1)
        row = self.result()['hourly'][0]
        self.assertEqual((row['provider'], row['stage'], row['actor']), ('other', 'none', 'unknown'))
        self.assertEqual(self.run_tick()['processedEvents'], 0)

    def test_capacity_floor_excludes_old_replayed_event_after_id_eviction(self):
        old_max = collector.MAX_SEEN
        collector.MAX_SEEN = 2
        try:
            event_id = self.add(1, at=NOW - 3000)
            self.add(2, at=NOW - 2000)
            self.add(3, at=NOW - 1000)
            self.run_tick()
            self.add(4, at=NOW - 3000, event_id=event_id)
            result = self.run_tick()
            self.assertEqual(result['lateEvents'], 1)
            self.assertEqual(self.total(), 3)
            self.assertEqual(self.result()['deduplicationFloorAt'], NOW - 3000)
        finally:
            collector.MAX_SEEN = old_max

    def test_observation_transaction_rolls_back_cursor_with_aggregates(self):
        self.add(1)
        self.add(2)
        original = collector.project_event
        calls = 0
        def broken(*args):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise ValueError('synthetic processing interruption')
            return original(*args)
        collector.project_event = broken
        try:
            with self.assertRaises(ValueError):
                self.run_tick()
        finally:
            collector.project_event = original
        self.assertEqual(self.total(), 0)
        self.assertEqual(self.run_tick()['processedEvents'], 2)
        self.assertEqual(self.total(), 2)

    def test_version_attribution_never_backfills_package_version(self):
        self.add(1)
        self.run_tick()
        self.add(2, at=NOW + 1)
        self.run_tick(now=NOW + 10)
        self.package.write_text(json.dumps({'version': '0.9.7'}))
        self.add(3, at=NOW + 20)
        self.run_tick(now=NOW + 30)
        self.add(4, at=NOW + 31)
        self.add(5, at=NOW - 500, runtimeVersion='0.9.5')
        self.run_tick(now=NOW + 40)
        versions = {}
        for row in self.result()['hourly']:
            versions[row['runtimeVersion']] = versions.get(row['runtimeVersion'], 0) + row['events']
        self.assertEqual(versions, {'unknown': 2, '0.9.6': 1, '0.9.7': 1, '0.9.5': 1})

    def test_allowlist_does_not_retain_secrets_or_task_content(self):
        secret = 'sk-protected-private-information-1234'
        self.add(1, source=secret, prompt=secret, command=secret, errorCode=secret, stage=secret,
                 failureReason=secret, runtimeVersion=secret, model=secret, parentId=secret)
        self.run_tick()
        self.assertNotIn(secret, json.dumps(self.result()))
        self.assertNotIn(secret.encode(), (self.state / 'efficiency.sqlite').read_bytes())
        row = self.result()['hourly'][0]
        self.assertEqual((row['provider'], row['stage'], row['errorCode']), ('other', 'none', 'none'))

    def test_duration_histograms_tokens_and_unknown_counts(self):
        self.add(1, type='attempt.finish', durationMs=5, inputTokens=12, outputTokens=8)
        self.add(2, type='attempt.finish', durationMs=6)
        self.add(3, type='request.finish', durationMs=4000000, inputTokens=100, outputTokens=100)
        self.run_tick()
        rows = self.result()['hourly']
        attempt = next(r for r in rows if r['type'] == 'attempt.finish')
        self.assertEqual((attempt['durationCount'], attempt['durationSumMs']), (2, 11))
        self.assertEqual(attempt['histogram'][1:3], [1, 1])
        self.assertEqual((attempt['inputTokensKnownEvents'], attempt['inputTokensSum']), (1, 12))
        request = next(r for r in rows if r['type'] == 'request.finish')
        self.assertEqual(request['histogram'][-1], 1)
        self.assertEqual(request['inputTokensKnownEvents'], 0)

    def test_work_stage_counts_are_separate_from_task_completion(self):
        self.add(1, type='work.finish', stage='verification', workDisposition='reused')
        self.run_tick()
        row = self.result()['hourly'][0]
        self.assertEqual((row['type'], row['stage'], row['workDisposition']), ('work.finish', 'verification', 'reused'))
        self.assertFalse(any(r['stage'] == 'task' for r in self.result()['hourly']))

    def test_concurrent_collectors_do_not_double_count(self):
        for i in range(1, 21):
            self.add(i)
        self.run_tick(max_events=1)
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: self.run_tick(), range(2)))
        self.assertEqual(sum(r['processedEvents'] for r in results), 19)
        self.assertEqual(self.total(), 20)

    def test_invalid_events_advance_cursor_without_storing_payload(self):
        self.add(1, kind='bad', durationMs=float('nan'))
        self.add(2)
        result = self.run_tick()
        self.assertEqual((result['invalidEvents'], result['cursor']), (1, 2))
        self.assertEqual(self.total(), 1)

    def test_marker_id_is_idempotent_and_does_not_relabel_history(self):
        self.add(1)
        self.run_tick()
        ident = str(uuid.uuid4())
        collector.marker(self.state, 'baseline', '0.9.6', ident, NOW)
        collector.marker(self.state, 'baseline', '0.9.6', ident, NOW + 1)
        self.assertEqual(len(self.result()['markers']), 1)
        self.assertEqual(self.result()['hourly'][0]['runtimeVersion'], 'unknown')
        with self.assertRaises(ValueError):
            collector.marker(self.state, 'release', '0.9.7', ident, NOW + 1)

    def test_symlink_and_nonprivate_output_are_rejected(self):
        real = self.root / 'real'
        real.mkdir(mode=0o700)
        self.state.symlink_to(real)
        with self.assertRaises(ValueError):
            self.run_tick()
        self.state.unlink()
        self.state.mkdir(mode=0o755)
        with self.assertRaises(ValueError):
            self.run_tick()

    def test_symlink_output_file_and_source_are_rejected(self):
        self.state.mkdir(mode=0o700)
        (self.state / 'efficiency.sqlite').symlink_to(self.source)
        with self.assertRaises(ValueError):
            self.run_tick()
        (self.state / 'efficiency.sqlite').unlink()
        linked = self.root / 'linked.db'
        linked.symlink_to(self.source)
        with self.assertRaises(ValueError):
            collector.collect(linked, self.state, now=NOW)

    def test_errors_do_not_print_source_paths(self):
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            code = collector.main(['--once', '--database', str(self.root / 'secret.db'), '--state-directory', str(self.state)])
        self.assertEqual(code, 1)
        self.assertEqual(json.loads(err.getvalue()), {'version': 1, 'error': 'collection_failed'})


if __name__ == '__main__':
    unittest.main()
