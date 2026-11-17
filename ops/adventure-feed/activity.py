"""Project activity from the owner's existing Amazing Adventure run."""
import argparse
import datetime
import json
import os
from pathlib import Path
import re
import ssl
import stat
import time
import urllib.request

STATE = Path.home() / '.local/state/usegrunt-adventure'
POOL = 'http://127.0.0.1:8793/v1/status'
RECEIVER = 'https://milo-gateway.fly.dev/admin/ingest/activity'
TOOLS = {'read', 'write', 'edit', 'bash'}
PHASES = {'starting', 'working', 'checkpoint', 'waiting_for_free_pool', 'stopped'}
ERRORS = {'not_installed', 'logged_out', 'quota', 'timeout', 'upstream', 'refused', 'cancelled'}
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


def private_tail(path, limit):
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
            stream.seek(-limit, os.SEEK_END)
            stream.readline(limit)
        return stream.read(limit)


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


def ask(url, **kwargs):
    with HTTP.open(urllib.request.Request(url, **kwargs), timeout=8) as response:
        return json.loads(response.read(131073))


def snapshot(state=STATE):
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
        if isinstance(model, str) and MODEL.fullmatch(model) and '://' not in model:
            provider['model'] = model
        if row.get('state') == 'answering' and row.get('active', 0) > 0:
            result['active'].append(provider)
        at = row.get('lastSuccessAt')
        if type(at) is int and now - 86400000 <= at <= now + 5000:
            if result['lastReply'] is None or at > result['lastReply']['at']:
                result['lastReply'] = {**provider, 'at': at}
        if row.get('errorCode') in ERRORS:
            result['issues'].append({**provider, 'error': row['errorCode']})
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
    delay = 0
    while True:
        try:
            data = snapshot()
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
