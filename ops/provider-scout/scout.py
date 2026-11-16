#!/usr/bin/env python3
"""Operator-only, twice-daily provider research and qualification queue."""
import argparse
import collections
import contextlib
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import threading
import time
from urllib.parse import urlsplit

BEGIN = '# BEGIN usegrunt-provider-scout'
END = '# END usegrunt-provider-scout'
UTC = dt.timezone.utc


def now():
    return dt.datetime.now(UTC).isoformat()


def private_directory(path):
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise ValueError('Scout state must be a private owned directory')


def atomic(path, value):
    descriptor, name = tempfile.mkstemp(prefix=path.name + '.', suffix='.tmp', dir=path.parent)
    temporary = Path(name)
    try:
        with os.fdopen(descriptor, 'w') as file:
            json.dump(value, file, indent=2)
            file.write('\n')
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def load(path, default=None):
    if not path.exists():
        return default
    if path.is_symlink() or path.stat().st_size > 2 * 1024 * 1024:
        raise ValueError('Unsafe scout state file')
    return json.loads(path.read_text())


def public_url(value):
    if not isinstance(value, str) or len(value) > 2048:
        return False
    parsed = urlsplit(value)
    return parsed.scheme == 'https' and bool(parsed.hostname) and not any((parsed.username, parsed.password, parsed.query, parsed.fragment))


def candidate_id(candidate):
    value = [urlsplit(candidate['homepage']).hostname.lower(), candidate['model'].strip().lower()]
    return hashlib.sha256(json.dumps(value).encode()).hexdigest()[:24]


def ready_evidence(candidate, workspace):
    probe = candidate['probe']
    if not isinstance(probe.get('evidence_file'), str):
        return False
    path = workspace / probe['evidence_file']
    if path.is_symlink() or not path.resolve().is_relative_to(workspace.resolve()):
        return False
    try:
        info = path.stat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600 or info.st_size > 131072:
            return False
        proof = load(path)
        observed = dt.datetime.fromisoformat(proof['observed_at'].replace('Z', '+00:00'))
        age = (dt.datetime.now(UTC) - observed).total_seconds()
        return (0 <= age < 48 * 3600 and proof.get('version') == 1 and proof.get('model') == candidate['model']
                and proof.get('source_id') == probe['source_id'] and bool(probe['source_id'])
                and proof.get('http_status') == probe['http_status'] == 200
                and all(proof.get(key) is True and probe.get(key) is True for key in
                        ('reply_received', 'attribution_verified', 'tool_call_verified', 'free_guard_verified')))
    except (OSError, ValueError, TypeError, KeyError):
        return False


def qualify(candidate, workspace, smoke=False):
    # A model's requested status cannot bypass the operator's eligibility gates.
    if not public_url(candidate['homepage']) or not candidate['primary_sources'] or not all(public_url(url) for url in candidate['primary_sources']):
        raise ValueError('Candidate needs public primary-source URLs')
    if candidate['proposal_url'] is not None and not public_url(candidate['proposal_url']):
        raise ValueError('Unsafe proposal URL')
    failed = (candidate['free_access'] == 'one_time' or candidate['quality'] == 'below_baseline'
              or candidate['signup_friction'] == 'high'
              or candidate['context_tokens'] is not None and candidate['context_tokens'] < 200000)
    if failed:
        return 'rejected'
    eligible = (candidate['free_access'] == 'recurring' and candidate['quality'] in ('target', 'above_baseline')
                and isinstance(candidate['context_tokens'], int) and candidate['context_tokens'] >= 200000
                and candidate['signup_friction'] in ('low', 'human_approval'))
    if smoke or not eligible:
        return 'researched' if candidate['status'] != 'rejected' else 'rejected'
    if candidate['status'] == 'ready_for_review':
        if candidate['setup_status'] not in ('anonymous', 'reused', 'signed_up'):
            return 'needs_approval' if candidate['setup_status'] == 'approval_needed' else 'integration_pending'
        return 'ready_for_review' if ready_evidence(candidate, workspace) else 'integration_pending'
    return candidate['status']


def ingest(report, ledger, workspace, smoke=False):
    if not isinstance(report, dict) or report.get('web_search_used') is not True or len(report.get('search_queries', [])) < 2:
        raise ValueError('Scout must complete actual web research')
    candidates = report.get('candidates')
    if not isinstance(candidates, list) or len(candidates) > (3 if smoke else 20):
        raise ValueError('Candidate budget exceeded')
    updated = json.loads(json.dumps(ledger))
    stamp = now()
    for candidate in candidates:
        status = qualify(candidate, workspace, smoke)
        key = candidate_id(candidate)
        old = updated['candidates'].get(key, {})
        updated['candidates'][key] = {**candidate, 'status': status, 'first_seen': old.get('first_seen', stamp),
                                      'last_seen': stamp, 'sightings': old.get('sightings', 0) + 1}
    return updated


def normalized_report(report, ledger):
    candidates = [{**item, 'status': ledger['candidates'][candidate_id(item)]['status']} for item in report['candidates']]
    changed = sum(old['status'] != new['status'] for old, new in zip(report['candidates'], candidates))
    summary = report['summary']
    if changed:
        ready = sum(item['status'] == 'ready_for_review' for item in candidates)
        summary = f'Operator validation adjusted {changed} candidate statuses; {len(candidates)} reviewed, {ready} ready for review.'
    return {**report, 'summary': summary, 'candidates': candidates}


def cron_text(existing, command):
    if existing.count(BEGIN) != existing.count(END) or existing.count(BEGIN) > 1:
        raise ValueError('Ambiguous scout crontab block')
    if BEGIN in existing:
        start = existing.index(BEGIN)
        finish = existing.index(END, start) + len(END)
        if existing[finish:finish + 1] == '\n':
            finish += 1
        existing = existing[:start] + existing[finish:]
    return existing.rstrip('\n') + '\n\n' + BEGIN + '\n# 09:00 and 21:00 America/New_York (server timezone)\n0 9,21 * * * ' + command + '\n' + END + '\n'


def install(root, source_repo):
    zone = subprocess.check_output(['timedatectl', 'show', '-p', 'Timezone', '--value'], text=True).strip()
    if zone != 'America/New_York':
        raise ValueError('This operator schedule requires the server timezone America/New_York')
    private_directory(root)
    target = Path.home() / '.local/lib/usegrunt-scout'
    private_directory(target)
    for name in ('scout.py', 'POLICY.md', 'report.schema.json'):
        if (target / name).is_symlink():
            raise ValueError('Unsafe installed scout file')
        if (Path(__file__).parent / name).resolve() != (target / name).resolve():
            shutil.copyfile(Path(__file__).parent / name, target / name)
        (target / name).chmod(0o600)
    codex = shutil.which('codex')
    if not codex or not shutil.which('timeout'):
        raise ValueError('Codex sign-in and GNU timeout are required before scheduling the scout')
    workspace = root / 'workspace'
    private_directory(workspace)
    private_directory(root / 'runs')
    private_directory(root / 'reports')
    remote = subprocess.check_output(['git', '-C', str(source_repo), 'remote', 'get-url', 'origin'], text=True).strip()
    if remote != 'https://github.com/bananaman614305/milo.git':
        raise ValueError('Unexpected source repository; no schedule was installed')
    checkout = workspace / 'repo'
    if not checkout.exists():
        subprocess.run(['git', 'clone', '--depth=1', remote, str(checkout)], check=True, capture_output=True, timeout=120)
    atomic(root / 'config.json', {'version': 1, 'codex': codex, 'source_repo': str(source_repo.resolve()),
                                 'workspace': str(workspace), 'timeout_seconds': 2700, 'timezone': zone})
    if not (root / 'ledger.json').exists():
        atomic(root / 'ledger.json', {'version': 1, 'candidates': {}})
    (root / 'cron.log').touch(mode=0o600, exist_ok=True)
    wrapper = Path.home() / '.local/bin/usegrunt-scout'
    wrapper.write_text('#!/bin/sh\nexec ' + shlex.join([sys.executable, str(target / 'scout.py'), '--state', str(root)]) + ' "$@"\n')
    wrapper.chmod(0o700)
    read = subprocess.run(['crontab', '-l'], capture_output=True, text=True)
    if read.returncode not in (0, 1) or read.returncode == 1 and 'no crontab' not in read.stderr:
        raise ValueError('Could not safely read existing crontab')
    previous = read.stdout
    command = shlex.join([sys.executable, str(target / 'scout.py'), '--state', str(root), 'run'])
    command += ' >> ' + shlex.quote(str(root / 'cron.log')) + ' 2>&1'
    if '%' in command:
        raise ValueError('Unsupported percent character in cron path')
    updated = cron_text(previous, command)
    if subprocess.run(['crontab', '-l'], capture_output=True, text=True).stdout != previous:
        raise ValueError('Crontab changed during install; retry without overwriting it')
    atomic(root / 'crontab-backup.json', {'saved_at': now(), 'content': previous})
    subprocess.run(['crontab', '-'], input=updated, text=True, check=True, capture_output=True)
    if subprocess.check_output(['crontab', '-l'], text=True) != updated:
        raise ValueError('Scheduled crontab verification failed')
    print(json.dumps({'installed': True, 'schedule': '09:00 and 21:00 America/New_York', 'command': str(wrapper)}))


def stop_worker(worker):
    if worker.poll() is not None:
        return
    try:
        os.killpg(worker.pid, signal.SIGTERM)
    except ProcessLookupError:
        worker.wait()
        return
    try:
        worker.wait(timeout=10)
    except subprocess.TimeoutExpired:
        with contextlib.suppress(ProcessLookupError):
            os.killpg(worker.pid, signal.SIGKILL)
        worker.wait()


def run(root, smoke=False):
    private_directory(root)
    lock_fd = os.open(root / 'run.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(lock_fd, 'w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print(json.dumps({'status': 'skipped', 'reason': 'scout already running'}))
            return 0
        config = load(root / 'config.json')
        workspace = Path(config['workspace'])
        private_directory(workspace)
        stamp = dt.datetime.now(UTC).strftime('%Y%m%dT%H%M%S%fZ')
        directory = root / 'runs' / stamp
        private_directory(directory)
        state = {'id': stamp, 'started_at': now(), 'status': 'running', 'pid': os.getpid(), 'smoke': smoke}
        atomic(root / 'last-run.json', state)
        ledger = load(root / 'ledger.json', {'version': 1, 'candidates': {}})
        registry = load(Path(config['source_repo']) / 'registry/adapters.json')
        context = {'date_utc': now(), 'smoke': smoke, 'source_repo': config['source_repo'],
                   'workspace': str(workspace), 'curated_registry': registry,
                   'previous_candidates': list(ledger['candidates'].values())[-200:],
                   'max_candidates': 3 if smoke else 20, 'max_signups': 0 if smoke else 2}
        policy = (Path(__file__).parent / 'POLICY.md').read_text()
        prompt = policy + '\n\n## This run\n' + json.dumps(context, indent=2)
        output = directory / 'result.json'
        duration = min(config['timeout_seconds'], 900) if smoke else config['timeout_seconds']
        args = [shutil.which('timeout') or '/usr/bin/timeout', '--signal=TERM', '--kill-after=10s', str(duration),
                config['codex'], '--no-daemon', '--search', '-a', 'never', '-c', 'sandbox_workspace_write.network_access=true',
                '-c', 'sandbox_workspace_write.writable_roots=[]',
                'exec', '--sandbox', 'workspace-write', '--ephemeral', '--skip-git-repo-check', '--trust',
                '-C', str(workspace), '--json',
                '--output-schema', str(Path(__file__).parent / 'report.schema.json'),
                '--output-last-message', str(output), '-']
        # Keep inherited secrets out of the agent's subprocess environment.
        allowed = {'HOME', 'PATH', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TERM', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'CODEX_HOME'}
        env = {key: value for key, value in os.environ.items() if key in allowed}
        env['PATH'] = str(Path.home() / '.local/bin') + ':/usr/local/bin:/usr/bin:/bin'
        counts = collections.Counter()
        worker = None
        reader = None
        previous_handlers = {}
        try:
            worker = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                      text=True, env=env, start_new_session=True, pass_fds=(lock.fileno(),))
            state['worker_pid'] = worker.pid
            atomic(root / 'last-run.json', state)

            def consume():
                for line in iter(lambda: worker.stdout.readline(1024 * 1024 + 1), ''):
                    if len(line) > 1024 * 1024:
                        continue
                    try:
                        event = json.loads(line)
                        kind = event.get('item', {}).get('type', '')
                        if event.get('type') == 'item.completed' and re.fullmatch('[a-z_]{1,64}', kind):
                            counts[kind] += 1
                    except (ValueError, TypeError, AttributeError):
                        pass

            reader = threading.Thread(target=consume, daemon=True)
            reader.start()
            def cancel(*_):
                raise InterruptedError()

            for number in (signal.SIGTERM, signal.SIGINT):
                previous_handlers[number] = signal.signal(number, cancel)
            worker.stdin.write(prompt)
            worker.stdin.close()
            deadline = time.monotonic() + duration
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise subprocess.TimeoutExpired(args, duration)
                try:
                    code = worker.wait(timeout=min(10, remaining))
                    break
                except subprocess.TimeoutExpired:
                    state.update(heartbeat_at=now(), tool_counts=dict(counts))
                    atomic(root / 'last-run.json', state)
            reader.join(timeout=5)
            if code in (124, 137):
                raise subprocess.TimeoutExpired(args, duration)
            if code != 0:
                raise ValueError('Codex worker failed; check its login and tool availability')
            if not any(counts[key] for key in ('web_search', 'web_search_call')):
                raise ValueError('No completed live web search was observed')
            report = load(output)
            updated = ingest(report, ledger, workspace, smoke)
            report = normalized_report(report, updated)
            atomic(root / 'ledger.json', updated)
            state.update(status='completed', summary=report['summary'], candidates_seen=len(report['candidates']),
                         ready_for_review=sum(value['status'] == 'ready_for_review' for value in updated['candidates'].values()),
                         blockers=report['blockers'], tool_counts=dict(counts), report=str(root / 'reports' / (stamp + '.json')))
            atomic(root / 'reports' / (stamp + '.json'), {**report, 'operator_status': state})
        except subprocess.TimeoutExpired:
            state.update(status='failed', reason='worker timeout')
        except InterruptedError:
            state.update(status='cancelled', reason='operator or service signal')
        except (ValueError, OSError, KeyError, TypeError):
            state.update(status='failed', reason='worker, output or evidence validation failed', tool_counts=dict(counts))
        finally:
            if worker is not None:
                stop_worker(worker)
                if reader is not None:
                    reader.join(timeout=5)
                worker.stdout.close()
                with contextlib.suppress(BrokenPipeError):
                    worker.stdin.close()
            for number, handler in previous_handlers.items():
                signal.signal(number, handler)
            state['finished_at'] = now()
            atomic(root / 'last-run.json', state)
            if output.exists():
                output.chmod(0o600)
        print(json.dumps(state))
        return 0 if state['status'] == 'completed' else 1


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--state', type=Path, default=Path.home() / '.local/state/usegrunt-scout')
    commands = parser.add_subparsers(dest='command', required=True)
    setup = commands.add_parser('install')
    setup.add_argument('--source-repo', type=Path, required=True)
    check = commands.add_parser('run')
    check.add_argument('--smoke', action='store_true', help='Live research only; no signups, inference or code changes')
    commands.add_parser('status')
    options = parser.parse_args()
    if options.command == 'install':
        install(options.state, options.source_repo)
        return 0
    if options.command == 'status':
        print(json.dumps({'schedule': '09:00 and 21:00 America/New_York', 'last_run': load(options.state / 'last-run.json'),
                          'candidates': len(load(options.state / 'ledger.json', {'candidates': {}})['candidates'])}, indent=2))
        return 0
    try:
        return run(options.state, options.smoke)
    except (OSError, ValueError, TypeError, KeyError):
        state = {'status': 'failed', 'finished_at': now(), 'reason': 'scout configuration or private state is invalid'}
        try:
            private_directory(options.state)
            atomic(options.state / 'last-run.json', state)
        except (OSError, ValueError):
            pass
        print(json.dumps(state))
        return 1


if __name__ == '__main__':
    sys.exit(main())
