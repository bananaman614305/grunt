import datetime
import json
from pathlib import Path
import tempfile
import unittest

from activity import events, private_tail, progress_text, project_checkpoint, project_pulls


class ActivityTest(unittest.TestCase):
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


if __name__ == '__main__':
    unittest.main()
