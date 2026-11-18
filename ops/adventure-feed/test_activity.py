import datetime
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from uptime import (
    DAY_MS, MODEL_PROGRESS_MS, TOOL_PROGRESS_MS, WORK_TICKS,
    WorkLedger, WorkProbe, classify_work, shell_activity, tool_running,
)

from activity import events, private_tail, progress_text, project_checkpoint, project_pulls, snapshot


class ActivityTest(unittest.TestCase):
    def test_keeps_source_errors_with_their_current_retry_state(self):
        rows = [
            {'id': 'kilo', 'state': 'available', 'errorCode': 'upstream'},
            {'id': 'zro', 'state': 'limited', 'errorCode': 'quota'},
            {'id': 'clixad', 'state': 'error', 'errorCode': 'refused'},
            {'id': 'freebuff', 'state': 'disabled', 'errorCode': 'refused'},
        ]
        with patch('activity.events', return_value=[]), patch('activity.private_tail', return_value='{"phase":"working"}'), \
                patch('activity.ask', return_value={'sources': rows}):
            self.assertEqual(snapshot()['issues'], [
                {'source': 'kilo', 'state': 'available', 'error': 'upstream'},
                {'source': 'zro', 'state': 'limited', 'error': 'quota'},
                {'source': 'clixad', 'state': 'error', 'error': 'refused'},
            ])

    def test_projects_only_completed_visible_messages_and_fixed_tool_metadata(self):
        now = 1794948372598
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            session = 'a' * 36
            config = root / 'config.json'
            config.write_text(json.dumps({'sessionId': session}))
            config.chmod(0o600)
            folder = root / 'worker/sessions'
            folder.mkdir(parents=True)
            log = folder / ('test_' + session + '.jsonl')
            stamp = datetime.datetime.fromtimestamp(now / 1000, datetime.timezone.utc).isoformat()
            rows = [
                {'role': 'user', 'content': [{'type': 'text', 'text': 'private prompt'}]},
                {'role': 'assistant', 'content': [
                    {'type': 'text', 'text': 'Finished the quest.\\nhttps://signed.example.test/link'},
                    {'type': 'thinking', 'thinking': 'private reasoning'},
                    {'type': 'toolCall', 'arguments': 'raw command'}]},
                {'role': 'assistant', 'stopReason': 'error', 'content': [{'type': 'text', 'text': 'raw error'}]},
                {'role': 'toolResult', 'toolName': 'bash', 'isError': True, 'content': 'raw output'}
            ]
            rows[1]['content'][0]['text'] = rows[1]['content'][0]['text'].replace('\\n', '\n')
            log.write_text('\n'.join(json.dumps({'type': 'message', 'timestamp': stamp, 'message': row}) for row in rows))
            log.chmod(0o600)
            self.assertEqual(events(root, now), [
                {'at': now, 'kind': 'progress', 'text': 'Finished the quest.'},
                {'at': now, 'kind': 'tool', 'tool': 'bash', 'failed': True}
            ])
            link = root / 'linked'
            link.symlink_to(folder, target_is_directory=True)
            with self.assertRaises(OSError):
                private_tail(link / log.name, 1024)

    def test_removes_code_fences_and_sensitive_lines(self):
        fence = chr(96) * 3
        raw = f'Finished save and load.\n{fence}js\ncode()\n{fence}\nSecret = hidden\nNext I will check reload.'
        self.assertEqual(progress_text([{'type': 'text', 'text': raw}]),
                         'Finished save and load. Next I will check reload.')

    def test_checkpoint_uses_grunts_current_work_and_plan_sections_only(self):
        content = '''# Grunt status

## Current task
The courtyard quests are playable.

## Completed checks
Raw test output is outside the brief.

## Next task (Round 3)
1. Connect the plaza and the market.
   Check that players can travel in both directions.
2. Add faction reputation.
3. API key should be left out.
4. Let players overhear conversations.
5. This is past the three-step limit.

## Private notes
These must not be included.
'''
        result = project_checkpoint(content, 123)
        self.assertEqual(result, {
            'at': 123, 'summary': 'The courtyard quests are playable.',
            'next': ['Connect the plaza and the market. Check that players can travel in both directions.',
                     'Add faction reputation.', 'Let players overhear conversations.']
        })

    def test_project_timeline_keeps_actual_pr_states_and_ignores_untrusted_links(self):
        day = '2026-11-17T19:00:00Z'
        newer = '2026-11-17T21:00:00Z'
        rows = project_pulls([
            {'number': 1, 'state': 'closed', 'merged_at': day, 'title': 'Project plan'},
            {'number': 2, 'state': 'open', 'created_at': newer, 'title': 'Round 1'},
            {'number': 3, 'state': 'open', 'created_at': newer, 'title': 'https://example.test/private'},
            {'number': 4, 'state': 'closed', 'closed_at': day, 'title': 'Abandoned draft',
             'html_url': 'https://example.test/fake'}
        ])
        self.assertEqual([(row['number'], row['status']) for row in rows], [(2, 'review'), (1, 'merged'), (4, 'closed')])
        self.assertNotIn('html_url', rows[-1])

    def test_distinguishes_project_work_from_provider_wait_and_a_running_but_stalled_process(self):
        now = 1794948372598
        worker = {'phase': 'working', 'lastActivityAt': now / 1000 - 60}
        self.assertEqual(classify_work(now, worker, {'activeRequests': 1}, worker_alive=True), 'working')
        self.assertEqual(classify_work(now, worker, None, worker_alive=True, tool_active=True), 'working')
        self.assertEqual(classify_work(now, worker, {'activeRequests': 0}, worker_alive=True, provider_handoff=True), 'provider_wait')
        self.assertEqual(classify_work(now, worker, {'activeRequests': 0}, worker_alive=True), 'stalled')
        self.assertEqual(classify_work(now, worker, {'activeRequests': 0}), 'between_cycles')
        self.assertEqual(classify_work(now, worker, None), 'offline')
        self.assertEqual(classify_work(now, {'phase': 'stopped'}, {'activeRequests': 0}), 'paused')
        self.assertEqual(classify_work(now, None, None), 'unknown')
        event = lambda kind: json.dumps({'type': 'tool_execution_' + kind, 'toolCallId': 'same'})
        self.assertTrue(tool_running(event('start')))
        self.assertFalse(tool_running(event('start') + '\n' + event('end')))

    def test_totals_clip_rolling_windows_preserve_history_and_exclude_observation_gaps(self):
        now = 1794948372598
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'work.sqlite3'
            ledger = WorkLedger(path)
            for at, state in [(now - DAY_MS - 5000, 'working'), (now - DAY_MS + 5000, 'provider_wait'),
                              (now - DAY_MS + 10000, 'unknown'), (now - 10000, 'working'),
                              (now - 5000, 'stalled'), (now, 'provider_wait')]:
                ledger.record(at, state)
            report = ledger.summary(now, 'provider_wait')
            self.assertEqual(report['day'], {'workingMs': 10000, 'downtimeMs': 10000, 'providerWaitMs': 5000})
            self.assertEqual(report['week'], {'workingMs': 15000, 'downtimeMs': 10000, 'providerWaitMs': 5000})
            ledger.db.close()
            reopened = WorkLedger(path)
            reopened.record(now + 5000, 'working')
            self.assertEqual(reopened.summary(now + 5000, 'working')['week'], report['week'])
            reopened.db.close()

    def test_observed_failed_model_only_time_becomes_provider_downtime(self):
        now = 1794948372598
        with tempfile.TemporaryDirectory() as temp:
            ledger = WorkLedger(Path(temp) / 'work.sqlite3')
            for offset, state in [(0, 'working'), (5000, 'model_only'), (10000, 'model_only')]:
                ledger.record(now + offset, state)
            ledger.record(now + 15000, 'provider_wait', failed_model_since=now + 10000)
            self.assertEqual(ledger.summary(now + 15000, 'provider_wait')['day'],
                             {'workingMs': 10000, 'downtimeMs': 5000, 'providerWaitMs': 5000})
            ledger.db.close()

    def test_a_quiet_live_shell_keeps_working_status_with_a_buffered_tool_start(self):
        now = 1794948372598
        status = {'phase': 'working', 'workerPid': 101, 'lastActivityAt': now / 1000 - 60,
                  'lastToolStartedAt': now / 1000 - 60, 'lastLog': 'cycle-20261117T202749Z.jsonl'}
        pool = {'activeRequests': 0, 'sources': []}

        def read(path, _limit):
            return json.dumps(status).encode() if path.name == 'status.json' else b'{"type":"turn_start"}\n'

        probe = WorkProbe(Path('/test-state'), read, lambda: pool)
        with patch('uptime.worker_exists', return_value=True), patch('uptime.shell_activity', return_value=(True, False, {})) as shell:
            self.assertEqual(probe.sample(now), 'working')
            shell.assert_called_once_with(101)
        with patch('uptime.worker_exists', return_value=True), patch('uptime.shell_activity', return_value=(False, False, {})):
            self.assertEqual(probe.sample(now), 'stalled')

    def test_old_tool_stays_working_while_nested_execution_advances_then_expires(self):
        now = 1794948372598
        start = now / 1000 - 600
        status = {'phase': 'working', 'workerPid': 101, 'lastActivityAt': start, 'lastToolStartedAt': start}
        probe = WorkProbe(Path('/test-state'), lambda *_: json.dumps(status), lambda: {'activeRequests': 0, 'sources': []})
        with patch('uptime.worker_exists', return_value=True), patch('uptime.shell_activity') as shell:
            shell.return_value = (True, False, {(104, 55): 10})
            self.assertEqual(probe.sample(now), 'stalled')
            shell.return_value = (True, False, {(104, 55): 10 + WORK_TICKS})
            self.assertEqual(probe.sample(now + 5000), 'working')
            self.assertEqual(probe.sample(now + 5000 + TOOL_PROGRESS_MS), 'working')
            self.assertEqual(probe.sample(now + 5001 + TOOL_PROGRESS_MS), 'stalled')
            # The same process ID with a new birth time has no comparable counter.
            shell.return_value = (True, False, {(104, 56): 100})
            self.assertEqual(probe.sample(now + 6000 + TOOL_PROGRESS_MS), 'stalled')

    def test_nested_reply_refreshes_a_quiet_tool_but_sleeping_shell_does_not(self):
        now = 1794948372598
        start = now / 1000 - 600
        status = {'phase': 'working', 'workerPid': 101, 'lastActivityAt': start, 'lastToolStartedAt': start}
        pool = {'activeRequests': 0, 'sources': [{'id': 'kilo', 'lastSuccessAt': now - 1000}]}
        probe = WorkProbe(Path('/test-state'), lambda *_: json.dumps(status), lambda: pool)
        with patch('uptime.worker_exists', return_value=True), patch('uptime.shell_activity') as shell:
            shell.return_value = (True, False, {})
            self.assertEqual(probe.sample(now), 'working')
            self.assertEqual(probe.sample(now + TOOL_PROGRESS_MS), 'stalled')
            status.update(lastActivityAt=now / 1000 - 60, lastToolStartedAt=now / 1000 - 60)
            shell.return_value = (True, True, {})
            self.assertEqual(probe.sample(now), 'stalled')

    def test_quiet_nested_request_counts_as_work_until_its_progress_expires(self):
        now = 1794948372598
        start = now / 1000 - 600
        status = {'phase': 'working', 'workerPid': 101, 'lastActivityAt': start, 'lastToolStartedAt': start}
        source = {'id': 'kilo', 'state': 'answering', 'active': 1}
        pool = {'activeRequests': 1, 'sources': [source]}
        probe = WorkProbe(Path('/test-state'), lambda *_: json.dumps(status), lambda: pool)
        with patch('uptime.worker_exists', return_value=True), patch('uptime.shell_activity', return_value=(True, False, {})):
            self.assertEqual(probe.sample(now), 'working')
            self.assertEqual(probe.sample(now + MODEL_PROGRESS_MS), 'working')
            later = now + MODEL_PROGRESS_MS + 1
            self.assertEqual(probe.sample(later), 'stalled')
            source['lastSuccessAt'] = later
            self.assertEqual(probe.sample(later), 'working')
            self.assertEqual(probe.sample(later + TOOL_PROGRESS_MS + 1), 'working')
            self.assertEqual(probe.sample(later + MODEL_PROGRESS_MS + 1), 'stalled')

    def test_ordinary_daemon_maintenance_is_not_nested_progress(self):
        now = 1794948372598
        start = now / 1000 - 600
        status = {'phase': 'working', 'workerPid': 101, 'lastActivityAt': start, 'lastToolStartedAt': start}
        source = {'id': 'kilo', 'state': 'ready', 'active': 0, 'lastSuccessAt': now - 1000, 'maintenance': {}}
        pool = {'activeRequests': 0, 'sources': [source]}
        probe = WorkProbe(Path('/test-state'), lambda *_: json.dumps(status), lambda: pool)
        with patch('uptime.worker_exists', return_value=True), patch('uptime.shell_activity', return_value=(True, False, {})):
            self.assertEqual(probe.sample(now), 'stalled')
            source.update(state='answering', active=1)
            pool['activeRequests'] = 1
            self.assertEqual(probe.sample(now + 5000), 'stalled')

    def test_shell_detection_ignores_orphans_and_zombies(self):
        with tempfile.TemporaryDirectory() as temp:
            proc = Path(temp)

            def process(pid, name, mode, children, ticks=0):
                p = proc / str(pid)
                task = p / 'task' / str(pid)
                task.mkdir(parents=True, exist_ok=True)
                fields = [mode] + ['0'] * 19
                fields[11], fields[19] = str(ticks), str(pid + 10)
                (p / 'stat').write_text(f'{pid} ({name}) ' + ' '.join(fields))
                (task / 'children').write_text(' '.join(map(str, children)))

            process(101, 'bwrap', 'S', [102])
            process(102, 'bwrap', 'S', [103, 104])
            process(103, 'pi', 'S', [105])
            process(104, 'bash', 'S', [])
            process(105, 'bash', 'Z', [])
            self.assertEqual(shell_activity(101, proc), (False, False, {}))
            process(105, 'bash', 'S', [106])
            process(106, 'sleep', 'S', [])
            self.assertEqual(shell_activity(101, proc), (True, True, {}))
            process(105, 'bash', 'S', [106, 107])
            process(107, 'timeout', 'S', [108])
            process(108, 'pi', 'S', [109], ticks=3)
            process(109, 'node', 'R', [], ticks=15)
            self.assertEqual(shell_activity(101, proc), (True, False, {(108, 118): 3, (109, 119): 15}))


if __name__ == '__main__':
    unittest.main()
