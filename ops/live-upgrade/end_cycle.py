"""Owner-authorized end of a long-running builder cycle, so the planned pause can freeze the supervisor at the checkpoint that follows.

The supervisor runs each cycle as a session-leader child (`start_new_session=True`, so pid == pgid). SIGTERM to that process group is
the supervisor's own cycle-limit primitive: it records a failed cycle, waits 60 s, then reports `waiting_for_free_pool`, which is a
usable checkpoint. Nothing else is touched: no SIGKILL, no signal to the supervisor, the pools or the execution host.

This module only acts when told to (`upgrade.py --end-cycle`, recorded as an owner authorization in controller-config.json) and
only on the cycle that is running when it looks. Every identity is pinned before the signal: the worker must be the supervisor's own
child, the leader of its process group, still the same process (start ticks) and still the cycle that status.json reports."""
import json
import os
import signal
import time
from pathlib import Path

DEFAULT_MIN_AGE = 120.0       # owner: interrupting a cycle is fine; only a cycle at least this old is ended (a just-started cycle is left to finish its first moves)
POLL = 5.0


class EndCycleError(RuntimeError):
    """The cycle could not be proven to be the supervisor's own worker; nothing was signalled."""


def _stat_fields(pid, proc):
    raw = (Path(proc) / str(pid) / 'stat').read_text()
    tail = raw.rpartition(') ')[2].split()
    if len(tail) < 20:
        raise EndCycleError('Unreadable worker process record')
    return {'state': tail[0], 'ppid': int(tail[1]), 'pgrp': int(tail[2]), 'session': int(tail[3]), 'ticks': tail[19]}


def worker_identity(status, supervisor_pid, proc='/proc'):
    pid = status.get('workerPid')
    if status.get('phase') != 'working' or type(pid) is not int or pid <= 1:
        raise EndCycleError('No builder cycle is running')
    try:
        fields = _stat_fields(pid, proc)
    except OSError as error:
        raise EndCycleError('Worker process is gone') from error
    if fields['state'] in ('Z', 'X'):
        raise EndCycleError('Worker process already exited')
    if fields['ppid'] != supervisor_pid:
        raise EndCycleError('Worker is not a child of the managed supervisor')
    if fields['pgrp'] != pid or fields['session'] != pid:
        raise EndCycleError('Worker is not its own process-group/session leader')
    return {'pid': pid, 'ticks': fields['ticks'], 'cycleStartedAt': status.get('cycleStartedAt'), 'cycles': status.get('cycles')}


def end_running_cycle(*, read_status, supervisor_pid, min_age=DEFAULT_MIN_AGE, deadline=None, proc='/proc', killpg=os.killpg,
                      wall=time.time, clock=time.monotonic, sleep=time.sleep, log=print):
    """Wait (never past `deadline`, a clock() value) until the running cycle is at least `min_age` seconds old, then end it.
    Returns what happened; a cycle that ends by itself first is the normal outcome and signals nothing."""
    while True:
        status = read_status()
        if not isinstance(status, dict) or status.get('phase') != 'working' or type(status.get('workerPid')) is not int:
            return {'action': 'none', 'reason': 'no builder cycle running (already at a checkpoint or between cycles)', 'builderPhase': (status or {}).get('phase')}
        started = status.get('cycleStartedAt')
        if not isinstance(started, (int, float)) or isinstance(started, bool):
            raise EndCycleError('Cycle start time is not recorded')
        age = wall() - started
        if age >= min_age:
            break
        wait = min_age - age
        if deadline is not None and clock() + wait >= deadline:
            return {'action': 'none', 'reason': 'cycle would not reach the minimum age before the wait budget ends', 'cycleAgeSeconds': round(age)}
        log(f'[end-cycle] cycle is {round(age)} s old; ending it only after {round(min_age)} s')
        sleep(min(POLL * 6, wait))
    supervisor = int(supervisor_pid())
    identity = worker_identity(status, supervisor, proc)
    again = read_status()
    if again.get('workerPid') != identity['pid'] or again.get('cycleStartedAt') != status.get('cycleStartedAt'):
        return {'action': 'none', 'reason': 'the cycle changed while it was being checked'}
    if _stat_fields(identity['pid'], proc)['ticks'] != identity['ticks']:
        raise EndCycleError('Worker process identity changed')
    killpg(identity['pid'], signal.SIGTERM)
    result = {'action': 'sigterm_process_group', **identity, 'cycleAgeSeconds': round(wall() - status['cycleStartedAt']), 'supervisorPid': supervisor,
              'expected': 'the supervisor records a failed cycle, waits about 60 s, then reports waiting_for_free_pool (a usable checkpoint)'}
    log('[end-cycle] ' + json.dumps(result, sort_keys=True))
    return result
