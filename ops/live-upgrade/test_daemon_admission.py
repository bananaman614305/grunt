"""Synthetic /proc and systemd fixtures; never signal or inspect live daemons."""
import json
import hashlib
import os
from pathlib import Path
import signal
import socket
import tempfile
import unittest
from unittest.mock import patch

from daemon_admission import AdmissionError, OwnedDaemonAdmission, OPENCODE_ARGV0, OPENCODE_EXE, unix_socket_diagnostics


class AdmissionFixture(unittest.TestCase):
    def setUp(self):
        self.profile_pin = patch('daemon_admission.OPENCODE_CONTENT_SHA256', hashlib.sha256(b'{"permission":{"external_directory":"deny"}}').hexdigest()); self.profile_pin.start(); self.addCleanup(self.profile_pin.stop)
        self.tmp = tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.proc = self.root / 'proc'; self.proc.mkdir()
        self.runtime = self.root / 'run'; self.runtime.mkdir(mode=0o700)
        self.events = []; self.states = {}; self.time = 0
        self.unix_rows = {}
        self.units = {
            'milo.service': {'ActiveState': 'active', 'Restart': 'on-failure', 'MainPID': '101', 'StandardOutput': 'journal', 'StandardError': 'inherit'},
            'grunt-amazing-adventure.service': {'ActiveState': 'active', 'Restart': 'always', 'MainPID': '103', 'StandardOutput': 'journal', 'StandardError': 'inherit'}}
        for pid, port, script, parent in [(101, 8792, '/synthetic/primary.js', 1), (102, 8793, '/synthetic/backend.mjs', 103)]:
            root = self.proc / str(pid)
            (root / 'task' / str(pid)).mkdir(parents=True)
            (root / 'task' / str(pid) / 'children').write_text('')
            (root / 'fd').mkdir(); (root / 'net').mkdir()
            (root / 'cmdline').write_bytes(('/synthetic/node\0' + script + '\0').encode())
            (root / 'exe').symlink_to('/synthetic/node')
            (root / 'fd/0').symlink_to('/dev/null')
            (root / 'fd/1').symlink_to('socket:[900]'); (root / 'fd/2').symlink_to('socket:[900]')
            (root / 'fd/18').symlink_to('socket:[' + str(pid * 10) + ']')
            (root / 'net/tcp').write_text('header\n' + self.tcp(pid * 10, port))
            (root / 'net/tcp6').write_text('header\n')
            (root / 'net/unix').write_text('header\n000: 2 0 0 0001 03 900\n')
            self.states[pid] = ['S', str(parent), str(pid * 100)]
            self.stat(pid)
        self.guard = OwnedDaemonAdmission(node='/synthetic/node', primary_script='/synthetic/primary.js',
            backend_script='/synthetic/backend.mjs', primary_pid=101, backend_pid=102, supervisor_pid=103,
            runtime_directory=self.runtime, env={}, proc_root=self.proc,
            unit_reader=lambda unit, field: self.units[unit][field], reload=self.reload,
            sender=self.send, clock=lambda: self.time, sleep=self.sleep,
            unix_diag_reader=lambda: self.unix_rows)

    def tcp(self, inode, port, *, state='0A', remote='00000000:0000', queue='00000000:00000000'):
        return f'0: 0100007F:{port:04X} {remote} {state} {queue} 00:00000000 00000000 1000 0 {inode}\n'

    def tcp6(self, inode, port, *, state='0A', remote='00000000:0000', queue='00000000:00000000'):
        fields=self.tcp(inode,port,state=state,remote=remote,queue=queue).split()
        fields[1]='0000000000000000FFFF0000'+fields[1]
        address,remote_port=fields[2].split(':')
        fields[2]=('0'*32 if address=='00000000' else '0000000000000000FFFF0000'+address)+':'+remote_port
        return ' '.join(fields)+'\n'

    def stat(self, pid):
        state, parent, ticks = self.states[pid]
        (self.proc / str(pid) / 'stat').write_text(str(pid) + ' (fixture node) ' + ' '.join([state, parent] + ['0'] * 17 + [ticks]))

    def reload(self):
        self.events.append('reload')
        for unit, original in [('milo.service', 'on-failure'), ('grunt-amazing-adventure.service', 'always')]:
            path = self.runtime / 'systemd/user' / (unit + '.d/99-grunt-runtime-cutover.conf')
            self.units[unit]['Restart'] = 'no' if path.exists() else original

    def send(self, pid, ticks, sig):
        if ticks != self.states[pid][2]: raise AdmissionError('Daemon PID identity changed')
        self.events.append((pid, sig))
        self.states[pid][0] = {signal.SIGSTOP: 'T', signal.SIGCONT: 'S', signal.SIGKILL: 'Z'}[sig]
        self.stat(pid)

    def sleep(self, seconds): self.time += seconds

    def owned_paths(self): return list(self.runtime.rglob('99-grunt-runtime-cutover.conf'))

    def managed_child(self):
        root = self.proc / '104'
        (root / 'task/104').mkdir(parents=True); (root / 'task/104/children').write_text('')
        (root / 'fd').mkdir(); (root / 'net').mkdir()
        # Explicit joining avoids numeric/octal escape ambiguity in fixture argv.
        (root / 'cmdline').write_bytes(b'\0'.join(value.encode() for value in [OPENCODE_ARGV0, 'serve', '--hostname', '127.0.0.1', '--port', '0']) + b'\0')
        (root / 'exe').symlink_to(OPENCODE_EXE)
        (root / 'environ').write_bytes(b'HOME=/home/alan\0OPENCODE_CONFIG_CONTENT={"permission":{"external_directory":"deny"}}\0')
        (root / 'cwd').symlink_to('/synthetic/owner'); (self.proc / '102/cwd').symlink_to('/synthetic/owner')
        (root / 'fd/0').symlink_to('/dev/null'); (root / 'fd/1').symlink_to('pipe:[777]'); (root / 'fd/2').symlink_to('/dev/null')
        (root / 'fd/18').symlink_to('socket:[1040]')
        (root / 'net/tcp').write_text('header\n' + self.tcp(1040, 4096))
        (root / 'net/tcp6').write_text('header\n'); (root / 'net/unix').write_text('header\n')
        self.states[104] = ['S', '102', '10400']; self.stat(104)
        (self.proc / '102/task/102/children').write_text('104')
        self.guard.metadata_reader = lambda row: {}
        self.guard.idle_checker = lambda: True
        return root

    def idle_managed_transport(self):
        parent, child = self.proc / '102', self.proc / '104'
        (parent / 'fd/21').symlink_to('socket:[2021]'); (child / 'fd/21').symlink_to('socket:[4021]')
        with (parent / 'net/tcp').open('a') as stream: stream.write(self.tcp(2021, 40000, state='01', remote='0100007F:1000'))
        with (child / 'net/tcp').open('a') as stream: stream.write(self.tcp(4021, 4096, state='01', remote='0100007F:9C40'))

    def unix_endpoint(self, pid, fd, inode):
        root = self.proc / str(pid)
        path = root / 'fd' / str(fd)
        if path.is_symlink(): path.unlink()
        path.symlink_to('socket:[' + str(inode) + ']')
        with (root / 'net/unix').open('a') as stream: stream.write(f'000: 2 0 0 0001 03 {inode}\n')

    def unix_pair_metadata(self, first, second):
        for inode, peer in [(first, second), (second, first)]:
            self.unix_rows[str(inode)] = {'peer': str(peer), 'type': socket.SOCK_STREAM, 'state': 1, 'receiveQueue': 0, 'sendQueue': 0}

    def assert_aborted_without_kills(self):
        self.assertFalse(self.guard.kill_started)
        self.assertFalse(any(isinstance(row, tuple) and row[1] == signal.SIGKILL for row in self.events))
        self.assertEqual([self.states[pid][0] for pid in (101, 102)], ['S', 'S'])
        self.assertEqual(self.owned_paths(), [])

    def execution_host(self):
        unit='grunt-adventure-execution-host.service';root=self.proc/'105'
        (root/'task/105').mkdir(parents=True);(root/'task/105/children').write_text('');(root/'fd').mkdir();(root/'net').mkdir()
        (root/'cmdline').write_bytes(b'\0'.join(value.encode() for value in ['/synthetic/node','/synthetic/host.js','execution-host','serve','--config','/synthetic/policy.json'])+b'\0');(root/'exe').symlink_to('/synthetic/node')
        (root/'fd/1').symlink_to('socket:[900]');(root/'fd/2').symlink_to('socket:[900]')
        (root/'net/tcp').write_text('header\n');(root/'net/tcp6').write_text('header\n');(root/'net/unix').write_text('header\n000: 2 0 0 0001 03 900\n')
        self.states[105]=['S','1','10500'];self.stat(105)
        self.units[unit]={'ActiveState':'active','Restart':'on-failure','MainPID':'105','StandardOutput':'journal','StandardError':'inherit'}
        def reload():
            self.reload();path=self.runtime/'systemd/user'/ (unit+'.d/99-grunt-runtime-cutover.conf');self.units[unit]['Restart']='no' if path.exists() else 'on-failure'
        self.guard=OwnedDaemonAdmission(node='/synthetic/node',primary_script='/synthetic/primary.js',backend_script='/synthetic/backend.mjs',primary_pid=101,backend_pid=102,supervisor_pid=103,runtime_directory=self.runtime,env={},proc_root=self.proc,unit_reader=lambda u,f:self.units[u][f],reload=reload,sender=self.send,clock=lambda:self.time,sleep=self.sleep,unix_diag_reader=lambda:self.unix_rows,host_pid=105,host_script='/synthetic/host.js',host_policy='/synthetic/policy.json')
        return root
    def test_execution_host_is_third_frozen_verified_daemon(self):
        self.execution_host();self.guard.install_restart_guards();self.guard.freeze_and_verify();self.guard.kill_verified_daemons();self.guard.restore_restart_guards()
        self.assertTrue(self.guard.all_dead);self.assertEqual(self.states[105][0],'Z');self.assertIn((105,signal.SIGKILL),self.events);self.assertEqual(self.owned_paths(),[])
    def test_execution_host_child_job_aborts_without_signals_or_kills(self):
        root=self.execution_host();(root/'task/105/children').write_text('999');self.guard.install_restart_guards()
        with self.assertRaises(AdmissionError):self.guard.freeze_and_verify()
        self.assert_aborted_without_kills();self.assertEqual(self.states[105][0],'S')
    def test_execution_host_outbound_socket_preserves_work(self):
        root=self.execution_host();(root/'fd/19').symlink_to('socket:[1051]');(root/'net/tcp').write_text('header\n'+self.tcp(1051,40000,state='01',remote='0100007F:0050'));self.guard.install_restart_guards()
        with self.assertRaises(AdmissionError):self.guard.freeze_and_verify()
        self.assert_aborted_without_kills();self.assertEqual(self.states[105][0],'S')
    def test_execution_host_wrong_unit_pid_is_never_signaled(self):
        self.execution_host();self.units['grunt-adventure-execution-host.service']['MainPID']='999'
        with self.assertRaises(AdmissionError):self.guard.install_restart_guards()
        self.assertFalse(self.events);self.assertEqual(self.owned_paths(),[])
    def test_socket_rejection_diagnostic_is_address_free_and_retry_tagged(self):
        root=self.execution_host();(root/'fd/19').symlink_to('socket:[1051]');(root/'net/tcp').write_text('header\n'+self.tcp(1051,40000,state='01',remote='0100007F:0050'));self.guard.install_restart_guards()
        with self.assertRaises(AdmissionError) as caught:self.guard.freeze_and_verify()
        self.assertEqual(caught.exception.admission_rejection_code,'socket_busy')
        value=self.guard.receipt['socketRejections'][0]
        self.assertEqual(value,{'pid':105,'role':'execution_host','family':'tcp','state':'01','phase':'frozen_verification'})
        self.assertNotIn('0100007F',json.dumps(value));self.assertNotIn('remote',value);self.assertFalse(self.guard.kill_started)
    def test_effective_guards_freeze_both_verify_then_kill_without_any_resume(self):
        self.guard.install_restart_guards()
        self.assertEqual(self.events, ['reload'])
        self.assertEqual([self.units[unit]['Restart'] for unit in self.guard.UNITS], ['no', 'no'])
        self.guard.freeze_and_verify(); self.guard.kill_verified_daemons()
        self.assertTrue(self.guard.all_dead)
        self.assertEqual(self.events, ['reload', (101, signal.SIGSTOP), (102, signal.SIGSTOP), (101, signal.SIGKILL), (102, signal.SIGKILL)])
        self.assertTrue(self.owned_paths())
        self.guard.restore_restart_guards()
        self.assertEqual(self.owned_paths(), [])
        self.assertEqual([self.units[unit]['Restart'] for unit in self.guard.UNITS], ['on-failure', 'always'])
        self.assertTrue(self.guard.receipt['restartGuardsRestored'])
        self.assertEqual(len(self.guard.receipt['restartGuards']), 2)
        self.assertNotIn('Environment', json.dumps(self.guard.receipt))

    def test_preexisting_runtime_guard_is_preserved_without_signals(self):
        path = self.runtime / 'systemd/user/milo.service.d/99-grunt-runtime-cutover.conf'
        path.parent.mkdir(parents=True); path.write_text('owner pause')
        with self.assertRaises(FileExistsError): self.guard.install_restart_guards()
        self.assertEqual(path.read_text(), 'owner pause'); self.assertEqual(self.events, [])

    def test_ineffective_restart_override_is_removed_without_restarting_or_signaling(self):
        self.guard.reload = lambda: None
        with self.assertRaisesRegex(AdmissionError, 'not effective'): self.guard.install_restart_guards()
        self.assertEqual(self.owned_paths(), []); self.assertEqual(self.events, [])

    def test_deliberately_frozen_primary_is_never_resumed(self):
        self.states[101][0] = 'T'; self.stat(101)
        self.guard.install_restart_guards()
        with self.assertRaisesRegex(AdmissionError, 'deliberately paused'): self.guard.freeze_and_verify()
        self.assertEqual(self.states[101][0], 'T')
        self.assertFalse(any(isinstance(event, tuple) for event in self.events))

    def test_child_job_in_any_daemon_thread_fails_closed_and_resumes_existing_work(self):
        task = self.proc / '102/task/999'; task.mkdir(); (task / 'children').write_text('501')
        self.guard.install_restart_guards()
        with self.assertRaisesRegex(AdmissionError, 'child job'): self.guard.freeze_and_verify()
        self.assert_aborted_without_kills()

    def test_request_accepted_after_idle_observation_is_detected_while_frozen(self):
        root = self.proc / '101'; (root / 'fd/21').symlink_to('socket:[2222]')
        with (root / 'net/tcp').open('a') as stream: stream.write(self.tcp(2222, 8792, state='01', remote='0100007F:A123'))
        self.guard.install_restart_guards()
        with self.assertRaisesRegex(AdmissionError, 'accepted, outbound'): self.guard.freeze_and_verify()
        self.assert_aborted_without_kills()

    def test_closed_inbound_request_with_outbound_call_is_still_rejected(self):
        root = self.proc / '102'; (root / 'fd/21').symlink_to('socket:[2222]')
        with (root / 'net/tcp').open('a') as stream: stream.write(self.tcp(2222, 40000, state='01', remote='0100007F:01BB'))
        self.guard.install_restart_guards()
        with self.assertRaisesRegex(AdmissionError, 'accepted, outbound'): self.guard.freeze_and_verify()
        self.assert_aborted_without_kills()

    def test_unmapped_socket_including_udp_or_ipc_is_ambiguous_and_rejected(self):
        (self.proc / '101/fd/21').symlink_to('socket:[3333]')
        self.guard.install_restart_guards()
        with self.assertRaisesRegex(AdmissionError, 'unknown socket'): self.guard.freeze_and_verify()
        self.assert_aborted_without_kills()

    def test_queued_kernel_backlog_is_rejected_retry_tagged_and_completely_unfrozen(self):
        (self.proc / '101/net/tcp').write_text('header\n' + self.tcp(1010, 8792, queue='00000000:00000001'))
        self.guard.install_restart_guards()
        with self.assertRaisesRegex(AdmissionError, 'queued ingress') as caught: self.guard.freeze_and_verify()
        self.assertEqual(caught.exception.admission_rejection_code,'socket_busy')
        self.assertFalse(hasattr(caught.exception,'socket_inode'))
        self.assertEqual(self.guard.receipt['socketRejections'],[{'pid':101,'role':'primary','family':'tcp','state':'0A','phase':'frozen_verification','reason':'listener_queued_ingress'}])
        self.assertEqual(self.guard.frozen,[]);self.assertEqual(self.guard.guards,[])
        self.assertTrue(self.guard.receipt['restartGuardsRestored'])
        self.assertEqual([self.units[u]['Restart'] for u in self.guard.UNITS],['on-failure','always'])
        self.assert_aborted_without_kills()

    def test_queued_listener_diagnostics_are_bounded_and_omit_addresses_and_queue_bytes(self):
        row=self.guard.targets[0]
        (self.proc/'101/net/tcp').write_text('header\n'+self.tcp(1010,8792,queue='00000001:00000000'))
        for _ in range(40):
            with self.assertRaisesRegex(AdmissionError,'queued ingress') as caught:self.guard._sockets(row)
            self.assertEqual(caught.exception.admission_rejection_code,'socket_busy')
        self.assertEqual(len(self.guard.receipt['socketRejections']),16)
        value=json.dumps(self.guard.receipt['socketRejections'])
        for private in ('0100007F','8792','00000001:00000000','remote','listenerInode'):self.assertNotIn(private,value)
        self.assertFalse(self.events);self.assertFalse(self.guard.kill_started)

    def test_malformed_listener_queue_metadata_is_terminal_and_never_a_busy_retry(self):
        (self.proc/'101/net/tcp').write_text('header\n'+self.tcp(1010,8792,queue='not-a-kernel-queue'))
        self.guard.install_restart_guards()
        with self.assertRaisesRegex(AdmissionError,'Ambiguous kernel TCP listener queue') as caught:self.guard.freeze_and_verify()
        self.assertFalse(hasattr(caught.exception,'admission_rejection_code'))
        self.assert_aborted_without_kills()

    def test_queued_backend_with_managed_child_is_never_given_a_transport_drain_exception(self):
        self.managed_child();self.idle_managed_transport()
        (self.proc/'102/net/tcp').write_text((self.proc/'102/net/tcp').read_text().replace('00000000:00000000','00000000:00000001',1))
        self.guard.quiet_checker=lambda:True;self.guard.install_restart_guards()
        with self.assertRaisesRegex(AdmissionError,'queued ingress') as caught:self.guard.freeze_and_verify()
        self.assertEqual(caught.exception.admission_rejection_code,'socket_busy')
        self.assertFalse(hasattr(caught.exception,'socket_inode'))
        self.assertEqual(self.time,0);self.assert_aborted_without_kills()
        self.assertEqual(self.states[104][0],'S')

    def test_journal_socket_must_be_confined_to_verified_inherited_logging_fds(self):
        (self.proc / '101/fd/21').symlink_to('socket:[900]')
        self.guard.install_restart_guards()
        with self.assertRaisesRegex(AdmissionError, 'unknown socket'): self.guard.freeze_and_verify()
        self.assert_aborted_without_kills()

    def test_wrong_backend_parent_is_not_treated_as_the_managed_daemon(self):
        self.states[102][1] = '999'; self.stat(102)
        with self.assertRaisesRegex(AdmissionError, 'supervisor identity'): self.guard.install_restart_guards()
        self.assertEqual(self.events, [])

    def test_new_network_activity_between_verification_and_kill_is_not_ignored(self):
        self.guard.install_restart_guards(); self.guard.freeze_and_verify()
        (self.proc / '101/fd/21').symlink_to('socket:[3333]')
        with self.assertRaisesRegex(AdmissionError, 'unknown socket'): self.guard.kill_verified_daemons()
        self.guard.abort_before_kill(); self.assert_aborted_without_kills()

    def test_queued_listener_at_pre_kill_recheck_never_sends_kill_and_can_cleanly_abort(self):
        self.guard.install_restart_guards();self.guard.freeze_and_verify()
        (self.proc/'101/net/tcp').write_text('header\n'+self.tcp(1010,8792,queue='00000000:00000001'))
        with self.assertRaisesRegex(AdmissionError,'queued ingress') as caught:self.guard.kill_verified_daemons()
        self.assertEqual(caught.exception.admission_rejection_code,'socket_busy')
        self.assertEqual(self.guard.receipt['socketRejections'][0]['phase'],'pre_kill_recheck')
        self.assertFalse(self.guard.kill_started);self.assertFalse(self.guard.all_dead)
        self.assertFalse(any(isinstance(event,tuple) and event[1]==signal.SIGKILL for event in self.events))
        self.assertEqual([self.states[pid][0] for pid in (101,102)],['T','T'])
        self.guard.abort_before_kill();self.assert_aborted_without_kills()
        self.assertEqual(self.guard.frozen,[]);self.assertTrue(self.guard.receipt['restartGuardsRestored'])

    def test_partial_kill_never_resumes_other_daemon_or_restores_restart_guards(self):
        original = self.guard.send
        def failing(pid, ticks, sig):
            if pid == 102 and sig == signal.SIGKILL: raise PermissionError('synthetic second kill rejected')
            return original(pid, ticks, sig)
        self.guard.send = failing
        self.guard.install_restart_guards(); self.guard.freeze_and_verify()
        with self.assertRaises(PermissionError): self.guard.kill_verified_daemons()
        self.assertTrue(self.guard.kill_started); self.assertFalse(self.guard.all_dead)
        with self.assertRaisesRegex(AdmissionError, 'preserve remaining'): self.guard.abort_before_kill()
        with self.assertRaisesRegex(AdmissionError, 'until both'): self.guard.restore_restart_guards()
        self.assertEqual(self.states[102][0], 'T'); self.assertEqual(len(self.owned_paths()), 2)
        self.assertFalse(any(isinstance(event, tuple) and event[1] == signal.SIGCONT for event in self.events))

    def test_replaced_owned_guard_is_not_deleted(self):
        self.guard.install_restart_guards()
        path = self.owned_paths()[0]; path.unlink(); path.write_text('different owner')
        with self.assertRaisesRegex(AdmissionError, 'guard changed'): self.guard.restore_restart_guards()
        self.assertEqual(path.read_text(), 'different owner')

    def test_pid_reuse_before_kill_does_not_signal_the_new_process(self):
        self.guard.install_restart_guards(); self.guard.freeze_and_verify()
        self.states[101][2] = '99999'; self.stat(101)
        with self.assertRaisesRegex(AdmissionError, 'PID identity'): self.guard.kill_verified_daemons()
        self.assertFalse(self.guard.kill_started)
        self.assertFalse(any(isinstance(event, tuple) and event[1] == signal.SIGKILL for event in self.events))

    def test_kernel_signal_uses_pinned_pidfd_and_closes_it_without_signaling_reused_pid(self):
        with patch('daemon_admission.os.pidfd_open', return_value=731) as opened, patch('daemon_admission.signal.pidfd_send_signal') as sent, patch('daemon_admission.os.close') as closed:
            self.guard._pidfd_signal(101, '10100', signal.SIGSTOP)
            opened.assert_called_once_with(101); sent.assert_called_once_with(731, signal.SIGSTOP); closed.assert_called_once_with(731)
        with patch('daemon_admission.os.pidfd_open', return_value=732), patch('daemon_admission.signal.pidfd_send_signal') as sent, patch('daemon_admission.os.close') as closed:
            with self.assertRaisesRegex(AdmissionError, 'PID identity'): self.guard._pidfd_signal(101, 'reused', signal.SIGKILL)
            sent.assert_not_called(); closed.assert_called_once_with(732)

    def test_reviewed_idle_opencode_child_is_frozen_with_daemons_and_killed_first(self):
        self.managed_child(); self.guard.install_restart_guards(); self.guard.freeze_and_verify(); self.guard.kill_verified_daemons()
        self.assertEqual([event for event in self.events if isinstance(event, tuple)], [(101, signal.SIGSTOP), (102, signal.SIGSTOP), (104, signal.SIGSTOP), (104, signal.SIGKILL), (101, signal.SIGKILL), (102, signal.SIGKILL)])
        self.assertTrue(self.guard.all_dead); self.assertEqual(self.guard.receipt['managedOpenCode']['readOnlySessionStatus'], 'all_idle')
        self.assertNotIn('permission', json.dumps(self.guard.receipt)); self.guard.restore_restart_guards()

    def test_managed_child_busy_or_retrying_session_never_freezes_or_kills_it(self):
        self.managed_child(); self.guard.metadata_reader = lambda row: {'ses_fixture': {'type': 'busy'}}
        self.guard.install_restart_guards()
        with self.assertRaisesRegex(AdmissionError, 'busy or ambiguous'): self.guard.freeze_and_verify()
        self.assertEqual(self.states[104][0], 'S'); self.assert_aborted_without_kills()

    def test_managed_child_profile_binary_or_account_drift_is_not_whitelisted(self):
        root = self.managed_child(); (root / 'environ').write_bytes((root / 'environ').read_bytes() + b'OPENCODE_SERVER_PASSWORD=synthetic-secret\0')
        calls = []; self.guard.metadata_reader = lambda row: calls.append(row) or {}
        self.guard.install_restart_guards()
        with self.assertRaisesRegex(AdmissionError, 'unmanaged child job'): self.guard.freeze_and_verify()
        self.assertEqual(calls, []); self.assert_aborted_without_kills()

    def test_same_named_child_with_different_executable_is_not_whitelisted(self):
        root = self.managed_child(); (root / 'exe').unlink(); (root / 'exe').symlink_to('/synthetic/imposter')
        self.guard.install_restart_guards()
        with self.assertRaisesRegex(AdmissionError, 'unmanaged child job'): self.guard.freeze_and_verify()
        self.assert_aborted_without_kills()

    def test_managed_child_cannot_hide_another_native_tool_process(self):
        root = self.managed_child(); (root / 'task/104/children').write_text('999')
        self.guard.install_restart_guards()
        with self.assertRaisesRegex(AdmissionError, 'unmanaged child job'): self.guard.freeze_and_verify()
        self.assert_aborted_without_kills()

    def test_opencode_child_external_network_activity_is_rejected_even_with_idle_claim(self):
        root = self.managed_child(); (root / 'fd/21').symlink_to('socket:[2222]')
        with (root / 'net/tcp').open('a') as stream: stream.write(self.tcp(2222, 40000, state='01', remote='01010101:01BB'))
        self.guard.install_restart_guards()
        with self.assertRaisesRegex(AdmissionError, 'accepted, outbound'): self.guard.freeze_and_verify()
        self.assert_aborted_without_kills()

    def test_managed_idle_parent_transport_may_close_naturally_before_any_freeze(self):
        self.managed_child(); self.idle_managed_transport()
        metadata = []; self.guard.metadata_reader = lambda row: metadata.append(row['pid']) or {}
        def naturally_close(seconds):
            self.sleep(seconds); self.events.append(('natural_idle_transport_close',))
            for pid, port in [(102, 8793), (104, 4096)]:
                (self.proc / str(pid) / 'fd/21').unlink()
                (self.proc / str(pid) / 'net/tcp').write_text('header\n' + self.tcp(pid * 10, port))
        self.guard.sleep = naturally_close
        self.guard.install_restart_guards(); self.guard.freeze_and_verify(); self.guard.kill_verified_daemons()
        self.assertLess(self.events.index(('natural_idle_transport_close',)), self.events.index((101, signal.SIGSTOP)))
        self.assertGreaterEqual(len(metadata),3);self.assertEqual(set(metadata),{104}); self.assertTrue(self.guard.all_dead); self.guard.restore_restart_guards()

    def test_managed_idle_transport_timeout_preserves_existing_sockets_and_processes(self):
        self.managed_child(); self.idle_managed_transport(); self.guard.quiet_timeout = .1
        self.guard.install_restart_guards()
        with self.assertRaisesRegex(AdmissionError, 'did not naturally close'): self.guard.freeze_and_verify()
        self.assertTrue((self.proc / '102/fd/21').is_symlink()); self.assertEqual(self.states[104][0], 'S')
        self.assert_aborted_without_kills()

    def test_new_pool_work_during_quiet_wait_aborts_instead_of_waiting_for_completion(self):
        self.managed_child(); self.idle_managed_transport()
        calls = [0]
        def idle(): calls[0] += 1; return calls[0] < 3
        self.guard.idle_checker = idle
        self.guard.install_restart_guards()
        with self.assertRaisesRegex(AdmissionError, 'New pool work'): self.guard.freeze_and_verify()
        self.assertLessEqual(self.time, 1); self.assert_aborted_without_kills()

    def backend_idle_tcp6(self):
        self.managed_child();self.guard.quiet_checker=lambda:True
        root=self.proc/'102';(root/'fd/29').symlink_to('socket:[6029]')
        (root/'net/tcp6').write_text('header\n'+self.tcp6(6029,40000,state='01',remote='01010101:01BB'))
        return root
    def test_existing_backend_tcp6_closes_naturally_before_any_daemon_freeze(self):
        root=self.backend_idle_tcp6();observations=[]
        def close(seconds):
            self.sleep(seconds);observations.append(self.time);self.assertFalse(self.guard.frozen)
            (root/'fd/29').unlink();(root/'net/tcp6').write_text('header\n')
        self.guard.sleep=close;self.guard.install_restart_guards();self.guard.freeze_and_verify()
        self.assertEqual(observations,[1]);self.assertTrue(self.guard.verified);self.assertFalse(self.guard.kill_started)
        self.guard.abort_before_kill();self.assert_aborted_without_kills()
    def test_backend_tcp6_timeout_never_freezes_or_kills_daemons(self):
        root=self.backend_idle_tcp6();self.guard.quiet_timeout=60;self.guard.install_restart_guards()
        with self.assertRaisesRegex(AdmissionError,'did not naturally close') as timeout:self.guard.freeze_and_verify()
        self.assertEqual(timeout.exception.admission_rejection_code,'socket_busy')
        self.assertEqual(self.time,60);self.assertTrue((root/'fd/29').is_symlink());self.assertFalse(any(isinstance(v,tuple) for v in self.events));self.assert_aborted_without_kills()
    def test_new_backend_socket_during_wait_is_not_treated_as_existing_idle_transport(self):
        root=self.backend_idle_tcp6()
        def change(seconds):
            self.sleep(seconds);(root/'fd/29').unlink();(root/'fd/30').symlink_to('socket:[6030]');(root/'net/tcp6').write_text('header\n'+self.tcp6(6030,40001,state='01',remote='01010101:01BB'))
        self.guard.sleep=change;self.guard.install_restart_guards()
        with self.assertRaisesRegex(AdmissionError,'accepted, outbound'):self.guard.freeze_and_verify()
        self.assertEqual(self.time,1);self.assert_aborted_without_kills()
    def test_existing_socket_cannot_mask_simultaneous_new_backend_socket(self):
        root=self.backend_idle_tcp6();self.guard.quiet_timeout=3
        network=self.guard._network
        def ordered(row):
            owners,tcp,unix=network(row);return dict(sorted(owners.items())),tcp,unix
        self.guard._network=ordered
        def add(seconds):
            self.sleep(seconds);(root/'fd/30').symlink_to('socket:[6030]')
            with (root/'net/tcp6').open('a') as stream:stream.write(self.tcp6(6030,40001,state='01',remote='01010101:01BB'))
        self.guard.sleep=add;self.guard.install_restart_guards()
        with self.assertRaisesRegex(AdmissionError,'accepted, outbound') as caught:self.guard.freeze_and_verify()
        self.assertEqual(caught.exception.socket_inode,'6030');self.assertEqual(self.time,1)
        self.assertTrue((root/'fd/29').is_symlink());self.assertTrue((root/'fd/30').is_symlink());self.assert_aborted_without_kills()
    def native_idle_tcp6(self):
        self.managed_child();self.guard.quiet_checker=lambda:True
        root=self.proc/'104';(root/'fd/29').symlink_to('socket:[7029]')
        (root/'net/tcp6').write_text('header\n'+self.tcp6(7029,40000,state='01',remote='01010101:01BB'))
        return root
    def test_native_existing_tcp6_must_naturally_close_before_strict_freeze(self):
        root=self.native_idle_tcp6();self.guard.quiet_timeout=60
        def close(seconds):
            self.sleep(seconds);self.assertFalse(self.guard.frozen)
            (root/'fd/29').unlink();(root/'net/tcp6').write_text('header\n')
        self.guard.sleep=close;self.guard.install_restart_guards();self.guard.freeze_and_verify()
        self.assertEqual(self.time,1);self.assertTrue(self.guard.verified)
        for proof in self.guard.receipt['daemons']:self.assertEqual(proof['applicationSockets'],0);self.assertEqual(proof['drainingManagedSockets'],0)
        self.guard.abort_before_kill();self.assert_aborted_without_kills()
    def test_native_persistent_tcp6_timeout_never_freezes_or_kills(self):
        root=self.native_idle_tcp6();self.guard.quiet_timeout=60;self.guard.install_restart_guards()
        with self.assertRaisesRegex(AdmissionError,'did not naturally close') as timeout:self.guard.freeze_and_verify()
        self.assertEqual(timeout.exception.admission_rejection_code,'socket_busy')
        self.assertEqual(self.time,60);self.assertTrue((root/'fd/29').is_symlink());self.assertFalse(any(isinstance(v,tuple) for v in self.events));self.assert_aborted_without_kills()
    def test_existing_native_cannot_mask_simultaneous_new_native_socket(self):
        root=self.native_idle_tcp6();network=self.guard._network
        def ordered(row):
            owners,tcp,unix=network(row);return dict(sorted(owners.items())),tcp,unix
        self.guard._network=ordered
        def add(seconds):
            self.sleep(seconds);(root/'fd/30').symlink_to('socket:[7030]')
            with (root/'net/tcp6').open('a') as stream:stream.write(self.tcp6(7030,40001,state='01',remote='01010101:01BB'))
        self.guard.sleep=add;self.guard.install_restart_guards()
        with self.assertRaisesRegex(AdmissionError,'accepted, outbound') as caught:self.guard.freeze_and_verify()
        self.assertEqual(caught.exception.socket_inode,'7030');self.assertEqual(self.time,1);self.assertTrue((root/'fd/29').is_symlink());self.assert_aborted_without_kills()
    def test_backend_and_native_share_one_sixty_second_window(self):
        root=self.native_idle_tcp6();backend=self.proc/'102'
        (backend/'fd/29').symlink_to('socket:[6029]');(backend/'net/tcp6').write_text('header\n'+self.tcp6(6029,40000,state='01',remote='01010101:01BB'))
        self.guard.quiet_timeout=60
        def backend_closes(seconds):
            self.sleep(seconds)
            if self.time==30:(backend/'fd/29').unlink();(backend/'net/tcp6').write_text('header\n')
        self.guard.sleep=backend_closes;self.guard.install_restart_guards()
        with self.assertRaisesRegex(AdmissionError,'did not naturally close') as timeout:self.guard.freeze_and_verify()
        self.assertEqual(timeout.exception.admission_rejection_code,'socket_busy')
        self.assertEqual(self.time,60);self.assertTrue((root/'fd/29').is_symlink());self.assertFalse(any(isinstance(v,tuple) for v in self.events));self.assert_aborted_without_kills()
    def test_native_wait_known_busy_is_not_a_transport_retry(self):
        self.native_idle_tcp6();self.guard.metadata_reader=lambda row:{'known':{'type':'busy'}};self.guard.install_restart_guards()
        with self.assertRaisesRegex(AdmissionError,'busy or ambiguous') as busy:self.guard.freeze_and_verify()
        self.assertFalse(hasattr(busy.exception,'admission_rejection_code'))
        self.assertEqual(self.time,0);self.assert_aborted_without_kills()
    def test_native_wait_fixed_deadline_is_not_a_transport_retry(self):
        self.native_idle_tcp6()
        def deadline():
            if self.time>=1:raise RuntimeError('fixed startup deadline')
        self.guard.quiet_checker=deadline;self.guard.install_restart_guards()
        with self.assertRaisesRegex(RuntimeError,'fixed startup deadline') as budget:self.guard.freeze_and_verify()
        self.assertFalse(hasattr(budget.exception,'admission_rejection_code'))
        self.assertEqual(self.time,1);self.assert_aborted_without_kills()
    def test_native_wait_rejects_changed_endpoint_on_same_inode(self):
        root=self.native_idle_tcp6()
        def change(seconds):self.sleep(seconds);(root/'net/tcp6').write_text('header\n'+self.tcp6(7029,40000,state='01',remote='02020202:01BB'))
        self.guard.sleep=change;self.guard.install_restart_guards()
        with self.assertRaisesRegex(AdmissionError,'identity changed'):self.guard.freeze_and_verify()
        self.assertEqual(self.time,1);self.assert_aborted_without_kills()
    def test_native_socket_appearing_after_freeze_is_rejected_without_wait(self):
        root=self.native_idle_tcp6();(root/'fd/29').unlink();(root/'net/tcp6').write_text('header\n');original=self.send
        def send(pid,ticks,sig):
            original(pid,ticks,sig)
            if pid==104 and sig==signal.SIGSTOP:(root/'fd/30').symlink_to('socket:[7030]');(root/'net/tcp6').write_text('header\n'+self.tcp6(7030,40000,state='01',remote='01010101:01BB'))
        self.guard.send=send;self.guard.install_restart_guards()
        with self.assertRaisesRegex(AdmissionError,'accepted, outbound'):self.guard.freeze_and_verify()
        self.assertEqual(self.time,0);self.assert_aborted_without_kills()
    def test_new_local_managed_pair_is_not_hidden_during_native_wait(self):
        self.native_idle_tcp6()
        def pair(seconds):self.sleep(seconds);self.idle_managed_transport()
        self.guard.sleep=pair;self.guard.install_restart_guards()
        with self.assertRaisesRegex(AdmissionError,'accepted, outbound'):self.guard.freeze_and_verify()
        self.assertEqual(self.time,1);self.assert_aborted_without_kills()

    def test_quiet_callback_failure_is_never_caught_as_transport_wait(self):
        for reason in ('operator hold','host busy','supervisor drift','protected bytes','startup budget'):
            with self.subTest(reason=reason):
                self.backend_idle_tcp6() if not self.guard.managed and not (self.proc/'104').exists() else None
                self.guard.quiet_checker=lambda:(_ for _ in ()).throw(RuntimeError(reason))
                self.guard.install_restart_guards()
                with self.assertRaisesRegex(RuntimeError,reason):self.guard.freeze_and_verify()
                self.assertEqual(self.time,0);self.assert_aborted_without_kills()
    def test_native_becoming_busy_during_backend_wait_aborts_without_freeze(self):
        self.backend_idle_tcp6();calls=[0]
        def metadata(row):calls[0]+=1;return {} if calls[0]<3 else {'s':{'type':'busy'}}
        self.guard.metadata_reader=metadata;self.guard.install_restart_guards()
        with self.assertRaisesRegex(AdmissionError,'busy or ambiguous'):self.guard.freeze_and_verify()
        self.assertEqual(self.time,1);self.assert_aborted_without_kills()
    def test_backend_identity_or_pause_change_during_wait_aborts(self):
        self.backend_idle_tcp6()
        def paused(seconds):self.sleep(seconds);self.states[102][0]='T';self.stat(102)
        self.guard.sleep=paused;self.guard.install_restart_guards()
        with self.assertRaisesRegex(AdmissionError,'deliberately paused'):self.guard.freeze_and_verify()
        self.assertEqual(self.states[102][0],'T');self.assertFalse(self.guard.kill_started);self.assertFalse(self.guard.frozen);self.assertEqual(self.owned_paths(),[])
    def test_socket_appearing_after_freeze_is_not_waited_or_accepted(self):
        root=self.backend_idle_tcp6();(root/'fd/29').unlink();(root/'net/tcp6').write_text('header\n')
        original=self.send
        def send(pid,ticks,sig):
            original(pid,ticks,sig)
            if pid==104 and sig==signal.SIGSTOP:(root/'fd/30').symlink_to('socket:[6030]');(root/'net/tcp6').write_text('header\n'+self.tcp6(6030,40000,state='01',remote='01010101:01BB'))
        self.guard.send=send;self.guard.install_restart_guards()
        with self.assertRaisesRegex(AdmissionError,'accepted, outbound'):self.guard.freeze_and_verify()
        self.assertEqual(self.time,0);self.assert_aborted_without_kills()

    def backend_without_native(self, *, state='01'):
        self.guard.quiet_checker=lambda:True;self.guard.idle_checker=lambda:True
        self.guard.metadata_reader=lambda row:self.fail('No native child metadata may be queried')
        root=self.proc/'102';(root/'fd/29').symlink_to('socket:[6029]')
        (root/'net/tcp6').write_text('header\n'+self.tcp6(6029,40000,state=state,remote='01010101:01BB'))
        return root
    def assert_no_daemon_signal(self):
        self.assertFalse(any(isinstance(event,tuple) for event in self.events))
    def no_native_natural_close(self, state):
        root=self.backend_without_native(state=state);observations=[]
        def close(seconds):
            self.sleep(seconds);self.assert_no_daemon_signal();self.assertFalse(self.guard.frozen)
            observations.append(self.time);(root/'fd/29').unlink();(root/'net/tcp6').write_text('header\n')
            self.events.append('natural_transport_closed')
        self.guard.sleep=close;self.guard.install_restart_guards();self.guard.freeze_and_verify()
        self.assertEqual(observations,[1]);self.assertEqual(self.guard.managed,[])
        self.assertTrue(self.guard.verified);self.assertEqual(self.guard.receipt['preFreezeTransportWaitSeconds'],1)
        self.assertLess(self.events.index('natural_transport_closed'),self.events.index((101,signal.SIGSTOP)))
        self.guard.abort_before_kill();self.assert_aborted_without_kills()
    def test_no_native_established_transport_closes_before_first_daemon_signal(self):self.no_native_natural_close('01')
    def test_no_native_close_wait_transport_closes_before_first_daemon_signal(self):self.no_native_natural_close('08')
    def test_no_native_transport_timeout_preserves_live_socket_without_any_signal(self):
        root=self.backend_without_native();self.guard.quiet_timeout=3;self.guard.install_restart_guards()
        with self.assertRaisesRegex(AdmissionError,'did not naturally close') as caught:self.guard.freeze_and_verify()
        self.assertEqual(caught.exception.admission_rejection_code,'socket_busy');self.assertEqual(self.time,3)
        self.assert_no_daemon_signal();self.assertTrue((root/'fd/29').is_symlink());self.assert_aborted_without_kills()
    def test_no_native_new_socket_cannot_hide_behind_original_transport(self):
        root=self.backend_without_native();network=self.guard._network
        def ordered(row):
            owners,tcp,unix=network(row);return dict(sorted(owners.items())),tcp,unix
        self.guard._network=ordered
        def add(seconds):
            self.sleep(seconds);(root/'fd/30').symlink_to('socket:[6030]')
            with (root/'net/tcp6').open('a') as stream:stream.write(self.tcp6(6030,40001,state='01',remote='01010101:01BB'))
        self.guard.sleep=add;self.guard.install_restart_guards()
        with self.assertRaisesRegex(AdmissionError,'accepted, outbound'):self.guard.freeze_and_verify()
        self.assertEqual(self.time,1);self.assert_no_daemon_signal();self.assert_aborted_without_kills()
    def test_no_native_unknown_descriptor_is_not_hidden_by_original_socket(self):
        root=self.backend_without_native()
        def add(seconds):self.sleep(seconds);(root/'fd/30').symlink_to('socket:[99999]')
        self.guard.sleep=add;self.guard.install_restart_guards()
        with self.assertRaisesRegex(AdmissionError,'unknown socket'):self.guard.freeze_and_verify()
        self.assert_no_daemon_signal();self.assert_aborted_without_kills()
    def test_no_native_queued_listener_is_rejected_during_observation(self):
        root=self.backend_without_native()
        def backlog(seconds):self.sleep(seconds);(root/'net/tcp').write_text('header\n'+self.tcp(1020,8793,queue='00000000:00000001'))
        self.guard.sleep=backlog;self.guard.install_restart_guards()
        with self.assertRaisesRegex(AdmissionError,'queued ingress'):self.guard.freeze_and_verify()
        self.assert_no_daemon_signal();self.assert_aborted_without_kills()
    def test_no_native_socket_inode_replacement_is_not_an_original_transport(self):
        root=self.backend_without_native()
        def replace(seconds):
            self.sleep(seconds);(root/'fd/29').unlink();(root/'fd/29').symlink_to('socket:[6030]')
            (root/'net/tcp6').write_text('header\n'+self.tcp6(6030,40000,state='01',remote='01010101:01BB'))
        self.guard.sleep=replace;self.guard.install_restart_guards()
        with self.assertRaisesRegex(AdmissionError,'accepted, outbound'):self.guard.freeze_and_verify()
        self.assert_no_daemon_signal();self.assert_aborted_without_kills()
    def test_no_native_same_inode_changed_endpoint_is_fatal(self):
        root=self.backend_without_native()
        def change(seconds):self.sleep(seconds);(root/'net/tcp6').write_text('header\n'+self.tcp6(6029,40000,state='01',remote='02020202:01BB'))
        self.guard.sleep=change;self.guard.install_restart_guards()
        with self.assertRaisesRegex(AdmissionError,'identity changed') as caught:self.guard.freeze_and_verify()
        self.assertFalse(hasattr(caught.exception,'admission_rejection_code'));self.assert_no_daemon_signal();self.assert_aborted_without_kills()
    def test_no_native_retired_inode_reappearance_is_not_observed_as_original(self):
        root=self.backend_without_native();(root/'fd/30').symlink_to('socket:[6030]')
        with (root/'net/tcp6').open('a') as stream:stream.write(self.tcp6(6030,40001,state='01',remote='01010101:01BB'))
        def change(seconds):
            self.sleep(seconds)
            if self.time==1:
                (root/'fd/29').unlink();(root/'net/tcp6').write_text('header\n'+self.tcp6(6030,40001,state='01',remote='01010101:01BB'))
            elif self.time==2:
                (root/'fd/29').symlink_to('socket:[6029]')
                with (root/'net/tcp6').open('a') as stream:stream.write(self.tcp6(6029,40000,state='01',remote='01010101:01BB'))
        self.guard.sleep=change;self.guard.install_restart_guards()
        with self.assertRaisesRegex(AdmissionError,'accepted, outbound'):self.guard.freeze_and_verify()
        self.assertEqual(self.time,2);self.assert_no_daemon_signal();self.assert_aborted_without_kills()
    def test_no_native_malformed_original_metadata_is_never_waited(self):
        root=self.backend_without_native();self.guard.install_restart_guards()
        original=self.tcp6(6029,40000,state='01',remote='01010101:01BB')
        for malformed in (original.replace('00000000:00000000','not-a-queue'),original.replace('01 00000000:','FF 00000000:'),original.replace('FFFF0000','ZZZZ0000')):
            with self.subTest(malformed=malformed):
                (root/'net/tcp6').write_text('header\n'+malformed)
                with self.assertRaisesRegex(AdmissionError,'Malformed kernel TCP'):self.guard.freeze_and_verify()
                self.assert_no_daemon_signal();self.assert_aborted_without_kills();self.guard.install_restart_guards()
        self.guard.abort_before_kill()
    def test_no_native_original_descriptor_losing_kernel_metadata_fails_closed(self):
        root=self.backend_without_native()
        def change(seconds):self.sleep(seconds);(root/'net/tcp6').write_text('header\n')
        self.guard.sleep=change;self.guard.install_restart_guards()
        with self.assertRaisesRegex(AdmissionError,'unknown kernel metadata'):self.guard.freeze_and_verify()
        self.assert_no_daemon_signal();self.assert_aborted_without_kills()
    def test_no_native_new_pool_work_stops_wait_without_signals(self):
        self.backend_without_native();calls=[0]
        def idle():calls[0]+=1;return calls[0]<2
        self.guard.idle_checker=idle;self.guard.install_restart_guards()
        with self.assertRaisesRegex(AdmissionError,'New pool work'):self.guard.freeze_and_verify()
        self.assertEqual(self.time,1);self.assert_no_daemon_signal();self.assert_aborted_without_kills()
    def test_no_native_callback_deadline_or_authority_failure_is_not_retry_wait(self):
        self.backend_without_native()
        def check():
            if self.time>=1:raise RuntimeError('fixed deadline or owned authority changed')
            return True
        self.guard.quiet_checker=check;self.guard.install_restart_guards()
        with self.assertRaisesRegex(RuntimeError,'fixed deadline or owned authority') as caught:self.guard.freeze_and_verify()
        self.assertFalse(hasattr(caught.exception,'admission_rejection_code'));self.assert_no_daemon_signal();self.assert_aborted_without_kills()
    def test_no_native_cancellation_preserves_socket_and_restores_owned_guards(self):
        root=self.backend_without_native();self.guard.sleep=lambda seconds:(_ for _ in ()).throw(KeyboardInterrupt())
        self.guard.install_restart_guards()
        with self.assertRaises(KeyboardInterrupt):self.guard.freeze_and_verify()
        self.assertTrue((root/'fd/29').is_symlink());self.assert_no_daemon_signal();self.assert_aborted_without_kills()
    def test_no_native_unknown_child_aborts_before_any_wait_or_freeze(self):
        self.backend_without_native();(self.proc/'102/task/102/children').write_text('999')
        self.guard.install_restart_guards()
        with self.assertRaisesRegex(AdmissionError,'unmanaged child job'):self.guard.freeze_and_verify()
        self.assertEqual(self.time,0);self.assert_no_daemon_signal();self.assert_aborted_without_kills()
    def test_no_native_socket_racing_after_quiet_success_is_rejected_frozen(self):
        root=self.backend_without_native();(root/'fd/29').unlink();(root/'net/tcp6').write_text('header\n');original=self.send
        def send(pid,ticks,sig):
            original(pid,ticks,sig)
            if pid==102 and sig==signal.SIGSTOP:
                (root/'fd/30').symlink_to('socket:[6030]');(root/'net/tcp6').write_text('header\n'+self.tcp6(6030,40000,state='01',remote='01010101:01BB'))
        self.guard.send=send;self.guard.install_restart_guards()
        with self.assertRaisesRegex(AdmissionError,'accepted, outbound'):self.guard.freeze_and_verify()
        self.assertEqual(self.time,0);self.assert_aborted_without_kills()

    def test_no_native_new_child_during_wait_aborts_before_any_signal(self):
        self.backend_without_native()
        def child(seconds):self.sleep(seconds);(self.proc/'102/task/102/children').write_text('999')
        self.guard.sleep=child;self.guard.install_restart_guards()
        with self.assertRaisesRegex(AdmissionError,'unmanaged child job'):self.guard.freeze_and_verify()
        self.assertEqual(self.time,1);self.assert_no_daemon_signal();self.assert_aborted_without_kills()
    def test_no_native_missing_idle_proof_never_authorizes_observation(self):
        self.backend_without_native();self.guard.idle_checker=None;self.guard.install_restart_guards()
        with self.assertRaisesRegex(AdmissionError,'Fresh idle proof'):self.guard.freeze_and_verify()
        self.assert_no_daemon_signal();self.assert_aborted_without_kills()
    def test_no_native_primary_socket_never_uses_backend_observation_exception(self):
        self.backend_without_native();root=self.proc/'101';(root/'fd/29').symlink_to('socket:[9029]')
        (root/'net/tcp6').write_text('header\n'+self.tcp6(9029,40000,state='01',remote='01010101:01BB'))
        self.guard.install_restart_guards()
        with self.assertRaisesRegex(AdmissionError,'accepted, outbound'):self.guard.freeze_and_verify()
        self.assertEqual(self.time,0);self.assert_no_daemon_signal();self.assert_aborted_without_kills()
    def test_no_native_new_tcp_before_kill_is_strictly_rejected_without_wait(self):
        root=self.backend_without_native()
        def close(seconds):
            self.sleep(seconds);self.assert_no_daemon_signal();(root/'fd/29').unlink();(root/'net/tcp6').write_text('header\n')
        self.guard.sleep=close;self.guard.install_restart_guards();self.guard.freeze_and_verify()
        (root/'fd/30').symlink_to('socket:[6030]');(root/'net/tcp6').write_text('header\n'+self.tcp6(6030,40000,state='01',remote='01010101:01BB'))
        with self.assertRaisesRegex(AdmissionError,'accepted, outbound'):self.guard.kill_verified_daemons()
        self.assertEqual(self.time,1);self.assertFalse(self.guard.kill_started)
        self.assertFalse(any(isinstance(event,tuple) and event[1]==signal.SIGKILL for event in self.events))
        self.guard.abort_before_kill();self.assert_aborted_without_kills()

    def test_paused_managed_child_is_not_resumed_or_terminated(self):
        self.managed_child(); self.states[104][0] = 'T'; self.stat(104)
        self.guard.install_restart_guards()
        with self.assertRaisesRegex(AdmissionError, 'deliberately paused'): self.guard.freeze_and_verify()
        self.assertEqual(self.states[104][0], 'T'); self.assert_aborted_without_kills()

    def test_empty_daemon_self_pair_with_descriptor_alias_is_proved_by_kernel_peers(self):
        self.unix_endpoint(102, 23, 6000); self.unix_endpoint(102, 25, 6000); self.unix_endpoint(102, 24, 6001)
        self.unix_pair_metadata(6000, 6001)
        self.guard.install_restart_guards(); self.guard.freeze_and_verify()
        proof = next(row for row in self.guard.receipt['daemons'] if row['pid'] == 102)
        self.assertEqual({row['kind'] for row in proof['emptyOwnedUnixPairs']}, {'daemon_internal'})
        self.guard.kill_verified_daemons(); self.assertTrue(self.guard.all_dead); self.guard.restore_restart_guards()

    def test_foreign_unix_peer_is_rejected_even_with_empty_connected_queues(self):
        self.unix_endpoint(102, 23, 6000); self.unix_pair_metadata(6000, 6001)
        foreign = self.proc / '999/fd'; foreign.mkdir(parents=True); (foreign / '24').symlink_to('socket:[6001]')
        self.guard.install_restart_guards()
        with self.assertRaisesRegex(AdmissionError, 'unknown socket'): self.guard.freeze_and_verify()
        self.assert_aborted_without_kills()

    def test_self_pair_with_receive_or_send_bytes_is_rejected(self):
        self.unix_endpoint(102, 23, 6000); self.unix_endpoint(102, 24, 6001)
        for inode, key in [('6000', 'receiveQueue'), ('6000', 'sendQueue'), ('6001', 'receiveQueue'), ('6001', 'sendQueue')]:
            with self.subTest(inode=inode, queue=key):
                self.unix_pair_metadata(6000, 6001); self.unix_rows[inode][key] = 1
                self.guard.install_restart_guards()
                with self.assertRaisesRegex(AdmissionError, 'unknown socket'): self.guard.freeze_and_verify()
                self.assert_aborted_without_kills()

    def test_unix_peer_proof_must_be_reciprocal_and_complete(self):
        self.unix_endpoint(102, 23, 6000); self.unix_endpoint(102, 24, 6001)
        for changed in ['peer', 'sendQueue', 'state', 'type']:
            with self.subTest(changed=changed):
                self.unix_pair_metadata(6000, 6001)
                if changed == 'peer': self.unix_rows['6001']['peer'] = '9999'
                elif changed == 'sendQueue': del self.unix_rows['6001']['sendQueue']
                elif changed == 'state': self.unix_rows['6001']['state'] = 10
                else: self.unix_rows['6001']['type'] = socket.SOCK_DGRAM
                self.guard.install_restart_guards()
                with self.assertRaisesRegex(AdmissionError, 'unknown socket'): self.guard.freeze_and_verify()
                self.assert_aborted_without_kills()

    def test_exact_empty_backend_to_pinned_child_stdout_pair_is_allowed(self):
        self.managed_child()
        self.unix_endpoint(102, 36, 7000); self.unix_endpoint(104, 1, 7001); self.unix_endpoint(104, 5, 7001)
        self.unix_pair_metadata(7000, 7001)
        self.guard.install_restart_guards(); self.guard.freeze_and_verify()
        for pid in (102, 104):
            proof = next(row for row in self.guard.receipt['daemons'] if row['pid'] == pid)
            self.assertEqual({row['kind'] for row in proof['emptyOwnedUnixPairs']}, {'managed_child_stdout'})
        self.guard.kill_verified_daemons(); self.guard.restore_restart_guards()

    def test_managed_child_other_ipc_fd_is_not_treated_as_spawn_stdout(self):
        self.managed_child(); self.unix_endpoint(102, 36, 7000); self.unix_endpoint(104, 6, 7001)
        self.unix_pair_metadata(7000, 7001)
        self.guard.install_restart_guards()
        with self.assertRaisesRegex(AdmissionError, 'unknown socket'): self.guard.freeze_and_verify()
        self.assert_aborted_without_kills()

    def test_queued_managed_stdout_is_rejected_without_losing_pending_bytes(self):
        self.managed_child(); self.unix_endpoint(102, 36, 7000); self.unix_endpoint(104, 1, 7001)
        self.unix_pair_metadata(7000, 7001); self.unix_rows['7000']['receiveQueue'] = 4
        self.guard.install_restart_guards()
        with self.assertRaisesRegex(AdmissionError, 'unknown socket'): self.guard.freeze_and_verify()
        self.assert_aborted_without_kills(); self.assertEqual(self.states[104][0], 'S')

    def test_kernel_unix_queues_are_refreshed_after_freeze_and_before_any_kill(self):
        self.unix_endpoint(102, 23, 6000); self.unix_endpoint(102, 24, 6001)
        self.unix_pair_metadata(6000, 6001)
        reads = []
        self.guard.unix_diag_reader = lambda: reads.append(tuple(self.states[pid][0] for pid in (101, 102))) or self.unix_rows
        self.guard.install_restart_guards(); self.guard.freeze_and_verify()
        self.assertEqual(reads, [('T', 'T')])
        self.unix_rows['6001']['receiveQueue'] = 1
        with self.assertRaisesRegex(AdmissionError, 'unknown socket'): self.guard.kill_verified_daemons()
        self.assertEqual(reads, [('T', 'T'), ('T', 'T')])
        self.guard.abort_before_kill(); self.assert_aborted_without_kills()


class OwnedKernelUnixPairFixture(unittest.TestCase):
    def test_real_owned_python_socketpair_has_reciprocal_peers_and_detectable_queued_data(self):
        # Only sockets created by this fixture are used. No live service is
        # contacted, frozen or signaled; netlink exposes metadata, not contents.
        first, second = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            first_inode = str(os.fstat(first.fileno()).st_ino)
            second_inode = str(os.fstat(second.fileno()).st_ino)
            rows = unix_socket_diagnostics()
            self.assertEqual(rows[first_inode]['peer'], second_inode)
            self.assertEqual(rows[second_inode]['peer'], first_inode)
            for inode in (first_inode, second_inode):
                self.assertEqual(rows[inode]['type'], socket.SOCK_STREAM)
                self.assertEqual(rows[inode]['state'], 1)
                self.assertEqual((rows[inode]['receiveQueue'], rows[inode]['sendQueue']), (0, 0))
            payload = b'synthetic queued fixture bytes'
            first.sendall(payload)
            queued = unix_socket_diagnostics()
            self.assertTrue(queued[first_inode]['sendQueue'] > 0 or queued[second_inode]['receiveQueue'] > 0)
            self.assertEqual(second.recv(len(payload)), payload)
            empty = unix_socket_diagnostics()
            self.assertEqual((empty[first_inode]['sendQueue'], empty[second_inode]['receiveQueue']), (0, 0))
        finally:
            first.close(); second.close()


if __name__ == '__main__': unittest.main()
