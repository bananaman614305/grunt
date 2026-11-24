"""Planned maintenance pause for a live upgrade (owner-authorized, between cycles only).

The unattended transaction (activate.py) can only start when, at one natural builder checkpoint, all of these hold at once: the
execution host is idle, both pools are idle, no source maintenance check starts inside the startup window, and the managed
daemons own no open TCP transport. The Claude builder keeps those false almost all the time (release-verification chains on the
host, a busy pool that keeps deferring every maintenance check by five minutes, keep-alive connections to the Squire egress
proxy that live about 70 s after the last request, status polls that land in a frozen daemon's accept queue). This module makes
them true on purpose:

  1. wait for the running cycle to end by itself, then freeze ONLY the supervisor (SIGSTOP, the checkpoint gate's own primitive;
     the supervisor honors `execution-upgrade-hold` only at process start, so the hold file cannot pause a running supervisor
     and `grunt-adventure pause` would stop the pool the transaction needs). No new cycle can start while it is frozen.
  2. quiet the two passive pollers (activity publisher: SIGSTOP of the same pinned process so its unit stays "active";
     overnight watcher: stop its timer so a deliberately stalled wake time raises no alert).
  3. settle: wait, bounded, until the proofs above have held together for QUIET_HOLD seconds.
  4. hand the same frozen supervisor to activate.activate(frozen_in=...), which re-runs every checkpoint proof.
  5. always resume the builder and the pollers, whatever happened (finally + an independent watchdog process for a killed owner).

Nothing here touches provider traffic, files outside the attempt directory, or any unit other than the passive timer.
"""
import json
import os
import signal
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path

from startup_gate import EXPECTED_UNION, EXPECTED_DEFERRED
import hostpaths

STATE = hostpaths.STATE
MAINTENANCE = hostpaths.CONFIG / 'maintenance.json'
PUBLISHER_UNIT = 'grunt-adventure-activity.service'
WATCH_TIMER = 'grunt-adventure-overnight-watch.timer'
WATCH_SERVICE = 'grunt-adventure-overnight-watch.service'
POOL_PORTS = (8792, 8793)
CHECKPOINT_PHASES = ('checkpoint', 'waiting_for_free_pool')
# Source checks the startup gate refuses to start near (same set it computes: eligible sources minus consent-deferred ones).
POTENTIAL_CHECKS = tuple(name for name in EXPECTED_UNION if name not in EXPECTED_DEFERRED)


class PauseError(RuntimeError):
    """The pause could not be completed. The builder and pollers are restored; nothing was mutated."""


class SettleTimeout(PauseError):
    """The preconditions did not become true inside the bounded window; give up cleanly."""


class PauseAborted(PauseError):
    """Something outside this operation changed the frozen state; stop without further action beyond undoing our own freeze."""


@dataclass
class Settings:
    # 180 s startup hard deadline + 60 s margin (both unchanged in startup_gate/activate) + 120 s for the pre-hold steps and the
    # 60 s transport wait that run before the gate's clock starts being the only thing that matters.
    lead_ms: int = 420000
    quiet_hold: float = 20.0          # conditions must stay true this long, continuously
    poll: float = 3.0
    settle_budget: float = 1500.0     # ~25 min from the freeze, then give up and resume
    freeze_timeout: float = 3600.0    # wait for the running cycle to end naturally
    watcher_stop_wait: float = 100.0  # the oneshot watcher may be mid-run when its timer stops (TimeoutStartSec is 85 s)
    heartbeat: float = 30.0
    watchdog_grace: float = 900.0     # added to settle_budget + activation budget for the independent watchdog's deadline


# --------------------------------------------------------------------------- read-only probes

def maintenance_lead(path=MAINTENANCE, *, now_ms=None, checks=POTENTIAL_CHECKS):
    """(milliseconds until the soonest startup-relevant source check, its id). Raises when the schedule cannot be read exactly."""
    now_ms = int(time.time() * 1000) if now_ms is None else now_ms
    raw = Path(path).read_bytes()
    if len(raw) > 1024 * 1024:
        raise ValueError('Oversized maintenance schedule')
    entries = json.loads(raw).get('entries')
    if not isinstance(entries, dict):
        raise ValueError('Malformed maintenance schedule')
    due = {}
    for name in checks:
        value = entries.get(name, {}).get('nextCheckAt') if isinstance(entries.get(name), dict) else None
        if type(value) is not int or value < 0:
            raise ValueError('Maintenance schedule has no exact entry for ' + name)
        due[name] = value
    soonest = min(due, key=due.get)
    return due[soonest] - now_ms, soonest


def _port(endpoint):
    return int(endpoint.rsplit(':', 1)[1], 16)


def _loopback(endpoint):
    host = endpoint.rsplit(':', 1)[0]
    return host == '0100007F' or host == '00000000000000000000000001000000'


def managed_sockets(pids, proc=Path('/proc'), pool_ports=POOL_PORTS):
    """Open TCP transports owned by the managed daemons and their descendants that daemon admission would not accept.

    Listeners are fine. So is the managed OpenCode parent<->child loopback pair (admission allows it once both ends are idle).
    Everything else counts: outbound keep-alive connections, and accepted connections on the pool ports (pollers)."""
    proc = Path(proc)
    family, stack = [], list(pids)
    while stack and len(family) < 64:
        pid = stack.pop()
        if pid in family or type(pid) is not int or pid <= 1:
            continue
        family.append(pid)
        try:
            for task in (proc / str(pid) / 'task').iterdir():
                stack.extend(int(value) for value in (task / 'children').read_text().split() if value.isdigit())
        except OSError:
            pass
    sockets, listeners = [], set()
    for pid in family:
        try:
            owned = {os.readlink(fd)[8:-1] for fd in (proc / str(pid) / 'fd').iterdir() if os.readlink(fd).startswith('socket:[')}
            table = {}
            for name in ('tcp', 'tcp6'):
                for line in (proc / str(pid) / 'net' / name).read_text().splitlines()[1:]:
                    fields = line.split()
                    if len(fields) < 10:
                        raise ValueError('Ambiguous kernel TCP metadata')
                    table[fields[9]] = (name, fields[1], fields[2], fields[3])
        except FileNotFoundError:
            continue  # exited while scanning
        for inode in owned & table.keys():
            family_name, local, remote, state = table[inode]
            if state == '0A':
                listeners.add(_port(local))
            else:
                sockets.append({'pid': pid, 'inode': inode, 'table': family_name, 'local': local, 'remote': remote, 'state': state})
    internal = listeners - set(pool_ports)
    return [row for row in sockets
            if not (_loopback(row['local']) and _loopback(row['remote']) and (_port(row['local']) in internal or _port(row['remote']) in internal))]


# --------------------------------------------------------------------------- the pause

class Pauser:
    def __init__(self, *, gate, unit_value, ctl, read_status, pools, host_quiet, maintenance, sockets, hold_path, managed_units,
                 preserve_paths=(), log=print, state_writer=None, clock=time.monotonic, sleep=time.sleep, wall=time.time, settings=None, watchdog=None,
                 end_cycle=None):
        self.gate, self.unit_value, self.ctl, self.read_status = gate, unit_value, ctl, read_status
        self.pools, self.host_quiet, self.maintenance, self.sockets = pools, host_quiet, maintenance, sockets
        self.hold_path, self.managed_units = Path(hold_path), tuple(managed_units)
        self.preserve_paths = tuple(str(path) for path in preserve_paths) or (str(hold_path),)
        self.log, self.state_writer = log, state_writer or (lambda value: None)
        self.clock, self.sleep, self.wall = clock, sleep, wall
        self.s = settings or Settings()
        self.watchdog_factory = watchdog
        self.end_cycle = end_cycle   # optional owner-authorized hook: end the running cycle (end_cycle.py); None = wait for it to end by itself
        self.frozen = None
        self.publisher = None        # (pid, start_ticks) of the publisher process this operation froze
        self.timer_was_active = False
        self.timer_stopped = False
        self.watchdog = None
        self.report = {}

    # ----- steps
    def _note(self, phase, **extra):
        self.log(f'[pause] {phase} ' + json.dumps(extra, sort_keys=True, default=str) if extra else f'[pause] {phase}')
        self.state_writer({'phase': phase, 'at': self.wall(), **extra})

    def freeze(self):
        """Wait for the running cycle to end (by itself, or by the owner-authorized end_cycle hook), then freeze the supervisor at that checkpoint."""
        self._note('waiting_for_natural_checkpoint', timeoutSeconds=self.s.freeze_timeout)
        if self.end_cycle is not None:
            try:
                outcome = self.end_cycle(self.clock() + self.s.freeze_timeout)
            except PauseError:
                raise
            except Exception as error:   # nothing was signalled unless the hook says so: give up cleanly instead of crashing the controller
                raise PauseError('Ending the running cycle failed: ' + (str(error)[:200] or type(error).__name__)) from error
            self._note('end_cycle', **outcome)
        self.frozen = self.gate.acquire(timeout_seconds=self.s.freeze_timeout)
        self.frozen_at = self.wall()
        self.deadline = self.clock() + self.s.settle_budget
        self._note('builder_frozen_at_checkpoint', supervisorPid=self.frozen.pid, settleBudgetSeconds=self.s.settle_budget)

    def quiet_observers(self):
        pid = int(self.unit_value(PUBLISHER_UNIT, 'MainPID') or 0)
        if self.unit_value(PUBLISHER_UNIT, 'ActiveState') == 'active' and pid > 1:
            ticks, state = self.gate._identity(pid)
            if state in ('T', 't'):
                self._note('publisher_already_stopped_by_someone_else_left_alone', pid=pid)
            else:
                self.gate._send(pid, ticks, signal.SIGSTOP)
                self.publisher = (pid, ticks)
                until = self.clock() + 2
                while self.gate._identity(pid)[1] not in ('T', 't'):
                    if self.clock() >= until:
                        raise PauseError('Activity publisher freeze could not be verified')
                    self.sleep(0.01)
        self.timer_was_active = self.unit_value(WATCH_TIMER, 'ActiveState') == 'active'
        if self.timer_was_active:
            self.timer_stopped = True  # set first: a failed stop is still restored by a start (idempotent)
            self.ctl('stop', WATCH_TIMER)
            until = self.clock() + self.s.watcher_stop_wait
            while self.unit_value(WATCH_SERVICE, 'ActiveState') in ('active', 'activating', 'deactivating'):
                if self.clock() >= until:
                    raise PauseError('Overnight watcher is still running after its timer was stopped')
                self.sleep(1)
        self._note('pollers_quiet', publisherFrozen=self.publisher is not None, watcherTimerStopped=self.timer_stopped)

    def start_watchdog(self, deadline_wall):
        if self.watchdog_factory is None:
            return
        spec = {'ownerPid': os.getpid(), 'ownerTicks': self.gate._identity(os.getpid())[0], 'deadline': deadline_wall,
                'supervisor': [self.frozen.pid, self.frozen.start_ticks],
                'publisher': list(self.publisher) if self.publisher else None,
                'restartTimer': self.timer_stopped, 'timer': WATCH_TIMER,
                'preserve': list(self.preserve_paths)}
        self.watchdog = self.watchdog_factory(spec)

    def assert_paused(self):
        """Integrity of OUR state. A violation means someone else changed it: abort (resume only what we froze), never wait."""
        ticks, state = self.gate._identity(self.frozen.pid)
        if ticks != self.frozen.start_ticks:
            raise PauseAborted('Supervisor changed during the planned pause')
        if state not in ('T', 't'):
            raise PauseAborted('Supervisor was resumed by someone else during the planned pause')
        if self.hold_path.exists() or self.hold_path.is_symlink():
            raise PauseAborted('An execution-upgrade-hold appeared during the planned pause; it is preserved')
        status = self.read_status()
        if not isinstance(status, dict) or status.get('phase') not in CHECKPOINT_PHASES or status.get('workerPid') is not None:
            raise PauseAborted('Builder is no longer at a checkpoint')
        for unit in self.managed_units:
            if self.unit_value(unit, 'ActiveState') != 'active':
                raise PauseAborted('Managed unit is not active: ' + unit)

    def unsettled(self):
        """Reasons the upgrade preconditions are not yet true (empty list = settled). Reads only."""
        reasons = []
        try:
            for port, pool in zip(POOL_PORTS, self.pools()):
                if type(pool.get('activeRequests')) is not int or pool['activeRequests'] != 0:
                    reasons.append(f'pool {port} has active requests')
        except Exception as error:
            reasons.append('pool status unreadable: ' + (str(error)[:80] or type(error).__name__))
        try:
            self.host_quiet()
        except Exception as error:
            reasons.append('execution host: ' + (str(error)[:100] or type(error).__name__))
        try:
            lead, soonest = self.maintenance()
            if lead < self.s.lead_ms:
                reasons.append(f'source check for {soonest} starts in {max(0, lead) // 1000}s (need {self.s.lead_ms // 1000}s or a completed check)')
        except Exception as error:
            reasons.append('maintenance schedule: ' + (str(error)[:100] or type(error).__name__))
        try:
            open_sockets = self.sockets()
            if open_sockets:
                reasons.append(f'{len(open_sockets)} managed TCP transport(s) still open')
        except Exception as error:
            reasons.append('transport scan: ' + (str(error)[:100] or type(error).__name__))
        return reasons

    def settle(self):
        """Wait (bounded by settle_budget from the freeze) until every proof has held together for quiet_hold seconds."""
        began = self.clock()
        quiet_since, last, beat, seen = None, None, began, {}
        while True:
            self.assert_paused()
            reasons = self.unsettled()
            now = self.clock()
            for reason in reasons:
                seen[reason.split(' (')[0]] = seen.get(reason.split(' (')[0], 0) + 1
            if reasons != last or now - beat >= self.s.heartbeat:
                self._note('settling' if reasons else 'settled_holding', waitedSeconds=round(now - began), reasons=reasons)
                last, beat = reasons, now
            if reasons:
                quiet_since = None
            else:
                quiet_since = now if quiet_since is None else quiet_since
                if now - quiet_since >= self.s.quiet_hold:
                    lead, soonest = self.maintenance()
                    self.report = {'settledAfterSeconds': round(now - began, 1), 'quietHoldSeconds': self.s.quiet_hold,
                                   'maintenanceLeadMs': lead, 'soonestCheck': soonest, 'leadRequiredMs': self.s.lead_ms,
                                   'unsettledReasonsSeen': seen, 'frozenAtWall': self.frozen_at}
                    self._note('settled', **self.report)
                    return self.report
            if now >= self.deadline:
                self._note('settle_timeout', waitedSeconds=round(now - began), reasons=reasons)
                raise SettleTimeout('Upgrade preconditions did not become true within the bounded pause window: ' + '; '.join(reasons or ['hold time not reached']))
            self.sleep(max(0.0, min(self.s.poll, self.deadline - now)))

    # ----- always-restore
    def resume_builder(self):
        frozen = self.frozen
        if frozen is not None and frozen.stopped:
            frozen.release()
            until = self.clock() + 2
            while True:
                ticks, state = self.gate._identity(frozen.pid)
                if ticks != frozen.start_ticks or state not in ('T', 't'):
                    break
                if self.clock() >= until:
                    raise PauseError('Supervisor did not resume after the planned pause')
                self.sleep(0.01)
            self._note('builder_resumed')

    def restore_observers(self):
        errors = []
        if self.publisher is not None:
            pid, ticks = self.publisher
            try:
                self.gate._send(pid, ticks, signal.SIGCONT)
            except Exception as error:  # the unit may have been restarted by systemd (new process): nothing to resume
                self.log('[pause] activity publisher not resumed (process changed or gone): ' + str(error)[:100])
            self.publisher = None
        if self.timer_stopped:
            try:
                self.ctl('start', WATCH_TIMER)
                self.timer_stopped = False
            except Exception as error:
                errors.append(error)
        if errors:
            raise PauseError('Overnight watcher timer was not restarted: ' + str(errors[0])[:100])

    def close(self):
        """Idempotent. Resume the builder first, then the pollers; report the first failure only after attempting everything."""
        first = None
        for step in (self.resume_builder, self.restore_observers):
            try:
                step()
            except BaseException as error:
                first = first or error
        if self.watchdog is not None:
            try:
                self.watchdog.terminate()
                self.watchdog.wait(timeout=5)
            except Exception:
                pass
            self.watchdog = None
        if first is not None:
            raise first

    def run(self, activate_fn):
        """freeze -> quiet -> settle -> activate_fn(frozen, report); the builder and pollers are restored on every path."""
        try:
            self.freeze()
            self.quiet_observers()
            self.start_watchdog(self.wall() + self.s.settle_budget + self.s.watchdog_grace)
            report = self.settle()
            return activate_fn(self.frozen, report)
        finally:
            self.close()


# --------------------------------------------------------------------------- independent watchdog (a killed owner must not leave the builder frozen)

def _proc_info(pid, proc=Path('/proc')):
    try:
        raw = (Path(proc) / str(pid) / 'stat').read_text()
    except OSError:
        return None
    tail = raw.rpartition(') ')[2].split()
    return (tail[19], tail[0]) if len(tail) > 19 else None


def _pinned(pid, ticks, signum):
    try:
        fd = os.pidfd_open(pid)
    except OSError:
        return False
    try:
        info = _proc_info(pid)
        if info is None or info[0] != ticks:
            return False
        signal.pidfd_send_signal(fd, signum)
        return True
    except OSError:
        return False
    finally:
        os.close(fd)


def watchdog(spec, *, sleep=time.sleep, wall=time.time, ctl=None, poll=2.0):
    """Run until the owner exits or the absolute deadline passes, then undo the pause UNLESS the activation owns state
    (hold / startup-attempted / work-may-resume present): that is recovery territory and is left exactly as it is."""
    while True:
        owner = _proc_info(spec['ownerPid'])
        alive = owner is not None and owner[0] == spec['ownerTicks'] and owner[1] not in ('Z', 'X')
        if alive and wall() < spec['deadline']:
            sleep(poll)
            continue
        break
    record = {'at': wall(), 'reason': 'owner_exited' if not alive else 'deadline'}
    if any(os.path.lexists(path) for path in spec['preserve']):
        record['action'] = 'deferred_to_operator_activation_state_present'
        return record
    pid, ticks = spec['supervisor']
    info = _proc_info(pid)
    if info is not None and info[0] == ticks and info[1] in ('T', 't'):
        record['supervisorResumed'] = _pinned(pid, ticks, signal.SIGCONT)
    if spec.get('publisher'):
        record['publisherResumed'] = _pinned(spec['publisher'][0], spec['publisher'][1], signal.SIGCONT)
    if spec.get('restartTimer'):
        try:
            (ctl or _systemctl)('start', spec['timer'])
            record['timerStarted'] = True
        except Exception as error:
            record['timerStarted'] = False
            record['timerError'] = str(error)[:100]
    record['action'] = 'resumed'
    return record


def _systemctl(action, unit):
    env = hostpaths.systemd_env()
    subprocess.run(['systemctl', '--user', action, unit], env=env, check=True, timeout=30, stdout=subprocess.DEVNULL)


class WatchdogUnit:
    """Handle for a watchdog running as its own transient user unit, so a dead owner's cgroup teardown cannot take it down too."""
    def __init__(self, unit, ctl):
        self.unit, self.ctl = unit, ctl

    def terminate(self):
        self.ctl('stop', self.unit + '.service')

    def wait(self, timeout=None):
        return 0


def spawn_watchdog_unit(spec, record_path, unit, *, run=subprocess.run, ctl=None):
    """Start the watchdog as `systemd-run --user` transient unit `unit` (outside the owner's cgroup). Failure to start is an error:
    the caller must not keep the builder frozen without a working watchdog."""
    env = hostpaths.systemd_env()
    command = ['systemd-run', '--user', '--collect', '--unit=' + unit, '--property=Type=exec', '--property=StandardOutput=null', '--property=StandardError=null',
               '--setenv=PYTHONDONTWRITEBYTECODE=1', '/usr/bin/python3', str(Path(__file__).resolve()), 'watchdog', json.dumps(spec), str(record_path)]
    result = run(command, env=env, capture_output=True, text=True, timeout=15)
    if result.returncode != 0:
        raise PauseError('Pause watchdog unit could not be started: ' + (result.stderr or '')[:200])
    return WatchdogUnit(unit, ctl or _systemctl)


def spawn_watchdog(spec, record_path):
    """Detached process; the owner terminates it on a normal exit. Survives `kill -9` of the owner (not a unit-wide stop, which
    the owner handles itself with a SIGTERM handler)."""
    return subprocess.Popen([sys.executable, str(Path(__file__).resolve()), 'watchdog', json.dumps(spec), str(record_path)],
                            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True,
                            env=hostpaths.systemd_env({'PATH': '/usr/bin:/bin', 'PYTHONDONTWRITEBYTECODE': '1', 'HOME': str(hostpaths.HOME)}))


if __name__ == '__main__':
    if len(sys.argv) == 4 and sys.argv[1] == 'watchdog':
        result = watchdog(json.loads(sys.argv[2]))
        temp = Path(sys.argv[3] + '.tmp')
        temp.write_text(json.dumps(result) + '\n')
        temp.chmod(0o600)
        os.replace(temp, sys.argv[3])
    else:
        raise SystemExit('internal helper: imported by pause-and-activate.py')
