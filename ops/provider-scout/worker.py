"""Bounded Codex workers for discovery/integration and independent review.

Only structured final results and event counters leave this module. Raw tool
transcripts, authentication configuration and upstream payloads are not logged.
"""
import collections
import contextlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import threading
import time
import tomllib

MAX_OUTPUT_BYTES = 2 * 1024 * 1024
MAX_EVENT_BYTES = 1024 * 1024
SQUIRE_TOOLS = (
    'list_credentials', 'operate_start', 'operate_drive', 'operate_observe',
    'operate_click', 'operate_type', 'operate_press', 'operate_scroll',
    'operate_select', 'operate_login', 'operate_navigate', 'operate_wait',
    'operate_dialog', 'operate_finish', 'operate_extract', 'use_credential',
    'scout_install_grant',
)


class WorkerError(RuntimeError):
    """A safe reason code suitable for operator status, never raw stderr."""

    def __init__(self, reason, tool_counts=None):
        super().__init__(reason)
        self.reason = reason
        self.tool_counts = dict(tool_counts or {})


def _private_directory(path):
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise WorkerError('unsafe_worker_output_directory')


def _protected_file(path, workspace):
    try:
        info = path.lstat()
        valid = (path.is_absolute() and stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid()
                 and not info.st_mode & 0o022 and not path.resolve().is_relative_to(workspace.resolve()))
    except OSError:
        valid = False
    if not valid:
        raise WorkerError('missing_or_writable_squire_guard')
    return path.resolve()


def _integration_names(config):
    home = Path(config.get('codex_home') or os.environ.get('CODEX_HOME') or Path.home() / '.codex')
    file = home / 'config.toml'
    try:
        saved = tomllib.loads(file.read_text()) if file.exists() else {}
        servers, plugins = saved.get('mcp_servers', {}), saved.get('plugins', {})
        if not isinstance(servers, dict) or not isinstance(plugins, dict):
            raise ValueError('invalid integration configuration')
        return list(servers), list(plugins)
    except (OSError, ValueError, TypeError):
        raise WorkerError('cannot_inspect_integration_configuration') from None


def _override(args, key, value):
    args.extend(['-c', key + '=' + json.dumps(value, separators=(',', ':'))])


def _toml_table(values):
    """CLI values use TOML; JSON-quoted dotted keys are literal key segments."""
    def literal(value):
        if isinstance(value, dict):
            return '{' + ','.join(json.dumps(key) + '=' + literal(item) for key, item in value.items()) + '}'
        return json.dumps(value, separators=(',', ':'))
    return literal(values)


def _disable_integrations(args, servers, plugins, role):
    # Codex splits override paths on '.', retaining quote characters. Never put
    # TOML/JSON quotes around individual dotted-path segments. A special name
    # needs one whole native TOML table, containing no backend config/secrets.
    plain = re.compile(r'[A-Za-z0-9_@-]+\Z')
    if all(plain.fullmatch(name) for name in servers):
        for name in servers:
            if role == 'reviewer' or name != 'squire':
                _override(args, 'mcp_servers.' + name + '.enabled', False)
    else:
        table = {name: {'enabled': False} for name in servers}
        args.extend(['-c', 'mcp_servers=' + _toml_table(table)])
    if all(plain.fullmatch(name) for name in plugins):
        for name in plugins:
            _override(args, 'plugins.' + name + '.enabled', False)
    else:
        args.extend(['-c', 'plugins=' + _toml_table({name: {'enabled': False} for name in plugins})])


def build_command(request, config, schema_path):
    """Return argv only; configuration values never become shell code."""
    role = request.get('role')
    if role not in ('implementer', 'reviewer'):
        raise WorkerError('invalid_worker_role')
    cwd = Path(request['cwd']).resolve()
    codex = str(config['codex'])
    if not Path(codex).is_absolute() or not cwd.is_dir():
        raise WorkerError('invalid_worker_paths')
    duration = request.get('timeout_seconds', 600)
    if isinstance(duration, bool) or not isinstance(duration, (float, int)) or not math.isfinite(duration) or not 0 < duration <= 3600:
        raise WorkerError('invalid_worker_deadline')
    args = [shutil.which('timeout') or '/usr/bin/timeout', '--signal=TERM', '--kill-after=10s', str(duration),
            codex, '--no-daemon', '--disable', 'apps', '--disable', 'plugins']
    if request.get('web_search', True):
        args.append('--search')
    servers, plugins = _integration_names(config)
    _disable_integrations(args, servers, plugins, role)
    if role == 'reviewer':
        # Preserve the user's configured model while removing every integration.
        # No --ignore-user-config/model override or broad permission profile is used.
        args.extend(['-a', 'never'])
        _override(args, 'mcp_servers.squire.enabled', False)
        args.extend(['exec', '--sandbox', 'read-only'])
    else:
        proxy = _protected_file(Path(config.get('squire_proxy') or Path(__file__).with_name('squire_proxy.py')), cwd)
        # Auto-review examines each sensitive action; this is not blanket MCP approval.
        smoke = request.get('smoke', False)
        args.extend(['-a', 'never'] if smoke else ['--approve-for-me'])
        # --sandbox conflicts with --approve-for-me in the installed CLI. The
        # native config override also pins the intended policy when user config
        # otherwise selects danger-full-access.
        _override(args, 'sandbox_mode', 'workspace-write')
        _override(args, 'sandbox_workspace_write.writable_roots', [])
        _override(args, 'sandbox_workspace_write.network_access', True)
        _override(args, 'mcp_servers.squire.enabled', True)
        _override(args, 'mcp_servers.squire.command', sys.executable)
        proxy_args = [str(proxy)]
        if not smoke:
            helper = _protected_file(Path(config.get('provision_helper') or proxy.with_name('provision.mjs')), cwd)
            proxy_args.extend(['--workspace', str(cwd), '--provision-helper', str(helper)])
            if config.get('node_binary'):
                node = Path(config['node_binary'])
                if not node.is_absolute() or not node.is_file():
                    raise WorkerError('invalid_worker_node_path')
                proxy_args.extend(['--node', str(node.resolve())])
        if config.get('squire_backend_config'):
            backend = _protected_file(Path(config['squire_backend_config']), cwd)
            if stat.S_IMODE(backend.stat().st_mode) != 0o600:
                raise WorkerError('unsafe_squire_backend_configuration')
            proxy_args.extend(['--backend-config', str(backend)])
        if config.get('squire_proxy_state'):
            state = Path(config['squire_proxy_state'])
            if not state.is_absolute() or state.resolve().is_relative_to(cwd):
                raise WorkerError('unsafe_squire_proxy_state')
            _private_directory(state)
            proxy_args.extend(['--state-dir', str(state)])
        _override(args, 'mcp_servers.squire.args', proxy_args)
        tools = ['list_credentials'] if smoke else list(SQUIRE_TOOLS)
        _override(args, 'mcp_servers.squire.enabled_tools', tools)
        _override(args, 'mcp_servers.squire.default_tools_approval_mode', 'prompt')
        _override(args, 'mcp_servers.squire.tools.list_credentials.approval_mode', 'approve')
        args.extend(['exec', '--sandbox', 'workspace-write', '--trust'] if smoke else ['exec', '--trust'])
    args.extend(['--ephemeral', '--skip-git-repo-check', '-C', str(cwd), '--json',
                 '--output-schema', str(schema_path), '--output-last-message', str(request['output_path']), '-'])
    return args


def preflight_workspace_sandbox(config, protected_dir):
    """Exercise native OS write restrictions without invoking a model or MCP.

    protected_dir belongs outside the worker workspace and normal scratch roots
    (such as /tmp). Host-side file checks, rather than a model assertion, decide
    whether the native workspace sandbox successfully enforced the boundary.
    """
    root = Path(protected_dir).resolve()
    _private_directory(root)
    codex = str(config['codex'])
    if not Path(codex).is_absolute():
        raise WorkerError('invalid_worker_paths')
    with tempfile.TemporaryDirectory(prefix='.sandbox-preflight-', dir=root) as temporary:
        directory = Path(temporary)
        workspace = directory / 'workspace'
        workspace.mkdir(mode=0o700)
        inside, outside = workspace / 'inside', directory / 'outside'
        program = ('import errno,pathlib,sys\n'
                   'pathlib.Path(sys.argv[1]).write_text("workspace-write-probe")\n'
                   'try:\n pathlib.Path(sys.argv[2]).write_text("must-be-denied")\n'
                   'except OSError as error:\n'
                   ' if error.errno not in (errno.EPERM,errno.EACCES,errno.EROFS): raise\n')
        args = [codex, '--approve-for-me', '-c', 'sandbox_mode="workspace-write"',
                '-c', 'sandbox_workspace_write.writable_roots=[]',
                '-c', 'sandbox_workspace_write.network_access=false',
                'sandbox', '--permission-profile', ':workspace', '-C', str(workspace),
                '--', sys.executable, '-c', program, str(inside), str(outside)]
        env = {key: value for key, value in os.environ.items()
               if key in ('HOME', 'PATH', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'CODEX_HOME')}
        if config.get('codex_home'):
            env['CODEX_HOME'] = str(Path(config['codex_home']).resolve())
        process = None
        try:
            process = subprocess.Popen(args, env=env, stdin=subprocess.DEVNULL,
                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                       start_new_session=True)
            code = process.wait(timeout=30)
            if code != 0 or not inside.is_file() or outside.exists():
                raise WorkerError('workspace_sandbox_preflight_failed')
            return {'workspace_write_verified': True, 'outside_write_blocked': True}
        except (OSError, subprocess.SubprocessError):
            raise WorkerError('workspace_sandbox_preflight_failed') from None
        finally:
            if process is not None:
                _stop(process)


def _matches(value, schema):
    if 'const' in schema and value != schema['const']:
        return False
    if 'anyOf' in schema and not any(_matches(value, choice) for choice in schema['anyOf']):
        return False
    if 'oneOf' in schema and sum(_matches(value, choice) for choice in schema['oneOf']) != 1:
        return False
    if 'allOf' in schema and not all(_matches(value, choice) for choice in schema['allOf']):
        return False
    types = schema.get('type', [])
    types = [types] if isinstance(types, str) else types
    valid = {'null': value is None, 'boolean': isinstance(value, bool), 'string': isinstance(value, str),
             'integer': isinstance(value, int) and not isinstance(value, bool),
             'number': isinstance(value, (int, float)) and not isinstance(value, bool),
             'array': isinstance(value, list), 'object': isinstance(value, dict)}
    if types and not any(valid.get(kind, False) for kind in types):
        return False
    if 'enum' in schema and value not in schema['enum']:
        return False
    if isinstance(value, dict):
        properties = schema.get('properties', {})
        if any(key not in value for key in schema.get('required', [])):
            return False
        if schema.get('additionalProperties') is False and any(key not in properties for key in value):
            return False
        if any(not _matches(item, properties[key]) for key, item in value.items() if key in properties):
            return False
    if isinstance(value, list):
        if len(value) < schema.get('minItems', 0) or len(value) > schema.get('maxItems', 10000):
            return False
        if any(not _matches(item, schema.get('items', {})) for item in value):
            return False
    if isinstance(value, str):
        if len(value) < schema.get('minLength', 0) or len(value) > schema.get('maxLength', MAX_OUTPUT_BYTES):
            return False
        if 'pattern' in schema and re.search(schema['pattern'], value) is None:
            return False
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if not math.isfinite(value) or value < schema.get('minimum', -math.inf) or value > schema.get('maximum', math.inf):
            return False
    return True


def _read_result(path, schema):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, 'rb') as file:
        info = os.fstat(file.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_size > MAX_OUTPUT_BYTES:
            raise WorkerError('unsafe_worker_result')
        result = json.loads(file.read(MAX_OUTPUT_BYTES + 1))
    path.chmod(0o600)
    if not _matches(result, schema):
        raise WorkerError('worker_result_schema_mismatch')
    return result


def _stop(worker):
    # Even a completed CLI can leave an owned background process in its group.
    # That process must not change candidate files after validation starts.
    with contextlib.suppress(ProcessLookupError):
        os.killpg(worker.pid, signal.SIGTERM)
    try:
        worker.wait(timeout=10)
    except subprocess.TimeoutExpired:
        pass
    finally:
        with contextlib.suppress(ProcessLookupError):
            os.killpg(worker.pid, signal.SIGKILL)
        worker.wait()


def run_agent(request, config, progress=None):
    """Run a bounded worker and return a schema-validated result plus counters.

    request = {role, prompt, schema, cwd, output_path, timeout_seconds,
               web_search=True, smoke=False, lock_fd?}
    config requires codex; squire_proxy/codex_home/backend_config are optional.
    A reviewer always has no integrations and a read-only filesystem sandbox.
    """
    output = Path(request['output_path'])
    _private_directory(output.parent)
    if output.exists() or output.is_symlink():
        raise WorkerError('worker_output_already_exists')
    schema = request['schema']
    if not isinstance(schema, dict) or not isinstance(request.get('prompt'), str):
        raise WorkerError('invalid_worker_request')
    descriptor, temporary = tempfile.mkstemp(prefix='.worker-schema-', suffix='.json', dir=output.parent)
    schema_path = Path(temporary)
    with os.fdopen(descriptor, 'w') as file:
        json.dump(schema, file)
    worker = reader = None
    counts = collections.Counter()
    violation = threading.Event()
    rejected = 0
    previous_handlers = {}
    try:
        args = build_command(request, config, schema_path)
        allowed = {'HOME', 'PATH', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TERM',
                   'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'CODEX_HOME'}
        env = {key: value for key, value in os.environ.items() if key in allowed}
        env['PATH'] = str(Path.home() / '.local/bin') + ':/usr/local/bin:/usr/bin:/bin'
        env['GIT_NO_REPLACE_OBJECTS'] = '1'
        if config.get('codex_home'):
            env['CODEX_HOME'] = str(Path(config['codex_home']).resolve())
        lock_fd = request.get('lock_fd')
        if lock_fd is not None and (isinstance(lock_fd, bool) or not isinstance(lock_fd, int) or lock_fd < 0):
            raise WorkerError('invalid_worker_lock')
        worker = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                  text=True, encoding='utf-8', errors='replace', env=env, start_new_session=True,
                                  pass_fds=() if lock_fd is None else (lock_fd,))

        def consume():
            nonlocal rejected
            for line in iter(lambda: worker.stdout.readline(MAX_EVENT_BYTES + 1), ''):
                if len(line) > MAX_EVENT_BYTES:
                    continue
                try:
                    event = json.loads(line)
                    item = event.get('item', {})
                    kind = item.get('type', '')
                    if kind == 'mcp_tool_call' and request['role'] == 'reviewer':
                        violation.set()
                    if event.get('type') == 'item.completed' and re.fullmatch('[a-z_]{1,64}', kind):
                        counts[kind] += 1
                        if kind == 'mcp_tool_call' and re.search(r'approval.{0,80}(?:reject|denied)|(?:reject|denied).{0,80}approval', str(item.get('error', '')), re.I):
                            rejected += 1
                except (ValueError, TypeError, AttributeError):
                    pass

        reader = threading.Thread(target=consume, daemon=True)
        reader.start()

        def cancel(*_):
            raise InterruptedError()

        if threading.current_thread() is threading.main_thread():
            for number in (signal.SIGTERM, signal.SIGINT):
                previous_handlers[number] = signal.signal(number, cancel)
        worker.stdin.write(request['prompt'])
        worker.stdin.close()
        deadline = time.monotonic() + request.get('timeout_seconds', 600)
        heartbeat = 0
        while True:
            if violation.is_set():
                raise WorkerError('reviewer_integration_violation', counts)
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise WorkerError('worker_timeout', counts)
            try:
                code = worker.wait(timeout=min(1, remaining))
                break
            except subprocess.TimeoutExpired:
                if progress and time.monotonic() - heartbeat >= 10:
                    progress({'event': 'worker_progress', 'role': request['role'], 'worker_pid': worker.pid,
                              'tool_counts': dict(counts), 'approval_rejections': rejected})
                    heartbeat = time.monotonic()
        reader.join(timeout=5)
        if violation.is_set():
            raise WorkerError('reviewer_integration_violation', counts)
        if code in (124, 137):
            raise WorkerError('worker_timeout', counts)
        if code != 0:
            raise WorkerError('worker_failed', counts)
        if request.get('require_web_search', False) and not counts['web_search'] and not counts['web_search_call']:
            raise WorkerError('worker_did_not_search', counts)
        result = _read_result(output, schema)
        return {'result': result, 'tool_counts': dict(counts), 'approval_rejections': rejected,
                'exit_code': code, 'output_path': str(output)}
    except WorkerError:
        raise
    except InterruptedError:
        raise WorkerError('worker_cancelled', counts) from None
    except (OSError, ValueError, TypeError, KeyError):
        raise WorkerError('worker_execution_or_output_failed', counts) from None
    finally:
        for number in previous_handlers:
            signal.signal(number, signal.SIG_IGN)
        try:
            if worker is not None:
                _stop(worker)
                if reader is not None:
                    reader.join(timeout=5)
                worker.stdout.close()
                with contextlib.suppress(BrokenPipeError):
                    worker.stdin.close()
        finally:
            for number, handler in previous_handlers.items():
                signal.signal(number, handler)
            schema_path.unlink(missing_ok=True)
