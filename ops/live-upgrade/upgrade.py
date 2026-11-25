#!/usr/bin/env python3
"""One-command live upgrade of the Amazing Adventure host to a published usegrunt release, by planned maintenance pause.

  python3 ops/live-upgrade/upgrade.py --version 0.10.1            # verify, prepare, seal, check, then LIVE: start the planned pause
  python3 ops/live-upgrade/upgrade.py --version 0.10.1 --check    # everything except the live start
  python3 ops/live-upgrade/upgrade.py --version 0.10.1 --end-cycle   # owner-authorized: also end a long-running cycle (see README)
  python3 ops/live-upgrade/upgrade.py status [--version V | --attempt DIR]    # read-only progress
  python3 ops/live-upgrade/upgrade.py verify [--version V | --attempt DIR]    # read-only success verification

Everything before the final step is read-only on the live host: the npm tarball is tied to the CI artifact and to a clean build of the
published commit, the helper set is copied into a fresh private attempt directory and sealed, the repository's own helper tests run
against the candidate build, and a rehearsal (stage + read-only preflight in a private copy) proves the candidate fits the live host.
The last step starts the controller (pause-and-activate.py) as a transient user unit. See README.md."""
import argparse
import datetime
import json
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.dont_write_bytecode = True
import attempt as attempts_lib  # noqa: E402
import end_cycle as end_cycle_module  # noqa: E402
import hostpaths  # noqa: E402
import release_pins  # noqa: E402
import stage  # noqa: E402   (pure constants and read-only helpers; importing it performs no action)
import activate  # noqa: E402
from attempt import AttemptError  # noqa: E402

REPO = HERE.parents[1]
LIVE_CACHE = hostpaths.CONFIG / 'registry.json'
EXIT_REFUSED = 2


def log(message):
    print(message, flush=True)


def list_controller_units(*, run=subprocess.run, env=None):
    result = run(['systemctl', '--user', 'list-units', attempts_lib.UNIT_PREFIX + '*', '--state=active,activating,deactivating', '--no-legend', '--plain'],
                 env=env or stage.ENV, capture_output=True, text=True, timeout=15)
    return [line.split()[0] for line in result.stdout.splitlines() if line.strip()]


def end_cycle_settings(args):
    if not args.end_cycle:
        return None
    return {'minAgeSeconds': args.end_cycle_min_age, 'authorization': 'Owner authorized ending a long-running builder cycle by SIGTERM to its worker process group '
            f'(only a cycle at least {args.end_cycle_min_age:g} s old, once the controller is waiting for the checkpoint); recorded by upgrade.py --end-cycle'}


def run_upgrade(args, *, workspace=None, runtimes=None, owner=None, state_dir=None, env=None, now=None):
    """Returns the process exit code. 0: launched (or --check passed). 2: refused with nothing live changed."""
    workspace = Path(workspace or args.workspace)
    runtimes = runtimes if runtimes is not None else stage.RUNTIMES
    owner, state_dir = Path(owner or stage.OWNER), Path(state_dir or stage.STATE)
    now = now or datetime.datetime.now(datetime.timezone.utc)
    version = args.version
    previous = attempts_lib.installed_version(runtimes)
    if previous == version:
        log(f'usegrunt {version} is already installed in both runtimes; nothing to upgrade. Run `upgrade.py verify` to re-check the last upgrade.')
        return 0
    release_pins.version_tuple(version)
    if release_pins.version_tuple(version) < release_pins.version_tuple(previous):
        raise AttemptError(f'{version} is older than the installed {previous}; downgrades are not supported (the Pi-era rollback does not exist)')
    busy = list_controller_units(env=env)
    if busy:
        raise AttemptError('another upgrade controller is still running: ' + ', '.join(busy))
    warning = attempts_lib.scout_warning(now)
    if warning:
        log('WARNING: ' + warning)
    attempt = attempts_lib.new_attempt_dir(workspace, version, now=now)
    log(f'[1/7] attempt directory {attempt}  ({previous} -> {version})')
    node = attempts_lib.discover_node(stage.unit_value)
    attempts_lib.write_scope(attempt, version, previous, node=node)
    log('[2/7] verifying the published release (npm tarball == CI artifact == clean build of the published commit)')
    pins = release_pins.verify_release(version, previous, repo=REPO, attempt=attempt, log=log)
    pins_path = attempt / 'evidence' / f'release-{version}-public-pins.json'
    source = attempt / 'source'
    payload = []
    if args.payload:
        payload = attempts_lib.build_payload(attempt, args.payload, owner)
        log(f'[3/7] owner-file payload: {", ".join(payload)}')
    else:
        log('[3/7] no owner-file payload: the owner launcher, brief and release CLI stay as installed')
    log('[4/7] preparing: helper copies, provider-source pins, installed-runtime manifests, pinned public registry, seal')
    attempts_lib.install_helpers(attempt)
    environment = {**activate.primary_environment(), 'GRUNT_SETUP_NO_DATA_SHARING': '1'}
    metadata = attempts_lib.run_metadata(node, source, stage.CONFIG, environment)
    expectations = attempts_lib.write_expectations(attempt, attempts_lib.derive_expectations(metadata))
    if expectations != attempts_lib.rollout_config.DEFAULT_EXPECTATIONS:
        log('NOTE: the candidate release serves a different provider-source set than the one reviewed for 0.10.0; the rehearsal checks it against the live pools.')
    for port, ids in expectations['ownerOptIns'].items():
        if ids:
            log(f'NOTE: owner-approved opt-in source(s) {", ".join(ids)} for port {port} only: the launcher must name exactly the reviewed opt-ins (--payload when the installed one lacks them); consent for them is recorded after the upgrade, never before.')
    attempts_lib.old_runtime_manifests(attempt, runtimes, previous)
    registry_raw, registry_url, registry_etag = attempts_lib.fetch_public_registry()
    opencode_note = f'sha256 of the exact string {attempts_lib.OPENCODE_PROFILE}; {attempts_lib.OPENCODE_SOURCE} verified unchanged between the previous and the new release commit'
    unchanged = _opencode_unchanged(args, source, previous, pins)
    if not unchanged:
        raise AttemptError(f'{attempts_lib.OPENCODE_SOURCE} changed since {previous} (or the previous release commit could not be found): review it, then rerun with --opencode-profile-reviewed')
    cache_equal = attempts_lib.live_cache_equals(registry_raw, LIVE_CACHE)
    prep = attempts_lib.write_preparation(attempt, version=version, previous=previous, pins=pins, pins_path=pins_path, source=source, registry_raw=registry_raw, registry_url=registry_url,
                                          opencode_sha=attempts_lib.opencode_profile_pin(), opencode_note=opencode_note, live_cache_equal=cache_equal, authorization=args.authorization, registry_etag=registry_etag)
    if not cache_equal:
        log('NOTE: the live registry cache differs from the public registry; the controller writes the approved public registry into it before staging (the installed runtime\'s own RegistrySync writer, old bytes kept), so there is no wait for the 00/06/12/18 UTC refresh.')
    attempts_lib.seal(attempt)
    if args.skip_tests:
        log('[5/7] helper tests SKIPPED (--skip-tests)')
    else:
        log('[5/7] running the helper tests against the candidate build')
        ok, tail = attempts_lib.run_unit_tests(source, tmpdir=os.environ.get('TMPDIR'))
        if not ok:
            raise AttemptError('helper tests failed against the candidate build: ' + ' | '.join(tail))
        log('      ' + ' | '.join(tail))
    log('[6/7] read-only rehearsal against the live host (stage and preflight in a private copy)')
    check = attempts_lib.rehearse(attempt, pins, prep, node=node, log=log)
    log('      ' + json.dumps({key: value for key, value in check.items() if key != 'rehearsalDirectory'}))
    status = attempts_lib.assertions(attempt, unit_value=stage.unit_value, state_dir=state_dir, runtimes=runtimes, previous=previous, owner=owner,
                                     list_units=lambda: list_controller_units(env=env), version=version)
    attempts_lib.supervisor_running(activate.pid)
    unit = attempts_lib.unit_name(attempt)
    command = attempts_lib.launch_command(attempt, unit)
    end_cycle = end_cycle_settings(args)
    log(f'[7/7] ready: builder phase {status.get("phase")}, completed cycles {status["cycles"]}')
    log('      ' + json.dumps({'unit': unit + '.service', 'budgets': attempts_lib.BUDGETS, 'endCycle': end_cycle}, indent=None))
    if args.check:
        log('--check: not launching. The command that would start the controller:\n  ' + ' '.join(command))
        return 0
    receipt = attempts_lib.launch(attempt, version=version, status=status, authorization=args.authorization, end_cycle=end_cycle, unit_value=stage.unit_value, env=env or stage.ENV)
    log(f'LAUNCHED {receipt["activationUnit"]} (pid {receipt["activationPid"]}). It waits for the running cycle to end'
        + (' (ending it once it is old enough, owner-authorized)' if end_cycle else ' by itself') + ', pauses, upgrades, resumes and verifies.')
    log(f'  follow:  python3 {HERE / "upgrade.py"} status --attempt {attempt}\n  verify:  python3 {HERE / "upgrade.py"} verify --attempt {attempt}\n  journal: journalctl --user -u {unit}')
    return 0


def _opencode_unchanged(args, source, previous, pins):
    if args.opencode_profile_reviewed:
        return True
    try:
        found = release_pins.find_publish_run(previous, repo=REPO, slug=release_pins.repo_slug(
            release_pins.sh(['git', '-C', str(REPO), 'remote', 'get-url', 'origin'], timeout=30)))
    except release_pins.ReleaseError:
        return False
    return attempts_lib.opencode_profile_unchanged(source, found['commit'], pins['sourceCommit'])


# ----------------------------------------------------------------------------- status / verify

def read_json(path):
    try:
        return json.loads(Path(path).read_text())
    except (OSError, ValueError):
        return None


def collect_status(attempt, *, state_dir=None, unit_value=None, get=None, wall=time.time):
    attempt = Path(attempt)
    state_dir = Path(state_dir or stage.STATE)
    unit_value = unit_value or stage.unit_value

    def fetch(port):
        with urllib.request.urlopen(f'http://127.0.0.1:{port}/v1/status', timeout=3) as response:
            return json.load(response)
    get = get or fetch
    out = {'now': wall(), 'attempt': str(attempt), 'scope': read_json(attempt / 'attempt.json')}
    for name in ('release-state.json', 'activation-ready.json', 'rollout-launched.json', 'pause-state.json', 'pause-outcome.json', 'pause-verification.json', 'pause-watchdog.json', 'check.json'):
        value = read_json(attempt / name)
        if value is not None:
            out[name] = {key: value[key] for key in value if key not in ('runtimes',)}
    receipt = read_json(attempt / 'activation-receipt.json')
    if receipt is not None:
        keys = ('success', 'terminal', 'failureType', 'failure', 'phase', 'workMayResume', 'workResumed', 'startupHardDeadlineMs', 'operatorRecoveryRequiredByMs', 'attemptNumber',
                'startupHoldPresent', 'failedBeforeMutation', 'restartGuardsRestoredBeforeStart', 'rollback', 'promptRootRecoveryRequired')
        out['receipt'] = {key: receipt.get(key) for key in keys if key in receipt}
    for name in ('startup-attempted.json', 'work-may-resume.json', 'pause-restore-warning.json'):
        out[name] = (attempt / name).exists()
    out['hold'] = (state_dir / 'execution-upgrade-hold').exists()
    status = read_json(state_dir / 'status.json') or {}
    out['adventure'] = {key: status.get(key) for key in ('phase', 'harness', 'cycles', 'workerPid', 'modelReplies', 'lastActivityAt', 'cycleStartedAt', 'claudeVersion')}
    launched = read_json(attempt / 'rollout-launched.json') or {}
    units = {}
    for unit in (launched.get('activationUnit'), 'milo.service', 'grunt-amazing-adventure.service', stage.UNITS[2], 'grunt-admin-collector.service'):
        if unit:
            try:
                units[unit] = [unit_value(unit, 'ActiveState'), unit_value(unit, 'SubState')]
            except Exception as error:
                units[unit] = str(error)[:60]
    out['units'] = units
    for port in (8792, 8793):
        try:
            value = get(port)
            out[str(port)] = {'activeRequests': value.get('activeRequests'), 'sources': len(value.get('sources', [])), 'statusSchema': value.get('version')}
        except Exception as error:
            out[str(port)] = 'unreachable: ' + str(error)[:60]
    return out


def summary(status):
    """One human line: where the attempt is."""
    state = (status.get('release-state.json') or {}).get('state') or 'not started'
    pause = (status.get('pause-state.json') or {}).get('phase')
    adventure = status.get('adventure', {})
    done = (status.get('release-state.json') or {}).get('state') == 'activated_and_first_cycle_verified'
    return f'{"DONE" if done else "in progress"}: {state}' + (f' / pause {pause}' if pause else '') + f' / builder {adventure.get("phase")} cycles {adventure.get("cycles")}'


def resolve_attempt(args):
    if args.attempt:
        path = Path(args.attempt).resolve()
        if not (path / 'attempt.json').is_file():
            raise AttemptError(f'{path} is not an upgrade attempt directory')
        return path
    return attempts_lib.latest_attempt(args.workspace, getattr(args, 'version', None))


def run_verify(attempt, *, run=subprocess.run, env=None):
    script = Path(attempt) / 'verify_success.py'
    if not script.is_file():
        raise AttemptError(f'{attempt} has no verify_success.py (was the attempt prepared?)')
    result = run([sys.executable, str(script)], capture_output=True, text=True, timeout=120,
                 env=hostpaths.systemd_env({**os.environ, 'PYTHONDONTWRITEBYTECODE': '1', **(env or {})}))
    print((result.stdout or '') + (result.stderr or ''), end='')
    return result.returncode


# ----------------------------------------------------------------------------- command line

def add_workspace(parser, *, suppress=False):
    default = argparse.SUPPRESS if suppress else Path(os.environ.get('GRUNT_UPGRADE_WORKSPACE') or attempts_lib.DEFAULT_WORKSPACE)
    parser.add_argument('--workspace', type=Path, default=default, help='where attempt directories are made (default: $GRUNT_UPGRADE_WORKSPACE, else usegrunt-upgrades under the XDG state directory)')


def add_run_options(parser, *, suppress=False):
    s = {'default': argparse.SUPPRESS} if suppress else {}
    parser.add_argument('--version', help='the published usegrunt version to install, e.g. 0.10.1', **s)
    parser.add_argument('--check', action='store_true', help='do everything except the live start and print the launch command', **s)
    parser.add_argument('--end-cycle', action='store_true', **s,
                        help='OWNER-AUTHORIZED: once the controller waits for the checkpoint, end a long-running cycle by SIGTERM to its worker process group '
                             '(the supervisor records a failed cycle and waits 60 s); never without this flag')
    parser.add_argument('--end-cycle-min-age', type=float, help=f'only end a cycle at least this many seconds old (default {end_cycle_module.DEFAULT_MIN_AGE:g})', **({'default': argparse.SUPPRESS} if suppress else {'default': end_cycle_module.DEFAULT_MIN_AGE}))
    parser.add_argument('--payload', type=Path, help='directory with owner files to install with the runtimes: free-pool.mjs, claude/worker-brief.md, claude/bin/grunt-release', **s)
    parser.add_argument('--authorization', help='authorization note recorded in the attempt (default: the documented standard path)',
                        **({'default': argparse.SUPPRESS} if suppress else {'default': attempts_lib.DEFAULT_AUTHORIZATION}))
    parser.add_argument('--skip-tests', action='store_true', help='skip the repository helper tests (they run in about 15 s)', **s)
    parser.add_argument('--opencode-profile-reviewed', action='store_true', help=f'acknowledge a changed {attempts_lib.OPENCODE_SOURCE} that you reviewed', **s)


def build_parser():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    add_workspace(parser)
    add_run_options(parser)
    sub = parser.add_subparsers(dest='command')
    run = sub.add_parser('run', help='the default when no command is given: verify, prepare, seal, check, launch')
    add_workspace(run, suppress=True)
    add_run_options(run, suppress=True)
    for name, text in (('status', 'read-only progress of an attempt'), ('verify', 'read-only success verification of an attempt')):
        command = sub.add_parser(name, help=text)
        add_workspace(command, suppress=True)
        command.add_argument('--attempt', type=Path, help='attempt directory (default: the latest)')
        command.add_argument('--version', default=argparse.SUPPRESS, help='latest attempt for this release version')
        command.add_argument('--json', action='store_true', help='status: print only the full JSON')
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    try:
        if args.command in ('status', 'verify'):
            attempt = resolve_attempt(args)
            if args.command == 'verify':
                return run_verify(attempt)
            value = collect_status(attempt)
            print(json.dumps(value, indent=1, default=str) if args.json else summary(value) + '\n' + json.dumps(value, indent=1, default=str))
            return 0
        if not args.version:
            build_parser().error('--version is required, e.g. --version 0.10.1')
        return run_upgrade(args)
    except (AttemptError, release_pins.ReleaseError) as error:
        print(f'REFUSED (nothing on the live host was changed by this step): {error}', file=sys.stderr)
        return EXIT_REFUSED


if __name__ == '__main__':
    raise SystemExit(main())
