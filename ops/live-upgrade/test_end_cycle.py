"""Owner-authorized cycle end: identities are pinned before the one SIGTERM; nothing else is ever signalled. Fake /proc, no real signals."""
import signal
import tempfile
import unittest
from pathlib import Path

import end_cycle

SUPERVISOR = 4000
WORKER = 5000


def stat_line(pid, *, state='S', ppid=SUPERVISOR, pgrp=None, session=None, ticks='777'):
    pgrp = pid if pgrp is None else pgrp
    session = pid if session is None else session
    fields = [state, str(ppid), str(pgrp), str(session)] + ['0'] * 15 + [ticks]
    return f'{pid} (claude) ' + ' '.join(fields) + ' 0 0\n'


class EndCycle(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.proc = Path(self.temp.name)
        self.now = 10000.0
        self.signals = []
        self.logs = []
        self.set_worker()
        self.status = {'phase': 'working', 'workerPid': WORKER, 'cycleStartedAt': self.now - 3600, 'cycles': 12}

    def set_worker(self, **kw):
        directory = self.proc / str(WORKER)
        directory.mkdir(exist_ok=True)
        (directory / 'stat').write_text(stat_line(WORKER, **kw))

    def end(self, **kw):
        kw.setdefault('min_age', 900)
        return end_cycle.end_running_cycle(read_status=lambda: self.status, supervisor_pid=lambda: SUPERVISOR, proc=self.proc, killpg=lambda pid, sig: self.signals.append((pid, sig)),
                                           wall=lambda: self.now, clock=lambda: 0.0, sleep=lambda s: self.fail('must not wait'), log=self.logs.append, **kw)

    def test_a_long_cycle_gets_exactly_one_sigterm_to_its_own_process_group(self):
        result = self.end()
        self.assertEqual(self.signals, [(WORKER, signal.SIGTERM)])
        self.assertEqual((result['action'], result['pid'], result['cycles']), ('sigterm_process_group', WORKER, 12))
        self.assertEqual(result['supervisorPid'], SUPERVISOR)

    def test_the_default_minimum_age_is_two_minutes(self):
        self.assertEqual(end_cycle.DEFAULT_MIN_AGE, 120.0)
        run = lambda: end_cycle.end_running_cycle(read_status=lambda: self.status, supervisor_pid=lambda: SUPERVISOR, proc=self.proc, killpg=lambda pid, sig: self.signals.append((pid, sig)),
                                                  wall=lambda: self.now, clock=lambda: 0.0, deadline=0.0, sleep=lambda s: self.fail('must not wait'), log=self.logs.append)
        self.status['cycleStartedAt'] = self.now - 100      # 100 s old: under the default, and no time left to wait for it
        self.assertEqual(run()['action'], 'none')
        self.assertEqual(self.signals, [])
        self.status['cycleStartedAt'] = self.now - 130      # 130 s old: ended
        self.assertEqual(run()['action'], 'sigterm_process_group')
        self.assertEqual(self.signals, [(WORKER, signal.SIGTERM)])

    def test_no_running_cycle_signals_nothing(self):
        for status in ({'phase': 'checkpoint', 'workerPid': None}, {'phase': 'waiting_for_free_pool'}, {'phase': 'paused', 'workerPid': None}, None):
            self.status = status
            self.assertEqual(self.end()['action'], 'none')
        self.assertEqual(self.signals, [])

    def test_a_young_cycle_is_left_alone_when_it_cannot_reach_the_minimum_age_in_time(self):
        self.status['cycleStartedAt'] = self.now - 60
        result = end_cycle.end_running_cycle(read_status=lambda: self.status, supervisor_pid=lambda: SUPERVISOR, proc=self.proc, killpg=lambda *a: self.signals.append(a),
                                             wall=lambda: self.now, clock=lambda: 0.0, deadline=100.0, min_age=900, sleep=lambda s: self.fail('no wait past the deadline'), log=self.logs.append)
        self.assertEqual(result['action'], 'none')
        self.assertEqual(self.signals, [])

    def test_a_young_cycle_waits_until_it_is_old_enough_then_ends(self):
        self.status['cycleStartedAt'] = self.now - 880
        waits = []

        def sleep(seconds):
            waits.append(seconds)
            self.now += seconds
        result = end_cycle.end_running_cycle(read_status=lambda: self.status, supervisor_pid=lambda: SUPERVISOR, proc=self.proc, killpg=lambda *a: self.signals.append(a),
                                             wall=lambda: self.now, clock=lambda: 0.0, deadline=10000.0, min_age=900, sleep=sleep, log=self.logs.append)
        self.assertEqual(result['action'], 'sigterm_process_group')
        self.assertEqual(len(self.signals), 1)
        self.assertTrue(waits)

    def test_the_worker_must_be_the_supervisors_own_group_leader_child(self):
        for kw in ({'ppid': 1}, {'pgrp': 1}, {'session': 1}, {'state': 'Z'}):
            self.signals.clear()
            self.set_worker(**kw)
            with self.subTest(kw), self.assertRaises(end_cycle.EndCycleError):
                self.end()
            self.assertEqual(self.signals, [])

    def test_a_vanished_worker_or_changed_cycle_signals_nothing(self):
        (self.proc / str(WORKER) / 'stat').unlink()
        with self.assertRaises(end_cycle.EndCycleError):
            self.end()
        self.set_worker()
        states = [self.status, {**self.status, 'cycleStartedAt': self.now - 5, 'workerPid': WORKER + 1}]
        result = end_cycle.end_running_cycle(read_status=lambda: states.pop(0) if len(states) > 1 else states[0], supervisor_pid=lambda: SUPERVISOR, proc=self.proc,
                                             killpg=lambda *a: self.signals.append(a), wall=lambda: self.now, clock=lambda: 0.0, min_age=900, sleep=lambda s: None, log=self.logs.append)
        self.assertEqual(result['action'], 'none')
        self.assertEqual(self.signals, [])

    def test_a_process_replaced_between_check_and_signal_is_refused(self):
        calls = []
        original = end_cycle._stat_fields

        def fields(pid, proc):
            calls.append(pid)
            value = original(pid, proc)
            return {**value, 'ticks': 'other'} if len(calls) > 1 else value
        end_cycle._stat_fields = fields
        self.addCleanup(setattr, end_cycle, '_stat_fields', original)
        with self.assertRaisesRegex(end_cycle.EndCycleError, 'identity changed'):
            self.end()
        self.assertEqual(self.signals, [])

    def test_a_cycle_without_a_recorded_start_is_refused(self):
        self.status['cycleStartedAt'] = None
        with self.assertRaises(end_cycle.EndCycleError):
            self.end()


if __name__ == '__main__':
    unittest.main()
