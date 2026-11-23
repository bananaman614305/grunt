"""Project an Amazing Adventure run recorded by Claude Code headless sessions.

Claude Code writes its transcript to ``<projects>/<encoded-cwd>/<session>.jsonl``
and each subagent's transcript to
``<projects>/<encoded-cwd>/<session>/subagents/agent-<id>.jsonl``. This module
turns those private files into the same activity entries the Pi reader emits:
completed visible assistant text, and tool names with outcomes. It also reports
two uptime signals: tool calls that have started but not finished, and the time
of the latest transcript row. Subagent entries carry ``subagent: true``.

Never read or return prompts, tool inputs, tool results, thinking, task
summaries or paths. Rows are inspected only for their type, timestamp, block
types, tool names, error flags and task status words. Visible text goes through
the caller's filter.
"""
import datetime
import json
import os
from pathlib import Path
import re

DAY_MS = 86400000
MAIN_LIMIT = 4 * 1024 * 1024  # Transcripts carry large request-blob rows.
SUBAGENT_LIMIT = 1024 * 1024
MAX_SUBAGENTS = 12
PENDING_MAX_MS = 2 * 3600 * 1000
SESSION = re.compile(r'[a-f0-9-]{36}')
SUBAGENT_FILE = re.compile(r'agent-[A-Za-z0-9]{1,64}\.jsonl')
NOTICE_STATUS = re.compile(r'<status>(completed|failed|killed|stopped)</status>')
# Claude Code tool names mapped to the fixed names the feed has always allowed.
TOOLS = {'Read': 'read', 'Glob': 'read', 'Grep': 'read', 'Write': 'write', 'Edit': 'edit',
         'MultiEdit': 'edit', 'NotebookEdit': 'edit', 'Bash': 'bash'}
SUBAGENT_TOOLS = {'Agent', 'Task'}


def stamp(value):
    try:
        moment = datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))
        return int(moment.timestamp() * 1000) if moment.tzinfo else None
    except (ValueError, TypeError, AttributeError, OverflowError):
        return None


def notice_status(row):
    """The completion word of a background subagent's task notification."""
    origin = row.get('origin')
    if not (isinstance(origin, dict) and origin.get('kind') == 'task-notification'):
        return None
    content = row['message'].get('content')
    if isinstance(content, list):
        content = next((block.get('text') for block in content
                        if isinstance(block, dict) and isinstance(block.get('text'), str)), None)
    found = NOTICE_STATUS.search(content) if isinstance(content, str) else None
    return found.group(1) if found else None


def parse(raw, project_text, now, *, subagent=False):
    """Return projected events, unfinished tool calls and the latest activity time."""
    events, names, pending, last_at = [], {}, {}, None
    for line in raw.splitlines():
        if not line.startswith(b'{') or line.startswith(b'{"type":"api-request'):
            continue
        try:
            row = json.loads(line)
            kind, message = row.get('type'), row['message']
            at = stamp(row.get('timestamp'))
        except (ValueError, TypeError, AttributeError, KeyError):
            continue
        if kind not in ('assistant', 'user') or not isinstance(message, dict) or at is None \
                or not now - DAY_MS <= at <= now + 5000:
            continue
        mark = {'subagent': True} if subagent or row.get('isSidechain') is True else {}
        last_at = at if last_at is None else max(last_at, at)
        content = message.get('content')
        blocks = content if isinstance(content, list) else []
        if kind == 'assistant':
            # Synthetic rows record API failures; the Pi reader skips errors too.
            if row.get('isApiErrorMessage') or message.get('model') == '<synthetic>':
                continue
            text = project_text(blocks)
            if text:
                events.append({'at': at, 'kind': 'progress', 'text': text, **mark})
            for block in blocks:
                if isinstance(block, dict) and block.get('type') == 'tool_use' and isinstance(block.get('id'), str):
                    names[block['id']] = block.get('name')
                    if block.get('name') not in SUBAGENT_TOOLS:
                        pending[block['id']] = at
            if message.get('stop_reason') == 'end_turn':
                pending.clear()
            continue
        result = [block for block in blocks if isinstance(block, dict) and block.get('type') == 'tool_result']
        status = notice_status(row)
        if status:
            events.append({'at': at, 'kind': 'tool', 'tool': 'subagent', 'failed': status != 'completed',
                           'phase': 'finished', **mark})
        elif not result and not row.get('isMeta'):
            pending.clear()  # A new prompt starts a new turn.
        launched = row.get('toolUseResult')
        for block in result:
            call = block.get('tool_use_id')
            pending.pop(call, None)
            name, failed = names.get(call), block.get('is_error') is True
            if name in TOOLS:
                events.append({'at': at, 'kind': 'tool', 'tool': TOOLS[name], 'failed': failed, **mark})
            elif name in SUBAGENT_TOOLS:
                started = not failed and isinstance(launched, dict) and launched.get('status') == 'async_launched'
                events.append({'at': at, 'kind': 'tool', 'tool': 'subagent', 'failed': failed,
                               'phase': 'started' if started else 'finished', **mark})
    open_since = [started for started in pending.values() if 0 <= now - started <= PENDING_MAX_MS]
    return {'events': events, 'open': len(open_since), 'since': min(open_since, default=None), 'last': last_at}


class ClaudeSessionReader:
    """Read the configured session's transcript and its subagent transcripts."""

    def __init__(self, directory, read, project_text, root=None):
        self.directory = directory
        self.read = read
        self.project_text = project_text
        self.root = Path(root) if root else directory / 'worker/claude/projects'

    def _main(self):
        config = json.loads(self.read(self.directory / 'config.json', 65536))
        session = str(config.get('sessionId', ''))
        if not SESSION.fullmatch(session):
            return None
        found = []
        for path in self.root.glob(f'*/{session}.jsonl'):
            try:
                found.append((path.lstat().st_mtime_ns, path))
            except OSError:
                continue
        return max(found)[1] if found else None

    def _subagents(self, main, now):
        found = []
        try:
            with os.scandir(main.parent / main.stem / 'subagents') as entries:
                for entry in entries:
                    if SUBAGENT_FILE.fullmatch(entry.name) and entry.is_file(follow_symlinks=False):
                        modified = entry.stat(follow_symlinks=False).st_mtime_ns // 1000000
                        if now - DAY_MS <= modified:
                            found.append((modified, Path(entry.path)))
        except OSError:
            return []
        return [path for _, path in sorted(found)[-MAX_SUBAGENTS:]]

    def load(self, now):
        main = self._main()
        if main is None:
            return {'events': [], 'open': 0, 'since': None, 'last': None}
        parts = [parse(self.read(main, MAIN_LIMIT), self.project_text, now)]
        for path in self._subagents(main, now):
            try:
                # Subagent files follow the builder's umask, so group read is tolerated.
                raw = self.read(path, SUBAGENT_LIMIT, shared_read=True)
            except (OSError, ValueError):
                continue
            parts.append(parse(raw, self.project_text, now, subagent=True))
        events = sorted((event for part in parts for event in part['events']), key=lambda event: event['at'])
        since = [part['since'] for part in parts if part['since'] is not None]
        last = [part['last'] for part in parts if part['last'] is not None]
        return {'events': events[-40:], 'open': sum(part['open'] for part in parts),
                'since': min(since, default=None), 'last': max(last, default=None)}

    def events(self, now):
        return self.load(now)['events']

    def activity(self, now):
        """Uptime signals: unfinished tool count, oldest start and latest row time (ms)."""
        state = self.load(now)
        return {'openTools': state['open'], 'openSince': state['since'], 'lastAt': state['last']}
