import datetime
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from uptime import (
    DAY_MS, MODEL_PROGRESS_MS, TOOL_PROGRESS_MS, WORK_TICKS,
    WorkLedger, WorkProbe, classify_work, shell_activity, tool_running, project_workers, project_jobs, managed_jobs,
)

from activity import events, private_tail, progress_text, project_checkpoint, project_pulls, publications, snapshot


class ActivityTest(unittest.TestCase):
    def test_keeps_source_errors_with_their_current_retry_state(self):
        rows = [
            {'id': 'kilo', 'state': 'available', 'errorCode': 'upstream'},
            {'id': 'zro', 'state': 'limited', 'errorCode': 'quota'},
            {'id': 'perch', 'state': 'error', 'errorCode': 'refused'},
            {'id': 'freebuff', 'state': 'disabled', 'errorCode': 'refused'},
        ]
        with patch('activity.events', return_value=[]), patch('activity.private_tail', return_value='{"phase":"working"}'), \
                patch('activity.ask', return_value={'sources': rows}):
            self.assertEqual(snapshot()['issues'], [
                {'source': 'kilo', 'state': 'available', 'error': 'upstream'},
                {'source': 'zro', 'state': 'limited', 'error': 'quota'},
                {'source': 'perch', 'state': 'error', 'error': 'refused'},
            ])

    def test_omits_secret_shaped_model_labels_without_losing_progress_or_source_state(self):
        now = 1794948372598
        progress = {'at': now, 'kind': 'progress', 'text': 'Optimizing texture downloads.'}
        for label in ('deepseek-v4-1-flash-economy-free', 'sk-synthetic-private-value', 'A' * 40):
            with self.subTest(label=label), patch('activity.events', return_value=[progress]), \
                    patch('activity.private_tail', return_value='{"phase":"working"}'), \
                    patch('activity.time.time', return_value=now / 1000), \
                    patch('activity.ask', return_value={'sources': [
                        {'id': 'fikra', 'model': label, 'state': 'answering', 'active': 1,
                         'lastSuccessAt': now, 'errorCode': 'refused'},
                        {'id': 'fikra', 'model': label, 'state': 'error', 'errorCode': 'refused'},
                        {'id': 'opencode', 'model': 'big-pickle', 'state': 'answering', 'active': 1},
                    ]}):
                report = snapshot()
            self.assertEqual(report['events'], [progress])
            self.assertEqual(report['active'], [{'source': 'fikra'}, {'source': 'opencode', 'model': 'big-pickle'}])
            self.assertEqual(report['lastReply'], {'source': 'fikra', 'at': now})
            self.assertEqual(report['issues'], [{'source': 'fikra', 'error': 'refused', 'state': 'error'}])
            self.assertNotIn(label, json.dumps(report))

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

    def test_a_quiet_live_shell_is_a_wait_with_a_buffered_tool_start(self):
        now = 1794948372598
        status = {'phase': 'working', 'workerPid': 101, 'lastActivityAt': now / 1000 - 60,
                  'lastToolStartedAt': now / 1000 - 60, 'lastLog': 'cycle-20261117T202749Z.jsonl'}
        pool = {'activeRequests': 0, 'sources': []}

        def read(path, _limit):
            return json.dumps(status).encode() if path.name == 'status.json' else b'{"type":"turn_start"}\n'

        probe = WorkProbe(Path('/test-state'), read, lambda: pool)
        with patch('uptime.worker_exists', return_value=True), patch('uptime.shell_activity', return_value=(True, False, {})) as shell:
            self.assertEqual(probe.sample(now), 'tool_wait')
            self.assertEqual(probe.category, 'tool_wait')
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
            self.assertEqual(probe.sample(now), 'tool_wait')
            self.assertEqual(probe.category, 'tool_wait')

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


class PerformanceTest(unittest.TestCase):
    now = 1794948372598
    worker_id = '11111111-1111-4111-8111-111111111111'
    other_id = '22222222-2222-4222-8222-222222222222'

    def workers(self, **fields):
        return {'active': [{'id': self.worker_id, 'state': 'running', 'createdAt': self.now - 1000, **fields}],
                'queued': [], 'recent': []}

    def jobs(self, **fields):
        return {'version': 1, 'observedAt': self.now, 'active': [], 'queued': [], 'recent': [], **fields}

    def test_projects_actual_adventure_workers_and_preserves_safe_failure_and_capability_fields(self):
        workers = self.workers(mode='agent', turns=3, toolCalls=7, artifactAvailable=True,
                               code='ownership_violation', waitingForSource=False,
                               capabilities={'filesystem': True, 'commands': True, 'sandbox': 'bubblewrap', 'secret': 'PRIVATE'},
                               task='PRIVATE TASK', command='PRIVATE COMMAND', artifact='PRIVATE DIFF')
        with patch('activity.events', return_value=[]), patch('activity.private_tail', return_value='{"phase":"working"}'), \
                patch('activity.ask', return_value={'sources': [], 'workers': workers}), \
                patch('activity.time.time', return_value=self.now / 1000):
            result = snapshot()['workers']
        self.assertEqual(result['active'][0]['code'], 'ownership_violation')
        self.assertEqual(result['active'][0]['toolCalls'], 7)
        self.assertEqual(result['active'][0]['capabilities'], {'filesystem': True, 'commands': True, 'sandbox': 'bubblewrap'})
        self.assertNotIn('PRIVATE', json.dumps(result))
        for field in ('state', 'id', 'createdAt'):
            with self.subTest(field=field):
                self.assertIsNone(project_workers(self.workers(**{field: []}), self.now))
        self.assertIsNone(project_workers({'active': [], 'queued': [], 'recent': [workers['active'][0]]}, self.now))
        self.assertIsNone(project_workers({'active': [workers['active'][0]] * 2, 'queued': [], 'recent': []}, self.now))

    def test_time_categories_are_disjoint_migrate_history_and_do_not_fill_gaps(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'work.sqlite3'
            ledger = WorkLedger(path)
            ledger.record(self.now, 'working')  # Historical interval lacks detail.
            for offset, state, category in [(5000, 'working', 'execution'), (10000, 'model_only', 'inference'),
                                            (15000, 'tool_wait', 'tool_wait'), (20000, 'provider_wait', 'provider_wait'),
                                            (25000, 'paused', 'idle'), (30000, 'stalled', 'blocked'),
                                            (35000, 'unknown', None), (60000, 'working', 'execution')]:
                ledger.record(self.now + offset, state, category=category)
            report = ledger.summary(self.now + 60000, 'working')['day']
            self.assertEqual(report['breakdown'], dict(executionMs=5000, inferenceMs=5000, toolWaitMs=5000,
                                                      providerWaitMs=5000, idleMs=5000, blockedMs=5000, unclassifiedMs=5000))
            self.assertEqual(sum(report['breakdown'].values()), report['workingMs'] + report['downtimeMs'])
            ledger.db.close()
            reopened = WorkLedger(path)
            reopened.record(self.now + 65000, 'working', category='execution')
            self.assertEqual(reopened.summary(self.now + 65000, 'working')['day'], report)
            reopened.db.close()

    def test_failed_inference_reclassification_changes_only_that_category(self):
        with tempfile.TemporaryDirectory() as temp:
            ledger = WorkLedger(Path(temp) / 'work.sqlite3')
            ledger.record(self.now, 'working', category='execution')
            ledger.record(self.now + 5000, 'model_only', category='inference')
            ledger.record(self.now + 10000, 'model_only', category='inference')
            ledger.record(self.now + 15000, 'provider_wait', self.now + 10000, category='provider_wait')
            result = ledger.summary(self.now + 15000, 'provider_wait')['day']
            self.assertEqual(result['breakdown']['inferenceMs'], 5000)
            self.assertEqual(result['breakdown']['executionMs'], 5000)
            self.assertEqual(result['breakdown']['providerWaitMs'], 5000)
            ledger.db.close()

    def test_worker_rollup_uses_sampled_slot_time_and_durable_deduplicated_completions(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'work.sqlite3'
            ledger = WorkLedger(path)
            workers = self.workers(waitingForSource=True)
            ledger.record_workers(self.now, workers)
            ledger.record_workers(self.now + 5000, workers)
            finished = {'active': [], 'queued': [], 'recent': [{**workers['active'][0], 'state': 'completed', 'finishedAt': self.now + 5000}]}
            ledger.record_workers(self.now + 10000, finished)
            ledger.record_workers(self.now + 15000, finished)
            ledger.record_workers(self.now + 45000, finished)  # Missing observations are excluded.
            result = ledger.summary(self.now + 45000, 'working')['workerUtilization']['day']
            self.assertEqual(result, dict(capacityMs=30000, occupiedMs=10000, sourceWaitMs=10000, completed=1, failed=0))
            ledger.db.close()
            ledger = WorkLedger(path)
            ledger.record_workers(self.now + 50000, finished)
            self.assertEqual(ledger.summary(self.now + 50000, 'working')['workerUtilization']['day'], result)
            ledger.db.close()

    def test_job_projection_rejects_stale_or_invalid_snapshots_and_omits_command_output(self):
        raw = self.jobs(active=[dict(id=self.worker_id, state='running', category='test', createdAt=self.now,
                                    command='PRIVATE', output='PRIVATE', ownerPid=101)])
        result = project_jobs(raw, self.now)
        self.assertNotIn('PRIVATE', json.dumps(result))
        self.assertNotIn('ownerPid', json.dumps(result))
        self.assertIsNone(project_jobs(raw, self.now + 15001))
        raw['active'][0]['category'] = []
        self.assertIsNone(project_jobs(raw, self.now))
        raw['active'][0]['category'] = 'test'
        def read(path, _limit):
            return json.dumps({'sessionId': self.worker_id}) if path.name == 'config.json' else json.dumps(raw)
        self.assertEqual(managed_jobs(Path('/state'), read, self.now), project_jobs(raw, self.now))

    def test_check_jobs_count_real_exits_deduplicate_jobs_and_clean_revisions_without_claiming_playability(self):
        with tempfile.TemporaryDirectory() as temp:
            ledger = WorkLedger(Path(temp) / 'work.sqlite3')
            ledger.record_jobs(self.now, self.jobs())
            head = 'a' * 40
            row = dict(id=self.worker_id, category='test', state='completed', createdAt=self.now,
                       finishedAt=self.now + 5000, exitCode=0, headAtStart=head, headAtFinish=head,
                       cleanAtStart=True, cleanAtFinish=True)
            rows = [row, {**row, 'id': self.other_id},
                    {**row, 'id': '33333333-3333-4333-8333-333333333333', 'state': 'failed', 'exitCode': 1},
                    {**row, 'id': '44444444-4444-4444-8444-444444444444', 'cleanAtFinish': False},
                    {**row, 'id': '55555555-5555-4555-8555-555555555555', 'exitCode': None}]
            for _ in range(2):
                ledger.record_jobs(self.now + 5000, self.jobs(recent=rows))
            result = ledger.summary(self.now + 5000, 'working')['delivery']
            self.assertEqual(result['day'], dict(successfulChecks=3, failedChecks=1, headLinkedChecks=1))
            self.assertIsNone(result['playableDeployments'])
            ledger.db.close()

    def test_published_builds_require_real_success_receipts_and_cache_bounded_lookups(self):
        head = 'a' * 40
        stamp = datetime.datetime.fromtimestamp((self.now - 5000) / 1000, datetime.timezone.utc).isoformat()
        deployments = [dict(id=1, environment='github-pages', sha=head, statuses_url='https://PRIVATE'),
                       dict(id=2, environment='github-pages', sha=head),
                       dict(id=3, environment='other', sha=head)]
        cache = dict(poll_at=float('-inf'), received_at=float('-inf'), observed_at=0, statuses={})
        with patch('activity._publication_cache', cache), patch('activity.time.monotonic', return_value=0), \
                patch('activity.ask', side_effect=[deployments, [dict(state='success', created_at=stamp)],
                                                   [dict(state='success', created_at=stamp)]]) as request:
            result = publications(self.now)
            self.assertEqual(request.call_count, 3)
            self.assertNotIn('PRIVATE', str(request.call_args_list))
            self.assertEqual(result['day'], dict(builds=2, revisions=1))
            self.assertEqual(result['latest'], dict(at=self.now - 5000, head=head))
            self.assertEqual(result['coverage'], 'partial')
            self.assertEqual(publications(self.now), result)
            self.assertEqual(request.call_count, 3)
        with patch('activity._publication_cache', cache), patch('activity.time.monotonic', return_value=240), \
                patch('activity.ask', side_effect=OSError('unavailable')):
            self.assertEqual(publications(self.now)['observedAt'], self.now)
        with patch('activity._publication_cache', cache), patch('activity.time.monotonic', return_value=4000), \
                patch('activity.ask', side_effect=OSError('unavailable')):
            self.assertIsNone(publications(self.now + 4000000))

    def test_failed_or_pending_deployments_and_pull_request_prose_do_not_count_as_publications(self):
        cache = dict(poll_at=float('-inf'), received_at=float('-inf'), observed_at=0, statuses={})
        deployments = [dict(id=1, environment='github-pages', sha='a' * 40),
                       dict(id=2, environment='github-pages', sha='b' * 40)]
        with patch('activity._publication_cache', cache), patch('activity.time.monotonic', return_value=0), \
                patch('activity.ask', side_effect=[deployments, [dict(state='failure')], [dict(state='pending')]]):
            result = publications(self.now)
            self.assertEqual(result['week'], dict(builds=0, revisions=0))
            self.assertNotIn('latest', result)

    def test_managed_running_job_is_a_wait_even_when_old_tool_has_no_cpu_progress(self):
        start = self.now / 1000 - 600
        status = dict(phase='working', workerPid=101, lastActivityAt=start, lastToolStartedAt=start)
        job = self.jobs(active=[dict(id=self.worker_id, category='build', state='running', createdAt=self.now - 600000)])
        def read(path, _limit):
            return json.dumps({'sessionId': self.worker_id} if path.name == 'config.json' else job if path.name == 'snapshot.json' else status)
        probe = WorkProbe(Path('/state'), read, lambda: {'activeRequests': 0, 'sources': []})
        with patch('uptime.worker_exists', return_value=True), patch('uptime.shell_activity', return_value=(True, False, {})):
            self.assertEqual(probe.sample(self.now), 'tool_wait')
            self.assertEqual(probe.category, 'tool_wait')
            self.assertEqual(probe.sample(self.now + 15001), 'stalled')

    def test_runtime_without_subworkers_or_job_snapshots_yields_no_worker_or_job_data(self):
        start = self.now / 1000 - 30
        status = dict(phase='working', workerPid=101, lastActivityAt=start, lastToolStartedAt=start)
        def read(path, _limit):
            if path.name == 'status.json':
                return json.dumps(status)
            if path.name == 'config.json':
                return json.dumps({'sessionId': self.worker_id})
            raise FileNotFoundError(path)
        probe = WorkProbe(Path('/state'), read, lambda: {'activeRequests': 0, 'sources': []})
        with patch('uptime.worker_exists', return_value=True), patch('uptime.shell_activity', return_value=(True, False, {})):
            self.assertIn(probe.sample(self.now), ('working', 'tool_wait'))
        self.assertIsNone(probe.workers)
        self.assertIsNone(probe.jobs)


if __name__ == '__main__':
    unittest.main()
