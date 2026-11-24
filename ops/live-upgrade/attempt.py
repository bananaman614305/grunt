"""Attempt directories for `upgrade.py`: create, seal, prepare, rehearse (read-only) and launch one planned-pause upgrade.

An attempt directory is private (0700) and self-contained: sealed copies of the helper set, the release evidence and the reviewed source
(`source/`), the pinned public registry, and everything the controller (`pause-and-activate.py`) writes while it runs. Nothing in this
module changes the live host except `launch`, which starts one transient user unit. Every external effect is injectable for the tests."""
import datetime
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request
from pathlib import Path
from zoneinfo import ZoneInfo

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.dont_write_bytecode = True
import hostpaths  # noqa: E402
import release_pins  # noqa: E402
import registry_refresh  # noqa: E402
import rollout_config  # noqa: E402

TOOLING = ('upgrade.py', 'attempt.py', 'release_pins.py')      # run from the repository; never copied into an attempt directory
DEFAULT_WORKSPACE = Path(os.environ.get('XDG_STATE_HOME') or hostpaths.HOME / '.local/state') / 'usegrunt-upgrades'
REGISTRY_URLS = registry_refresh.REGISTRY_URLS   # same order as src/local/registry.ts
OPENCODE_PROFILE = '{"permission":{"external_directory":"deny"}}'   # the managed native OpenCode child's pinned OPENCODE_CONFIG_CONTENT
OPENCODE_SOURCE = 'src/local/opencode.ts'
BUDGETS = {'overallSeconds': 7200, 'checkpointWaitSeconds': 3600, 'pauseSettleSeconds': 1500, 'activationSeconds': 900, 'verifySeconds': 900}
UNIT_PREFIX = 'grunt-runtime-upgrade-'
DEFAULT_AUTHORIZATION = ('Planned maintenance pause: the owner authorized deliberately pausing the Amazing Adventure builder for about 10-15 minutes, '
                         'between cycles and never mid-cycle, as the standard live-upgrade path (ops/live-upgrade/README.md)')
SCOUT_TIMES = ((9, 0), (21, 0))      # provider scout cron, America/New_York; it uses the runtime this upgrade swaps


class AttemptError(RuntimeError):
    """A precondition failed; nothing live was changed."""


def sha(value):
    return hashlib.sha256(value if isinstance(value, bytes) else Path(value).read_bytes()).hexdigest()


def write_private(path, value, *, exclusive=True):
    data = value if isinstance(value, str) else json.dumps(value, indent=2) + '\n'
    fd = os.open(path, os.O_CREAT | os.O_WRONLY | os.O_TRUNC | (os.O_EXCL if exclusive else 0), 0o600)
    with os.fdopen(fd, 'w') as stream:
        stream.write(data)


# ----------------------------------------------------------------------------- the attempt directory

def new_attempt_dir(workspace, version, *, now=None):
    now = now or datetime.datetime.now(datetime.timezone.utc)
    workspace = Path(workspace)
    workspace.mkdir(parents=True, exist_ok=True)
    stamp = now.strftime('%Y%m%dT%H%M%SZ')
    for index in range(100):
        path = workspace / (f'runtime-upgrade-{version}-{stamp}' + (f'-{index}' if index else ''))
        try:
            path.mkdir(mode=0o700)
            return path
        except FileExistsError:
            continue
    raise AttemptError('Could not create a fresh attempt directory')


def unit_name(attempt):
    """grunt-runtime-upgrade-<version>-<stamp>, unique per attempt directory."""
    version, stamp = attempt_parts(attempt)
    return f'{UNIT_PREFIX}{version}-{stamp.lower()}'


def attempt_parts(attempt):
    name = Path(attempt).name
    if not name.startswith('runtime-upgrade-'):
        raise AttemptError(f'{name} is not an upgrade attempt directory')
    version, _, stamp = name[len('runtime-upgrade-'):].partition('-')
    return version, stamp


def attempts(workspace):
    return sorted((path for path in Path(workspace).glob('runtime-upgrade-*') if path.is_dir() and (path / rollout_config.ATTEMPT_FILE).is_file()),
                  key=lambda path: json.loads((path / rollout_config.ATTEMPT_FILE).read_text()).get('createdAt', 0))


def latest_attempt(workspace, version=None):
    rows = [path for path in attempts(workspace) if version is None or json.loads((path / rollout_config.ATTEMPT_FILE).read_text())['version'] == version]
    if not rows:
        raise AttemptError('No upgrade attempt directory found' + (f' for {version}' if version else ''))
    return rows[-1]


def helper_names():
    return [path.name for path in rollout_config.helper_files(HERE) if path.name not in TOOLING]


def install_helpers(attempt):
    """Copy the production helper set (never tests or this tooling) into the attempt directory."""
    for name in helper_names():
        target = Path(attempt) / name
        shutil.copy2(HERE / name, target)
        target.chmod(0o600)
    return helper_names()


def write_scope(attempt, version, previous, *, created_at=None, node=None):
    """attempt.json: the release pair (derived from --version and the installed runtime) and the managed Node binary (discovered from the live
    unit), which every sealed helper reads through rollout_config."""
    value = {'version': version, 'previousVersion': previous, 'createdAt': time.time() if created_at is None else created_at}
    if node is not None:
        value['node'] = str(node)
    write_private(Path(attempt) / rollout_config.ATTEMPT_FILE, value)


def discover_node(unit_value, unit='milo.service'):
    """The Node binary the primary daemon actually runs under, from its unit's ExecStart (`{ path=... ; argv[]=<node> <script> ... }`)."""
    exec_start = unit_value(unit, 'ExecStart')
    marker = 'argv[]='
    if marker not in exec_start:
        raise AttemptError(f'{unit} has no ExecStart to discover the managed Node binary from')
    node = exec_start.split(marker, 1)[1].split()[0]
    if not os.path.isabs(node) or not os.access(node, os.X_OK):
        raise AttemptError(f'The managed Node binary {node!r} of {unit} is not an executable absolute path')
    if os.path.realpath(node) != node:
        raise AttemptError(f'The managed Node binary {node!r} of {unit} is a symlink; the daemon checks compare resolved binaries, so point the unit at {os.path.realpath(node)}')
    return node


def installed_version(runtimes):
    """The version both installed runtime trees agree on."""
    versions = {json.loads((Path(runtime) / 'package.json').read_text())['version'] for runtime in runtimes}
    if len(versions) != 1:
        raise AttemptError(f'The installed runtimes disagree on their version: {sorted(versions)}')
    return versions.pop()


# ----------------------------------------------------------------------------- the owner-file payload (optional)

def build_payload(attempt, payload_dir, owner):
    """Copy an operator-supplied payload (free-pool.mjs, claude/worker-brief.md, claude/bin/grunt-release) into the attempt and derive
    claude/assets.json from the live manifest, exactly as the stage step will re-derive and require it. Returns the file names."""
    source = Path(payload_dir)
    allowed = {'free-pool.mjs', 'claude/worker-brief.md', 'claude/bin/grunt-release'}
    found = {path.relative_to(source).as_posix() for path in source.rglob('*') if path.is_file() or path.is_symlink()}
    if not found or found - allowed:
        raise AttemptError('A payload may contain only ' + ', '.join(sorted(allowed)) + (f' (found extra: {sorted(found - allowed)})' if found - allowed else ''))
    target = Path(attempt) / 'payload'
    target.mkdir(mode=0o700)
    for name in sorted(found):
        origin = source / name
        if origin.is_symlink():
            raise AttemptError(f'Payload file {name} is a symlink')
        (target / name).parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        shutil.copy2(origin, target / name)
        (target / name).chmod(0o700 if name.startswith('claude/bin/') else 0o600)
    if found & {'claude/worker-brief.md', 'claude/bin/grunt-release'}:
        import stage   # deferred: stage reads rollout_config, which is scoped by the attempt directory only when run from inside it
        live = json.loads((Path(owner) / 'claude/assets.json').read_text())['files']
        files = {name: (sha(target / 'claude' / name) if name in ('worker-brief.md', 'bin/grunt-release') and (target / 'claude' / name).is_file() else live[name])
                 for name in stage.ASSET_NAMES}
        write_private(target / 'claude/assets.json', json.dumps({'files': files}, indent=1) + '\n')
        found.add('claude/assets.json')
    return sorted(found)


# ----------------------------------------------------------------------------- the pinned public registry and baselines

def fetch_public_registry(*, opener=urllib.request.urlopen):
    """(raw bytes, url, etag or None) of the public registry, from the first host that answers (like the daemon)."""
    try:
        return registry_refresh.fetch_public_registry(opener=opener)
    except registry_refresh.RegistryRefreshError as error:
        raise AttemptError(str(error)) from error


def opencode_profile_pin():
    return hashlib.sha256(OPENCODE_PROFILE.encode()).hexdigest()


def opencode_profile_unchanged(source, previous_commit, commit, *, run=subprocess.run):
    """True when src/local/opencode.ts (which builds the pinned profile) is byte-identical at the previous and the new release commit."""
    result = run(['git', '-C', str(source), 'diff', '--quiet', previous_commit, commit, '--', OPENCODE_SOURCE], capture_output=True, text=True, timeout=60)
    if result.returncode not in (0, 1):
        raise AttemptError('Could not compare the native OpenCode profile source between the releases')
    return result.returncode == 0


def old_runtime_manifests(attempt, runtimes, previous, *, stage_module=None):
    """Hash every file of both installed trees (plus their dependency digests); the controller re-verifies them before staging."""
    from release_proof import tree_digest
    sha_file = (stage_module.sha if stage_module else sha)
    rows = []
    for live in map(Path, runtimes):
        if json.loads((live / 'package.json').read_text())['version'] != previous:
            raise AttemptError(f'{live} is not {previous}')
        files = {str(path.relative_to(live)): sha_file(path) for path in [live / 'package.json', live / 'README.md', *(live / 'dist').rglob('*')] if path.is_file() and not path.is_symlink()}
        rows.append({'live': str(live), 'oldFiles': files, 'dependenciesSha256': tree_digest(live / 'node_modules')})
    write_private(Path(attempt) / 'old-runtime-manifests.json', rows)
    return [(row['live'], len(row['oldFiles'])) for row in rows]


def run_metadata(node, source, config_dir, environment, *, run=subprocess.run):
    """The candidate's own startup metadata (read-only; the same script and input the startup gate uses)."""
    request = {'runtimeDirectory': str(source), 'configDirectory': str(config_dir), 'effectiveEnvironment': environment}
    result = run([node, str(HERE / 'startup_gate_metadata.mjs')], input=json.dumps(request).encode(), capture_output=True, timeout=30,
                 env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'HOME': '/nonexistent'})
    if result.returncode != 0:
        raise AttemptError('The candidate release could not produce its startup metadata (the gate would fail closed)')
    return json.loads(result.stdout)


def derive_expectations(metadata):
    """The provider-source pins for this attempt, from the candidate release itself. The live pools are compared against them by the
    read-only rehearsal (source_transition.capture_before) before anything is paused, and again inside the transaction."""
    value = {'eligibleUnion': sorted(metadata['eligibleUnion']), 'consentDeferred': sorted(metadata['consentDeferred']),
             'retiredPackagedSources': sorted(metadata['retiredPackagedSources']), 'legacyAdvertisements': rollout_config.DEFAULT_EXPECTATIONS['legacyAdvertisements']}
    return value


def write_expectations(attempt, value):
    write_private(Path(attempt) / rollout_config.EXPECTATIONS_FILE, value)
    rollout_config.load_expectations(attempt)   # validates shape
    return value


# ----------------------------------------------------------------------------- sealing and preparation

def seal(attempt):
    """Record the sha256 of every helper and payload file. Launch refuses any later change; stage pins the same set."""
    attempt = Path(attempt)
    helpers = {path.name: sha(path) for path in rollout_config.helper_files(attempt)}
    payload = {path.relative_to(attempt / 'payload').as_posix(): sha(path) for path in sorted((attempt / 'payload').rglob('*')) if path.is_file()} if (attempt / 'payload').is_dir() else {}
    value = {'note': 'sha256 of every helper in the attempt directory (stage.py pins exactly this set) and of the owner-file payload', 'helpers': helpers, 'payload': payload}
    path = attempt / 'seal.json'
    write_private(path, value, exclusive=False)
    return value


def write_preparation(attempt, *, version, previous, pins, pins_path, source, registry_raw, registry_url, opencode_sha, opencode_note, live_cache_equal, authorization, registry_etag=None):
    registry = json.loads(registry_raw)
    approved = Path(attempt) / 'approved-registry-public.json'
    write_private(approved, registry_raw.decode(), exclusive=True)
    value = {'version': version, 'previousVersion': previous, 'newAdmissionBudgetAuthorized': True, 'authorization': authorization,
             'totalAdmissionBudgetSeconds': BUDGETS['overallSeconds'], 'sourceCommit': pins['sourceCommit'], 'archive': str(Path(attempt) / 'evidence' / f'usegrunt-{version}.tgz'),
             'source': str(source), 'releaseManifest': str(pins_path), 'opencodeProfileSha256': opencode_sha, 'opencodeProfileDerivation': opencode_note,
             'publicRegistrySha256': sha(registry_raw), 'publicRegistryPublication': registry['published'], 'publicRegistrySource': registry_url,
             'liveCacheEqualsApproved': live_cache_equal, 'noRuntimeChangesYet': True}
    if registry_etag is not None:
        value['publicRegistryEtag'] = registry_etag   # the controller writes the live cache with it, exactly as the daemon's own refresh would
    write_private(Path(attempt) / 'attempt-preparation.json', value)
    return value


def live_cache_equals(registry_raw, cache_path):
    try:
        return json.loads(Path(cache_path).read_text()).get('registry') == json.loads(registry_raw)
    except (OSError, ValueError):
        return False


# ----------------------------------------------------------------------------- checks

def next_scout(now, zone='America/New_York'):
    local = now.astimezone(ZoneInfo(zone))
    for day in (0, 1):
        for hour, minute in SCOUT_TIMES:
            candidate = (local + datetime.timedelta(days=day)).replace(hour=hour, minute=minute, second=0, microsecond=0)
            if candidate > local:
                return candidate
    raise AssertionError('unreachable')


def scout_warning(now, *, within=BUDGETS['overallSeconds'] + 1800):
    """The provider scout (cron 09:00/21:00 New York, up to ~45 min) imports the runtime this upgrade swaps."""
    start = next_scout(now)
    ahead = (start - now.astimezone(start.tzinfo)).total_seconds()
    if ahead <= within:
        return f'the provider scout starts at {start:%H:%M %Z} (in {round(ahead / 60)} min), inside this upgrade window; it will see the new runtime. Prefer to launch right after a scout ends.'
    return None


def assertions(attempt, *, unit_value, state_dir, runtimes, previous, owner, list_units, version):
    """Read-only launch preconditions. Raises AttemptError naming the first failure; returns the builder status."""
    attempt = Path(attempt)

    def need(condition, message):
        if not condition:
            raise AttemptError(message)
    hold = Path(state_dir) / 'execution-upgrade-hold'
    need(not hold.exists() and not hold.is_symlink(), 'execution-upgrade-hold exists: preserve it')
    for name in ('runtime-stage.json', 'activation-receipt.json', 'startup-attempted.json', 'work-may-resume.json', 'controller-config.json', 'release-state.json', 'staged'):
        need(not (attempt / name).exists(), f'{name} already present in {attempt}; use a fresh attempt directory')
    busy = list_units()
    need(not busy, 'another upgrade controller is still running: ' + ', '.join(busy) + ' (two controllers must never overlap)')
    unit = unit_name(attempt)
    need(unit_value(unit + '.service', 'LoadState') == 'not-found', 'unit name already in use')
    seal_value = json.loads((attempt / 'seal.json').read_text())
    current = {path.name: sha(path) for path in rollout_config.helper_files(attempt)}
    sealed = seal_value['helpers']
    differing = sorted((set(current) ^ set(sealed)) | {name for name in current if name in sealed and current[name] != sealed[name]})
    need(not differing, 'helpers differ from the seal: ' + ', '.join(differing))
    payload = {path.relative_to(attempt / 'payload').as_posix(): sha(path) for path in sorted((attempt / 'payload').rglob('*')) if path.is_file()} if (attempt / 'payload').is_dir() else {}
    need(payload == seal_value['payload'], 'payload differs from the seal')
    prep = json.loads((attempt / 'attempt-preparation.json').read_text())
    need(prep['newAdmissionBudgetAuthorized'] is True and prep['totalAdmissionBudgetSeconds'] == BUDGETS['overallSeconds'], 'preparation lacks the bounded authorization')
    need(prep['version'] == version and prep['previousVersion'] == previous, 'preparation is for a different release')
    need(sha(attempt / 'approved-registry-public.json') == prep['publicRegistrySha256'], 'pinned public registry changed')
    for key in ('archive', 'source', 'releaseManifest'):
        need(Path(prep[key]).exists(), f'{key} is missing')
    need(sha(prep['archive']) == json.loads(Path(prep['releaseManifest']).read_text())['archiveSha256'], 'archive differs from the pins')
    config = json.loads((Path(state_dir) / 'config.json').read_text())
    need(config.get('harness') == 'claude-code' and config.get('sessionFormat') == 'claude-code', 'the Adventure builder is not on Claude Code (config.json harness)')
    status = json.loads((Path(state_dir) / 'status.json').read_text())
    need(status.get('harness') == 'claude-code', 'Adventure status.json harness is not claude-code')
    need(status.get('phase') not in ('paused', 'stopped'), 'deliberate worker pause: preserve it')
    need(isinstance(status.get('cycles'), int), 'status.json has no completed-cycle count')
    for runtime in runtimes:
        need(json.loads((Path(runtime) / 'package.json').read_text())['version'] == previous, f'{runtime} is not {previous}')
    for row in json.loads((attempt / 'old-runtime-manifests.json').read_text()):
        for name, digest in row['oldFiles'].items():
            need(sha(Path(row['live']) / name) == digest, f'installed runtime differs from old-runtime-manifests.json: {row["live"]}/{name}')
    return status


def supervisor_running(supervisor_pid, *, proc='/proc'):
    pid = int(supervisor_pid())
    state = (Path(proc) / str(pid) / 'stat').read_text().rpartition(') ')[2].split()[0]
    if state in ('T', 't', 'Z'):
        raise AttemptError('the supervisor is frozen: something holds it (an active attempt?)')


def launch_command(attempt, unit):
    attempt = Path(attempt)
    log = str(attempt / 'activation-console.log')
    return ['systemd-run', '--user', '--collect', '--unit=' + unit, '--property=Type=exec', '--property=WorkingDirectory=' + str(attempt),
            '--property=StandardOutput=append:' + log, '--property=StandardError=append:' + log, '--setenv=PYTHONDONTWRITEBYTECODE=1',
            '/usr/bin/python3', str(attempt / 'pause-and-activate.py')]


def controller_config(*, now, monotonic, authorization, end_cycle=None):
    value = {'version': 2, 'mode': 'planned_pause', 'deadlineMonotonic': monotonic + BUDGETS['overallSeconds'], 'startedAt': now, 'admissionBudgetSeconds': BUDGETS['overallSeconds'],
             'checkpointWaitSeconds': BUDGETS['checkpointWaitSeconds'], 'pauseSettleBudgetSeconds': BUDGETS['pauseSettleSeconds'],
             'activationBudgetSeconds': BUDGETS['activationSeconds'], 'verifyBudgetSeconds': BUDGETS['verifySeconds'], 'authorization': authorization}
    if end_cycle is not None:
        value['endCycle'] = {'authorized': True, 'minAgeSeconds': end_cycle['minAgeSeconds'], 'authorization': end_cycle['authorization']}
    return value


def launch(attempt, *, version, status, authorization, end_cycle, run=subprocess.run, now=time.time, monotonic=time.monotonic, unit_value, env):
    """LIVE: write controller-config.json and start the controller as a transient user unit. Returns the receipt."""
    attempt = Path(attempt)
    unit = unit_name(attempt)
    started, clock = now(), monotonic()
    fd = os.open(attempt / 'activation-console.log', os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.close(fd)
    config = controller_config(now=started, monotonic=clock, authorization=authorization, end_cycle=end_cycle)
    write_private(attempt / 'controller-config.json', config)
    result = run(launch_command(attempt, unit), env=env, capture_output=True, text=True, timeout=15)
    if result.returncode != 0:
        raise AttemptError('Transient launch failed: ' + (result.stderr or '')[:300])
    pid = int(unit_value(unit + '.service', 'MainPID'))
    prep = json.loads((attempt / 'attempt-preparation.json').read_text())
    receipt = {'version': version, 'mode': 'planned_pause', 'sourceCommit': prep['sourceCommit'], 'startedAt': started, 'afterCycle': status['cycles'],
               'activationUnit': unit + '.service', 'activationPid': pid, 'activationStartedAt': started, 'absoluteAdmissionMonotonicDeadline': config['deadlineMonotonic'],
               'admissionBudgetSeconds': BUDGETS['overallSeconds'], 'endCycle': config.get('endCycle')}
    write_private(attempt / 'rollout-launched.json', receipt)
    return receipt


# ----------------------------------------------------------------------------- read-only rehearsal and the repository's own tests

def run_unit_tests(source, *, run=subprocess.run, tmpdir=None):
    """The helper tests of this repository against the candidate build (`GRUNT_UPGRADE_TEST_RUNTIME`). Returns (ok, last output lines)."""
    env = {**os.environ, 'GRUNT_UPGRADE_TEST_RUNTIME': str(source), 'PYTHONDONTWRITEBYTECODE': '1'}
    if tmpdir:
        env['TMPDIR'] = str(tmpdir)
    result = run([sys.executable, '-m', 'unittest', 'discover', '-s', str(HERE), '-p', 'test_*.py'], capture_output=True, text=True, timeout=900, env=env,
                 preexec_fn=lambda: os.umask(0o022))
    tail = (result.stderr or result.stdout or '').strip().splitlines()[-3:]
    return result.returncode == 0, tail


def rehearse(attempt, pins, prep, *, node, run=subprocess.run, log=print):
    """Stage and read-only preflight in a private copy (`rehearsal/`), exactly the helpers the controller will run, so a failure shows up
    now and not after the builder is paused. The copy's staged node_modules are deleted afterwards. Live files are only read."""
    attempt = Path(attempt)
    copy = attempt / 'rehearsal'
    copy.mkdir(mode=0o700)
    for path in rollout_config.helper_files(attempt):
        shutil.copy2(path, copy / path.name)
    if (attempt / 'payload').is_dir():
        shutil.copytree(attempt / 'payload', copy / 'payload')
    env = hostpaths.systemd_env({**os.environ, 'PYTHONDONTWRITEBYTECODE': '1'})
    result = {'rehearsalDirectory': str(copy)}
    try:
        log('[check] staging the public archive in a private copy (read-only on the live host)')
        stage = run([sys.executable, str(copy / 'stage.py'), '--archive', prep['archive'], '--source', prep['source'], '--release-manifest', prep['releaseManifest'],
                     '--opencode-profile-sha256', prep['opencodeProfileSha256']], cwd=copy, env=env, capture_output=True, text=True, timeout=1200)
        if stage.returncode != 0:
            raise AttemptError('Rehearsal stage failed: ' + (stage.stderr or stage.stdout)[-600:])
        result['stage'] = 'ok'
        log('[check] read-only preflight (startup gate, source transition against the live pools)')
        preflight = run([sys.executable, str(copy / 'preflight.py')], cwd=copy, env=env, capture_output=True, text=True, timeout=300)
        if preflight.returncode == 0:
            result['preflight'] = 'ok'
        elif 'due inside the startup window' in (preflight.stderr or ''):
            result['preflight'] = 'maintenance_window'   # pure schedule timing: the controller waits it out
            log('[check] a source maintenance check is inside the startup window right now; the controller waits for it to pass')
        else:
            raise AttemptError('Rehearsal preflight failed closed: ' + (preflight.stderr or preflight.stdout)[-600:])
        contract = run([node, str(copy / 'check_runtime_contract.mjs'), str(copy / 'staged/1'), '--import'], capture_output=True, text=True, timeout=120)
        if contract.returncode != 0 or 'CONTRACT OK' not in contract.stdout:
            raise AttemptError('Runtime contract check failed: ' + contract.stdout[-600:])
        result['contract'] = 'ok'
    finally:
        for staged in (copy / 'staged').glob('*/node_modules'):
            shutil.rmtree(staged, ignore_errors=True)
    write_private(attempt / 'check.json', {**result, 'at': time.time()}, exclusive=False)
    return result
