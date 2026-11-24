"""Planned maintenance pause: synthetic /proc, synthetic clocks, a real checkpoint gate with owned signals, and real throwaway
child processes for the watchdog. No live units, no signals to anything this test did not start."""
import json, os, signal, subprocess, sys, tempfile, time, unittest
from pathlib import Path
from checkpoint_gate import CheckpointGate, GateError, FrozenSupervisor
import maintenance_pause as mp

HERE = Path(__file__).resolve().parent


class World(unittest.TestCase):
    """Fake clock. sleep() advances time and lets the scenario change the world."""
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=HERE)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.now = 0.0
        self.events = []
        self.logs = []
        self.states = {}                      # pid -> state letter (synthetic /proc)
        self.status = {'phase': 'checkpoint', 'workerPid': None, 'cycles': 7}
        self.units = {mp.PUBLISHER_UNIT: {'ActiveState': 'active', 'MainPID': '301'}, mp.WATCH_TIMER: {'ActiveState': 'active'},
                      mp.WATCH_SERVICE: {'ActiveState': 'inactive'}, 'milo.service': {'ActiveState': 'active'},
                      'grunt-amazing-adventure.service': {'ActiveState': 'active'}, 'grunt-adventure-execution-host.service': {'ActiveState': 'active'}}
        self.active_requests = [0, 0]
        self.host_busy_until = 0
        self.lead_ms = lambda: 10 * 60 * 1000
        self.open_sockets = lambda: []
        self.hold = self.root / 'execution-upgrade-hold'
        supervisor = self.root / '101'
        (supervisor / 'task/101').mkdir(parents=True)
        (supervisor / 'task/101/children').write_text('102')
        child = self.root / '102'
        child.mkdir()
        (child / 'cmdline').write_bytes(b'/synthetic/node\0/synthetic/backend\0')
        (child / 'exe').symlink_to('/synthetic/node')
        (self.root / '301').mkdir()
        (self.root / str(os.getpid())).mkdir()
        self.states.update({101: 'S', 301: 'S', os.getpid(): 'R'})
        self.write_stats()
        self.gate = CheckpointGate(status_path=self.root / 'unused', supervisor_pid=lambda: 101, expected_backend_script='/synthetic/backend',
                                   expected_node='/synthetic/node', proc_root=self.root, status_reader=lambda path: dict(self.status),
                                   pool_reader=lambda port: {'activeRequests': self.active_requests[port - 8792]}, clock=lambda: self.now, sleep=self.sleep)
        self.gate._send = self.send
        self.scenario = lambda: None

    def write_stats(self):
        for pid, state in self.states.items():
            (self.root / str(pid) / 'stat').write_text(f'{pid} (synthetic) ' + ' '.join([state, '1'] + ['0'] * 17 + [str(1000 + pid)]))

    def send(self, pid, ticks, signum):
        self.events.append((round(self.now, 1), pid, signal.Signals(signum).name))
        if signum == signal.SIGSTOP:
            self.states[pid] = 'T'
        elif signum == signal.SIGCONT:
            self.states[pid] = 'S'
        self.write_stats()

    def sleep(self, seconds):
        self.now += seconds
        self.scenario()

    def unit_value(self, unit, field):
        return self.units[unit][field]

    def ctl(self, action, unit):
        self.events.append((round(self.now, 1), unit, action))
        if unit == mp.WATCH_TIMER:
            self.units[unit]['ActiveState'] = 'inactive' if action == 'stop' else 'active'

    def host_quiet(self):
        if self.now < self.host_busy_until:
            raise RuntimeError('Execution host owns active work; preserve it')
        return {'state': 'idle'}

    def pauser(self, **settings):
        defaults = dict(quiet_hold=5.0, poll=1.0, settle_budget=120.0, freeze_timeout=30.0, watcher_stop_wait=5.0, heartbeat=1000.0)
        defaults.update(settings)
        return mp.Pauser(gate=self.gate, unit_value=self.unit_value, ctl=self.ctl, read_status=lambda: dict(self.status),
                         pools=lambda: [{'activeRequests': n} for n in self.active_requests], host_quiet=self.host_quiet,
                         maintenance=lambda: (self.lead_ms(), 'perch'), sockets=lambda: self.open_sockets(), hold_path=self.hold,
                         managed_units=('milo.service', 'grunt-amazing-adventure.service', 'grunt-adventure-execution-host.service'),
                         log=self.logs.append, clock=lambda: self.now, sleep=self.sleep, wall=lambda: 1000 + self.now, settings=mp.Settings(**defaults))

    def signals(self, pid=None):
        return [(e[2]) for e in self.events if isinstance(e[1], int) and (pid is None or e[1] == pid)]

    def assertRestored(self):
        self.assertEqual(self.states[101], 'S', 'builder must be running again')
        self.assertEqual(self.states[301], 'S', 'activity publisher must be running again')
        self.assertEqual(self.units[mp.WATCH_TIMER]['ActiveState'], 'active', 'watcher timer must be started again')


class PauseWindow(World):
    def test_happy_path_freezes_only_the_supervisor_settles_hands_over_and_does_not_double_resume(self):
        seen = []

        def activate_fn(frozen, report):
            seen.append((self.states[101], self.states[301], self.units[mp.WATCH_TIMER]['ActiveState'], report['settledAfterSeconds']))
            frozen.stopped = False                      # activate.terminate_before_stop() hands the supervisor over to the transaction
            self.states[101] = 'R'
            return {'success': True}
        self.assertEqual(self.pauser().run(activate_fn), {'success': True})
        self.assertEqual(seen, [('T', 'T', 'inactive', 5.0)])    # frozen, publisher frozen, watcher timer stopped, held 5 s
        self.assertEqual(self.signals(101), ['SIGSTOP'])             # no second SIGCONT after the handover
        self.assertEqual(self.signals(301), ['SIGSTOP', 'SIGCONT'])
        self.assertEqual(self.units[mp.WATCH_TIMER]['ActiveState'], 'active')

    def test_never_interrupts_a_running_cycle_it_waits_for_the_checkpoint(self):
        self.status = {'phase': 'working', 'workerPid': 555, 'cycles': 7}

        def scenario():
            if self.now >= 12:
                self.status = {'phase': 'checkpoint', 'workerPid': None, 'cycles': 8}
        self.scenario = scenario
        p = self.pauser()
        p.freeze()
        self.assertEqual([e for e in self.events if e[2] == 'SIGSTOP'], [(12.0, 101, 'SIGSTOP')])
        p.close()
        self.assertRestored()

    def test_the_end_cycle_hook_runs_once_before_the_checkpoint_wait_and_its_outcome_is_recorded(self):
        calls, notes = [], []
        self.status = {'phase': 'working', 'workerPid': 555, 'cycles': 7}

        def hook(deadline):
            calls.append((self.now, deadline))
            self.status = {'phase': 'waiting_for_free_pool', 'workerPid': None, 'cycles': 8}   # the supervisor's own reaction to the SIGTERM
            return {'action': 'sigterm_process_group', 'pid': 555}
        p = self.pauser()
        p.end_cycle = hook
        p.state_writer = notes.append
        p.freeze()
        self.assertEqual(calls, [(0.0, 30.0)])                       # bounded by the checkpoint wait
        self.assertEqual([n['phase'] for n in notes][:3], ['waiting_for_natural_checkpoint', 'end_cycle', 'builder_frozen_at_checkpoint'])
        self.assertEqual(self.signals(101), ['SIGSTOP'])
        p.close()
        self.assertRestored()

    def test_a_failing_end_cycle_hook_is_a_clean_give_up_with_nothing_frozen(self):
        def hook(deadline):
            raise RuntimeError('worker is not the supervisors child')
        p = self.pauser()
        p.end_cycle = hook
        with self.assertRaisesRegex(mp.PauseError, 'Ending the running cycle failed'):
            p.run(lambda frozen, report: self.fail('must not activate'))
        self.assertEqual(self.signals(101), [])
        self.assertRestored()

    def test_without_the_hook_nothing_ends_the_cycle(self):
        p = self.pauser()
        self.assertIsNone(p.end_cycle)
        p.freeze()
        p.close()

    def test_failure_in_the_transaction_resumes_the_builder_and_the_pollers(self):
        class Rejected(RuntimeError):
            upgrade_retry_safe = True
        with self.assertRaises(Rejected):
            self.pauser().run(lambda frozen, report: (_ for _ in ()).throw(Rejected('synthetic admission rejection')))
        self.assertRestored()
        self.assertEqual(self.signals(101), ['SIGSTOP', 'SIGCONT'])

    def test_a_transaction_that_keeps_the_builder_frozen_for_recovery_is_not_resumed_by_us(self):
        def partial(frozen, report):
            frozen.stopped = False                      # activate marks a partial admission this way
            raise RuntimeError('partial admission; preserve frozen processes and hold')
        with self.assertRaises(RuntimeError):
            self.pauser().run(partial)
        self.assertEqual(self.signals(101), ['SIGSTOP'])
        self.assertEqual(self.states[301], 'S')         # the passive pollers are still restored
        self.assertEqual(self.units[mp.WATCH_TIMER]['ActiveState'], 'active')

    def test_settle_times_out_cleanly_when_the_host_never_goes_idle(self):
        self.host_busy_until = 10 ** 6
        with self.assertRaises(mp.SettleTimeout) as caught:
            self.pauser().run(lambda frozen, report: self.fail('must not activate'))
        self.assertIn('execution host', str(caught.exception))
        self.assertRestored()
        self.assertGreaterEqual(self.now, 120)
        self.assertLess(self.now, 125)                  # bounded by the budget, not unbounded

    def test_each_precondition_blocks_the_hand_over_until_it_clears(self):
        cases = {
            'host': lambda: setattr(self, 'host_busy_until', 40),
            'pool': lambda: None,
            'maintenance': lambda: setattr(self, 'lead_ms', lambda: 30000 if self.now < 40 else 10 ** 7),
            'transports': lambda: setattr(self, 'open_sockets', lambda: [{'pid': 1}] if self.now < 40 else []),
        }
        for name, arm in cases.items():
            with self.subTest(name):
                self.events.clear(); self.now = 0; self.states.update({101: 'S', 301: 'S'}); self.write_stats()
                self.active_requests = [0, 0]; self.host_busy_until = 0; self.lead_ms = lambda: 10 ** 7; self.open_sockets = lambda: []
                self.units[mp.WATCH_TIMER]['ActiveState'] = 'active'
                arm()
                if name == 'pool':
                    self.scenario = lambda: setattr(self, 'active_requests', [0, 2] if 1 <= self.now < 40 else [0, 0])
                else:
                    self.scenario = lambda: None
                handed = []
                self.pauser().run(lambda frozen, report: handed.append(report['settledAfterSeconds']) or {'success': True})
                self.assertGreaterEqual(handed[0], 45)  # cleared at 40 s, then the 5 s hold
                self.assertRestored()

    def test_flapping_condition_restarts_the_quiet_hold(self):
        self.open_sockets = lambda: [{'pid': 1}] if int(self.now) in (3, 4) else []
        handed = []
        self.pauser().run(lambda frozen, report: handed.append(report['settledAfterSeconds']) or {'success': True})
        self.assertGreaterEqual(handed[0], 9)          # clean 0-2, dirty 3-4, then a full 5 s hold from 5

    def test_maintenance_lead_must_cover_the_startup_window_not_merely_exceed_the_gate_floor(self):
        self.lead_ms = lambda: 300000                  # beyond the gate's own 240 s floor but inside our 420 s lead
        with self.assertRaises(mp.SettleTimeout) as caught:
            self.pauser(settle_budget=20.0).run(lambda frozen, report: self.fail('must not activate'))
        self.assertIn('source check for perch', str(caught.exception))
        self.assertRestored()

    def test_someone_else_resuming_the_supervisor_aborts_the_window(self):
        def scenario():
            if self.now >= 3:
                self.states[101] = 'S'; self.write_stats()
        self.scenario = scenario
        with self.assertRaises(mp.PauseAborted):
            self.pauser().run(lambda frozen, report: self.fail('must not activate'))
        self.assertEqual(self.signals(101), ['SIGSTOP', 'SIGCONT'])  # our own freeze is still undone (pinned identity, harmless if already running)
        self.assertRestored()

    def test_a_hold_that_appears_is_preserved_and_the_window_is_abandoned(self):
        self.scenario = lambda: self.hold.write_text('someone else') if self.now >= 2 else None
        with self.assertRaises(mp.PauseAborted) as caught:
            self.pauser().run(lambda frozen, report: self.fail('must not activate'))
        self.assertIn('hold', str(caught.exception))
        self.assertTrue(self.hold.exists())            # never removed or touched
        self.assertRestored()

    def test_builder_leaving_the_checkpoint_or_a_unit_going_down_aborts(self):
        for change, text in ((lambda: self.status.update(phase='working', workerPid=9), 'checkpoint'),
                             (lambda: self.units['milo.service'].update(ActiveState='failed'), 'not active')):
            with self.subTest(text):
                self.now = 0; self.states.update({101: 'S', 301: 'S'}); self.write_stats()
                self.status = {'phase': 'checkpoint', 'workerPid': None, 'cycles': 7}; self.units['milo.service']['ActiveState'] = 'active'
                self.units[mp.WATCH_TIMER]['ActiveState'] = 'active'
                self.scenario = lambda change=change: change() if self.now >= 2 else None
                with self.assertRaisesRegex(mp.PauseAborted, text):
                    self.pauser().run(lambda frozen, report: self.fail('must not activate'))
                self.assertRestored()

    def test_failure_while_quieting_the_pollers_still_resumes_everything(self):
        self.units[mp.WATCH_SERVICE]['ActiveState'] = 'active'                       # the oneshot watcher never finishes
        with self.assertRaisesRegex(mp.PauseError, 'still running'):
            self.pauser().run(lambda frozen, report: self.fail('must not activate'))
        self.assertRestored()

    def test_a_publisher_that_someone_else_stopped_is_left_alone(self):
        self.states[301] = 'T'; self.write_stats()
        p = self.pauser(); p.freeze(); p.quiet_observers(); p.close()
        self.assertEqual(self.signals(301), [])
        self.assertEqual(self.states[301], 'T')

    def test_a_restarted_publisher_is_not_signalled_by_stale_identity(self):
        p = self.pauser(); p.freeze(); p.quiet_observers()
        (self.root / '301/stat').write_text('301 (synthetic) ' + ' '.join(['S', '1'] + ['0'] * 17 + ['424242']))  # same pid, new start ticks
        p.gate._send = lambda pid, ticks, sig: (_ for _ in ()).throw(GateError('Supervisor process changed during activation')) if sig == signal.SIGCONT and pid == 301 else self.send(pid, ticks, sig)
        p.close()                                                                      # must not raise
        self.assertEqual(self.states[101], 'S')

    def test_timer_that_was_not_running_is_not_started_by_the_restore(self):
        self.units[mp.WATCH_TIMER]['ActiveState'] = 'inactive'
        self.pauser().run(lambda frozen, report: {'success': True})
        self.assertNotIn((mp.WATCH_TIMER, 'start'), [(e[1], e[2]) for e in self.events])
        self.assertNotIn((mp.WATCH_TIMER, 'stop'), [(e[1], e[2]) for e in self.events])

    def test_failed_timer_restart_is_reported_after_everything_else_is_resumed(self):
        original = self.ctl
        self.ctl = lambda action, unit: (_ for _ in ()).throw(RuntimeError('systemctl failed')) if action == 'start' else original(action, unit)
        with self.assertRaisesRegex(mp.PauseError, 'timer was not restarted'):
            self.pauser().run(lambda frozen, report: {'success': True})
        self.assertEqual(self.states[101], 'S'); self.assertEqual(self.states[301], 'S')

    def test_checkpoint_wait_that_never_ends_gives_up_without_freezing_anything(self):
        self.status = {'phase': 'working', 'workerPid': 555, 'cycles': 7}
        with self.assertRaises(GateError):
            self.pauser(freeze_timeout=10.0).run(lambda frozen, report: self.fail('must not activate'))
        self.assertEqual(self.events, [])               # nothing frozen, nothing stopped
        self.assertRestored()

    def test_close_is_idempotent(self):
        p = self.pauser(); p.freeze(); p.quiet_observers(); p.close(); p.close()
        self.assertEqual(self.signals(101), ['SIGSTOP', 'SIGCONT'])
        self.assertEqual(self.signals(301), ['SIGSTOP', 'SIGCONT'])

    def test_pool_with_active_requests_blocks_and_an_idle_pool_does_not(self):
        p = self.pauser()
        p.pools = lambda: [{'activeRequests': 1}, {'activeRequests': 0}]
        self.assertIn('pool 8792 has active requests', p.unsettled())
        p.pools = lambda: [{'activeRequests': 0}, {'activeRequests': '0'}]
        self.assertIn('pool 8793 has active requests', p.unsettled())
        p.pools = lambda: [{'activeRequests': 0}, {'activeRequests': 0}]
        self.assertEqual(p.unsettled(), [])

    def test_unreadable_proofs_count_as_not_yet_never_as_settled(self):
        p = self.pauser()
        p.pools = lambda: (_ for _ in ()).throw(OSError('refused'))
        p.maintenance = lambda: (_ for _ in ()).throw(ValueError('no entry'))
        p.sockets = lambda: (_ for _ in ()).throw(OSError('gone'))
        self.assertEqual(len(p.unsettled()), 3)

    # --- watchdog lifecycle inside the pause window ---
    class FakeWatchdog:
        def __init__(self):
            self.terminated = 0
        def terminate(self):
            self.terminated += 1
        def wait(self, timeout=None):
            return 0

    def test_the_watchdog_is_armed_with_pinned_identities_and_always_disarmed(self):
        made = []
        def factory(spec):
            made.append(spec)
            return self.FakeWatchdog()
        for outcome in ('ok', 'fail'):
            self.events.clear(); self.states.update({101: 'S', 301: 'S'}); self.write_stats(); self.units[mp.WATCH_TIMER]['ActiveState'] = 'active'
            p = self.pauser(); p.watchdog_factory = factory
            run = (lambda frozen, report: {'success': True}) if outcome == 'ok' else (lambda frozen, report: (_ for _ in ()).throw(RuntimeError('boom')))
            try:
                p.run(run)
            except RuntimeError:
                pass
            self.assertEqual(made[-1]['supervisor'], [101, '1101']); self.assertEqual(made[-1]['publisher'], [301, '1301']); self.assertEqual(made[-1]['ownerTicks'], str(1000 + os.getpid())); self.assertTrue(made[-1]['restartTimer'])
            self.assertEqual(made[-1]['ownerPid'], os.getpid()); self.assertGreater(made[-1]['deadline'], 1000 + 120)
            self.assertIsNone(p.watchdog)
            self.assertRestored()

    def test_a_watchdog_that_cannot_start_means_no_pause_and_everything_is_resumed(self):
        def factory(spec):
            raise mp.PauseError('Pause watchdog unit could not be started: boom')
        p = self.pauser(); p.watchdog_factory = factory
        with self.assertRaisesRegex(mp.PauseError, 'watchdog unit'):
            p.run(lambda frozen, report: self.fail('must not activate'))
        self.assertRestored()

    def test_watchdog_unit_command_runs_outside_the_owner_cgroup_and_failure_is_an_error(self):
        calls = []
        def run(command, **kw):
            calls.append(command)
            return subprocess.CompletedProcess(command, 0, '', '')
        stops = []
        handle = mp.spawn_watchdog_unit({'ownerPid': 1}, '/tmp/record.json', 'grunt-pause-watchdog-1', run=run, ctl=lambda action, unit: stops.append((action, unit)))
        self.assertEqual(calls[0][:5], ['systemd-run', '--user', '--collect', '--unit=grunt-pause-watchdog-1', '--property=Type=exec'])
        self.assertEqual(calls[0][-4:-2], [str(Path(mp.__file__).resolve()), 'watchdog']); self.assertEqual(json.loads(calls[0][-2]), {'ownerPid': 1})
        handle.terminate(); self.assertEqual(stops, [('stop', 'grunt-pause-watchdog-1.service')])
        with self.assertRaisesRegex(mp.PauseError, 'could not be started'):
            mp.spawn_watchdog_unit({}, '/tmp/r', 'x', run=lambda command, **kw: subprocess.CompletedProcess(command, 1, '', 'Failed to start'))


class RealSignals(unittest.TestCase):
    """End to end with the real checkpoint gate and real SIGSTOP/SIGCONT, on throwaway processes this test starts."""
    def test_pause_freezes_only_the_supervisor_and_publisher_and_resumes_both(self):
        exe = os.path.realpath(sys.executable)
        temp = tempfile.TemporaryDirectory(dir=HERE)
        self.addCleanup(temp.cleanup)
        backend = Path(temp.name) / 'backend.py'
        backend.write_text('import time\ntime.sleep(60)\n')
        supervisor = subprocess.Popen([exe, '-c', 'import subprocess,sys,time; subprocess.Popen([sys.argv[1], sys.argv[2]]); time.sleep(60)', exe, str(backend)])
        publisher = subprocess.Popen([exe, '-c', 'import time; time.sleep(60)'])
        bystander = subprocess.Popen([exe, '-c', 'import time; time.sleep(60)'])

        def cleanup():
            for process in (supervisor, publisher, bystander):
                process.kill(); process.wait()
        self.addCleanup(cleanup)
        deadline = time.time() + 5
        while time.time() < deadline and not Path(f'/proc/{supervisor.pid}/task/{supervisor.pid}/children').read_text().strip():
            time.sleep(0.02)
        state = lambda pid: mp._proc_info(pid)[1]
        units = {mp.PUBLISHER_UNIT: {'ActiveState': 'active', 'MainPID': str(publisher.pid)}, mp.WATCH_TIMER: {'ActiveState': 'active'}, mp.WATCH_SERVICE: {'ActiveState': 'inactive'},
                 'milo.service': {'ActiveState': 'active'}}
        timer = []
        gate = CheckpointGate(status_path=Path(temp.name) / 'unused', supervisor_pid=lambda: supervisor.pid, expected_backend_script=str(backend), expected_node=exe,
                              status_reader=lambda path: {'phase': 'waiting_for_free_pool', 'workerPid': None, 'cycles': 3}, pool_reader=lambda port: {'activeRequests': 0})
        observed = []

        def activate_fn(frozen, report):
            observed.append((state(supervisor.pid), state(publisher.pid), state(bystander.pid)))
            return {'success': True}
        pauser = mp.Pauser(gate=gate, unit_value=lambda unit, field: units[unit][field], ctl=lambda action, unit: timer.append((action, unit)),
                           read_status=lambda: {'phase': 'waiting_for_free_pool', 'workerPid': None, 'cycles': 3}, pools=lambda: [{'activeRequests': 0}, {'activeRequests': 0}],
                           host_quiet=lambda: {}, maintenance=lambda: (10 ** 7, 'perch'), sockets=lambda: [], hold_path=Path(temp.name) / 'hold',
                           managed_units=('milo.service',), log=lambda m: None, settings=mp.Settings(quiet_hold=0.2, poll=0.05, settle_budget=20, freeze_timeout=5))
        pauser.run(activate_fn)
        self.assertEqual(observed, [('T', 'T', 'S')])                                 # supervisor and publisher frozen, bystander untouched
        deadline = time.time() + 3
        while time.time() < deadline and (state(supervisor.pid) in ('T', 't') or state(publisher.pid) in ('T', 't')):
            time.sleep(0.02)
        self.assertNotIn(state(supervisor.pid), ('T', 't')); self.assertNotIn(state(publisher.pid), ('T', 't'))
        self.assertEqual(timer, [('stop', mp.WATCH_TIMER), ('start', mp.WATCH_TIMER)])


class Probes(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=HERE)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def schedule(self, **entries):
        path = self.root / 'maintenance.json'
        path.write_text(json.dumps({'version': 1, 'nextStartAt': 0, 'entries': {name: {'nextCheckAt': at} for name, at in entries.items()}}))
        return path

    def test_potential_checks_exclude_consent_deferred_sources(self):
        for name in ('kilo', 'goedel', 'freepi'):
            self.assertNotIn(name, mp.POTENTIAL_CHECKS)
        self.assertIn('perch', mp.POTENTIAL_CHECKS)

    def test_maintenance_lead_reports_the_soonest_relevant_check(self):
        path = self.schedule(**{name: 10 ** 12 for name in mp.POTENTIAL_CHECKS}, kilo=1)   # an overdue consent-deferred source is irrelevant
        entries = json.loads(path.read_text()); entries['entries']['beatapi']['nextCheckAt'] = 5_000_000
        path.write_text(json.dumps(entries))
        self.assertEqual(mp.maintenance_lead(path, now_ms=4_000_000), (1_000_000, 'beatapi'))

    def test_missing_or_malformed_schedule_fails_closed(self):
        entries = {name: 10 ** 12 for name in mp.POTENTIAL_CHECKS}
        entries.pop('perch')
        with self.assertRaises(ValueError):
            mp.maintenance_lead(self.schedule(**entries), now_ms=0)
        (self.root / 'bad.json').write_text('{"entries": []}')
        with self.assertRaises(ValueError):
            mp.maintenance_lead(self.root / 'bad.json', now_ms=0)

    def proc(self, layout, table):
        """layout: {pid: {'children': [..], 'sockets': {fd: inode}}}; one shared kernel table for the namespace."""
        header = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n'
        for pid, spec in layout.items():
            base = self.root / str(pid)
            (base / 'fd').mkdir(parents=True); (base / 'net').mkdir(); (base / 'task' / str(pid)).mkdir(parents=True)
            (base / 'task' / str(pid) / 'children').write_text(' '.join(str(c) for c in spec.get('children', [])))
            for fd, inode in spec.get('sockets', {}).items():
                os.symlink(f'socket:[{inode}]', base / 'fd' / str(fd))
            for name in ('tcp', 'tcp6'):
                rows = [header] + [f'   0: {l} {r} {st} 00000000:00000000 00:00000000 00000000  {os.getuid()}        0 {inode} 1 0000000000000000 100 0 0 10 0\n'
                                    for (tbl, l, r, st, inode) in table if tbl == name]
                (base / 'net' / name).write_text(''.join(rows))
        return self.root

    L = '0100007F'

    def test_outbound_keepalive_and_accepted_poller_connections_are_open_transports_but_listeners_are_not(self):
        table = [('tcp', f'{self.L}:2259', '00000000:0000', '0A', 11),                         # listener on 8793
                 ('tcp6', '2A010000000000000000000002000000:B368', '2A098280000100000000000015160000:01BB', '01', 12),   # outbound keep-alive
                 ('tcp', f'{self.L}:2259', f'{self.L}:C350', '01', 13)]                         # accepted poll connection on 8793
        proc = self.proc({4000: {'sockets': {3: 11, 4: 12, 5: 13}}}, table)
        rows = mp.managed_sockets([4000], proc=proc)
        self.assertEqual({r['inode'] for r in rows}, {'12', '13'})
        table = table[:1]
        self.assertEqual(mp.managed_sockets([4000], proc=self.proc_reset(table)), [])

    def proc_reset(self, table):
        import shutil
        for child in self.root.iterdir():
            shutil.rmtree(child)
        return self.proc({4000: {'sockets': {3: 11}}}, table)

    def test_managed_opencode_loopback_pair_is_not_counted_but_its_outbound_socket_is(self):
        table = [('tcp', f'{self.L}:2259', '00000000:0000', '0A', 11), ('tcp', f'{self.L}:1000', '00000000:0000', '0A', 21),
                 ('tcp', f'{self.L}:9C40', f'{self.L}:1000', '01', 22), ('tcp', f'{self.L}:1000', f'{self.L}:9C40', '01', 23),
                 ('tcp6', '2A010000000000000000000002000000:B368', '2A098280000100000000000015160000:01BB', '01', 24)]
        proc = self.proc({4000: {'children': [4001], 'sockets': {3: 11, 4: 22}}, 4001: {'sockets': {3: 21, 4: 23, 5: 24}}}, table)
        self.assertEqual({r['inode'] for r in mp.managed_sockets([4000], proc=proc)}, {'24'})

    def test_a_pid_that_exits_while_scanning_is_skipped(self):
        self.assertEqual(mp.managed_sockets([987654], proc=self.root), [])


class Watchdog(unittest.TestCase):
    """Real throwaway processes: the watchdog must undo the pause if its owner dies, and must leave activation state alone."""
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=HERE)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.children = []
        self.addCleanup(lambda: [c.kill() or c.wait() for c in self.children])

    def child(self, code='import time; time.sleep(60)'):
        process = subprocess.Popen([sys.executable, '-c', code])
        self.children.append(process)
        deadline = time.time() + 5
        while mp._proc_info(process.pid) is None and time.time() < deadline:
            time.sleep(0.01)
        return process

    def stopped(self, process):
        os.kill(process.pid, signal.SIGSTOP)
        deadline = time.time() + 5
        while mp._proc_info(process.pid)[1] not in ('T', 't') and time.time() < deadline:
            time.sleep(0.01)
        return mp._proc_info(process.pid)[0]

    def state(self, process):
        deadline = time.time() + 3
        while time.time() < deadline:
            info = mp._proc_info(process.pid)
            if info and info[1] not in ('T', 't'):
                return info[1]
            time.sleep(0.02)
        return 'T'

    def spec(self, owner, supervisor, publisher=None, **extra):
        return {'ownerPid': owner.pid, 'ownerTicks': mp._proc_info(owner.pid)[0], 'deadline': time.time() + 3600,
                'supervisor': [supervisor.pid, self.stopped(supervisor)], 'publisher': [publisher.pid, self.stopped(publisher)] if publisher else None,
                'restartTimer': True, 'timer': 'fake.timer', 'preserve': [str(self.root / 'hold')], **extra}

    def armed_with_dead_owner(self, supervisor, **extra):
        owner = self.child()
        spec = self.spec(owner, supervisor, **extra)
        owner.kill(); owner.wait()
        return spec

    def test_dead_owner_resumes_supervisor_publisher_and_restarts_the_timer(self):
        supervisor, publisher, owner = self.child(), self.child(), self.child('import time; time.sleep(60)')
        spec = self.spec(owner, supervisor, publisher)
        owner.kill(); owner.wait()
        calls = []
        record = mp.watchdog(spec, ctl=lambda action, unit: calls.append((action, unit)), poll=0.02)
        self.assertEqual(record['action'], 'resumed'); self.assertEqual(record['reason'], 'owner_exited')
        self.assertNotIn(self.state(supervisor), ('T', 't')); self.assertNotIn(self.state(publisher), ('T', 't'))
        self.assertEqual(calls, [('start', 'fake.timer')])

    def test_deadline_resumes_even_if_the_owner_is_alive_but_wedged(self):
        supervisor, owner = self.child(), self.child()
        spec = {**self.spec(owner, supervisor), 'deadline': time.time() - 1}
        record = mp.watchdog(spec, ctl=lambda *a: None, poll=0.02)
        self.assertEqual((record['action'], record['reason']), ('resumed', 'deadline'))
        self.assertNotIn(self.state(supervisor), ('T', 't'))

    def test_activation_state_present_means_leave_everything_for_the_operator(self):
        for marker in ('hold',):
            supervisor = self.child()
            spec = self.armed_with_dead_owner(supervisor)
            (self.root / marker).write_text('x')
            record = mp.watchdog(spec, ctl=lambda *a: self.fail('must not touch units'), poll=0.02)
            self.assertEqual(record['action'], 'deferred_to_operator_activation_state_present')
            self.assertEqual(mp._proc_info(supervisor.pid)[1], 'T')            # still frozen: recovery territory

    def test_a_reused_pid_is_never_signalled(self):
        supervisor = self.child()
        spec = self.armed_with_dead_owner(supervisor)
        spec['supervisor'][1] = '1'                                            # identity no longer matches
        mp.watchdog(spec, ctl=lambda *a: None, poll=0.02)
        self.assertEqual(mp._proc_info(supervisor.pid)[1], 'T')

    def test_runs_as_a_detached_process_and_survives_its_owner(self):
        supervisor, owner = self.child(), self.child()
        spec = {**self.spec(owner, supervisor), 'restartTimer': False}
        record_path = self.root / 'record.json'
        process = mp.spawn_watchdog(spec, record_path)
        self.children.append(process)
        time.sleep(0.3)
        self.assertIsNone(process.poll())                                      # armed while the owner lives
        self.assertEqual(mp._proc_info(supervisor.pid)[1], 'T')
        owner.kill(); owner.wait()
        process.wait(timeout=15)
        self.assertEqual(json.loads(record_path.read_text())['action'], 'resumed')
        self.assertNotIn(self.state(supervisor), ('T', 't'))


class GateReproof(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=HERE)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        base = self.root / '101'
        (base / 'task/101').mkdir(parents=True)
        (base / 'task/101/children').write_text('102')
        child = self.root / '102'
        child.mkdir()
        (child / 'cmdline').write_bytes(b'/synthetic/node\0/synthetic/backend\0')
        (child / 'exe').symlink_to('/synthetic/node')
        self.state, self.events, self.status, self.active = 'S', [], {'phase': 'checkpoint', 'workerPid': None, 'cycles': 5}, 0
        self.stat()

    def stat(self):
        (self.root / '101/stat').write_text('101 (synthetic) ' + ' '.join([self.state, '1'] + ['0'] * 17 + ['1000']))

    def gate(self, **kw):
        gate = CheckpointGate(status_path=self.root / 'unused', supervisor_pid=lambda: 101, expected_backend_script='/synthetic/backend', expected_node='/synthetic/node',
                              proc_root=self.root, status_reader=lambda path: dict(self.status), pool_reader=lambda port: {'activeRequests': self.active}, sleep=lambda s: None, **kw)

        def send(pid, ticks, sig):
            self.events.append(sig)
            self.state = 'T' if sig == signal.SIGSTOP else 'S'
            self.stat()
        gate._send = send
        return gate

    def test_verify_frozen_accepts_a_pause_taken_without_a_host_check_and_returns_the_handle(self):
        gate = self.gate()
        frozen = gate.acquire(timeout_seconds=0)
        self.assertIs(self.gate(host_idle=lambda: False).verify_frozen(frozen), frozen)       # host proof is the activation's own, later read
        frozen.release()
        self.assertEqual(self.events, [signal.SIGSTOP, signal.SIGCONT])

    def test_verify_frozen_rejects_every_change_since_the_freeze(self):
        for name, change, text in (('resumed', lambda: setattr(self, 'state', 'S'), 'no longer frozen'),
                                   ('worker', lambda: self.status.update(phase='working', workerPid=9), 'changed during planned pause'),
                                   ('busy pool', lambda: setattr(self, 'active', 1), 'changed during planned pause')):
            with self.subTest(name):
                self.state, self.status, self.active, self.events = 'S', {'phase': 'checkpoint', 'workerPid': None, 'cycles': 5}, 0, []
                self.stat()
                gate = self.gate()
                frozen = gate.acquire(timeout_seconds=0)
                change(); self.stat()
                with self.assertRaisesRegex(GateError, text):
                    gate.verify_frozen(frozen)
        released = FrozenSupervisor(self.gate(), 101, '1000', 102, stopped=False)
        with self.assertRaisesRegex(GateError, 'not frozen'):
            self.gate().verify_frozen(released)


if __name__ == '__main__':
    unittest.main()
