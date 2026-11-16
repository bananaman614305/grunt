#!/usr/bin/env python3
"""Operator-only, twice-daily discovery, qualification and guarded release."""
import argparse
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
import time
from urllib.parse import urlsplit

from worker import WorkerError, run_agent

BEGIN = '# BEGIN usegrunt-provider-scout'
END = '# END usegrunt-provider-scout'
UTC = dt.timezone.utc
REPOSITORY = 'bananaman614305/grunt'
ORIGIN = 'https://github.com/' + REPOSITORY + '.git'
# Explicit installation-only migration allowlist. New fetches/clones use Grunt.
LEGACY_ORIGINS = frozenset({'https://github.com/bananaman614305/milo.git'})


class ScoutCancelled(BaseException):
    """Cancellation must cross controller exception-to-blocked handlers."""


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
        return 'ready_for_review' if isinstance(candidate.get('release_request'), dict) and ready_evidence(candidate, workspace) else 'integration_pending'
    return candidate['status']


def ingest(report, ledger, workspace, smoke=False):
    if not isinstance(report, dict) or report.get('web_search_used') is not True or len(report.get('search_queries', [])) < 2:
        raise ValueError('Scout must complete actual web research')
    candidates = report.get('candidates')
    if not isinstance(candidates, list) or len(candidates) > (3 if smoke else 20):
        raise ValueError('Candidate budget exceeded')
    requests = [item for item in candidates if item.get('release_request') is not None]
    if len(requests) > (0 if smoke else 1):
        raise ValueError('Integration budget exceeded')
    updated = json.loads(json.dumps(ledger))
    stamp = now()
    for candidate in candidates:
        status = qualify(candidate, workspace, smoke)
        key = candidate_id(candidate)
        old = updated['candidates'].get(key, {})
        lifecycle = {name: value for name, value in old.items() if name.startswith('pipeline_')}
        updated['candidates'][key] = {**candidate, **lifecycle, 'status': status, 'first_seen': old.get('first_seen', stamp),
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
    modules = [path.name for path in Path(__file__).parent.iterdir()
               if path.suffix in ('.py', '.mjs') and not path.name.startswith('test_')]
    for name in [*modules, 'POLICY.md', 'report.schema.json']:
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
    if remote != ORIGIN and remote not in LEGACY_ORIGINS:
        raise ValueError('Unexpected source repository; no schedule was installed')
    checkout = workspace / 'repo'
    if not checkout.exists():
        subprocess.run(['git', 'clone', '--depth=1', ORIGIN, str(checkout)], check=True, capture_output=True, timeout=120)
    config = load(root / 'config.json', {})
    config.update(version=2, codex=codex, source_repo=str(source_repo.resolve()),
                  workspace=str(workspace), timezone=zone, repository=REPOSITORY)
    config.setdefault('timeout_seconds', 2700)
    config.setdefault('release_enabled', False)
    config['squire_proxy'] = str(target / 'squire_proxy.py')
    config['provision_helper'] = str(target / 'provision.mjs')
    atomic(root / 'config.json', config)
    if not (root / 'ledger.json').exists():
        atomic(root / 'ledger.json', {'version': 1, 'candidates': {}})
    (root / 'cron.log').touch(mode=0o600, exist_ok=True)
    wrapper = Path.home() / '.local/bin/usegrunt-scout'
    wrapper.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if wrapper.is_symlink():
        raise ValueError('Unsafe installed scout wrapper')
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


def record_pipeline_result(ledger, result, candidate=None):
    """Only trusted controller results may set these durable lifecycle fields."""
    if not isinstance(result, dict):
        raise ValueError('Invalid pipeline result')
    key = candidate_id(candidate) if candidate is not None else result.get('candidate_id')
    source = result.get('source_id')
    head = result.get('head_sha')
    keys = [key] if key in ledger['candidates'] else [
        item_key for item_key, item in ledger['candidates'].items()
        if source and (item.get('release_request') or {}).get('source_id') == source
        and (not head or (item.get('release_request') or {}).get('head_sha') == head)]
    for item_key in keys:
        request = ledger['candidates'][item_key].get('release_request') or {}
        if (source and request.get('source_id') != source) or (head and request.get('head_sha') != head):
            raise ValueError('Pipeline result does not match candidate')
        ledger['candidates'][item_key].update(pipeline_status=result['status'],
                                              pipeline_reason=result.get('reason', ''),
                                              pipeline_updated_at=now())


def refresh_source_main(source_repo, timeout=60):
    """Refresh the canonical tracking ref without changing the source tree."""
    if timeout <= 0:
        raise ValueError('Source refresh budget exhausted')
    executable = shutil.which('gh')
    if not executable or not Path(executable).is_absolute():
        raise ValueError('Trusted GitHub authentication helper is unavailable')
    helper = Path(executable).resolve(strict=True)
    info = helper.stat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid not in (0, os.getuid()) or info.st_mode & 0o022:
        raise ValueError('Trusted GitHub authentication helper is unavailable')
    args = ['git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
            '-c', 'credential.helper=',
            '-c', 'credential.https://github.com.helper=!' + shlex.quote(str(helper)) + ' auth git-credential',
            '-c', 'http.followRedirects=false',
            '-c', 'maintenance.auto=false', '-c', 'gc.auto=0',
            '-C', str(source_repo), 'fetch', '--no-tags', '--no-recurse-submodules',
            '--no-auto-maintenance', '--no-write-fetch-head',
            ORIGIN,
            '+refs/heads/main:refs/remotes/origin/main']
    env = {key: value for key, value in os.environ.items()
           if key in ('HOME', 'PATH', 'LANG', 'LC_ALL')}
    env.update(GIT_CONFIG_GLOBAL='/dev/null', GIT_CONFIG_NOSYSTEM='1', GIT_TERMINAL_PROMPT='0')
    process = None
    try:
        process = subprocess.Popen(args, env=env, stdin=subprocess.DEVNULL,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                   start_new_session=True)
        if process.wait(timeout=min(timeout, 60)) != 0:
            raise ValueError('Canonical source refresh failed')
    except (OSError, subprocess.SubprocessError):
        raise ValueError('Canonical source refresh failed') from None
    finally:
        if process is not None:
            with contextlib.suppress(ProcessLookupError):
                os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                pass
            finally:
                with contextlib.suppress(ProcessLookupError):
                    os.killpg(process.pid, signal.SIGKILL)
                process.wait()


def read_source_snapshot(source_repo, timeout=60):
    """Read registry bytes from the exact fetched main commit, not the tree."""
    deadline = time.monotonic() + min(timeout, 60)
    prefix = ['git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
              '--no-pager', '-C', str(source_repo)]
    env = {key: value for key, value in os.environ.items()
           if key in ('HOME', 'PATH', 'LANG', 'LC_ALL')}
    env.update(GIT_CONFIG_GLOBAL='/dev/null', GIT_CONFIG_NOSYSTEM='1',
               GIT_TERMINAL_PROMPT='0', GIT_NO_REPLACE_OBJECTS='1')

    def read(arguments):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise ValueError('Source snapshot budget exhausted')
        process = None
        try:
            process = subprocess.Popen([*prefix, *arguments], env=env, stdin=subprocess.DEVNULL,
                                       stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                       start_new_session=True)
            output, _ = process.communicate(timeout=min(remaining, 30))
            if process.returncode != 0 or len(output) > 2 * 1024 * 1024:
                raise ValueError('Canonical source snapshot failed')
            return output
        except (OSError, subprocess.SubprocessError):
            raise ValueError('Canonical source snapshot failed') from None
        finally:
            if process is not None:
                with contextlib.suppress(ProcessLookupError):
                    os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    pass
                finally:
                    with contextlib.suppress(ProcessLookupError):
                        os.killpg(process.pid, signal.SIGKILL)
                    process.wait()
                    process.stdout.close()

    head = read(['rev-parse', '--verify', 'refs/remotes/origin/main^{commit}']).decode('ascii').strip()
    if not re.fullmatch(r'[0-9a-f]{40}', head):
        raise ValueError('Canonical source snapshot has no valid commit')
    registry = json.loads(read(['show', head + ':registry/adapters.json']))
    if not isinstance(registry, dict):
        raise ValueError('Canonical registry is invalid')
    return {'base_sha': head, 'registry': registry}


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
        deadline = time.monotonic() + config['timeout_seconds']
        workspace = Path(config['workspace'])
        private_directory(workspace)
        stamp = dt.datetime.now(UTC).strftime('%Y%m%dT%H%M%S%fZ')
        directory = root / 'runs' / stamp
        private_directory(directory)
        state = {'id': stamp, 'started_at': now(), 'status': 'running', 'pid': os.getpid(), 'smoke': smoke}
        atomic(root / 'last-run.json', state)
        ledger = load(root / 'ledger.json', {'version': 1, 'candidates': {}})
        pipeline = None
        resume_consumed = False
        snapshot = None
        output = directory / 'result.json'
        previous_handlers = {}
        def cancel(*_):
            raise ScoutCancelled()
        for number in (signal.SIGTERM, signal.SIGINT):
            previous_handlers[number] = signal.signal(number, cancel)
        try:
            if not smoke and config.get('release_enabled') is True:
                refresh_source_main(config['source_repo'], deadline - time.monotonic())
                snapshot = read_source_snapshot(config['source_repo'], deadline - time.monotonic())
                state['source_main_refreshed_at'] = now()
                from pipeline import Pipeline
                pipeline = Pipeline({**config, '_deadline_monotonic': deadline, '_lock_fd': lock.fileno()}, root)
                state['pipeline_results'] = pipeline.resume_pending()
                for result in state['pipeline_results']:
                    record_pipeline_result(ledger, result)
                resume_consumed = any(result.get('status') != 'superseded' for result in state['pipeline_results'])
                atomic(root / 'ledger.json', ledger)
            registry = snapshot['registry'] if snapshot else load(Path(config['source_repo']) / 'registry/adapters.json')
            context = {'date_utc': now(), 'smoke': smoke, 'source_repo': config['source_repo'],
                       'repository': REPOSITORY,
                       'workspace': str(workspace), 'curated_registry': registry,
                       'base_sha': snapshot['base_sha'] if snapshot else None,
                       'previous_candidates': list(ledger['candidates'].values())[-200:],
                       'max_candidates': 3 if smoke else 20, 'max_signups': 0 if smoke else 2,
                       'max_integrations': 0 if smoke or resume_consumed else 1,
                       'release_enabled': bool(pipeline)}
            policy = (Path(__file__).parent / 'POLICY.md').read_text()
            prompt = policy + '\n\n## This run\n' + json.dumps(context, indent=2)
            duration = min(900 if smoke else 1200, deadline - time.monotonic())
            if duration <= 0:
                raise WorkerError('worker_timeout')

            def progress(value):
                state.update(heartbeat_at=now(), tool_counts=value.get('tool_counts', {}),
                             approval_rejections=value.get('approval_rejections', 0))
                if 'worker_pid' in value:
                    state['worker_pid'] = value['worker_pid']
                atomic(root / 'last-run.json', state)

            result = run_agent({'role': 'implementer', 'prompt': prompt,
                                'schema': load(Path(__file__).parent / 'report.schema.json'),
                                'cwd': str(workspace), 'output_path': str(output),
                                'timeout_seconds': duration, 'lock_fd': lock.fileno(),
                                'smoke': smoke, 'web_search': True, 'require_web_search': True},
                               config, progress)
            report = result['result']
            updated = ingest(report, ledger, workspace, smoke)
            if pipeline is not None and not resume_consumed:
                submitted = [updated['candidates'][candidate_id(item)] for item in report['candidates']]
                eligible = [item for item in submitted
                            if item['status'] == 'ready_for_review' and item.get('release_request')
                            and item.get('pipeline_status') not in ('released', 'publication_pending')]
                if eligible:
                    item = eligible[0]
                    outcome = pipeline.process(item)
                    record_pipeline_result(updated, outcome, item)
                    state.setdefault('pipeline_results', []).append(outcome)
            report = normalized_report(report, updated)
            atomic(root / 'ledger.json', updated)
            state.update(status='completed', summary=report['summary'], candidates_seen=len(report['candidates']),
                         ready_for_review=sum(value['status'] == 'ready_for_review' for value in updated['candidates'].values()),
                         blockers=report['blockers'], tool_counts=result['tool_counts'],
                         approval_rejections=result.get('approval_rejections', 0),
                         report=str(root / 'reports' / (stamp + '.json')))
            atomic(root / 'reports' / (stamp + '.json'), {**report, 'operator_status': state})
        except ScoutCancelled:
            for number in previous_handlers:
                signal.signal(number, signal.SIG_IGN)
            state.update(status='cancelled', reason='operator or service signal')
        except WorkerError as error:
            state.update(status='cancelled' if error.reason == 'worker_cancelled' else 'failed',
                         reason='worker timeout' if error.reason == 'worker_timeout' else error.reason,
                         tool_counts=error.tool_counts)
        except (ValueError, OSError, KeyError, TypeError, ImportError):
            state.update(status='failed', reason='worker, output or pipeline validation failed')
        finally:
            try:
                state['finished_at'] = now()
                atomic(root / 'last-run.json', state)
            finally:
                for number, handler in previous_handlers.items():
                    signal.signal(number, handler)
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
