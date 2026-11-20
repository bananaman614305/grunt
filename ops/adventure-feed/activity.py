"""Project activity from the owner's existing Amazing Adventure run."""
import argparse
import datetime
import json
import os
from pathlib import Path
import re
import ssl
import stat
import threading
import time
import urllib.request

STATE = Path.home() / '.local/state/usegrunt-adventure'
POOL = 'http://127.0.0.1:8793/v1/status'
RECEIVER = 'https://milo-gateway.fly.dev/admin/ingest/activity'
PROJECT = Path.home() / 'projects/amazing-adventure'
PULL_REQUESTS = 'https://api.github.com/repos/bananaman614305/amazing-adventure/pulls?state=all&sort=updated&direction=desc&per_page=6'
MILESTONE_REFRESH = 240
MILESTONE_STALE = 3600
_milestone_cache = {'poll_at': float('-inf'), 'received_at': float('-inf'), 'rows': []}
TOOLS = {'read', 'write', 'edit', 'bash'}
PHASES = {'starting', 'working', 'checkpoint', 'waiting_for_free_pool', 'stopped'}
ERRORS = {'not_installed', 'logged_out', 'quota', 'timeout', 'upstream', 'refused', 'cancelled'}
ISSUE_STATES = {'available', 'limited', 'error', 'unavailable'}
PROVIDER = re.compile(r'[a-z][a-z0-9-]{0,63}')
MODEL = re.compile(r'[A-Za-z0-9][A-Za-z0-9._:/+ -]{0,159}')
SENSITIVE = re.compile(
    r'https?://|vault:|/home/|/tmp/|/worker/|/root/|/proc/|/etc/|file:|'
    r'\b(?:bearer|password|secret|credential|api[ _-]?key|access[ _-]?token|'
    r'refresh[ _-]?token|cookie|private[ _-]?key|authorization)\b|'
    r'\b(?:sk-|gh[pousr]_|AKIA|GOCSPX-|AIza)[\w-]+|'
    r'[\w.+-]+@[\w.-]+\.[a-z]{2,}|[A-Za-z0-9_+/=-]{32,}', re.I)
MARKUP = re.compile(r'[<>]|^\s*(?:[{}\[\]$>]|//|[+-]{3}|'
                    r'(?:export|const|let|var|function|import|curl|sudo|git|npm|node)\s+)')


def progress_text(content):
    """Use only visible assistant text blocks from completed messages."""
    parts = []
    for block in content if isinstance(content, list) else []:
        if not isinstance(block, dict) or block.get('type') != 'text':
            continue
        text = block.get('text')
        if not isinstance(text, str):
            continue
        text = re.sub(r'\x60{3}[\s\S]*?(?:\x60{3}|$)|~~~[\s\S]*?(?:~~~|$)|\x60[^\x60\n]*\x60', '', text)
        if '<' in text or '>' in text:
            continue
        for line in text.splitlines()[:40]:
            line = ' '.join(line.strip().split())
            if (line and not SENSITIVE.search(line) and not MARKUP.search(line)
                    and not any(ord(char) < 32 or 127 <= ord(char) <= 159 or 0x202a <= ord(char) <= 0x202e
                                or 0x2066 <= ord(char) <= 0x2069 for char in line)):
                parts.append(line)
    return ' '.join(parts)[:400].strip()


def private_tail(path, limit, *, checkpoint=False):
    # Open each component by descriptor so a worker cannot redirect a
    # concurrent read through a replaced directory or a symbolic link.
    directory = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in path.absolute().parts[1:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = child
        fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    finally:
        os.close(directory)
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError('Expected a private runner file')
        if info.st_size > limit:
            if checkpoint:
                raise ValueError('Checkpoint exceeds its size limit')
            stream.seek(-limit, os.SEEK_END)
            stream.readline(limit)
        data = stream.read(limit)
        return (data, info.st_mtime_ns // 1000000) if checkpoint else data


def events(state, now):
    config = json.loads(private_tail(state / 'config.json', 65536))
    session = str(config.get('sessionId', ''))
    if not re.fullmatch(r'[a-f0-9-]{36}', session):
        return []
    paths = sorted((state / 'worker/sessions').glob(f'*_{session}.jsonl'))
    if not paths:
        return []
    rows = []
    for line in private_tail(paths[-1], 1024 * 1024).splitlines():
        try:
            entry = json.loads(line)
            if entry.get('type') != 'message':
                continue
            message = entry['message']
            at = int(datetime.datetime.fromisoformat(entry['timestamp']).timestamp() * 1000)
        except (ValueError, TypeError, AttributeError, KeyError, OverflowError):
            continue
        if not now - 86400000 <= at <= now + 5000 or not isinstance(message, dict):
            continue
        if message.get('role') == 'assistant' and message.get('stopReason') not in ('error', 'aborted'):
            text = progress_text(message.get('content'))
            if text:
                rows.append({'at': at, 'kind': 'progress', 'text': text})
        if message.get('role') == 'toolResult' and message.get('toolName') in ('read', 'write', 'edit', 'bash'):
            rows.append({'at': at, 'kind': 'tool', 'tool': message['toolName'],
                         'failed': message.get('isError') is True})
    return rows[-40:]


class Direct(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


HTTP = urllib.request.build_opener(urllib.request.ProxyHandler({}), Direct(),
                                   urllib.request.HTTPSHandler(context=ssl.create_default_context()))


def ask(url, *, limit=131072, timeout=8, **kwargs):
    with HTTP.open(urllib.request.Request(url, **kwargs), timeout=timeout) as response:
        data = response.read(limit + 1)
        if len(data) > limit:
            raise ValueError('Response exceeds its size limit')
        return json.loads(data)


def clean_summary(value):
    return progress_text([{'type': 'text', 'text': value}])


def project_checkpoint(raw, at):
    # Match Grunt's standing checkpoint format. Other sections are omitted.
    sections = {}
    heading = None
    fenced = None
    for line in raw.splitlines():
        fence = re.match(r'^\s*(\x60{3,}|~{3,})', line)
        if fence:
            marker = fence.group(1)[0]
            fenced = marker if fenced is None else None if marker == fenced else fenced
            continue
        if fenced:
            continue
        name = re.match(r'^#{1,6}\s+(.+?)\s*$', line)
        if name:
            heading = name.group(1).strip().lower()
            sections.setdefault(heading, [])
        elif heading is not None:
            sections[heading].append(line)
    current = next((clean_summary('\n'.join(lines)) for name, lines in sections.items()
                    if re.match(r'^current (task|work)\b', name)), '')
    next_lines = next((lines for name, lines in sections.items()
                       if re.match(r'^next (tasks?|steps?|up)\b', name)), [])
    # Group indented continuation lines with their list item.
    groups = []
    for line in next_lines:
        item = re.match(r'^\s*(?:[-*+]|\d+[.\)])\s+(.+)$', line)
        if item:
            groups.append([item.group(1)])
        elif line.strip():
            if not groups:
                groups.append([])
            groups[-1].append(line)
    steps = [clean_summary('\n'.join(group)) for group in groups]
    result = {'at': at, 'next': [step for step in steps if step][:3]}
    if current:
        result['summary'] = current
    return result if current or result['next'] else None


def checkpoint(path, now):
    try:
        raw, at = private_tail(path, 32768, checkpoint=True)
        if now - 30 * 86400000 <= at <= now + 5000:
            return project_checkpoint(raw.decode('utf-8'), at)
    except (OSError, ValueError):
        return None
    return None


def project_pulls(value):
    if not isinstance(value, list):
        raise ValueError('Expected pull requests')
    rows = []
    for raw in value[:6]:
        if not isinstance(raw, dict):
            continue
        number = raw.get('number')
        title = clean_summary(raw.get('title'))[:160].strip()
        if type(number) is not int or not 0 < number <= 1000000 or not title:
            continue
        if raw.get('merged_at'):
            status, date = 'merged', raw.get('merged_at')
        elif raw.get('state') == 'closed':
            status, date = 'closed', raw.get('closed_at')
        elif raw.get('state') == 'open':
            status, date = ('draft' if raw.get('draft') is True else 'review'), raw.get('created_at')
        else:
            continue
        try:
            timestamp = datetime.datetime.fromisoformat(date)
            if not timestamp.tzinfo:
                continue
            at = int(timestamp.timestamp() * 1000)
        except (ValueError, TypeError, OverflowError):
            continue
        rows.append({'number': number, 'title': title, 'status': status, 'at': at})
    return sorted(rows, key=lambda row: row['at'], reverse=True)[:4]


def milestones():
    now = time.monotonic()
    if now - _milestone_cache['poll_at'] >= MILESTONE_REFRESH:
        _milestone_cache['poll_at'] = now
        try:
            rows = project_pulls(ask(PULL_REQUESTS, limit=262144, timeout=3,
                                 headers={'Accept': 'application/vnd.github+json',
                                          'User-Agent': 'grunt-project-status'}))
            _milestone_cache.update(received_at=now, rows=rows)
        except (OSError, ValueError):
            pass
    return _milestone_cache['rows'] if now - _milestone_cache['received_at'] <= MILESTONE_STALE else []


def snapshot(state=STATE, *, include_project=False):
    now = int(time.time() * 1000)
    try:
        history = events(state, now)
    except (OSError, ValueError):
        history = []
    try:
        status = json.loads(private_tail(state / 'status.json', 65536))
    except (OSError, ValueError):
        status = {}
    try:
        sources = ask(POOL)['sources']
        pool_online = True
    except (OSError, ValueError, KeyError):
        sources = []
        pool_online = False
    phase = status.get('phase')
    result = {'version': 1, 'observedAt': now,
              'phase': phase if phase in PHASES and pool_online else 'offline',
              'active': [], 'lastReply': None, 'issues': [], 'events': history}
    for row in sources:
        source = row.get('id', '')
        if not isinstance(source, str) or not PROVIDER.fullmatch(source):
            continue
        provider = {'source': source}
        model = row.get('model')
        # Match the receiver's secret filter: omit only the optional label,
        # so one secret-shaped model name cannot reject the whole live feed.
        if isinstance(model, str) and MODEL.fullmatch(model) and not SENSITIVE.search(model):
            provider['model'] = model
        if row.get('state') == 'answering' and row.get('active', 0) > 0:
            result['active'].append(provider)
        at = row.get('lastSuccessAt')
        if type(at) is int and now - 86400000 <= at <= now + 5000:
            if result['lastReply'] is None or at > result['lastReply']['at']:
                result['lastReply'] = {**provider, 'at': at}
        if row.get('errorCode') in ERRORS and row.get('state') in ISSUE_STATES:
            result['issues'].append({**provider, 'error': row['errorCode'], 'state': row['state']})
    if include_project:
        recent_milestones = [row for row in milestones() if 0 < row['at'] <= now + 5000]
        project = {'milestones': recent_milestones}
        report = checkpoint(PROJECT / 'GRUNT_STATUS.md', now)
        if report:
            project['checkpoint'] = report
        result['project'] = project
    return result


def watch():
    seen = set()
    prior = None
    while True:
        data = snapshot()
        route = (data['phase'], tuple(x['source'] for x in data['active']),
                 (data['lastReply'] or {}).get('source'),
                 tuple((x['source'], x['error']) for x in data['issues']))
        if route != prior:
            phase, active, last, issues = route
            print(f"{phase.replace('_', ' ')} · answering {', '.join(active) or '—'} · last reply {last or '—'}", flush=True)
            for source, error in issues:
                if prior is None or (source, error) not in prior[3]:
                    print(f'  {source} · {error.replace("_", " ")}', flush=True)
        history = data['events']
        for i, event in enumerate(history):
            key = (event['at'], event['kind'], event.get('text'), event.get('tool'))
            if key not in seen and (prior is not None or i >= len(history) - 12):
                stamp = time.strftime('%H:%M:%S', time.localtime(event['at'] / 1000))
                detail = event['text'] if event['kind'] == 'progress' else (
                    f"{event['tool']} {'failed' if event['failed'] else 'finished'}")
                print(f'{stamp}  {detail}', flush=True)
            seen.add(key)
        if len(seen) > 4000:
            seen = {key for key in seen if key[0] >= data['observedAt'] - 3600000}
        prior = route
        time.sleep(2)


def upload():
    # This mode runs only as a separate, explicitly enabled owner service.
    key = os.environ['GRUNT_ADMIN_INGEST_KEY']
    instance = os.environ['GRUNT_ADMIN_INSTANCE_ID']
    if not re.fullmatch(r'[A-Za-z0-9_-]{32,128}', key) or not PROVIDER.fullmatch(instance):
        raise ValueError('Invalid activity upload configuration')
    from uptime import WorkMeter, WorkProbe
    meter = WorkMeter(WorkProbe(STATE, private_tail, lambda: ask(POOL, timeout=2)), STATE / 'uptime' / 'work.sqlite3')
    threading.Thread(target=meter.run, name='grunt-work-meter', daemon=True).start()
    delay = 0
    while True:
        try:
            work = meter.latest
            data = snapshot(include_project=True)
            if work and 0 <= data['observedAt'] - work['at'] <= 15000:
                data['work'] = work
            answer = ask(RECEIVER, method='POST', headers={'Authorization': 'Bearer ' + key,
                         'Content-Type': 'application/json'},
                         data=json.dumps({'instanceId': instance, 'activity': data}).encode())
            if answer.get('accepted') is not True:
                raise ValueError('Activity upload was not acknowledged')
            if delay != 6:
                print('Grunt activity upload connected', flush=True)
            delay = 6
        except (OSError, ValueError):
            if delay <= 6:
                print('Grunt activity upload unavailable. Retrying.', flush=True)
            delay = min(60, max(12, delay * 2))
        time.sleep(delay)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=['snapshot', 'watch', 'upload'])
    mode = parser.parse_args().mode
    if mode == 'snapshot':
        print(json.dumps(snapshot(), ensure_ascii=False))
    elif mode == 'watch':
        watch()
    else:
        upload()


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        pass
    except (OSError, ValueError, KeyError):
        raise SystemExit('Grunt activity is unavailable. Check the private runner state.')
