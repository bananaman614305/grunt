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
STATES = {'working', 'provider_wait', 'between_cycles', 'starting', 'paused', 'offline', 'stalled', 'unknown'}
LOG_NAME = re.compile(r'cycle-\d{8}T\d{6}Z\.jsonl')


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


def classify_work(now, status, pool, *, worker_alive=False, tool_active=False, provider_handoff=False):
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
    if tool_active and -5000 <= age <= 300000:
        return 'working'
    if pool is None:
        return 'offline'
    if pool.get('activeRequests', 0) > 0:
        return 'working' if -5000 <= age <= 240000 else 'stalled'
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


def live_shell_tool(worker_pid, proc=Path('/proc')):
    """Look only for a live bash child of this runner's Pi process."""
    if type(worker_pid) is not int or worker_pid <= 1:
        return False

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
            state = after.split()[0]
            return before.split('(', 1)[1] if state not in ('Z', 'X', 'x') else ''
        except (OSError, ValueError, IndexError):
            return ''

    scoped = [worker_pid]
    for _ in range(4):
        nested = []
        for pid in scoped:
            name = process(pid)
            if name == 'pi' and any(process(child) == 'bash' for child in children(pid)):
                return True
            if name == 'bwrap':
                nested.extend(children(pid))
        scoped = nested[:64]
    return False


class WorkProbe:
    def __init__(self, directory, read, pool):
        self.directory = directory
        self.read = read
        self.pool = pool
        self.active = set()
        self.handoff_at = None
        self.exclusive_model = None
        self.failed_model_since = None

    def sample(self, now):
        self.failed_model_since = None
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
        active = {row['id'] for row in sources if row.get('state') == 'answering' and type(row.get('active')) is int and row['active'] > 0}
        failed = {row.get('id') for row in sources if row.get('errorCode') and row.get('state') in ('error', 'limited', 'unavailable')}
        if self.active & failed:
            self.handoff_at = now
        if active:
            self.handoff_at = None
        self.active = active
        handoff = self.handoff_at is not None and now - self.handoff_at < 240000

        unfinished = False
        log = status.get('lastLog')
        if status.get('phase') == 'working' and isinstance(log, str) and LOG_NAME.fullmatch(log):
            try:
                unfinished = tool_running(self.read(self.directory / 'logs' / log, 262144))
            except (ValueError, OSError):
                pass
        # A quiet shell command can still be running while Pi's event is in
        # the supervisor's buffered (or capped) cycle log. Require both the
        # fresh supervisor start marker and a shell under this specific Pi.
        started = status.get('lastToolStartedAt')
        if not unfinished and status.get('phase') == 'working' and type(started) in (int, float) and math.isfinite(started):
            if -5000 <= now - started * 1000 <= 300000:
                unfinished = live_shell_tool(status.get('workerPid'))
        if unfinished or status.get('phase') != 'working':
            self.handoff_at = None
        state = classify_work(now, status, pool, worker_alive=worker_exists(status.get('workerPid')),
                              tool_active=unfinished, provider_handoff=handoff and not unfinished)
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
        self.previous = None
        self.next_prune = 0

    def record(self, at, state, failed_model_since=None):
        if state not in STATES and state != 'model_only':
            raise ValueError('Unexpected work state')
        prior = self.previous
        with self.db:
            if at >= self.next_prune:
                self.db.execute('DELETE FROM intervals WHERE end <= ?', (at - 8 * DAY_MS,))
                self.next_prune = at + 3600000
            if prior and 0 < at - prior[0] <= MAX_GAP_MS and prior[1] != 'unknown':
                last = self.db.execute('SELECT start, end, state FROM intervals ORDER BY start DESC LIMIT 1').fetchone()
                # Overlapping samples after a backwards wall-clock adjustment
                # are ignored until time catches up.
                if last is None or prior[0] >= last[1]:
                    if last and last[1] == prior[0] and last[2] == prior[1]:
                        self.db.execute('UPDATE intervals SET end=? WHERE start=?', (at, last[0]))
                    else:
                        self.db.execute('INSERT INTO intervals VALUES (?,?,?)', (prior[0], at, prior[1]))
            if failed_model_since is not None:
                boundary = self.db.execute('SELECT start, end FROM intervals WHERE state=? AND start<? AND end>? AND end<=?',
                                           ('model_only', failed_model_since, failed_model_since, at)).fetchone()
                if boundary:
                    self.db.execute('UPDATE intervals SET end=? WHERE start=?', (failed_model_since, boundary[0]))
                    self.db.execute('INSERT INTO intervals VALUES (?,?,?)', (failed_model_since, boundary[1], 'provider_wait'))
                self.db.execute('UPDATE intervals SET state=? WHERE state=? AND start>=? AND end<=?',
                                ('provider_wait', 'model_only', failed_model_since, at))
        self.previous = (at, state)

    def _window(self, at, length):
        rows = self.db.execute('''
            SELECT state, SUM(MIN(end, ?) - MAX(start, ?))
            FROM intervals WHERE end > ? AND start < ? GROUP BY state
        ''', (at, at - length, at - length, at))
        totals = dict(rows)
        working = totals.get('working', 0) + totals.get('model_only', 0)
        return {'workingMs': working, 'downtimeMs': sum(totals.values()) - working,
                'providerWaitMs': totals.get('provider_wait', 0)}

    def summary(self, at, state):
        return {'at': at, 'state': 'working' if state == 'model_only' else state, 'day': self._window(at, DAY_MS),
                'week': self._window(at, DAY_MS * 7)}


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
                ledger.record(at, state, self.probe.failed_model_since)
                self.latest = ledger.summary(at, state)
            except (ValueError, OSError, sqlite3.Error):
                if ledger is not None:
                    ledger.db.close()
                    ledger = None
                self.latest = None
            time.sleep(max(0.25, SAMPLE_MS / 1000 - (time.monotonic() - started)))
