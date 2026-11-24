"""Private rollout invariants. No inference, game commands, service calls or credentials."""
import hashlib, json, os, stat
from pathlib import Path

HOST_UNIT = 'grunt-adventure-execution-host.service'

def sha(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''): digest.update(block)
    return digest.hexdigest()

def tree_digest(directory):
    root = Path(directory)
    if root.is_symlink() or not root.is_dir(): raise ValueError('Expected real dependency directory')
    rows = []
    for path in sorted(root.rglob('*')):
        name = path.relative_to(root).as_posix()
        if path.is_symlink():
            if not path.resolve().is_relative_to(root.resolve()): raise ValueError('Dependency symlink escapes runtime')
            rows.append([name, 'link', os.readlink(path)])
        elif path.is_file(): rows.append([name, 'file', stat.S_IMODE(path.stat().st_mode), sha(path)])
        elif not path.is_dir(): raise ValueError('Unsupported dependency entry')
    return hashlib.sha256(json.dumps(rows, separators=(',', ':')).encode()).hexdigest()

def assert_runtime(directory, plan, row):
    root = Path(directory)
    if root.is_symlink() or not root.is_dir(): raise ValueError('Expected real runtime')
    found = {p.relative_to(root).as_posix() for p in (root / 'dist').rglob('*') if p.is_file() or p.is_symlink()}
    expected = {name for name in plan['packageFiles'] if name.startswith('dist/')}
    if found != expected: raise ValueError('Installed dist file set differs from public package')
    for name, digest in plan['packageFiles'].items():
        target = root / name
        if target.is_symlink() or not target.is_file() or sha(target) != digest:
            raise ValueError('Public package byte mismatch: ' + name)
    if tree_digest(root / 'node_modules') != row['dependenciesSha256']:
        raise ValueError('Installed dependencies changed')

def session_roots(state):
    """Saved-session directory: the Claude Code runner's projects tree."""
    return [Path(state) / 'worker/claude/projects']

def session_snapshot(state, session_id):
    files = []
    for root in session_roots(state):
        if root.is_symlink(): raise ValueError('Saved session directory is a symlink')
        if not root.is_dir(): continue
        for path in sorted(root.rglob('*')):
            if path.is_symlink(): raise ValueError('Saved session symlink')
            if path.is_file(): files.append({'root': 'claude', 'path': path.relative_to(root).as_posix(), 'bytes': path.stat().st_size, 'sha256': sha(path)})
    if not files: raise ValueError('Saved session files missing')
    return {'sessionId': session_id, 'files': files}

def assert_session_preserved(state, snapshot, *, allow_append=False):
    roots = {'claude': Path(state) / 'worker/claude/projects'}
    config = json.loads((Path(state) / 'config.json').read_text())
    if config['sessionId'] != snapshot['sessionId']: raise ValueError('Saved session identity changed')
    for row in snapshot['files']:
        root = roots[row['root']]
        if root.is_symlink(): raise ValueError('Saved session directory changed')
        path = root / row['path']
        if path.is_symlink() or not path.is_file() or any(p.is_symlink() for p in path.parents if p != root.parent):
            raise ValueError('Saved session path changed')
        size = path.stat().st_size
        if size < row['bytes'] or (not allow_append and size != row['bytes']): raise ValueError('Saved session was truncated or replaced')
        with path.open('rb') as stream: digest = hashlib.sha256(stream.read(row['bytes'])).hexdigest()
        if digest != row['sha256']: raise ValueError('Saved session history changed')

def assert_profile(state, owner=None):
    """The Claude Code runner's pinned, hashed assets (the builder harness since the 0.10.0 cutover).

    The manifest (claude/assets.json) pins the claude binary (version + sha256 recorded in PIN.json at staging), the brief, the
    operator settings, the Stop hook and grunt-release. Permission mode is bypassPermissions by decision; the bubblewrap sandbox in the
    protected supervisor.py is the boundary, so this check pins bytes rather than refusing a mode."""
    config = json.loads((Path(state) / 'config.json').read_text())
    if config.get('harness') != 'claude-code': raise ValueError('The Adventure builder is not on the Claude Code harness')
    root = Path(owner or Path.home() / '.local/lib/usegrunt-adventure') / 'claude'
    manifest = json.loads((root / 'assets.json').read_text())
    if set(manifest['files']) != {'worker-brief.md', 'settings.json', 'hooks/stop_gate.py', 'bin/grunt-release', 'bin/claude'}:
        raise ValueError('Claude Code asset set changed')
    for name, digest in manifest['files'].items():
        path = root / name
        if path.is_symlink() or not path.is_file() or sha(path) != digest: raise ValueError('Claude Code asset changed: ' + name)

def assert_host_installation(policy_path, unit_path, state, owner, node, *, expected_policy_path=None):
    policy = json.loads(Path(policy_path).read_text())
    if str(Path(state) / 'execution-upgrade-hold') not in policy.get('holdFiles', []):
        raise ValueError('Execution host policy must preserve rollout hold')
    if policy.get('stateDirectory') != str(Path(state) / 'execution-host'):
        raise ValueError('Execution host private state directory changed')
    text = Path(unit_path).read_text()
    fields = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith(('#', ';', '[')): continue
        if '=' not in line: raise ValueError('Unsupported execution host unit line')
        key, value = line.split('=', 1)
        if key in fields: raise ValueError('Repeated execution host unit property')
        fields[key] = value
    expected = f'{node} {Path(owner) / "runtime/dist/local/main.js"} execution-host serve --config {expected_policy_path or policy_path}'
    if fields.get('ExecStart') != expected: raise ValueError('Execution host command changed')
    for field in ('PartOf', 'After', 'WantedBy'):
        if fields.get(field) != 'grunt-amazing-adventure.service': raise ValueError('Execution host must follow builder lifecycle only')
    if any(key.startswith('Exec') and key != 'ExecStart' for key in fields) or any(key in fields for key in ('Requires','BindsTo','Wants')):
        raise ValueError('Execution host unit must not launch startup work or unrelated units')
    return True

def assert_public_archive(plan):
    import base64, tarfile
    from pathlib import PurePosixPath
    archive = Path(plan['archive'])
    digest = 'sha512-' + base64.b64encode(hashlib.sha512(archive.read_bytes()).digest()).decode()
    if digest != plan['archiveIntegrity']: raise ValueError('Public archive integrity changed')
    found = {}
    with tarfile.open(archive, 'r:gz') as tar:
        for member in tar.getmembers():
            parts = PurePosixPath(member.name).parts
            if not parts or parts[0] != 'package' or any(p in ('.', '..') for p in parts): raise ValueError('Unsafe public archive path')
            if member.isdir(): continue
            if not member.isfile() or len(parts) < 2 or member.size > 20 * 1024 * 1024: raise ValueError('Unsupported public archive entry')
            name = '/'.join(parts[1:])
            if name in found: raise ValueError('Duplicate public archive entry')
            found[name] = hashlib.sha256(tar.extractfile(member).read()).hexdigest()
            source = Path(plan['reviewedSource']) / name
            if source.is_symlink() or sha(source) != found[name]: raise ValueError('Reviewed build changed')
    if found != plan['packageFiles']: raise ValueError('Public archive manifest changed')

def capture_cooldowns(snapshots, eligible, now):
    known = set(eligible); windows = {}
    for snapshot in snapshots.values():
        for row in snapshot['sources']:
            deadline = row.get('retryAt')
            if deadline is None: continue
            if isinstance(deadline, bool) or not isinstance(deadline, (int, float)) or not 0 <= deadline <= 8640000000000000:
                raise ValueError('Invalid installed cooldown deadline')
            if deadline <= now: continue
            if row['id'] not in known or row.get('errorCode') not in ('quota', 'upstream', 'timeout', 'refused') or deadline - now > 32 * 86400000:
                raise ValueError('Unrecognized future installed cooldown; preserve and inspect')
            old = windows.get(row['id'])
            # A shorter quota from either pool must retain quota semantics even when
            # a sibling error has a longer deadline; healthy() may clear non-quota holds.
            windows[row['id']] = {'id': row['id'], 'code': 'quota' if row['errorCode'] == 'quota' or old and old['code'] == 'quota' else row['errorCode'], 'retryAt': max(deadline, old['retryAt'] if old else 0)}
    return {'capturedAt': now, 'windows': [windows[key] for key in sorted(windows)]}

def assert_cooldowns(snapshot, captured, now):
    current = {row['id']: row for row in snapshot['sources']}
    for row in captured['windows']:
        if row['retryAt'] <= now: continue
        after = current.get(row['id'], {})
        if (after.get('retryAt') or 0) < row['retryAt'] or row['code'] == 'quota' and after.get('errorCode') != 'quota':
            raise ValueError('Installed cooldown was shortened: ' + row['id'])
