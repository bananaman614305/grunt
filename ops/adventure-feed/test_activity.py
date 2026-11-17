import datetime
import json
from pathlib import Path
import tempfile
import unittest

from activity import events, private_tail, progress_text


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


if __name__ == '__main__':
    unittest.main()
