"""Observe project work on Chad independently of availability of the web feed."""
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import stat
import time

SAMPLE_MS = 5000
MAX_GAP_MS = 15000
DAY_MS = 86400000
TOOL_PROGRESS_MS = 45000
MODEL_PROGRESS_MS = 240000
WORK_TICKS = max(1, os.sysconf('SC_CLK_TCK') // 40) if os.name == 'posix' else 2
STATES = {'working', 'provider_wait', 'between_cycles', 'starting', 'paused', 'offline', 'stalled', 'tool_wait', 'unknown'}
CATEGORIES = ('execution', 'inference', 'tool_wait', 'provider_wait', 'idle', 'blocked')
BREAKDOWN_FIELDS = ('executionMs', 'inferenceMs', 'toolWaitMs', 'providerWaitMs', 'idleMs', 'blockedMs')
LOG_NAME = re.compile(r'cycle-\d{8}T\d{6}Z\.jsonl')
TOOL_WRAPPERS = {'bash', 'sh', 'bwrap', 'timeout', 'sleep', 'tail', 'tee'}
UUID = re.compile(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}', re.I)
WORKER_CODES = ('invalid_task', 'busy', 'cancelled', 'timeout', 'quota', 'unavailable', 'invalid_workspace', 'unsupported_sandbox', 'ownership_violation', 'artifact_conflict', 'limit')
JOB_CATEGORIES = ('test', 'build', 'render', 'download', 'other')


def project_workers(value, now):
    """Allowlist counters/status only. Task text and artifacts never enter the feed."""
    if not isinstance(value, dict):
        return None
    result, seen = {}, set()
    for group, states, limit in [('active', ('running',), 2), ('queued', ('queued',), 16), ('recent', ('completed', 'failed', 'cancelled'), 20)]:
        rows = value.get(group)
        if not isinstance(rows, list) or len(rows) > limit:
            return None
        result[group] = []
        for raw in rows:
            if (not isinstance(raw, dict) or not isinstance(raw.get('id'), str) or not UUID.fullmatch(raw['id'])
                    or raw['id'] in seen or raw.get('state') not in states or type(raw.get('createdAt')) is not int
                    or not 0 <= raw['createdAt'] <= now + 5000):
                return None
            seen.add(raw['id'])
            row = {key: raw[key] for key in ('id', 'state', 'createdAt')}
            for key in ('startedAt', 'finishedAt'):
                if type(raw.get(key)) is int and raw['createdAt'] <= raw[key] <= now + 5000:
                    row[key] = raw[key]
            source = raw.get('source')
            if isinstance(source, str) and re.fullmatch(r'[a-z][a-z0-9-]{0,63}', source):
                row['source'] = source
            if raw.get('activity') in ('review', 'tests', 'implementation', 'research'):
                row['activity'] = raw['activity']
            if raw.get('code') in WORKER_CODES:
                row['code'] = raw['code']
            if raw.get('mode') in ('proposal', 'agent'):
                row['mode'] = raw['mode']
            for key in ('turns', 'toolCalls'):
                if type(raw.get(key)) is int and 0 <= raw[key] <= 10000:
                    row[key] = raw[key]
            for key in ('artifactAvailable', 'waitingForSource'):
                if type(raw.get(key)) is bool:
                    row[key] = raw[key]
            if type(raw.get('nextAttemptAt')) is int and 0 <= raw['nextAttemptAt'] <= now + 35 * DAY_MS:
                row['nextAttemptAt'] = raw['nextAttemptAt']
            caps = raw.get('capabilities')
            if isinstance(caps, dict) and type(caps.get('filesystem')) is bool and type(caps.get('commands')) is bool:
                row['capabilities'] = {key: caps[key] for key in ('filesystem', 'commands')}
                if caps.get('sandbox') in ('bubblewrap', 'filesystem'):
                    row['capabilities']['sandbox'] = caps['sandbox']
            result[group].append(row)
    return result


def project_jobs(value, now):
    if (not isinstance(value, dict) or value.get('version') != 1 or type(value.get('observedAt')) is not int
            or not now - MAX_GAP_MS <= value['observedAt'] <= now + 5000):
        return None
    result = {'version': 1, 'observedAt': value['observedAt']}
    seen = set()
    for group, states, limit in [('active', ('running',), 2), ('queued', ('queued',), 16), ('recent', ('completed', 'failed', 'cancelled'), 100)]:
        rows = value.get(group)
        if not isinstance(rows, list) or len(rows) > limit:
            return None
        result[group] = []
        for raw in rows:
            if (not isinstance(raw, dict) or not isinstance(raw.get('id'), str) or not UUID.fullmatch(raw['id'])
                    or raw['id'] in seen or raw.get('state') not in states or raw.get('category') not in JOB_CATEGORIES
                    or type(raw.get('createdAt')) is not int or not 0 <= raw['createdAt'] <= now + 5000):
                return None
            seen.add(raw['id'])
            row = {key: raw[key] for key in ('id', 'state', 'category', 'createdAt')}
            for key in ('startedAt', 'finishedAt'):
                if type(raw.get(key)) is int and raw['createdAt'] <= raw[key] <= now + 5000:
                    row[key] = raw[key]
            if type(raw.get('exitCode')) is int and -255 <= raw['exitCode'] <= 255:
                row['exitCode'] = raw['exitCode']
            for key in ('headAtStart', 'headAtFinish'):
                if isinstance(raw.get(key), str) and re.fullmatch(r'[a-f0-9]{40}', raw[key]):
                    row[key] = raw[key]
            for key in ('cleanAtStart', 'cleanAtFinish'):
                if type(raw.get(key)) is bool:
                    row[key] = raw[key]
            result[group].append(row)
    return result


def managed_jobs(directory, read, now):
    try:
        config = json.loads(read(directory / 'config.json', 65536))
        session = config.get('sessionId')
        if not isinstance(session, str) or not UUID.fullmatch(session):
            return None
        raw = json.loads(read(directory / 'worker/jobs/sessions' / session / 'snapshot.json', 131072))
        return project_jobs(raw, now)
    except (ValueError, OSError, AttributeError, TypeError):
        return None


def tool_running(raw):
    """Project the supervisor's bounded event tail to an unfinished-tool flag."""
    pending = set()
    for line in raw.splitlines():
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if not isinstance(row, dict):
            continue
        kind, call = row.get('type'), row.get('toolCallId')
        if kind in ('turn_start', 'agent_end'):
            pending.clear()
        if not isinstance(call, str):
            continue
        if kind in ('tool_execution_start', 'tool_execution_update'):
            pending.add(call)
        elif kind == 'tool_execution_end':
            pending.discard(call)
    return bool(pending)


def classify_work(now, status, pool, *, worker_alive=False, tool_active=False, tool_progress=False, provider_handoff=False):
    if not isinstance(status, dict):
        return 'unknown'
    phase = status.get('phase')
    if phase == 'stopped':
        return 'paused'
    if phase == 'checkpoint':
        return 'between_cycles'
    if phase == 'starting':
        return 'starting'
    if phase == 'waiting_for_free_pool':
        return 'provider_wait' if pool is not None else 'offline'
    if phase != 'working':
        return 'unknown'
    if not worker_alive:
        return 'between_cycles' if pool is not None else 'offline'
    activity = status.get('lastActivityAt')
    age = now - activity * 1000 if type(activity) in (int, float) and math.isfinite(activity) else math.inf
    if tool_active and (tool_progress or -5000 <= age <= 300000):
        return 'working'
    if pool is None:
        return 'offline'
    if pool.get('activeRequests', 0) > 0:
        return 'working' if -5000 <= age <= MODEL_PROGRESS_MS else 'stalled'
    if provider_handoff:
        return 'provider_wait'
    return 'working' if -5000 <= age <= 8000 else 'stalled'


def worker_exists(pid):
    if type(pid) is not int or pid <= 1:
        return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def shell_activity(worker_pid, proc=Path('/proc')):
    """Sample only this worker's shell descendants, using process names and CPU counters."""
    if type(worker_pid) is not int or worker_pid <= 1:
        return False, False, {}

    def children(pid):
        try:
            raw = (proc / str(pid) / 'task' / str(pid) / 'children').read_text()
            return [int(child) for child in raw.split()[:64] if child.isascii() and child.isdecimal()]
        except (OSError, ValueError):
            return []

    def process(pid):
        try:
            raw = (proc / str(pid) / 'stat').read_text()
            before, after = raw.rsplit(')', 1)
            fields = after.split()
            if fields[0] not in ('Z', 'X', 'x'):
                return before.split('(', 1)[1], int(fields[19]), int(fields[11]) + int(fields[12])
        except (OSError, ValueError, IndexError):
            pass
        return None

    scoped = [worker_pid]
    shells = []
    for _ in range(4):
        nested = []
        for pid in scoped:
            entry = process(pid)
            if entry is None:
                continue
            name = entry[0]
            if name == 'pi':
                shells.extend(child for child in children(pid) if (process(child) or ('',))[0] == 'bash')
            if name == 'bwrap':
                nested.extend(children(pid))
        scoped = nested[:64]
        if not scoped:
            break

    counters = {}
    sleeping = False
    visited = set()
    scoped = shells[:64]
    for _ in range(10):
        nested = []
        for pid in scoped:
            if pid in visited or len(visited) >= 128:
                continue
            visited.add(pid)
            entry = process(pid)
            if entry is None:
                continue
            name, started, ticks = entry
            sleeping |= name == 'sleep'
            if name not in TOOL_WRAPPERS:
                counters[pid, started] = ticks
            nested.extend(children(pid))
        scoped = nested[:128]
        if not scoped or len(visited) >= 128:
            break
    return bool(shells), sleeping and not counters and not scoped, counters


class WorkProbe:
    def __init__(self, directory, read, pool):
        self.directory = directory
        self.read = read
        self.pool = pool
        self.active = set()
        self.handoff_at = None
        self.exclusive_model = None
        self.failed_model_since = None
        self.tool_identity = None
        self.tool_counters = {}
        self.tool_progress_at = None
        self.tool_requests = frozenset()
        self.tool_request_at = None
        self.category = None
        self.workers = None
        self.jobs = None

    def shell_progress(self, now, status, sources):
        started = status.get('lastToolStartedAt')
        cycle_started = status.get('cycleStartedAt')
        if (status.get('phase') != 'working' or type(started) not in (int, float) or not math.isfinite(started)
                or started * 1000 > now + 5000
                or (type(cycle_started) in (int, float) and started < cycle_started)):
            self.tool_identity = self.tool_progress_at = None
            self.tool_counters = {}
            self.tool_requests = frozenset()
            self.tool_request_at = None
            return False, False, False
        pid = status.get('workerPid')
        live, sleeping, counters = shell_activity(pid)
        identity = (pid, started) if live else None
        # Use the dedicated game pool. Ordinary daemon health checks share lastSuccessAt.
        request_sources = [row for row in sources if 'maintenance' not in row] if live and not sleeping else []
        requests = frozenset(
            (row['id'], row['active'], row['lastSuccessAt'] if type(row.get('lastSuccessAt')) is int else None)
            for row in request_sources
            if row.get('state') == 'answering' and type(row.get('active')) is int and row['active'] > 0
        )
        if identity != self.tool_identity or requests != self.tool_requests:
            self.tool_request_at = now if requests else None
        self.tool_requests = requests
        if identity != self.tool_identity:
            self.tool_progress_at = None
        elif sum(max(0, ticks - self.tool_counters.get(process, ticks)) for process, ticks in counters.items()) >= WORK_TICKS:
            self.tool_progress_at = now
        self.tool_identity = identity
        self.tool_counters = counters
        fresh_cpu = self.tool_progress_at is not None and 0 <= now - self.tool_progress_at <= TOOL_PROGRESS_MS
        fresh_reply = any(type(row.get('lastSuccessAt')) is int and
                          max(started * 1000, now - TOOL_PROGRESS_MS) <= row['lastSuccessAt'] <= now + 5000
                          for row in request_sources)
        fresh_request = self.tool_request_at is not None and 0 <= now - self.tool_request_at <= MODEL_PROGRESS_MS
        return live, sleeping, live and (fresh_cpu or fresh_reply or fresh_request)

    def sample(self, now):
        self.failed_model_since = None
        self.category = None
        self.workers = None
        self.jobs = managed_jobs(self.directory, self.read, now)
        try:
            status = json.loads(self.read(self.directory / 'status.json', 65536))
        except (ValueError, OSError):
            self.exclusive_model = None
            return 'unknown'
        if not isinstance(status, dict):
            self.exclusive_model = None
            return 'unknown'
        try:
            pool = self.pool()
            if not isinstance(pool, dict) or type(pool.get('activeRequests')) is not int or not isinstance(pool.get('sources'), list):
                pool = None
        except (ValueError, OSError, KeyError):
            pool = None
        sources = [row for row in pool['sources'] if isinstance(row, dict) and isinstance(row.get('id'), str)] if pool is not None else []
        self.workers = project_workers(pool.get('workers'), now) if pool is not None else None
        active = {row['id'] for row in sources if row.get('state') == 'answering' and type(row.get('active')) is int and row['active'] > 0}
        failed = {row.get('id') for row in sources if row.get('errorCode') and row.get('state') in ('error', 'limited', 'unavailable')}
        if self.active & failed:
            self.handoff_at = now
        if active:
            self.handoff_at = None
        self.active = active
        handoff = self.handoff_at is not None and now - self.handoff_at < MODEL_PROGRESS_MS

        unfinished = False
        log = status.get('lastLog')
        if status.get('phase') == 'working' and isinstance(log, str) and LOG_NAME.fullmatch(log):
            try:
                unfinished = tool_running(self.read(self.directory / 'logs' / log, 262144))
            except (ValueError, OSError):
                pass
        # Shell work can outlast, or never reach, the buffered cycle log.
        shell_live, sleeping, progress = self.shell_progress(now, status, sources)
        unfinished = (unfinished or shell_live) and not sleeping
        if unfinished or status.get('phase') != 'working':
            self.handoff_at = None
        state = classify_work(now, status, pool, worker_alive=worker_exists(status.get('workerPid')),
                              tool_active=unfinished, tool_progress=progress,
                              provider_handoff=handoff and not unfinished)
        # A live process is not evidence of execution. Explicit sleeps and
        # quiet tools stay visible as waits without being called stalled work.
        if (status.get('phase') == 'working' and worker_exists(status.get('workerPid')) and not active
                and (sleeping or unfinished and state == 'working' and not progress
                     or self.jobs and self.jobs['active'] and not progress)):
            state = 'tool_wait'
        category = {'working': 'execution', 'tool_wait': 'tool_wait', 'provider_wait': 'provider_wait',
                    'between_cycles': 'idle', 'paused': 'idle', 'starting': 'blocked',
                    'offline': 'blocked', 'stalled': 'blocked'}.get(state)
        if state == 'working' and active:
            category = 'inference'
        self.category = category
        if self.exclusive_model and any(row['id'] in failed and (row['id'], row.get('lastSuccessAt')) == self.exclusive_model[:2] for row in sources):
            self.failed_model_since = self.exclusive_model[2]
        # A sole model attempt can be reclassified when the pool reports it
        # failed. Never rewrite time when tools or other calls were also active.
        if state == 'working' and not unfinished and len(active) == 1 and pool['activeRequests'] == 1:
            source = next(row for row in sources if row['id'] in active)
            identity = (source['id'], source.get('lastSuccessAt'))
            if not self.exclusive_model or self.exclusive_model[:2] != identity:
                self.exclusive_model = (*identity, now)
            return 'model_only'
        self.exclusive_model = None
        return state


class WorkLedger:
    """Retain bounded intervals. Unknown time is inferred from recording gaps."""
    def __init__(self, path):
        directory = path.parent
        info = directory.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
            raise ValueError('Expected a private uptime directory')
        file = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
        try:
            info = os.fstat(file)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600:
                raise ValueError('Expected a private uptime database')
        finally:
            os.close(file)
        self.db = sqlite3.connect(path, timeout=2)
        self.db.execute('CREATE TABLE IF NOT EXISTS intervals (start INTEGER PRIMARY KEY, end INTEGER NOT NULL, state TEXT NOT NULL)')
        self.db.execute('CREATE INDEX IF NOT EXISTS intervals_end ON intervals(end)')
        if 'category' not in {row[1] for row in self.db.execute('PRAGMA table_info(intervals)')}:
            self.db.execute('ALTER TABLE intervals ADD COLUMN category TEXT')
        self.db.execute('CREATE TABLE IF NOT EXISTS worker_intervals (start INTEGER PRIMARY KEY, end INTEGER NOT NULL, active INTEGER NOT NULL, waiting INTEGER NOT NULL)')
        self.db.execute('CREATE TABLE IF NOT EXISTS worker_events (id TEXT PRIMARY KEY, at INTEGER NOT NULL, state TEXT NOT NULL)')
        self.db.execute('CREATE TABLE IF NOT EXISTS check_jobs (id TEXT PRIMARY KEY, at INTEGER NOT NULL, success INTEGER NOT NULL, head TEXT)')
        self.db.execute('CREATE TABLE IF NOT EXISTS meter_meta (name TEXT PRIMARY KEY, value INTEGER NOT NULL)')
        self.db.commit()
        self.previous = None
        self.previous_workers = None
        self.next_prune = 0

    def record(self, at, state, failed_model_since=None, category=None):
        if state not in STATES and state != 'model_only':
            raise ValueError('Unexpected work state')
        if category is not None and category not in CATEGORIES:
            raise ValueError('Unexpected work category')
        prior = self.previous
        with self.db:
            if at >= self.next_prune:
                self.db.execute('DELETE FROM intervals WHERE end <= ?', (at - 8 * DAY_MS,))
                self.db.execute('DELETE FROM worker_intervals WHERE end <= ?', (at - 8 * DAY_MS,))
                self.db.execute('DELETE FROM worker_events WHERE at <= ?', (at - 8 * DAY_MS,))
                self.db.execute('DELETE FROM check_jobs WHERE at <= ?', (at - 8 * DAY_MS,))
                self.next_prune = at + 3600000
            if prior and 0 < at - prior[0] <= MAX_GAP_MS and prior[1] != 'unknown':
                last = self.db.execute('SELECT start, end, state, category FROM intervals ORDER BY start DESC LIMIT 1').fetchone()
                # Overlapping samples after a backwards wall-clock adjustment
                # are ignored until time catches up.
                if last is None or prior[0] >= last[1]:
                    if last and last[1] == prior[0] and last[2:] == prior[1:]:
                        self.db.execute('UPDATE intervals SET end=? WHERE start=?', (at, last[0]))
                    else:
                        self.db.execute('INSERT INTO intervals(start,end,state,category) VALUES (?,?,?,?)', (prior[0], at, prior[1], prior[2]))
            if failed_model_since is not None:
                boundary = self.db.execute('SELECT start, end, category FROM intervals WHERE state=? AND start<? AND end>? AND end<=?',
                                           ('model_only', failed_model_since, failed_model_since, at)).fetchone()
                if boundary:
                    self.db.execute('UPDATE intervals SET end=? WHERE start=?', (failed_model_since, boundary[0]))
                    self.db.execute('INSERT INTO intervals(start,end,state,category) VALUES (?,?,?,?)', (failed_model_since, boundary[1], 'provider_wait', 'provider_wait' if boundary[2] else None))
                self.db.execute('UPDATE intervals SET state=? WHERE state=? AND start>=? AND end<=?',
                                ('provider_wait', 'model_only', failed_model_since, at))
                self.db.execute("UPDATE intervals SET category='provider_wait' WHERE state='provider_wait' AND category='inference' AND start>=? AND end<=?", (failed_model_since, at))
        self.previous = (at, state, category)

    def record_workers(self, at, workers):
        """Record observed slot-time, not inferred historical utilization."""
        if workers is None:
            self.previous_workers = None
            return
        active = workers['active']
        count, waiting = len(active), sum(row.get('waitingForSource') is True for row in active)
        prior = self.previous_workers
        with self.db:
            self.db.execute("INSERT OR IGNORE INTO meter_meta VALUES ('workers_since',?)", (at,))
            since = self.db.execute("SELECT value FROM meter_meta WHERE name='workers_since'").fetchone()[0]
            if prior and 0 < at - prior[0] <= MAX_GAP_MS:
                last = self.db.execute('SELECT start,end,active,waiting FROM worker_intervals ORDER BY start DESC LIMIT 1').fetchone()
                if last is None or prior[0] >= last[1]:
                    if last and last[1] == prior[0] and last[2:] == prior[1:]:
                        self.db.execute('UPDATE worker_intervals SET end=? WHERE start=?', (at, last[0]))
                    else:
                        self.db.execute('INSERT INTO worker_intervals VALUES (?,?,?,?)', (prior[0], at, prior[1], prior[2]))
            for row in workers['recent']:
                finished = row.get('finishedAt')
                if type(finished) is int and since <= finished <= at and row['state'] in ('completed', 'failed'):
                    self.db.execute('INSERT OR IGNORE INTO worker_events VALUES (?,?,?)', (row['id'], finished, row['state']))
        self.previous_workers = (at, count, waiting)

    def record_jobs(self, at, jobs):
        if jobs is None:
            return
        with self.db:
            self.db.execute("INSERT OR IGNORE INTO meter_meta VALUES ('jobs_since',?)", (at,))
            since = self.db.execute("SELECT value FROM meter_meta WHERE name='jobs_since'").fetchone()[0]
            for row in jobs['recent']:
                finished = row.get('finishedAt')
                if (row['category'] not in ('test', 'build') or type(finished) is not int or not since <= finished <= at
                        or row['state'] not in ('completed', 'failed') or type(row.get('exitCode')) is not int):
                    continue
                head = row.get('headAtStart') if (row.get('cleanAtStart') is True and row.get('cleanAtFinish') is True
                        and row.get('headAtStart') == row.get('headAtFinish')) else None
                self.db.execute('INSERT OR IGNORE INTO check_jobs VALUES (?,?,?,?)', (row['id'], finished, int(row['state'] == 'completed' and row['exitCode'] == 0), head))

    def _window(self, at, length):
        rows = self.db.execute('''
            SELECT state, SUM(MIN(end, ?) - MAX(start, ?))
            FROM intervals WHERE end > ? AND start < ? GROUP BY state
        ''', (at, at - length, at - length, at))
        totals = dict(rows)
        working = totals.get('working', 0) + totals.get('model_only', 0)
        result = {'workingMs': working, 'downtimeMs': sum(totals.values()) - working,
                  'providerWaitMs': totals.get('provider_wait', 0)}
        classified = dict(self.db.execute('''SELECT category,SUM(MIN(end,?)-MAX(start,?))
            FROM intervals WHERE end>? AND start<? AND category IS NOT NULL GROUP BY category''',
            (at, at - length, at - length, at)))
        if classified:
            breakdown = {field: classified.get(category, 0) for category, field in zip(CATEGORIES, BREAKDOWN_FIELDS)}
            breakdown['unclassifiedMs'] = max(0, sum(totals.values()) - sum(breakdown.values()))
            result['breakdown'] = breakdown
        return result

    def _worker_window(self, at, length):
        rows = self.db.execute('SELECT start,end,active,waiting FROM worker_intervals WHERE end>? AND start<?', (at - length, at))
        capacity = occupied = waiting = 0
        for start, end, active, pending in rows:
            duration = max(0, min(end, at) - max(start, at - length))
            capacity += duration * 2
            occupied += duration * active
            waiting += duration * pending
        events = dict(self.db.execute('SELECT state,COUNT(*) FROM worker_events WHERE at>? AND at<=? GROUP BY state', (at - length, at)))
        return {'capacityMs': capacity, 'occupiedMs': occupied, 'sourceWaitMs': waiting,
                'completed': events.get('completed', 0), 'failed': events.get('failed', 0)}

    def summary(self, at, state):
        result = {'at': at, 'state': 'working' if state == 'model_only' else state, 'day': self._window(at, DAY_MS),
                  'week': self._window(at, DAY_MS * 7)}
        since = self.db.execute("SELECT value FROM meter_meta WHERE name='workers_since'").fetchone()
        if since:
            result['workerUtilization'] = {'observedSince': since[0], 'day': self._worker_window(at, DAY_MS), 'week': self._worker_window(at, DAY_MS * 7)}
        jobs_since = self.db.execute("SELECT value FROM meter_meta WHERE name='jobs_since'").fetchone()
        if jobs_since:
            def checks(length):
                passed, failed, linked = self.db.execute('SELECT SUM(success),SUM(1-success),COUNT(DISTINCT CASE WHEN success=1 THEN head END) FROM check_jobs WHERE at>? AND at<=?', (at - length, at)).fetchone()
                return {'successfulChecks': passed or 0, 'failedChecks': failed or 0, 'headLinkedChecks': linked or 0}
            result['delivery'] = {'observedSince': jobs_since[0], 'day': checks(DAY_MS), 'week': checks(7 * DAY_MS), 'playableDeployments': None}
        return result


class WorkMeter:
    def __init__(self, probe, database):
        self.probe = probe
        self.database = database
        self.latest = None

    def run(self):
        ledger = None
        while True:
            started = time.monotonic()
            try:
                if ledger is None:
                    ledger = WorkLedger(self.database)
                # Sample time is assigned before the bounded local read.
                at = int(time.time() * 1000)
                state = self.probe.sample(at)
                ledger.record(at, state, self.probe.failed_model_since, self.probe.category)
                ledger.record_workers(at, self.probe.workers)
                ledger.record_jobs(at, self.probe.jobs)
                self.latest = ledger.summary(at, state)
            except (ValueError, OSError, sqlite3.Error):
                if ledger is not None:
                    ledger.db.close()
                    ledger = None
                self.latest = None
            time.sleep(max(0.25, SAMPLE_MS / 1000 - (time.monotonic() - started)))
