"""Idle-only old-daemon admission guard. Importing performs no live operations.

No request is admitted after the daemon freezes. The verified idle daemons are
killed while still frozen, because normal systemd stop sends SIGCONT and the old
HTTP shutdown handlers leave listeners open during asynchronous cleanup.
"""
import hashlib
import json
import os
from pathlib import Path
import signal
import socket
import stat
import struct
import subprocess
import time
import uuid
import urllib.request

import hostpaths

OPENCODE_ARGV0 = hostpaths.OPENCODE_ARGV0
OPENCODE_EXE = hostpaths.OPENCODE_EXE
# Fresh stage supplies the explicitly reviewed anonymous profile pin. No historical default.
OPENCODE_CONTENT_SHA256 = None
from rollout_config import RUNTIME_GUARD_NAME


class AdmissionError(RuntimeError):
    pass


def unix_socket_diagnostics():
    """Read kernel peer/queue metadata only; never read socket payloads.

    /proc/net/unix does not expose peers or byte queues. UNIX_DIAG does, and a
    fresh bounded netlink dump lets admission prove that both ends are known and
    empty rather than guessing from descriptor names or process argv.
    """
    sequence = uuid.uuid4().int & 0xffffffff
    request = struct.pack('=BBHIIIII', socket.AF_UNIX, 0, 0, 0xffffffff, 0,
                          4 | 16, 0xffffffff, 0xffffffff)  # PEER + RQLEN
    message = struct.pack('=IHHII', 16 + len(request), 20, 0x301, sequence, 0) + request
    rows = {}; total = 0
    try:
        with socket.socket(socket.AF_NETLINK, socket.SOCK_RAW, 4) as channel:
            channel.settimeout(2)
            channel.bind((0, 0))
            channel.sendto(message, (0, 0))
            deadline = time.monotonic() + 2
            while True:
                if time.monotonic() >= deadline: raise AdmissionError('Kernel Unix metadata deadline exceeded')
                data, _ancillary, flags, address = channel.recvmsg(65536)
                total += len(data)
                if not data or flags & socket.MSG_TRUNC or address[0] != 0 or total > 4 * 1024 * 1024:
                    raise AdmissionError('Incomplete or oversized kernel Unix metadata')
                offset = 0
                while offset < len(data):
                    if len(data) - offset < 16: raise AdmissionError('Malformed kernel Unix header')
                    size, kind, response_flags, seq, _pid = struct.unpack_from('=IHHII', data, offset)
                    if size < 16 or offset + size > len(data) or seq != sequence or response_flags & 0x10:
                        raise AdmissionError('Incomplete kernel Unix metadata dump')
                    payload = data[offset + 16:offset + size]
                    offset += (size + 3) & ~3
                    if kind == 3: return rows  # NLMSG_DONE
                    if kind == 2: raise AdmissionError('Kernel Unix metadata query rejected')
                    if kind != 20 or len(payload) < 16: raise AdmissionError('Unexpected kernel Unix metadata message')
                    family, socket_type, state, _pad, inode, _cookie0, _cookie1 = struct.unpack_from('=BBBBIII', payload)
                    if family != socket.AF_UNIX: raise AdmissionError('Unexpected kernel socket family')
                    row = {'type': socket_type, 'state': state}
                    attribute = 16
                    while attribute < len(payload):
                        if len(payload) - attribute < 4: raise AdmissionError('Malformed kernel Unix attribute')
                        length, tag = struct.unpack_from('=HH', payload, attribute)
                        if length < 4 or attribute + length > len(payload): raise AdmissionError('Malformed kernel Unix attribute')
                        value = payload[attribute + 4:attribute + length]
                        if tag == 2:  # UNIX_DIAG_PEER
                            if len(value) != 4 or 'peer' in row: raise AdmissionError('Ambiguous kernel Unix peer')
                            row['peer'] = str(struct.unpack('=I', value)[0])
                        elif tag == 4:  # UNIX_DIAG_RQLEN
                            if len(value) != 8 or 'receiveQueue' in row: raise AdmissionError('Ambiguous kernel Unix queues')
                            row['receiveQueue'], row['sendQueue'] = struct.unpack('=II', value)
                        attribute += (length + 3) & ~3
                    if str(inode) in rows: raise AdmissionError('Duplicate kernel Unix inode')
                    rows[str(inode)] = row
    except (OSError, ValueError, struct.error) as error:
        raise AdmissionError('Kernel Unix peer/queue metadata unavailable') from error


class OwnedDaemonAdmission:
    UNITS = ('milo.service', 'grunt-amazing-adventure.service')

    def __init__(self, *, node, primary_script, backend_script, primary_pid,
                 backend_pid, supervisor_pid, runtime_directory, env, proc_root=Path('/proc'),
                 unit_reader=None, reload=None, sender=None, clock=time.monotonic,
                 sleep=time.sleep, idle_checker=None, metadata_reader=None, quiet_timeout=15, quiet_checker=None,
                 unix_diag_reader=None, host_pid=None, host_script=None, host_policy=None):
        self.node = str(node)
        self.supervisor_pid = supervisor_pid
        self.proc = Path(proc_root)
        self.runtime = Path(runtime_directory)
        self.env = env
        self.read_unit = unit_reader or self._unit_value
        self.reload = reload or self._reload
        self.send = sender or self._pidfd_signal
        self.clock, self.sleep = clock, sleep
        self.idle_checker = idle_checker
        self.quiet_checker = quiet_checker
        self.metadata_reader = metadata_reader or self._opencode_status
        self.unix_diag_reader = unix_diag_reader or unix_socket_diagnostics
        if not 0 < quiet_timeout <= 60: raise AdmissionError('Managed transport quiet wait must be bounded')
        self.quiet_timeout = quiet_timeout
        self.managed = []
        self.targets = [dict(unit=self.UNITS[0], pid=primary_pid, script=str(primary_script), port=8792),
                        dict(unit=self.UNITS[1], pid=backend_pid, script=str(backend_script), port=8793)]
        if host_pid is not None:
            if type(host_pid) is not int or host_pid <= 1 or host_pid in (primary_pid, backend_pid, supervisor_pid): raise AdmissionError('Invalid execution host identity')
            self.targets.append(dict(unit='grunt-adventure-execution-host.service', pid=host_pid, script=str(host_script), policy=str(host_policy), port=0, executionHost=True))
        if any(type(pid) is not int or pid <= 1 for pid in (primary_pid, backend_pid, supervisor_pid)) or len({primary_pid, backend_pid, supervisor_pid}) != 3:
            raise AdmissionError('Invalid managed daemon identities')
        if not all(Path(value).is_absolute() for value in (self.node, str(primary_script), str(backend_script), str(self.runtime))):
            raise AdmissionError('Admission paths must be absolute')
        self.guards = []
        self.frozen = []
        self.verified = False
        self.kill_started = False
        self.all_dead = False
        self.receipt = {'daemonAdmission': 'not_started', 'providerCalls': 0}
        self.nonce = uuid.uuid4().hex

    def _all_targets(self): return self.targets + self.managed

    def _unit_value(self, unit, field):
        return subprocess.check_output(['systemctl', '--user', 'show', unit, '-p', field, '--value'], env=self.env, text=True, timeout=5).strip()

    def _reload(self):
        subprocess.run(['systemctl', '--user', 'daemon-reload'], env=self.env, check=True, timeout=60, stdout=subprocess.DEVNULL)

    def _identity(self, pid):
        raw = (self.proc / str(pid) / 'stat').read_text()
        prefix, separator, tail = raw.rpartition(') ')
        values = tail.split()
        if not separator or not prefix.startswith(str(pid) + ' (') or len(values) < 20:
            raise AdmissionError('Invalid daemon process identity')
        return values[19], values[0]

    def _pidfd_signal(self, pid, ticks, signum):
        if not hasattr(os, 'pidfd_open') or not hasattr(signal, 'pidfd_send_signal'):
            raise AdmissionError('Linux pidfd signaling is required')
        fd = os.pidfd_open(pid)
        try:
            if self._identity(pid)[0] != ticks:
                raise AdmissionError('Daemon PID identity changed')
            signal.pidfd_send_signal(fd, signum)
        finally:
            os.close(fd)

    def _private_directory(self, path):
        # No symlinked parent may redirect an owned transient systemd guard.
        if path.resolve() != path:
            raise AdmissionError('Runtime unit directory is not canonical')
        if path.exists():
            info = path.stat()
            if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o022:
                raise AdmissionError('Runtime unit directory is not privately controlled')
            return False
        if not path.parent.is_dir():
            self._private_directory(path.parent)
        path.mkdir(mode=0o700)
        return True

    def install_restart_guards(self):
        if self.guards or self.frozen or self.kill_started:
            raise AdmissionError('Admission guard already used')
        for row in self.targets:
            if self.read_unit(row['unit'], 'ActiveState') != 'active':
                raise AdmissionError('Managed unit is not active; preserve its state')
            row['originalRestart'] = self.read_unit(row['unit'], 'Restart')
            if row['originalRestart'] not in ('no', 'on-success', 'on-failure', 'on-abnormal', 'on-watchdog', 'on-abort', 'always'):
                raise AdmissionError('Unknown managed restart policy')
            self._pin(row)
        try:
            for row in self.targets:
                directory = self.runtime / 'systemd/user' / (row['unit'] + '.d')
                created = self._private_directory(directory)
                path = directory / RUNTIME_GUARD_NAME
                data = ('# owned Grunt cutover ' + self.nonce + '\n[Service]\nRestart=no\n').encode()
                fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                guard = dict(path=path, data=data, inode=os.fstat(fd).st_ino, device=os.fstat(fd).st_dev,
                             createdDirectory=created, unit=row['unit'], originalRestart=row['originalRestart'])
                self.guards.append(guard)
                with os.fdopen(fd, 'wb') as stream:
                    stream.write(data); stream.flush(); os.fsync(stream.fileno())
            self.receipt['restartGuards'] = [{'path': str(row['path']), 'sha256': hashlib.sha256(row['data']).hexdigest(),
                                             'originalRestart': row['originalRestart']} for row in self.guards]
            self.reload()
            for row in self.targets:
                if self.read_unit(row['unit'], 'Restart') != 'no':
                    raise AdmissionError('Owned no-restart guard is not effective')
                self._pin(row, expected_ticks=row['ticks'])
            self.receipt['restartSuppressedWithoutRestart'] = True
        except BaseException:
            self.restore_restart_guards()
            raise

    def _pin(self, row, expected_ticks=None):
        if row.get('managedOpenCode'):
            return self._pin_opencode(row, expected_ticks)
        root = self.proc / str(row['pid'])
        ticks, state = self._identity(row['pid'])
        command = [part.decode() for part in (root / 'cmdline').read_bytes().split(b'\0') if part]
        expected = [self.node, row['script']] + (['execution-host','serve','--config',row['policy']] if row.get('executionHost') else [])
        if command != expected or os.readlink(root / 'exe') != self.node:
            raise AdmissionError('Daemon executable or argv changed')
        if expected_ticks is not None and ticks != expected_ticks:
            raise AdmissionError('Daemon PID identity changed')
        if state not in ('R', 'S', 'D', 'I', 'T', 't'):
            raise AdmissionError('Daemon is not a running managed process')
        if row.get('executionHost') and self.read_unit(row['unit'], 'MainPID') != str(row['pid']): raise AdmissionError('Execution host service identity changed')
        if row['unit'] == self.UNITS[0] and self.read_unit(row['unit'], 'MainPID') != str(row['pid']):
            raise AdmissionError('Primary daemon service identity changed')
        if row['unit'] == self.UNITS[1]:
            fields = (root / 'stat').read_text().rpartition(') ')[2].split()
            if fields[1] != str(self.supervisor_pid) or self.read_unit(row['unit'], 'MainPID') != str(self.supervisor_pid):
                raise AdmissionError('Free-pool backend supervisor identity changed')
        row['ticks'] = ticks
        return state

    def _children(self, row):
        tasks = self.proc / str(row['pid']) / 'task'
        for task in tasks.iterdir():
            children = (task / 'children').read_text().split()
            allowed = {str(child['pid']) for child in self.managed if child['parentPid'] == row['pid']}
            if any(child not in allowed for child in children):
                raise AdmissionError('Daemon still owns an unmanaged child job; preserve work')

    def _pin_opencode(self, row, expected_ticks=None):
        root = self.proc / str(row['pid'])
        ticks, state = self._identity(row['pid'])
        fields = (root / 'stat').read_text().rpartition(') ')[2].split()
        command = [part.decode() for part in (root / 'cmdline').read_bytes().split(b'\0') if part]
        if (root.stat().st_uid != os.getuid() or command != [OPENCODE_ARGV0, 'serve', '--hostname', '127.0.0.1', '--port', '0']
            or os.readlink(root / 'exe') != OPENCODE_EXE or fields[1] != str(row['parentPid'])
            or expected_ticks is not None and ticks != expected_ticks):
            raise AdmissionError('Unrecognized managed OpenCode identity')
        env = dict(part.split(b'=', 1) for part in (root / 'environ').read_bytes().split(b'\0') if b'=' in part)
        content = env.get(b'OPENCODE_CONFIG_CONTENT', b'')
        if (hashlib.sha256(content).hexdigest() != OPENCODE_CONTENT_SHA256 or env.get(b'OPENCODE_CONFIG')
            or env.get(b'OPENCODE_CONFIG_DIR') or env.get(b'OPENCODE_SERVER_PASSWORD')
            or env.get(b'HOME') != os.fsencode(hostpaths.HOME) or env.get(b'XDG_CONFIG_HOME', os.fsencode(hostpaths.HOME / '.config')) != os.fsencode(hostpaths.HOME / '.config')
            or env.get(b'XDG_DATA_HOME', os.fsencode(hostpaths.HOME / '.local/share')) != os.fsencode(hostpaths.HOME / '.local/share')):
            raise AdmissionError('Managed OpenCode profile is not the reviewed anonymous scope')
        if json.loads(content).get('permission', {}).get('external_directory') != 'deny':
            raise AdmissionError('Managed OpenCode external directory policy changed')
        if os.readlink(root / 'cwd') != os.readlink(self.proc / str(row['parentPid']) / 'cwd'):
            raise AdmissionError('Managed OpenCode cwd scope changed')
        if state not in ('R', 'S', 'D', 'I', 'T', 't'):
            raise AdmissionError('Managed OpenCode process is not running')
        row['ticks'] = ticks
        return state

    def _opencode_status(self, row):
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *_args, **_kwargs): raise AdmissionError('Managed metadata redirect rejected')
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        request = urllib.request.Request(f'http://127.0.0.1:{row["port"]}/session/status', headers={'Connection': 'close'})
        with opener.open(request, timeout=2) as response:
            data = response.read(1024 * 1024 + 1)
        if len(data) > 1024 * 1024: raise AdmissionError('Managed OpenCode status oversized')
        return json.loads(data)

    def _discover_managed_children(self):
        # Only the existing backend-owned native server has been reviewed.
        backend = self.targets[1]
        children = set()
        for task in (self.proc / str(backend['pid']) / 'task').iterdir():
            children.update((task / 'children').read_text().split())
        if len(children) > 1: raise AdmissionError('Multiple backend children are ambiguous')
        if children:
            value = next(iter(children))
            if not value.isdigit(): raise AdmissionError('Invalid managed child identity')
            child = dict(pid=int(value), parentPid=backend['pid'], managedOpenCode=True, unit=backend['unit'])
            try: state = self._pin_opencode(child)
            except (OSError, ValueError, AdmissionError):
                raise AdmissionError('Backend child is not reviewed managed OpenCode; preserve unmanaged child job') from None
            if state in ('T', 't'): raise AdmissionError('Managed child deliberately paused')
            owners, tcp, _unix = self._network(child)
            listeners = [entry for inode, entry in tcp.items() if inode in owners and entry['table'] == 'tcp' and entry['state'] == '0A']
            if len(listeners) != 1 or not listeners[0]['local'].startswith('0100007F:') or listeners[0]['remote'] != '00000000:0000':
                raise AdmissionError('Managed OpenCode sole loopback listener not proved')
            child['port'] = int(listeners[0]['local'].split(':')[1], 16)
            if not 1 <= child['port'] <= 65535 or child['port'] in (8792, 8793): raise AdmissionError('Invalid managed OpenCode listener')
            self.managed.append(child)
            self._children(child)
            if self.idle_checker is None or self.idle_checker() is not True:
                raise AdmissionError('Both pools must remain idle before managed metadata inspection')
            status = self.metadata_reader(child)
            if not isinstance(status, dict) or len(status) > 1000 or any(not isinstance(value, dict) or value.get('type') != 'idle' for value in status.values()):
                raise AdmissionError('Managed OpenCode has busy or ambiguous session status')
            self.receipt['managedOpenCode'] = {'pid': child['pid'], 'port': child['port'], 'parentPid': child['parentPid'],
                'profileSha256': OPENCODE_CONTENT_SHA256, 'readOnlySessionStatus': 'all_idle', 'providerCalls': 0}
        for row in self._all_targets(): self._children(row)

    def _wait_managed_transport_quiet(self):
        if not self.managed and self.quiet_checker is None: return
        if self.idle_checker is None: raise AdmissionError('Fresh idle proof required for transport observation')
        deadline = self.clock() + self.quiet_timeout
        child = self.managed[0] if self.managed else None; parent = self.targets[1]
        observed = (parent, child) if child is not None else (parent,)
        def tcp_identity(entry):
            # Only syntactically valid kernel TCP records can be observed. This
            # is not an idle/acceptance proof and never reaches frozen checks.
            family = entry.get('table'); width = 8 if family == 'tcp' else 32 if family == 'tcp6' else 0
            def hex_field(value, length):
                return isinstance(value, str) and len(value) == length and all(c in '0123456789abcdefABCDEF' for c in value)
            def endpoint(value):
                parts = value.split(':') if isinstance(value, str) else []
                return len(parts) == 2 and hex_field(parts[0], width) and hex_field(parts[1], 4)
            queue = entry.get('queue'); parts = queue.split(':') if isinstance(queue, str) else []
            if (not width or not endpoint(entry.get('local')) or not endpoint(entry.get('remote'))
                or not hex_field(entry.get('state'), 2) or not 1 <= int(entry['state'], 16) <= 12 or len(parts) != 2 or any(not hex_field(value, 8) for value in parts)):
                raise AdmissionError('Malformed kernel TCP transport metadata')
            return family, entry['local'], entry['remote']
        existing_tcp = {}
        for row in observed:
            owners, tcp, _ = self._network(row)
            existing_tcp[row['pid']] = {}
            for inode in owners:
                if inode in tcp:
                    identity = tcp_identity(tcp[inode])
                    if tcp[inode]['state'] in ('01', '08'): existing_tcp[row['pid']][inode] = identity
        def waiting_tcp(row):
            owners, tcp, _ = self._network(row); waiting = set()
            for inode, identity in list(existing_tcp[row['pid']].items()):
                if inode not in owners:
                    del existing_tcp[row['pid']][inode]  # A retired inode can never become an original again.
                    continue
                if inode not in tcp: raise AdmissionError('Original TCP descriptor has unknown kernel metadata')
                if tcp_identity(tcp[inode]) != identity: raise AdmissionError('Original TCP transport identity changed')
                if tcp[inode]['state'] in ('01', '08'): waiting.add(inode)
            return waiting
        while True:
            if self.frozen or self.kill_started: raise AdmissionError('Transport wait must precede every daemon freeze')
            if self.quiet_checker is not None: self.quiet_checker()
            if self.idle_checker() is not True:
                raise AdmissionError('New pool work began during managed transport wait; preserve it')
            for row in self._all_targets():
                if self._pin(row, expected_ticks=row['ticks']) in ('T', 't'):
                    raise AdmissionError('Daemon deliberately paused during transport wait')
                self._children(row)
            if child is not None:
                # Supporting known-busy detection only; never socket authorization.
                status = self.metadata_reader(child)
                if not isinstance(status, dict) or len(status) > 1000 or any(not isinstance(value, dict) or value.get('type') != 'idle' for value in status.values()):
                    raise AdmissionError('Managed OpenCode has busy or ambiguous session status')
            waiting_by_pid = {row['pid']: waiting_tcp(row) for row in observed}
            allowed = {row['pid']: set() for row in observed}
            if child is not None:
                po, pt, _ = self._network(parent); co, ct, _ = self._network(child)
                for inode, entry in pt.items():
                    if inode not in po or inode not in waiting_by_pid[parent['pid']] or entry['state'] not in ('01', '08') or entry['remote'] != f'0100007F:{child["port"]:04X}' or not entry['local'].startswith('0100007F:'): continue
                    peers = [other for other, peer in ct.items() if other in co and other in waiting_by_pid[child['pid']] and peer['local'] == entry['remote'] and peer['remote'] == entry['local'] and peer['state'] in ('01', '08')]
                    if len(peers) == 1:
                        allowed[parent['pid']].add(inode); allowed[child['pid']].add(peers[0])
                    elif entry['state'] == '08': allowed[parent['pid']].add(inode)
            busy = False
            for row in self._all_targets():
                try:
                    proof = self._sockets(row, allowed.get(row['pid'], set()))
                    busy = busy or bool(proof['drainingManagedSockets'])
                except AdmissionError as error:
                    # Never accept this socket. Only observe an existing owned TCP
                    # transport naturally disappear while every authority/idle proof holds.
                    if (self.quiet_checker is None or not (row is parent or row is child)
                        or getattr(error, 'admission_rejection_code', None) != 'socket_busy'
                        or getattr(error, 'socket_inode', None) not in waiting_by_pid[row['pid']]
                        or getattr(error, 'socket_family', None) not in ('tcp', 'tcp6')
                        or getattr(error, 'socket_state', None) not in ('01', '08')): raise
                    # A first old socket must never hide a simultaneous new socket,
                    # unknown descriptor or semantic failure later in /proc order.
                    # This observation-only pass masks current validated old TCP
                    # transports; frozen/pre-kill acceptance never receives this set.
                    self._sockets(row, allowed.get(row['pid'], set()) | waiting_tcp(row))
                    busy = True
            if self.quiet_checker is not None: self.quiet_checker()
            if self.clock() >= deadline:
                error = AdmissionError('Managed idle transport did not naturally close; preserve it')
                error.admission_rejection_code = 'socket_busy'
                self.receipt['managedTransportTimeout'] = True
                raise error
            if not busy:
                self.receipt['preFreezeTransportWaitSeconds'] = self.quiet_timeout - max(0, deadline - self.clock())
                return
            if self.clock() >= deadline:
                error = AdmissionError('Managed idle transport did not naturally close; preserve it')
                error.admission_rejection_code = 'socket_busy'
                self.receipt['managedTransportTimeout'] = True
                raise error
            self.sleep(min(1, max(0, deadline - self.clock())))

    def _network(self, row):
        root = self.proc / str(row['pid'])
        owners = {}
        for fd in (root / 'fd').iterdir():
            target = os.readlink(fd)
            if target.startswith('socket:[') and target.endswith(']'):
                owners.setdefault(target[8:-1], set()).add(fd.name)
        tcp = {}
        for name in ('tcp', 'tcp6'):
            lines = (root / 'net' / name).read_text().splitlines()
            for line in lines[1:]:
                fields = line.split()
                if len(fields) < 10:
                    raise AdmissionError('Ambiguous kernel TCP metadata')
                tcp[fields[9]] = dict(table=name, local=fields[1], remote=fields[2], state=fields[3], queue=fields[4])
        unix = set()
        for line in (root / 'net/unix').read_text().splitlines()[1:]:
            fields = line.split()
            if len(fields) < 7:
                raise AdmissionError('Ambiguous kernel Unix metadata')
            if fields[4] == '0001' and fields[5] == '03':
                unix.add(fields[6])
        return owners, tcp, unix

    def _sockets(self, row, draining=frozenset()):
        owners, tcp, unix = self._network(row)
        listeners = []; draining_count = 0; internal_pairs = []
        unix_proofs = None
        for inode, fds in owners.items():
            entry = tcp.get(inode)
            if inode in draining:
                draining_count += 1
                continue
            if entry and entry['table'] == 'tcp' and entry['state'] == '0A' and entry['local'] == f'0100007F:{row["port"]:04X}' and entry['remote'] == '00000000:0000':
                # Even unaccepted kernel backlog is conservatively rejected.
                if entry['queue'] != '00000000:00000000':
                    queue = entry['queue']
                    if len(queue) != 17 or queue[8] != ':' or any(c not in '0123456789abcdefABCDEF' for c in queue[:8] + queue[9:]):
                        raise AdmissionError('Ambiguous kernel TCP listener queue metadata')
                    # Reject every nonempty backlog. This tag authorizes only the
                    # existing full cleanup proof and a later natural checkpoint;
                    # no socket identity is attached that could enable draining.
                    diagnostic = {'pid': row['pid'], 'role': 'managed_native' if row.get('managedOpenCode') else 'primary' if row['unit'] == self.UNITS[0] else 'backend', 'family': 'tcp', 'state': '0A', 'phase': self.receipt.get('admissionPhase', 'unknown'), 'reason': 'listener_queued_ingress'}
                    rejections = self.receipt.setdefault('socketRejections', [])
                    if len(rejections) < 16: rejections.append(diagnostic)
                    error = AdmissionError('Daemon listener has queued ingress')
                    error.admission_rejection_code = 'socket_busy'
                    raise error
                listeners.append(inode)
                continue
            # systemd journal stdout/stderr are inherited Unix stream sockets,
            # not provider IPC. No other fd may own or duplicate those sockets.
            if inode in unix and fds <= {'1', '2'}:
                output, error = self.read_unit(row['unit'], 'StandardOutput'), self.read_unit(row['unit'], 'StandardError')
                if output == 'journal' and error in ('inherit', 'journal'):
                    continue
            if inode in unix:
                if unix_proofs is None: unix_proofs = self._empty_unix_pairs()
                if inode in unix_proofs:
                    internal_pairs.append(unix_proofs[inode])
                    continue
            # Metadata only: no local/remote addresses, paths, payloads or descriptors.
            family = entry['table'] if entry else 'unix' if inode in unix else 'unknown'
            state = entry['state'] if entry else 'connected_stream' if inode in unix else 'unknown'
            diagnostic = {'pid': row['pid'], 'role': 'execution_host' if row.get('executionHost') else 'managed_native' if row.get('managedOpenCode') else 'primary' if row['unit'] == self.UNITS[0] else 'backend', 'family': family, 'state': state, 'phase': self.receipt.get('admissionPhase', 'unknown')}
            self.receipt.setdefault('socketRejections', []).append(diagnostic)
            error = AdmissionError('Daemon has an accepted, outbound or unknown socket; preserve work')
            error.admission_rejection_code = 'socket_busy'
            error.socket_inode = inode
            error.socket_family = family
            error.socket_state = state
            raise error
        if len(listeners) != (0 if row.get('executionHost') else 1):
            raise AdmissionError('Exact managed loopback listener not verified')
        return {'pid': row['pid'], 'port': row['port'], 'listenerInode': listeners[0] if listeners else None, 'children': 0,
                'applicationSockets': 0, 'journalOnlyOtherSockets': not internal_pairs,
                'emptyOwnedUnixPairs': internal_pairs, 'drainingManagedSockets': draining_count}

    def _empty_unix_pairs(self):
        metadata = self.unix_diag_reader()
        if not isinstance(metadata, dict): raise AdmissionError('Invalid kernel Unix metadata')
        targets = {target['pid']: target for target in self._all_targets()}
        ownership = {}
        for target in targets.values():
            # The cross-process exception must remain bound to this operation's
            # exact pinned managed child, including its reviewed configuration.
            self._pin(target, expected_ticks=target['ticks'])
            fds, _tcp, unix = self._network(target)
            for inode in unix & fds.keys():
                ownership.setdefault(inode, {})[target['pid']] = fds[inode]
        allowed = {}
        for inode, owner in ownership.items():
            info = metadata.get(inode, {})
            peer = info.get('peer')
            other = metadata.get(peer, {})
            if (info.get('type') != socket.SOCK_STREAM or other.get('type') != socket.SOCK_STREAM
                or info.get('state') != 1 or other.get('state') != 1 or other.get('peer') != inode
                or peer == inode or any(entry.get(key) != 0 for entry in (info, other) for key in ('receiveQueue', 'sendQueue'))):
                continue
            peer_owner = ownership.get(peer, {})
            # Both endpoints must be exclusively owned within the same pinned
            # daemon's descriptors; aliases inside that process are harmless.
            if len(owner) == len(peer_owner) == 1 and set(owner) == set(peer_owner):
                pid = next(iter(owner))
                if pid in {target['pid'] for target in self.targets}:
                    allowed[inode] = {'kind': 'daemon_internal', 'peerInode': peer, 'receiveQueue': 0, 'sendQueue': 0}
                    continue
            # Node spawn's managed child stdout is a Unix socketpair on this
            # host. Only backend<->the pinned native child fd1 (known Bun alias5)
            # qualifies; no arbitrary application IPC or another child qualifies.
            if len(owner) != 1 or len(peer_owner) != 1: continue
            pid, peer_pid = next(iter(owner)), next(iter(peer_owner))
            backend = self.targets[1]['pid']
            for child in self.managed:
                if {pid, peer_pid} != {backend, child['pid']} or child['parentPid'] != backend: continue
                child_fds = owner[pid] if pid == child['pid'] else peer_owner[peer_pid]
                parent_fds = peer_owner[peer_pid] if pid == child['pid'] else owner[pid]
                if '1' in child_fds and child_fds <= {'1', '5'} and all(fd.isdigit() and int(fd) >= 3 for fd in parent_fds):
                    allowed[inode] = {'kind': 'managed_child_stdout', 'peerInode': peer, 'receiveQueue': 0, 'sendQueue': 0}
        return allowed

    def freeze_and_verify(self):
        if len(self.guards) != len(self.targets) or self.frozen or self.kill_started:
            raise AdmissionError('Effective owned restart guards required before freeze')
        try:
            self.receipt['admissionPhase'] = 'managed_transport_quiet'
            self._discover_managed_children()
            self._wait_managed_transport_quiet()
            self.receipt['admissionPhase'] = 'frozen_verification'
            for row in self._all_targets():
                if not row.get('managedOpenCode') and self.read_unit(row['unit'], 'Restart') != 'no':
                    raise AdmissionError('Restart suppression changed')
                state = self._pin(row, expected_ticks=row['ticks'])
                if state in ('T', 't'):
                    raise AdmissionError('Daemon was already deliberately paused')
                self.send(row['pid'], row['ticks'], signal.SIGSTOP)
                self.frozen.append(row)
                deadline = self.clock() + 2
                while True:
                    state = self._pin(row, expected_ticks=row['ticks'])
                    if state in ('T', 't'): break
                    if self.clock() >= deadline: raise AdmissionError('Daemon freeze not verified')
                    self.sleep(.01)
            proofs = []
            for row in self._all_targets():
                self._children(row); proofs.append(self._sockets(row))
            self.verified = True
            self.receipt.update(daemonAdmission='frozen_idle_verified', daemons=proofs)
        except BaseException:
            self.abort_before_kill()
            raise

    def kill_verified_daemons(self):
        if not self.verified or self.kill_started:
            raise AdmissionError('Both idle daemons must be verified before termination')
        self.receipt['admissionPhase'] = 'pre_kill_recheck'
        # Recheck everything while both application event loops remain stopped.
        for row in self._all_targets():
            if self._pin(row, expected_ticks=row['ticks']) not in ('T', 't') or self.read_unit(row['unit'], 'Restart') != 'no':
                raise AdmissionError('Daemon admission changed before termination')
            self._children(row); self._sockets(row)
        self.kill_started = True
        for row in self.managed + self.targets:
            self.send(row['pid'], row['ticks'], signal.SIGKILL)
        deadline = self.clock() + 5
        while True:
            dead = []
            for row in self._all_targets():
                try:
                    ticks, state = self._identity(row['pid'])
                    if ticks != row['ticks']: raise AdmissionError('Daemon PID reused during termination')
                    dead.append(state == 'Z')
                except FileNotFoundError: dead.append(True)
            if all(dead): break
            if self.clock() >= deadline:
                raise AdmissionError('Daemon death unverified; preserve frozen supervisor, hold and restart guards')
            self.sleep(.01)
        self.all_dead = True
        self.receipt['daemonAdmission'] = 'verified_idle_daemons_dead_without_resume'

    def abort_before_kill(self):
        if self.kill_started:
            raise AdmissionError('Termination began; preserve remaining frozen processes and guards')
        # Signal only processes this operation froze, by their original pidfd identity.
        for row in reversed(self.frozen):
            self.send(row['pid'], row['ticks'], signal.SIGCONT)
        self.frozen.clear()
        self.restore_restart_guards()
        self.receipt['daemonAdmission'] = 'aborted_without_terminating_work'

    def restore_restart_guards(self):
        if self.kill_started and not self.all_dead:
            raise AdmissionError('Preserve restart guards until both daemon deaths verified')
        for guard in reversed(self.guards):
            if guard.get('removed'): continue
            path = guard['path']
            info = path.lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_ino != guard['inode'] or info.st_dev != guard['device'] or path.read_bytes() != guard['data']:
                raise AdmissionError('Owned restart guard changed; preserve and inspect')
            path.unlink()
            guard['removed'] = True
            if guard['createdDirectory']:
                try: path.parent.rmdir()
                except OSError: pass  # Other operator drop-ins are never removed.
        if self.guards:
            self.reload()
            for guard in self.guards:
                if self.read_unit(guard['unit'], 'Restart') != guard['originalRestart']:
                    raise AdmissionError('Original restart policy not restored')
        self.guards.clear()
        self.receipt['restartGuardsRestored'] = True
