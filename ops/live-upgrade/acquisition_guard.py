"""Private metadata-only guard for the explicitly disabled acquisition callback."""
import os, re, shlex
from pathlib import Path
FLAG = 'GRUNT_BACKGROUND_ACCOUNT_ACQUISITION'
DROPIN_BYTES = b'[Service]\nEnvironment=GRUNT_BACKGROUND_ACCOUNT_ACQUISITION=0\n'

def environment_rows(text):
    try: values = shlex.split(text)
    except ValueError as error: raise RuntimeError('Ambiguous primary unit environment') from error
    result = []
    for value in values:
        name, separator, setting = value.partition('=')
        if not separator or not re.fullmatch('[A-Za-z_][A-Za-z0-9_]*', name): raise RuntimeError('Ambiguous primary unit environment')
        result.append((name, setting, value))
    return result

def normalized_service_environment(text):
    """Only the intended disabled assignment may differ from the original unit hash."""
    rows = environment_rows(text)
    selected = [setting for name, setting, _ in rows if name == FLAG]
    if selected and selected != ['0']: raise RuntimeError('Unexpected primary account-acquisition override')
    return shlex.join([raw for name, _setting, raw in rows if name != FLAG])

def assert_unit_opt_out(reader):
    rows = environment_rows(reader('Environment'))
    if [setting for name, setting, _ in rows if name == FLAG] != ['0']:
        raise RuntimeError('Primary unit must explicitly disable account acquisition before startup')
    if reader('EnvironmentFiles'):
        raise RuntimeError('Primary environment files require separate account-acquisition review')
    try: unset = shlex.split(reader('UnsetEnvironment'))
    except ValueError as error: raise RuntimeError('Ambiguous primary environment removal') from error
    if any(value.partition('=')[0] == FLAG for value in unset): raise RuntimeError('Primary acquisition opt-out could be removed')
    return {'effectiveUnitOptOut': True, 'accountAcquisition': False}

def _read(path, limit):
    with Path(path).open('rb') as stream: value = stream.read(limit + 1)
    if len(value) > limit: raise RuntimeError('Oversized primary process metadata')
    return value

def _identity(proc):
    try:
        tail = _read(proc / 'stat', 65536).decode().rpartition(') ')[2].split()
        if len(tail) <= 19 or tail[0] == 'Z' or not tail[19].isdigit(): raise ValueError()
        return tail[19]
    except (OSError, UnicodeError, ValueError) as error: raise RuntimeError('Primary process identity is unavailable') from error

def assert_process_opt_out(reader, node, script, *, proc_root=Path('/proc')):
    proof = assert_unit_opt_out(reader)
    try: pid = int(reader('MainPID'))
    except ValueError as error: raise RuntimeError('Primary process identity is unavailable') from error
    if pid <= 1: raise RuntimeError('Primary process is not running')
    proc = Path(proc_root) / str(pid); ticks = _identity(proc)
    if proc.stat().st_uid != os.getuid(): raise RuntimeError('Primary process owner changed')
    command = [part.decode() for part in _read(proc / 'cmdline', 65536).split(b'\0') if part]
    if command != [node, script] or os.readlink(proc / 'exe') != node:
        raise RuntimeError('Primary process is not the trusted managed entry point')
    entries = [part.partition(b'=') for part in _read(proc / 'environ', 1024 * 1024).split(b'\0') if b'=' in part]
    if [setting for name, _separator, setting in entries if name == FLAG.encode()] != [b'0']:
        raise RuntimeError('Actual primary process did not disable account acquisition')
    if reader('MainPID') != str(pid) or _identity(proc) != ticks:
        raise RuntimeError('Primary process changed during account-acquisition verification')
    return {**proof, 'effectiveProcessOptOut': True, 'pid': pid, 'startTicks': ticks}
