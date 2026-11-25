"""Read-only pinned-catalog startup admission proof; does not manage services or files.

API: gate = StartupGate.capture(config_directory=..., candidate_runtime=..., node=...,
 effective_environment=selected_planned_env, hard_deadline_ms=now_ms+180000,
 source_ids_per_port={'8792': status_ids, '8793': status_ids})
Then gate.assert_ready(effective_environment, source_ids_per_port=...) before activation
and every held check. gate.assert_process_environment(pid, expected_entry) verifies the
primary's actual argv and selected environment. The transaction owner installs/restores
TEMP_ENV_CONTENT only while that service is stopped; this module never writes it.
"""
from __future__ import annotations
import copy
import json
import os
from pathlib import Path
import stat
import subprocess
import time
from typing import Callable

from rollout_config import load_expectations, expected_port_sets

TEMP_ENV_CONTENT = b'[Service]\nEnvironment=GRUNT_SETUP_NO_DATA_SHARING=1\n'
MAX_HOLD_MS = 180000
DEFAULT_MARGIN_MS = 30000
EXPECTATIONS = load_expectations()
EXPECTED_DEFERRED = EXPECTATIONS['consentDeferred']
EXPECTED_UNION = EXPECTATIONS['eligibleUnion']
EXPECTED_PORTS = expected_port_sets(EXPECTATIONS)   # per pool: the union minus the owner opt-ins that belong to the other pool only
RETIRED_PACKAGED = EXPECTATIONS['retiredPackagedSources']
SETTINGS = ('CONFIG_DIR', 'PORT', 'SOURCES', 'DAEMON', 'OPT_IN_SOURCES', 'BACKGROUND_ACCOUNT_ACQUISITION', 'SETUP_NO_DATA_SHARING')
ENV_KEYS = frozenset(f'{prefix}_{name}' for prefix in ('GRUNT', 'MILO') for name in SETTINGS)
class GateError(RuntimeError):
    pass

class MaintenanceWindowError(GateError):
    """A probe-eligible source's next maintenance check falls inside hard deadline + margin.
    Pure schedule timing: the pinned metadata is otherwise valid, nothing was written, and a later moment can pass.
    Callers that have mutated nothing may wait for the next natural checkpoint; callers past the first mutation must treat it as any GateError."""
    def __init__(self, earliest_source: str, earliest_at_ms: int, floor_ms: int):
        super().__init__('Startup admission preflight failed closed: a source maintenance check is due inside the startup window; nothing was changed.')
        self.earliest_source, self.earliest_at_ms, self.floor_ms = earliest_source, earliest_at_ms, floor_ms

def _fail() -> None:
    raise GateError('Startup admission preflight failed closed; preserve state; root recovery is required if startup began.')

def _selected(environment: dict) -> dict[str, str]:
    if not isinstance(environment, dict):
        _fail()
    if any(environment.get(name) for name in ('NODE_OPTIONS', 'NODE_PATH')):
        _fail()
    result = {}
    for name in ENV_KEYS:
        if name in environment:
            value = environment[name]
            if not isinstance(value, str) or '\0' in value or len(value.encode()) > 16384:
                _fail()
            result[name] = value
    return result

def _setting(environment: dict, name: str) -> str | None:
    return environment.get('GRUNT_' + name, environment.get('MILO_' + name))

def _read_bounded(path: Path, maximum: int) -> bytes:
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode) or before.st_uid != os.getuid() or before.st_size > maximum:
            _fail()
        chunks = []
        size = 0
        while True:
            part = os.read(descriptor, min(65536, maximum + 1 - size))
            if not part:
                break
            chunks.append(part)
            size += len(part)
            if size > maximum:
                _fail()
        after = os.fstat(descriptor)
        if (before.st_ino, before.st_dev, before.st_mtime_ns, before.st_ctime_ns) != (after.st_ino, after.st_dev, after.st_mtime_ns, after.st_ctime_ns):
            _fail()
        return b''.join(chunks)
    finally:
        os.close(descriptor)

class StartupGate:
    @classmethod
    def capture(cls, *, config_directory: str, candidate_runtime: str, node: str,
                effective_environment: dict, hard_deadline_ms: int,
                margin_ms: int = DEFAULT_MARGIN_MS, source_ids_per_port: dict | None = None,
                metadata_reader: Callable[[dict], dict] | None = None,
                now_ms: Callable[[], int] | None = None) -> 'StartupGate':
        gate = cls()
        gate.config_directory = str(Path(config_directory).resolve(strict=True))
        gate.candidate_runtime = str(Path(candidate_runtime).resolve(strict=True))
        gate.node = str(Path(node).resolve(strict=True))
        gate.environment = _selected(effective_environment)
        gate.source_ids_per_port = copy.deepcopy(source_ids_per_port)
        gate.now_ms = now_ms or (lambda: time.time_ns() // 1000000)
        if not isinstance(hard_deadline_ms, int) or isinstance(hard_deadline_ms, bool) or not isinstance(margin_ms, int) or isinstance(margin_ms, bool) or not 1000 <= margin_ms <= 60000:
            _fail()
        duration = hard_deadline_ms - gate.now_ms()
        if not 0 < duration <= MAX_HOLD_MS:
            _fail()
        gate.hard_deadline_ms, gate.margin_ms = hard_deadline_ms, margin_ms
        gate.monotonic_deadline = time.monotonic() + duration / 1000
        gate.metadata_reader = metadata_reader or gate._metadata
        gate._process_starts = {}
        value = gate.metadata_reader(gate._input(gate.environment, gate.source_ids_per_port))
        gate._validate(value)
        gate._baseline = copy.deepcopy(value)
        return gate

    @property
    def baseline(self) -> dict:
        return copy.deepcopy(self._baseline)

    def _input(self, environment: dict, source_ids_per_port: dict | None) -> dict:
        value = {'runtimeDirectory': self.candidate_runtime, 'configDirectory': self.config_directory,
                 'effectiveEnvironment': _selected(environment), 'ownerOptIns': EXPECTATIONS['ownerOptIns']}
        if source_ids_per_port is not None:
            value['sourceIdsPerPort'] = source_ids_per_port
        return value

    def _metadata(self, value: dict) -> dict:
        helper = Path(__file__).with_name('startup_gate_metadata.mjs')
        environment = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'HOME': '/nonexistent'}
        try:
            result = subprocess.run([self.node, str(helper)], input=json.dumps(value).encode(),
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=False, timeout=10, env=environment)
            if result.returncode or len(result.stdout) > 65536:
                _fail()
            parsed = json.loads(result.stdout)
            if not isinstance(parsed, dict):
                _fail()
            return parsed
        except (OSError, subprocess.SubprocessError, ValueError):
            _fail()

    def _validate(self, value: dict) -> None:
        if self.now_ms() >= self.hard_deadline_ms or time.monotonic() >= self.monotonic_deadline:
            _fail()
        if not isinstance(value, dict) or value.get('version') != 1 or value.get('retiredPackagedSources') != RETIRED_PACKAGED or value.get('eligibleUnion') != EXPECTED_UNION or value.get('consentDeferred') != EXPECTED_DEFERRED or value.get('staleOrdinaryPolicies') != [] or value.get('optOut') is not True or value.get('accountAcquisitionDisabled') is not True or value.get('primaryManagedAutomatic') is not True:
            _fail()
        expected_checks = [item for item in EXPECTED_UNION if item not in EXPECTED_DEFERRED]
        if value.get('potentialChecks') != expected_checks or value.get('sourceIdsPerPort') != EXPECTED_PORTS or value.get('ownerOptIns') != EXPECTATIONS['ownerOptIns']:
            _fail()
        for name in ('consentSha256', 'policySha256', 'registrySha256', 'maintenanceSha256', 'probeEntriesSha256'):
            text = value.get(name)
            if not isinstance(text, str) or len(text) != 64 or any(char not in '0123456789abcdef' for char in text):
                _fail()
        checks = value.get('nextCheckAt')
        if not isinstance(checks, dict) or sorted(checks) != expected_checks:
            _fail()
        floor = self.hard_deadline_ms + self.margin_ms
        if any(not isinstance(at, int) or isinstance(at, bool) or not at <= 8640000000000000 for at in checks.values()):
            _fail()
        soonest = min(checks, key=checks.get)
        if checks[soonest] <= floor:
            raise MaintenanceWindowError(soonest, checks[soonest], floor)

    def assert_ready(self, effective_environment: dict | None = None, *, source_ids_per_port: dict | None = None) -> dict:
        environment = self.environment if effective_environment is None else _selected(effective_environment)
        if environment != self.environment or _setting(environment, 'BACKGROUND_ACCOUNT_ACQUISITION') != '0' or _setting(environment, 'SETUP_NO_DATA_SHARING') != '1':
            _fail()
        ports = self.source_ids_per_port if source_ids_per_port is None else source_ids_per_port
        value = self.metadata_reader(self._input(environment, ports))
        self._validate(value)
        # Deferred-only schedule writes are expected; authority and source policies are immutable.
        for name in ('consentSha256', 'policySha256', 'registrySha256', 'sourceIdsPerPort', 'eligibleUnion', 'consentDeferred', 'potentialChecks', 'probeEntriesSha256'):
            if value[name] != self._baseline[name]:
                _fail()
        return copy.deepcopy(value)

    @staticmethod
    def _start_ticks(pid: int) -> bytes:
        data = _read_bounded(Path('/proc') / str(pid) / 'stat', 16384)
        try:
            return data.rsplit(b')', 1)[1].split()[19]
        except (IndexError, ValueError):
            _fail()

    def assert_process_environment(self, pid: int, expected_entry: str) -> dict:
        if not isinstance(pid, int) or isinstance(pid, bool) or pid < 1:
            _fail()
        before = self._start_ticks(pid)
        if pid in self._process_starts and self._process_starts[pid] != before:
            _fail()
        root = Path('/proc') / str(pid)
        argv = _read_bounded(root / 'cmdline', 65536).split(b'\0')
        if argv[-1:] == [b'']:
            argv.pop()
        if len(argv) != 2 or os.fsdecode(argv[0]) != self.node or os.fsdecode(argv[1]) != expected_entry:
            _fail()
        selected = {}
        # Decode only the allowlisted settings; never return or log unrelated process values.
        for item in _read_bounded(root / 'environ', 1024 * 1024).split(b'\0'):
            key, separator, value = item.partition(b'=')
            if separator and key in (b'NODE_OPTIONS', b'NODE_PATH') and value:
                _fail()
            if separator and key.decode('ascii', errors='ignore') in ENV_KEYS:
                selected[key.decode('ascii')] = value.decode('utf8', errors='strict')
        if self._start_ticks(pid) != before or selected != self.environment:
            _fail()
        self._process_starts[pid] = before
        return self.assert_ready(selected)
