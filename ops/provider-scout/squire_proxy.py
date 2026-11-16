#!/usr/bin/env python3
"""Restricted, metadata-only credential capture bridge for the operator scout.

The real Squire transport and its environment are read by this backend process;
they are never returned to the model. This bridge does not grant tool approval.
Codex still reviews the allowed browser operations under its normal policy.
"""
import argparse
from datetime import datetime, timedelta, timezone
import ipaddress
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
import tomllib
import uuid
from urllib.parse import urlsplit

ALLOWED_TOOLS = frozenset({
    'scout_install_grant',
    'list_credentials', 'use_credential', 'operate_start', 'operate_drive',
    'operate_observe', 'operate_click', 'operate_type', 'operate_press',
    'operate_scroll', 'operate_select', 'operate_login', 'operate_navigate',
    'operate_wait', 'operate_dialog', 'operate_finish', 'operate_extract',
})
MAX_LINE = 4 * 1024 * 1024
_PAYMENT_FIELDS = {'amount_cents', 'card_id', 'payment_card', 'payment_method_id', 'cvv', 'pan'}
_FORMAT_TOOLS = {'operate_start', 'operate_observe', 'operate_click', 'operate_type', 'operate_press',
                 'operate_scroll', 'operate_select', 'operate_navigate', 'operate_wait'}
INSTALL_TOOL = {'name': 'scout_install_grant', 'description':
    'Install a backend-only Squire provider grant for an approved candidate API credential. '
    'Checks fresh exact-service vault metadata and writes a private candidate config. '
    'Returns only the relative config path; never returns a bearer token. Does not certify free usage or consent.',
    'inputSchema': {'type': 'object', 'additionalProperties': False,
        'required': ['service', 'reference', 'source_id'], 'properties': {
            'service': {'type': 'string', 'minLength': 1, 'maxLength': 200},
            'reference': {'type': 'string', 'pattern': '^vault://', 'maxLength': 2048},
            'source_id': {'type': 'string', 'pattern': '^[a-z][a-z0-9-]{0,63}$'}}}}


class Denied(ValueError):
    pass


_DENIAL_CODES = {
    'Candidate credential metadata does not match': 'candidate_metadata_mismatch',
    'Identity and publishing credentials cannot be installed': 'identity_credential_denied',
    'Identity credentials cannot be installed': 'identity_credential_denied',
    'An API-key credential is required': 'api_key_metadata_required',
    'Provider hosts are required': 'provider_hosts_required',
    'Explicit public provider hosts are required': 'provider_hosts_invalid',
    'Identity and publishing hosts cannot be installed': 'identity_host_denied',
    'Candidate already has a different tracked grant': 'candidate_reference_changed',
    'Candidate grant budget reached': 'grant_budget_reached',
    'Grant response did not contain a usable backend grant': 'grant_response_invalid',
    'Candidate grant installation failed': 'install_helper_failed',
    'Candidate grant installation did not return safe metadata': 'install_metadata_invalid',
    'Private backend operation failed': 'private_backend_failed',
    'Installation is not configured': 'install_not_configured',
}


def _instant(value):
    if not isinstance(value, str) or len(value) > 64:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
        return parsed.astimezone(timezone.utc) if parsed.tzinfo else None
    except ValueError:
        return None


def _grant_current(value, now=None):
    now = now or datetime.now(timezone.utc)
    expiry = _instant(value.get('expires_at'))
    if expiry:
        return now < expiry
    created = _instant(value.get('created_at'))
    return created is not None and created <= now < created + timedelta(hours=12)


def _public_url(value):
    if not isinstance(value, str) or len(value) > 4096:
        return False
    url = urlsplit(value)
    if url.scheme != 'https' or not url.hostname or url.username or url.password:
        return False
    host = url.hostname.lower()
    if host == 'localhost' or host.endswith(('.localhost', '.local', '.internal')):
        return False
    try:
        return ipaddress.ip_address(host).is_global
    except ValueError:
        return True


def _service(value):
    return isinstance(value, str) and 0 < len(value.strip()) <= 200 and value.strip() != '*'


def _payment_fields(value):
    if isinstance(value, dict):
        return any(str(key).lower() in _PAYMENT_FIELDS or _payment_fields(item) for key, item in value.items())
    if isinstance(value, list):
        return any(_payment_fields(item) for item in value)
    return False


def validate_call(name, arguments, sessions):
    """Return a safe copy; denied calls never reach the real Squire process."""
    if name not in ALLOWED_TOOLS or not isinstance(arguments, dict):
        raise Denied('Tool is not available to the scouting worker')
    args = json.loads(json.dumps(arguments))
    if _payment_fields(args) or 'proxy' in args:
        raise Denied('Payment and proxy configuration are not permitted')
    if name == 'scout_install_grant':
        if set(args) != {'service', 'reference', 'source_id'} or not _service(args.get('service')):
            raise Denied('A specific candidate service is required')
        if not isinstance(args.get('reference'), str) or not args['reference'].startswith('vault://') or len(args['reference']) > 2048:
            raise Denied('A vault reference is required')
        if not isinstance(args.get('source_id'), str) or not re.fullmatch('[a-z][a-z0-9-]{0,63}', args['source_id']):
            raise Denied('A bounded candidate source identifier is required')
        return args
    if name == 'list_credentials':
        services = args.get('service')
        if not (_service(services) or isinstance(services, list) and 0 < len(services) <= 20 and all(_service(item) for item in services)):
            raise Denied('A specific service filter is required')
        return {'service': services, 'fields': 'summary'}
    if name == 'use_credential':
        http = args.get('http')
        if not isinstance(http, dict) or http.get('method', '').upper() not in ('GET', 'POST') or not _public_url(http.get('url')):
            raise Denied('A bounded HTTPS API request is required')
        # A model must not ask an upstream echo/model endpoint to repeat a key.
        if '${SECRET' in str(http.get('body', '')):
            raise Denied('Secret injection in request bodies is not permitted')
        path = urlsplit(http['url']).path.lower()
        if any(part in {'echo', 'debug', 'headers', 'env', 'keys', 'api-keys', 'secrets', 'credentials', 'checkout', 'payments', 'topup', 'deposit', 'cards'} for part in path.split('/')):
            raise Denied('Credential-management and payment endpoints are not permitted')
        return args

    session = args.get('session_id')
    if session is not None and session not in sessions:
        raise Denied('Only scout-owned browser sessions may be used')
    if name not in ('operate_start', 'operate_drive') and not session:
        raise Denied('A scout-owned browser session is required')
    if name == 'operate_start' and not _public_url(args.get('service_url')):
        raise Denied('A public HTTPS provider URL is required')
    if name == 'operate_drive' and (not session or args.get('url') is not None) and not _public_url(args.get('url')):
        raise Denied('A public HTTPS provider URL is required')
    if name == 'operate_navigate' and not _public_url(args.get('url')):
        raise Denied('A public HTTPS provider URL is required')
    if name == 'operate_extract':
        capture = args.get('capture')
        store = capture.get('store') if isinstance(capture, dict) else args.get('store')
        if not isinstance(store, dict) or not _service(store.get('service')):
            raise Denied('Credential extraction must store directly in the vault')
        if capture is not None and (not isinstance(capture, dict) or not isinstance(capture.get('source'), dict)):
            raise Denied('A capture source is required')
        # Never permit a second raw/slot extraction branch in the same request.
        args.pop('into_slot', None)
    if name == 'operate_login' and args.get('action') not in ('oauth', 'prepare_signup', 'store_signup', 'load_saved'):
        raise Denied('Unsupported sealed-login operation')
    # Full DOM and screenshots can contain a newly revealed API key.
    if name in _FORMAT_TOOLS:
        args['format'] = 'compact'
    return args


def _payload(result):
    if not isinstance(result, dict):
        return {}
    if isinstance(result.get('structuredContent'), dict):
        return result['structuredContent']
    for content in result.get('content', []):
        if isinstance(content, dict) and content.get('type') == 'text':
            try:
                parsed = json.loads(content.get('text', ''))
                if isinstance(parsed, dict):
                    return parsed
            except (ValueError, TypeError):
                pass
    return {}


def _credential_metadata(value):
    if not isinstance(value, dict):
        return {}
    out = {}
    reference = value.get('reference')
    if isinstance(reference, str) and reference.startswith('vault://') and len(reference) <= 2048:
        out['reference'] = reference
    for key in ('service', 'label', 'created_at'):
        item = value.get(key)
        if isinstance(item, str) and len(item) <= 300 and not re.search(r'\b(?:sk-|Bearer\s|eyJ)', item):
            out[key] = item
    for key in ('field_names', 'allowed_hosts'):
        items = value.get(key)
        if isinstance(items, list):
            out[key] = [item for item in items[:100] if isinstance(item, str) and re.fullmatch(r'[A-Za-z0-9_.:/-]{1,200}', item)]
    return out


def _result(payload, error=False):
    return {'content': [{'type': 'text', 'text': json.dumps(payload, separators=(',', ':'))}],
            'structuredContent': payload, 'isError': error}


def project_result(name, result):
    """Never forward extraction values or original upstream error payloads."""
    data = _payload(result)
    if isinstance(result, dict) and result.get('isError'):
        return _result({'error': 'Squire operation failed; no upstream payload was retained'}, True)
    if name == 'operate_extract':
        out = {}
        for key in ('stored', 'closed'):
            if isinstance(data.get(key), bool):
                out[key] = data[key]
        for key in ('storage', 'cleanup', 'execution', 'mutation', 'retry'):
            if isinstance(data.get(key), str) and re.fullmatch('[a-z_]{1,40}', data[key]):
                out[key] = data[key]
        for key in ('session_id', 'operation_id', 'write_id'):
            if isinstance(data.get(key), str) and re.fullmatch('[A-Za-z0-9._:-]{1,200}', data[key]):
                out[key] = data[key]
        if isinstance(data.get('candidate_count'), int):
            out['candidate_count'] = max(0, data['candidate_count'])
        metadata = _credential_metadata(data.get('stored_credential'))
        if metadata:
            out['stored_credential'] = metadata
        if data.get('error'):
            out['error'] = 'Credential capture needs attention; no raw payload was retained'
        return _result(out)
    if name == 'list_credentials':
        rows = data.get('credentials')
        if not isinstance(rows, list):
            return _result({'error': 'Vault metadata lookup did not return a credential list'}, True)
        return _result({'credentials': [_credential_metadata(row) for row in rows[:100]]})
    if name == 'use_credential':
        status = data.get('status', data.get('status_code', data.get('http_status')))
        if isinstance(status, int) and status >= 400:
            return _result({'status': status, 'error': 'Provider request failed; no upstream error payload was retained'})
    return result


def filter_catalog(result, install_enabled=False):
    if not isinstance(result, dict) or not isinstance(result.get('tools'), list):
        return {'tools': []}
    tools = []
    for original in result['tools']:
        if not isinstance(original, dict) or original.get('name') not in ALLOWED_TOOLS or original.get('name') == 'scout_install_grant':
            continue
        tool = json.loads(json.dumps(original))
        schema = tool.setdefault('inputSchema', {'type': 'object', 'properties': {}})
        if tool['name'] == 'operate_extract':
            tool['description'] = 'Capture a revealed provider key directly into the vault. Requires store.service or capture.store.service. Returns metadata only; raw extraction and slot-only extraction are prohibited.'
            store = {'type': 'object', 'required': ['service'], 'properties': {
                'service': {'type': 'string', 'minLength': 1, 'maxLength': 200, 'pattern': r'\S'}}}
            schema['anyOf'] = [
                {'required': ['store'], 'properties': {'store': store}},
                {'required': ['capture'], 'properties': {'capture': {
                    'type': 'object', 'required': ['store', 'source'], 'properties': {
                        'store': store, 'source': {'type': 'object'}}}}},
            ]
        if tool['name'] == 'list_credentials':
            tool['description'] = 'Look up saved account metadata for specific candidate services. Requires service and always returns fields=summary; secret values are never returned.'
            schema['required'] = list(dict.fromkeys([*schema.get('required', []), 'service']))
            schema.setdefault('properties', {})['fields'] = {'type': 'string', 'enum': ['summary']}
        tools.append(tool)
    if install_enabled:
        tools.append(INSTALL_TOOL)
    return {'tools': tools}


def backend_config(path=None):
    if path is None:
        path = Path(os.environ.get('CODEX_HOME', str(Path.home() / '.codex'))) / 'config.toml'
        source = 'toml'
    else:
        path = Path(path)
        source = 'json'
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077 or info.st_size > 1048576:
        raise ValueError('Backend configuration must be a private owned regular file')
    value = tomllib.loads(path.read_text()).get('mcp_servers', {}).get('squire') if source == 'toml' else json.loads(path.read_text())
    if not isinstance(value, dict) or not isinstance(value.get('command'), str) or not value['command']:
        raise ValueError('No stdio Squire backend is configured')
    args = value.get('args', [])
    env = value.get('env', {})
    if not isinstance(args, list) or not all(isinstance(arg, str) for arg in args) or not isinstance(env, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in env.items()):
        raise ValueError('Invalid Squire transport configuration')
    if any('squire_proxy.py' in arg for arg in args):
        raise ValueError('Recursive Squire proxy configuration is not permitted')
    return [value['command'], *args], {**os.environ, **env}


def _private_dir(path):
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise ValueError('Proxy state requires a private owned directory')


class SessionStore:
    def __init__(self, directory):
        self.directory = Path(directory)
        _private_dir(self.directory)
        self.path = self.directory / 'sessions.json'
        self.lock = threading.Lock()
        self.sessions = set()
        if self.path.exists():
            info = self.path.lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600 or info.st_size > 262144:
                raise ValueError('Unsafe proxy session state')
            value = json.loads(self.path.read_text())
            if not isinstance(value, list) or len(value) > 1000 or not all(isinstance(item, str) for item in value):
                raise ValueError('Invalid proxy session state')
            self.sessions = set(value)

    def contains(self):
        with self.lock:
            return set(self.sessions)

    def observe(self, name, arguments, result):
        payload = _payload(result)
        session = payload.get('session_id')
        with self.lock:
            if name in ('operate_start', 'operate_drive') and not arguments.get('session_id') and isinstance(session, str) and re.fullmatch('[A-Za-z0-9._:-]{1,200}', session):
                if len(self.sessions) >= 1000:
                    raise ValueError('Scout session budget reached')
                self.sessions.add(session)
                self.persist()
            if name == 'operate_finish' and payload.get('closed') is True:
                self.sessions.discard(arguments.get('session_id'))
                self.persist()

    def persist(self):
        fd, temporary = tempfile.mkstemp(prefix='sessions.', suffix='.tmp', dir=self.directory)
        try:
            with os.fdopen(fd, 'w') as output:
                json.dump(sorted(self.sessions), output)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, self.path)
        finally:
            Path(temporary).unlink(missing_ok=True)


def _provider_metadata(data, service, reference):
    """Bind exactly one API key, rejecting identity and package-publishing keys."""
    rows = data.get('credentials', [])
    rows = [row for row in rows if isinstance(row, dict) and row.get('reference') == reference
            and isinstance(row.get('service'), str) and row['service'].casefold() == service.casefold()]
    if len(rows) != 1:
        raise Denied('Candidate credential metadata does not match')
    row = rows[0]
    if re.search(r'(^|[^a-z])(npm|github|google|oauth|login|identity|payment|stripe|paypal)([^a-z]|$)', service.casefold()):
        raise Denied('Identity and publishing credentials cannot be installed')
    names = row.get('field_names')
    # Squire's legacy/single-field API keys use "value" or "token" rather
    # than "api_key". The exact service/reference and provider hosts bind
    # those generic fields; identity and publishing services stay excluded.
    if not isinstance(names, list) or not any(isinstance(name, str) and re.sub('[^a-z]', '', name.lower()) in ('apikey', 'key', 'value', 'token') for name in names):
        raise Denied('An API-key credential is required')
    if any(isinstance(name, str) and re.sub('[^a-z]', '', name.lower()) in ('password', 'refresh_token', 'refreshtoken', 'cookie', 'sessioncookie') for name in names):
        raise Denied('Identity credentials cannot be installed')
    hosts = row.get('allowed_hosts')
    if not isinstance(hosts, list) or not hosts or len(hosts) > 100:
        raise Denied('Provider hosts are required')
    for host in hosts:
        if not isinstance(host, str):
            raise Denied('Explicit public provider hosts are required')
        # Squire uses a single leading wildcard for provider subdomains.
        # Validate its public base and apply the same identity exclusions.
        base_host = host[2:] if host.startswith('*.') else host
        if not re.fullmatch(r'[A-Za-z0-9.-]+', base_host) or '.' not in base_host or not _public_url('https://' + base_host):
            raise Denied('Explicit public provider hosts are required')
        normalized = base_host.casefold().rstrip('.')
        if (any(normalized == domain or normalized.endswith('.' + domain) for domain in (
                'github.com', 'githubusercontent.com', 'npmjs.org', 'npmjs.com', 'google.com',
                'googleapis.com', 'stripe.com', 'paypal.com'))
                or set(normalized.split('.')) & {'accounts', 'oauth', 'login', 'identity'}):
            raise Denied('Identity and publishing hosts cannot be installed')
    return row


class GrantStore:
    """Backend-only reusable bearer grants; never returned through MCP."""
    def __init__(self, directory):
        self.path = Path(directory) / 'grants.json'
        self.values = {}
        if self.path.exists():
            info = self.path.lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600 or info.st_size > 1048576:
                raise ValueError('Unsafe proxy grant state')
            self.values = json.loads(self.path.read_text())
            if not isinstance(self.values, dict) or len(self.values) > 128:
                raise ValueError('Invalid proxy grant state')

    def save(self, key, value):
        if key not in self.values and len(self.values) >= 128:
            raise Denied('Candidate grant budget reached')
        self.values[key] = value
        fd, temporary = tempfile.mkstemp(prefix='grants.', suffix='.tmp', dir=self.path.parent)
        try:
            with os.fdopen(fd, 'w') as output:
                json.dump(self.values, output)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, self.path)
        finally:
            Path(temporary).unlink(missing_ok=True)


class GrantInstaller:
    def __init__(self, workspace, helper, node, state_directory):
        self.workspace, self.helper = Path(workspace), Path(helper)
        if not self.workspace.is_absolute() or not self.helper.is_absolute():
            raise ValueError('Trusted absolute installation paths are required')
        self.workspace = self.workspace.resolve(strict=True)
        if not self.workspace.is_dir() or self.workspace.stat().st_uid != os.getuid():
            raise ValueError('An owned workspace is required')
        info = self.helper.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o022:
            raise ValueError('A protected installation helper is required')
        if self.helper.resolve().is_relative_to(self.workspace):
            raise ValueError('Installation helper must be outside the worker workspace')
        self.node = str(Path(node or shutil.which('node') or '').resolve(strict=True))
        self.store = GrantStore(state_directory)
        self.lock = threading.Lock()

    def install(self, args, call):
        with self.lock:
            metadata = call('list_credentials', {'service': args['service'], 'fields': 'summary'})
            _provider_metadata(metadata, args['service'], args['reference'])
            key = args['source_id']
            saved = self.store.values.get(key)
            if saved and (saved.get('reference') != args['reference'] or saved.get('service') != args['service']):
                raise Denied('Candidate already has a different tracked grant')
            if not saved or not _grant_current(saved):
                if key not in self.store.values and len(self.store.values) >= 128:
                    raise Denied('Candidate grant budget reached')
                previous = list(saved.get('previous_grants', [])) if saved else []
                if saved:
                    previous.append({field: saved[field] for field in (
                        'grant_id', 'reference', 'service', 'created_at', 'expires_at') if field in saved})
                # Never revoke a prior grant automatically: a promoted config
                # may still depend on it. Retain IDs for operator-owned cleanup.
                grant = call('grant_app_access', {'reference': args['reference']})
                base, token = grant.get('base_url'), grant.get('token')
                if not _public_url(base) or urlsplit(base).query or urlsplit(base).fragment or not isinstance(token, str) or not 0 < len(token) <= 16384:
                    raise Denied('Grant response did not contain a usable backend grant')
                now = datetime.now(timezone.utc)
                expires = _instant(grant.get('expires_at')) or now + timedelta(hours=12)
                if expires <= now:
                    raise Denied('Grant response did not contain a usable backend grant')
                saved = {'reference': args['reference'], 'service': args['service'], 'base_url': base, 'token': token,
                         'created_at': now.isoformat(), 'expires_at': expires.isoformat()}
                if previous:
                    saved['previous_grants'] = previous
                if isinstance(grant.get('grant_id'), str) and len(grant['grant_id']) <= 300:
                    saved['grant_id'] = grant['grant_id']
                # Track before installation so a failed helper cannot leak an orphan grant.
                self.store.save(key, saved)
            request = {'workspace': str(self.workspace), 'source_id': key,
                       'grant': {'base_url': saved['base_url'], 'token': saved['token']}}
            completed = subprocess.run([self.node, str(self.helper)], input=json.dumps(request),
                text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=30)
            if completed.returncode or len(completed.stdout) > 8192:
                raise Denied('Candidate grant installation failed')
            output = json.loads(completed.stdout)
            relative = f'candidate-configs/{key}/{key}.json'
            if not isinstance(output, dict) or output.get('installed') is not True or output.get('source_id') != key or output.get('config_file') != relative:
                raise Denied('Candidate grant installation did not return safe metadata')
            return {'installed': True, 'source_id': key, 'config_file': relative}


class Proxy:
    def __init__(self, argv, env, state, source=None, sink=None, installer=None):
        self.argv, self.env, self.state = argv, env, state
        self.source = source or sys.stdin.buffer
        self.sink = sink or sys.stdout.buffer
        self.pending = {}
        self.lock = threading.Lock()
        self.output_lock = threading.Lock()
        self.backend = None
        self.installer = installer
        self.backend_lock = threading.Lock()
        self.tasks = []

    def send_backend(self, message):
        with self.backend_lock:
            self.backend.stdin.write(json.dumps(message).encode() + b'\n')
            self.backend.stdin.flush()

    def internal_call(self, name, arguments):
        request_id = 'scout-private-' + uuid.uuid4().hex
        record = {'event': threading.Event()}
        with self.lock:
            self.pending[request_id] = record
        try:
            self.send_backend({'jsonrpc': '2.0', 'id': request_id, 'method': 'tools/call',
                               'params': {'name': name, 'arguments': arguments}})
            if not record['event'].wait(30) or record.get('failed'):
                raise Denied('Private backend operation failed')
            result = record.get('result', {})
            if not isinstance(result, dict) or result.get('isError'):
                raise Denied('Private backend operation failed')
            return _payload(result) or (result if 'content' not in result else {})
        finally:
            with self.lock:
                self.pending.pop(request_id, None)

    def install_request(self, request_id, args):
        try:
            if not self.installer:
                raise Denied('Installation is not configured')
            result = _result(self.installer.install(args, self.internal_call))
        except Denied as error:
            result = _result({'installed': False, 'error': 'Candidate grant installation needs attention; no backend payload was retained',
                              'code': _DENIAL_CODES.get(str(error), 'policy_denied')}, True)
        except (OSError, ValueError, TypeError, KeyError, subprocess.SubprocessError):
            result = _result({'installed': False, 'error': 'Candidate grant installation needs attention; no backend payload was retained',
                              'code': 'installation_failed'}, True)
        self.emit({'jsonrpc': '2.0', 'id': request_id, 'result': result})

    def emit(self, value):
        encoded = json.dumps(value, separators=(',', ':')).encode() + b'\n'
        if len(encoded) > MAX_LINE:
            raise ValueError('Oversized proxy response')
        with self.output_lock:
            self.sink.write(encoded)
            self.sink.flush()

    def error(self, request_id, text):
        self.emit({'jsonrpc': '2.0', 'id': request_id, 'error': {'code': -32602, 'message': text}})

    def client_message(self, message):
        if not isinstance(message, dict) or message.get('jsonrpc') != '2.0':
            raise ValueError('Invalid protocol message')
        method = message.get('method')
        request_id = message.get('id')
        if method == 'tools/call':
            params = message.get('params', {})
            try:
                name = params.get('name')
                args = validate_call(name, params.get('arguments', {}), self.state.contains())
            except (Denied, AttributeError, TypeError, ValueError):
                self.error(request_id, 'This Squire operation is not permitted by the scouting policy')
                return
            message = {**message, 'params': {**params, 'arguments': args}}
            if name == 'scout_install_grant':
                self.tasks = [task for task in self.tasks if task.is_alive()]
                if self.tasks:
                    self.error(request_id, 'A candidate installation is already in progress')
                    return
                task = threading.Thread(target=self.install_request, args=(request_id, args), daemon=True)
                self.tasks.append(task)
                task.start()
                return
            record = {'method': method, 'name': name, 'arguments': args}
        elif method in ('initialize', 'ping', 'tools/list') or method is None:
            record = {'method': method}
        elif method in ('notifications/initialized', 'notifications/cancelled'):
            record = {'method': method}
        else:
            if request_id is not None:
                self.error(request_id, 'Protocol operation is not available to the scouting worker')
            return
        if request_id is not None and method is not None:
            with self.lock:
                if request_id in self.pending:
                    raise ValueError('Duplicate request identifier')
                self.pending[request_id] = record
        self.send_backend(message)

    def backend_message(self, message):
        if not isinstance(message, dict):
            raise ValueError('Invalid backend protocol message')
        method = message.get('method')
        if method is not None:
            if method == 'elicitation/create':
                self.emit(message)
            elif method == 'notifications/tools/list_changed':
                self.emit({'jsonrpc': '2.0', 'method': method})
            # Backend logging and arbitrary notifications can contain payloads.
            return
        with self.lock:
            record = self.pending.pop(message.get('id'), None)
        if record is None:
            return
        if 'event' in record:
            record['failed'] = 'error' in message
            record['result'] = message.get('result', {})
            record['event'].set()
            return
        if 'error' in message:
            self.emit({'jsonrpc': '2.0', 'id': message.get('id'), 'error': {'code': -32603, 'message': 'Squire backend request failed'}})
            return
        result = message.get('result', {})
        if record['method'] == 'tools/list':
            result = filter_catalog(result, self.installer is not None)
        elif record['method'] == 'tools/call':
            self.state.observe(record['name'], record['arguments'], result)
            result = project_result(record['name'], result)
        self.emit({'jsonrpc': '2.0', 'id': message.get('id'), 'result': result})

    @staticmethod
    def read(stream):
        while True:
            line = stream.readline(MAX_LINE + 1)
            if not line:
                return
            if len(line) > MAX_LINE:
                raise ValueError('Oversized protocol message')
            try:
                yield json.loads(line)
            except (ValueError, UnicodeDecodeError):
                raise ValueError('Invalid protocol JSON') from None

    def run(self):
        # Only the spawned stdio backend is owned here. Existing broker/browser
        # processes never receive signals from this proxy.
        self.backend = subprocess.Popen(self.argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=subprocess.DEVNULL, env=self.env, bufsize=0)
        failed = threading.Event()

        def consume():
            try:
                for message in self.read(self.backend.stdout):
                    self.backend_message(message)
            except (ValueError, OSError, TypeError, KeyError):
                failed.set()

        reader = threading.Thread(target=consume, daemon=True)
        reader.start()
        try:
            for message in self.read(self.source):
                if failed.is_set() or self.backend.poll() is not None:
                    return 1
                self.client_message(message)
            for task in self.tasks:
                task.join(timeout=65)
            self.backend.stdin.close()
            try:
                self.backend.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.backend.terminate()
            reader.join(timeout=5)
            return 1 if failed.is_set() else 0
        except (ValueError, OSError, TypeError, KeyError):
            return 1
        finally:
            if self.backend.poll() is None:
                self.backend.terminate()
                try:
                    self.backend.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self.backend.kill()
                    self.backend.wait()
            reader.join(timeout=2)
            self.backend.stdout.close()
            if not self.backend.stdin.closed:
                self.backend.stdin.close()


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--backend-config', type=Path)
    parser.add_argument('--state-dir', type=Path, default=Path.home() / '.local/state/usegrunt-scout/squire-proxy')
    parser.add_argument('--workspace', type=Path)
    parser.add_argument('--provision-helper', type=Path)
    parser.add_argument('--node', type=Path)
    options = parser.parse_args()
    try:
        argv, env = backend_config(options.backend_config)
        state = SessionStore(options.state_dir)
        if bool(options.workspace) != bool(options.provision_helper):
            raise ValueError('Both trusted installation paths are required')
        installer = GrantInstaller(options.workspace, options.provision_helper, options.node, options.state_dir) if options.workspace else None
        return Proxy(argv, env, state, installer=installer).run()
    except (OSError, ValueError, TypeError, KeyError):
        # Never include an exception, transport environment or upstream payload.
        return 1


if __name__ == '__main__':
    sys.exit(main())
