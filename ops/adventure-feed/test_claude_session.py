import datetime
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from activity import events, private_tail, progress_text, session_format, snapshot
from claude_session import ClaudeSessionReader
from uptime import CLAUDE_AGENTS, WORK_TICKS, WorkProbe, shell_activity, tool_running

NOW = 1794948372598
SESSION = '0a1b2c3d-1111-4222-8333-444455556666'
AGENT = 'a0123456789abcdef'


def iso(offset=0):
    moment = datetime.datetime.fromtimestamp((NOW + offset) / 1000, datetime.timezone.utc)
    return moment.isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def assistant(blocks, offset=0, stop='tool_use', **extra):
    return {'type': 'assistant', 'timestamp': iso(offset), 'isSidechain': False,
            'message': {'model': 'grunt', 'role': 'assistant', 'content': blocks, 'stop_reason': stop}, **extra}


def text(value, offset=0, **kw):
    return assistant([{'type': 'text', 'text': value}], offset, **kw)


def use(call, name, offset=0, **kw):
    return assistant([{'type': 'tool_use', 'id': call, 'name': name, 'input': {'command': 'PRIVATE INPUT'}}], offset, **kw)


def result(call, offset=0, error=False, meta=None, **extra):
    row = {'type': 'user', 'timestamp': iso(offset), 'isSidechain': False,
           'message': {'role': 'user', 'content': [{'type': 'tool_result', 'tool_use_id': call,
                                                    'content': 'PRIVATE OUTPUT', 'is_error': error}]},
           'toolUseResult': meta or {'stdout': 'PRIVATE OUTPUT'}, **extra}
    return row


def notice(status, offset=0):
    body = (f'<task-notification>\n<task-id>x</task-id>\n<status>{status}</status>\n'
            '<summary>PRIVATE SUMMARY</summary>\n<result>PRIVATE RESULT</result>\n</task-notification>')
    return {'type': 'user', 'timestamp': iso(offset), 'isSidechain': False, 'origin': {'kind': 'task-notification'},
            'message': {'role': 'user', 'content': body}}


def prompt(offset=0):
    return {'type': 'user', 'timestamp': iso(offset), 'isSidechain': False,
            'message': {'role': 'user', 'content': 'PRIVATE PROMPT'}}


BLOB = {'type': 'api-request-blob', 'sessionId': SESSION, 'hash': 'h', 'message': {'role': 'user', 'content': 'PRIVATE BLOB'}}


def write(path, rows, mode=0o600):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text('\n'.join(json.dumps(row) for row in rows) + '\n')
    path.chmod(mode)


class Fixture:
    """A private runner state directory holding a synthetic Claude Code session."""

    def __init__(self, temp, main, subagents=None):
        self.root = Path(temp)
        config = self.root / 'config.json'
        config.write_text(json.dumps({'sessionId': SESSION}))
        config.chmod(0o600)
        self.projects = self.root / 'worker/claude/projects'
        folder = self.projects / '-worker-project'
        write(folder / (SESSION + '.jsonl'), main)
        for name, rows in (subagents or {}).items():
            write(folder / SESSION / 'subagents' / f'agent-{name}.jsonl', rows, 0o664)

    def reader(self):
        return ClaudeSessionReader(self.root, private_tail, progress_text)


class ClaudeProjectionTest(unittest.TestCase):
    def test_projects_visible_text_tool_outcomes_and_subagents_without_private_content(self):
        main = [
            prompt(-9000), BLOB,
            assistant([{'type': 'thinking', 'thinking': 'PRIVATE THINKING'}], -8000),
            text('Finished the quest.\nhttps://signed.example.test/link', -7000),
            use('t1', 'Bash', -6000), result('t1', -5900, error=True),
            use('t2', 'Edit', -5000), result('t2', -4900),
            use('t3', 'Grep', -4800), result('t3', -4700),
            use('t4', 'WebFetch', -4600), result('t4', -4500),
            use('t5', 'mcp__vault__get', -4400), result('t5', -4300),
            use('a1', 'Agent', -4000),
            result('a1', -3900, meta={'status': 'async_launched', 'prompt': 'PRIVATE PROMPT', 'agentId': AGENT}),
            text('Waiting on the map worker.', -3500),
            text('raw API failure', -3400, isApiErrorMessage=True),
            notice('completed', -1000), notice('failed', -900), notice('killed', -800),
        ]
        sub = [
            {**prompt(-3800), 'isSidechain': True},
            {**text('Mapped the market.', -3000), 'isSidechain': True},
            {**use('s1', 'Read', -2900), 'isSidechain': True}, {**result('s1', -2800), 'isSidechain': True},
        ]
        with tempfile.TemporaryDirectory() as temp:
            rows = Fixture(temp, main, {AGENT: sub}).reader().events(NOW)
        self.assertEqual(rows, [
            {'at': NOW - 7000, 'kind': 'progress', 'text': 'Finished the quest.'},
            {'at': NOW - 5900, 'kind': 'tool', 'tool': 'bash', 'failed': True},
            {'at': NOW - 4900, 'kind': 'tool', 'tool': 'edit', 'failed': False},
            {'at': NOW - 4700, 'kind': 'tool', 'tool': 'read', 'failed': False},
            {'at': NOW - 3900, 'kind': 'tool', 'tool': 'subagent', 'failed': False, 'phase': 'started'},
            {'at': NOW - 3500, 'kind': 'progress', 'text': 'Waiting on the map worker.'},
            {'at': NOW - 3000, 'kind': 'progress', 'text': 'Mapped the market.', 'subagent': True},
            {'at': NOW - 2800, 'kind': 'tool', 'tool': 'read', 'failed': False, 'subagent': True},
            {'at': NOW - 1000, 'kind': 'tool', 'tool': 'subagent', 'failed': False, 'phase': 'finished'},
            {'at': NOW - 900, 'kind': 'tool', 'tool': 'subagent', 'failed': True, 'phase': 'finished'},
            {'at': NOW - 800, 'kind': 'tool', 'tool': 'subagent', 'failed': True, 'phase': 'finished'},
        ])
        self.assertNotIn('PRIVATE', json.dumps(rows))

    def test_foreground_and_failed_agent_calls_finish(self):
        main = [use('a1', 'Agent', -3000), result('a1', -2000, meta={'status': 'completed'}),
                use('a2', 'Task', -1500), result('a2', -1000, error=True)]
        with tempfile.TemporaryDirectory() as temp:
            rows = Fixture(temp, main).reader().events(NOW)
        self.assertEqual([(row['failed'], row['phase']) for row in rows], [(False, 'finished'), (True, 'finished')])

    def test_old_and_future_rows_and_malformed_lines_are_ignored(self):
        main = [text('Too old.', -86400001), text('From the future.', 6000), text('Recent update.', -1000)]
        with tempfile.TemporaryDirectory() as temp:
            fixture = Fixture(temp, main)
            path = fixture.projects / '-worker-project' / (SESSION + '.jsonl')
            path.write_text('{not json\n[1]\n{"type":"assistant"}\n' + path.read_text())
            self.assertEqual(fixture.reader().events(NOW), [{'at': NOW - 1000, 'kind': 'progress', 'text': 'Recent update.'}])

    def test_activity_signals_count_unfinished_tools_in_main_and_subagents_until_the_turn_ends(self):
        main = [use('t1', 'Bash', -9000), result('t1', -8000), use('t2', 'Bash', -7000), use('a1', 'Agent', -6000)]
        sub = [{**use('s1', 'Bash', -5000), 'isSidechain': True}, {**text('Compiling.', -2000), 'isSidechain': True}]
        with tempfile.TemporaryDirectory() as temp:
            reader = Fixture(temp, main, {AGENT: sub}).reader()
            self.assertEqual(reader.activity(NOW), {'openTools': 2, 'openSince': NOW - 7000, 'lastAt': NOW - 2000})
        done = [*main, text('Done.', -1000, stop='end_turn')]
        with tempfile.TemporaryDirectory() as temp:
            self.assertEqual(Fixture(temp, done).reader().activity(NOW),
                             {'openTools': 0, 'openSince': None, 'lastAt': NOW - 1000})
        with tempfile.TemporaryDirectory() as temp:  # A new prompt after a crash drops stale calls.
            self.assertEqual(Fixture(temp, [*main, prompt(-500)]).reader().activity(NOW)['openTools'], 0)

    def test_open_tool_that_started_over_two_hours_ago_is_not_counted(self):
        with tempfile.TemporaryDirectory() as temp:
            reader = Fixture(temp, [use('t1', 'Bash', -3 * 3600 * 1000)]).reader()
            self.assertEqual(reader.activity(NOW)['openTools'], 0)

    def test_missing_session_or_projects_directory_is_empty(self):
        with tempfile.TemporaryDirectory() as temp:
            config = Path(temp) / 'config.json'
            config.write_text(json.dumps({'sessionId': SESSION}))
            config.chmod(0o600)
            reader = ClaudeSessionReader(Path(temp), private_tail, progress_text)
            self.assertEqual(reader.events(NOW), [])
            self.assertEqual(reader.activity(NOW), {'openTools': 0, 'openSince': None, 'lastAt': None})
            config.write_text(json.dumps({'sessionId': '../etc'}))
            self.assertEqual(reader.events(NOW), [])

    def test_transcripts_must_be_private_and_subagents_may_not_be_world_writable(self):
        main = [text('Visible update.', -1000)]
        with tempfile.TemporaryDirectory() as temp:
            fixture = Fixture(temp, main, {AGENT: [{**text('Sub update.', -900), 'isSidechain': True}]})
            self.assertEqual(len(fixture.reader().events(NOW)), 2)  # Subagent files are 0664.
            sub = fixture.projects / '-worker-project' / SESSION / 'subagents' / f'agent-{AGENT}.jsonl'
            sub.chmod(0o666)  # World-writable files are refused.
            self.assertEqual(len(fixture.reader().events(NOW)), 1)
            with self.assertRaises(ValueError):
                private_tail(sub, 1024, shared_read=True)
            main_path = fixture.projects / '-worker-project' / (SESSION + '.jsonl')
            main_path.chmod(0o640)
            with self.assertRaises(ValueError):
                fixture.reader().events(NOW)

    def test_subagent_symlinks_and_odd_names_are_not_read(self):
        with tempfile.TemporaryDirectory() as temp:
            fixture = Fixture(temp, [text('Visible update.', -1000)])
            folder = fixture.projects / '-worker-project' / SESSION / 'subagents'
            folder.mkdir(parents=True)
            target = Path(temp) / 'other.jsonl'
            write(target, [{**text('Linked.', -900), 'isSidechain': True}])
            (folder / 'agent-link.jsonl').symlink_to(target)
            write(folder / 'notes.jsonl', [{**text('Odd name.', -800), 'isSidechain': True}])
            self.assertEqual([row['text'] for row in fixture.reader().events(NOW)], ['Visible update.'])


class SelectionTest(unittest.TestCase):
    def state(self, temp, **config):
        path = Path(temp) / 'config.json'
        path.write_text(json.dumps({'sessionId': SESSION, **config}))
        path.chmod(0o600)
        return Path(temp)

    def test_defaults_to_pi_and_prefers_the_environment_over_config(self):
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, clear=False):
            os.environ.pop('GRUNT_ADVENTURE_SESSION_FORMAT', None)
            state = self.state(temp)
            self.assertEqual(session_format(state), 'pi')
            self.assertEqual(session_format(Path(temp) / 'missing'), 'pi')
            state = self.state(temp, sessionFormat='claude-code')
            self.assertEqual(session_format(state), 'claude-code')
            os.environ['GRUNT_ADVENTURE_SESSION_FORMAT'] = 'pi'
            self.assertEqual(session_format(state), 'pi')
            os.environ['GRUNT_ADVENTURE_SESSION_FORMAT'] = 'codex'
            with self.assertRaises(ValueError):
                session_format(state)

    def test_events_and_snapshot_use_claude_transcripts_when_selected(self):
        with tempfile.TemporaryDirectory() as temp:
            fixture = Fixture(temp, [text('Opened the plaza.', -1000), use('t1', 'Bash', -900), result('t1', -800)])
            env = {'GRUNT_ADVENTURE_SESSION_FORMAT': 'claude-code'}
            with patch.dict(os.environ, env):
                expected = [{'at': NOW - 1000, 'kind': 'progress', 'text': 'Opened the plaza.'},
                            {'at': NOW - 800, 'kind': 'tool', 'tool': 'bash', 'failed': False}]
                self.assertEqual(events(fixture.root, NOW), expected)
                with patch('activity.ask', return_value={'sources': []}), patch('activity.time.time', return_value=NOW / 1000):
                    self.assertEqual(snapshot(fixture.root)['events'], expected)
            # A custom projects directory can be configured.
            moved = Path(temp) / 'elsewhere'
            fixture.projects.rename(moved)
            with patch.dict(os.environ, {**env, 'GRUNT_ADVENTURE_CLAUDE_PROJECTS': str(moved)}):
                self.assertEqual(len(events(fixture.root, NOW)), 2)
            with patch.dict(os.environ, env):
                self.assertEqual(events(fixture.root, NOW), [])


class ClaudeUptimeTest(unittest.TestCase):
    def probe(self, temp, main, sub=None, status=None):
        fixture = Fixture(temp, main, sub)
        status = status or {'phase': 'working', 'workerPid': 101, 'lastActivityAt': NOW / 1000 - 600}
        read = lambda path, limit, **kw: json.dumps(status).encode() if path.name == 'status.json' else private_tail(path, limit, **kw)
        return WorkProbe(fixture.root, read, lambda: {'activeRequests': 0, 'sources': []}, session=fixture.reader())

    def test_unfinished_transcript_tool_is_a_wait_until_cpu_progress_without_status_tool_fields(self):
        with tempfile.TemporaryDirectory() as temp:
            probe = self.probe(temp, [use('t1', 'Bash', -1000)])
            with patch('uptime.worker_exists', return_value=True), \
                    patch('uptime.shell_activity', return_value=(True, False, {(7, 1): 1})) as shell:
                self.assertEqual(probe.sample(NOW), 'tool_wait')
                shell.assert_called_with(101, agents=CLAUDE_AGENTS)
                shell.return_value = (True, False, {(7, 1): 1 + WORK_TICKS})
                self.assertEqual(probe.sample(NOW + 5000), 'working')
                self.assertEqual(probe.category, 'execution')

    def test_subagent_tool_and_transcript_rows_keep_orchestration_working(self):
        main = [use('a1', 'Agent', -400000), result('a1', -399000, meta={'status': 'async_launched'})]
        sub = [{**use('s1', 'Bash', -60000), 'isSidechain': True}]
        with tempfile.TemporaryDirectory() as temp:
            probe = self.probe(temp, main, {AGENT: sub})
            with patch('uptime.worker_exists', return_value=True), \
                    patch('uptime.shell_activity', return_value=(True, False, {(7, 1): 1})) as shell:
                self.assertEqual(probe.sample(NOW), 'tool_wait')
                shell.return_value = (True, False, {(7, 1): 1 + WORK_TICKS})
                self.assertEqual(probe.sample(NOW + 5000), 'working')
        # Without any recent row or CPU progress the same state is a stall, not work.
        with tempfile.TemporaryDirectory() as temp:
            probe = self.probe(temp, [use('t1', 'Bash', -400000)])
            with patch('uptime.worker_exists', return_value=True), \
                    patch('uptime.shell_activity', return_value=(True, False, {(7, 1): 1})):
                self.assertEqual(probe.sample(NOW), 'stalled')

    def test_recent_transcript_rows_count_as_activity_and_old_ones_do_not(self):
        with tempfile.TemporaryDirectory() as temp:
            probe = self.probe(temp, [text('Planning the next step.', -3000, stop='end_turn')],
                               status={'phase': 'working', 'workerPid': 101, 'lastActivityAt': NOW / 1000 - 600})
            pool = {'activeRequests': 1, 'sources': [{'id': 'kilo', 'state': 'answering', 'active': 1}]}
            probe.pool = lambda: pool
            with patch('uptime.worker_exists', return_value=True), patch('uptime.shell_activity', return_value=(False, False, {})):
                self.assertEqual(probe.sample(NOW), 'model_only')
                self.assertEqual(probe.category, 'inference')
                self.assertEqual(probe.sample(NOW + 400000), 'stalled')

    def test_pi_probe_is_unchanged_without_a_session_reader(self):
        status = {'phase': 'working', 'workerPid': 101, 'lastActivityAt': NOW / 1000 - 60, 'lastToolStartedAt': NOW / 1000 - 60}
        probe = WorkProbe(Path('/state'), lambda *_: json.dumps(status), lambda: {'activeRequests': 0, 'sources': []})
        with patch('uptime.worker_exists', return_value=True), patch('uptime.shell_activity', return_value=(True, False, {})) as shell:
            self.assertEqual(probe.sample(NOW), 'tool_wait')
            shell.assert_called_once_with(101)

    def test_stream_json_log_tracks_unfinished_tools_and_turn_boundaries(self):
        row = lambda value: json.dumps(value)
        start = row({'type': 'assistant', 'message': {'content': [{'type': 'text', 'text': 'x'}, {'type': 'tool_use', 'id': 'u1', 'name': 'Bash'}]}})
        end = row({'type': 'user', 'message': {'content': [{'type': 'tool_result', 'tool_use_id': 'u1', 'content': 'x'}]}})
        self.assertTrue(tool_running(start))
        self.assertFalse(tool_running(start + '\n' + end))
        self.assertFalse(tool_running(start + '\n' + row({'type': 'result', 'subtype': 'success'})))
        self.assertFalse(tool_running(start + '\n' + row({'type': 'system', 'subtype': 'init'})))
        self.assertFalse(tool_running(row({'type': 'system', 'subtype': 'task_progress'})))

    def test_shell_detection_finds_claude_children_only_when_asked(self):
        with tempfile.TemporaryDirectory() as temp:
            proc = Path(temp)

            def process(pid, name, children, ticks=0):
                task = proc / str(pid) / 'task' / str(pid)
                task.mkdir(parents=True)
                fields = ['S'] + ['0'] * 19
                fields[11], fields[19] = str(ticks), str(pid + 10)
                (proc / str(pid) / 'stat').write_text(f'{pid} ({name}) ' + ' '.join(fields))
                (task / 'children').write_text(' '.join(map(str, children)))

            process(101, 'bwrap', [102])
            process(102, 'claude', [103])
            process(103, 'bash', [104])
            process(104, 'node', [], ticks=9)
            self.assertEqual(shell_activity(101, proc), (False, False, {}))
            self.assertEqual(shell_activity(101, proc, agents=CLAUDE_AGENTS), (True, False, {(104, 114): 9}))


if __name__ == '__main__':
    unittest.main()
