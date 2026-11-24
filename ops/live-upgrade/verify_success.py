#!/usr/bin/env python3
"""Read-only success verification of a finished upgrade attempt (run by the controller after the first cycle, and by
`upgrade.py verify`). Lives in the attempt directory, so it checks exactly the release that attempt installed.

It never signals, restarts or writes anything. It compares the installed runtimes with the public package pins, the owner files with
the stage plan and the receipt, the protected files, unit fingerprints, resource policy and observer, checks the hold and temporary
guards are gone, that the managed daemons were (re)started after the transaction began, and that both pools answer with the status
schema (`/v1/status` `version` is the status schema number, an integer, not the package version)."""
import datetime
import json
import os
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
sys.dont_write_bytecode = True
import activate  # noqa: E402
import hostpaths  # noqa: E402
import registry_cache  # noqa: E402
import stage  # noqa: E402
from release_proof import assert_runtime  # noqa: E402
from rollout_config import VERSION, PREVIOUS_VERSION  # noqa: E402

DAEMON_UNITS = ('milo.service', 'grunt-amazing-adventure.service', activate.HOST_UNIT)


def process_started_at(pid, *, proc='/proc', uptime=None, now=time.time, ticks=os.sysconf('SC_CLK_TCK')):
    """Wall-clock start of a process from its kernel start ticks."""
    raw = (Path(proc) / str(pid) / 'stat').read_text().rpartition(') ')[2].split()
    uptime = float((Path(proc) / 'uptime').read_text().split()[0]) if uptime is None else uptime
    return now() - uptime + int(raw[19]) / ticks


def receipt_start(receipt):
    return datetime.datetime.strptime(receipt['startedAt'], '%Y%m%dT%H%M%SZ').replace(tzinfo=datetime.timezone.utc).timestamp()


def fetch_status(port):
    with urllib.request.urlopen(f'http://127.0.0.1:{port}/v1/status', timeout=5) as response:
        return json.load(response)


def assert_pool_status(port, status):
    """`/v1/status` `version` is the status SCHEMA number (an integer), never the package version: the 0.10.0 check compared it with the
    package version and failed every real upgrade. The installed release is proven by the package bytes and the daemons' restart instead."""
    assert isinstance(status.get('version'), int) and not isinstance(status['version'], bool), (port, 'status schema version is not an integer', status.get('version'))
    assert 'workers' not in status, f'{port} still reports the removed worker slots'


def verify(root=ROOT, *, unit_value=None, status_reader=None, started_at=process_started_at):
    unit_value = unit_value or activate.unit_value
    status_reader = status_reader or fetch_status
    root = Path(root)
    plan = json.loads((root / 'runtime-stage.json').read_text())
    receipt = json.loads((root / 'activation-receipt.json').read_text())
    assert plan['version'] == VERSION and plan['previousVersion'] == PREVIOUS_VERSION, 'stage plan is for a different release'
    assert receipt['version'] == VERSION, 'receipt is for a different release'
    assert receipt['success'] is True and receipt['workMayResume'] is True, 'activation did not succeed'
    assert receipt['restartGuardsRestoredBeforeStart'] is True, 'restart guards were not restored before start'
    for row in plan['runtimes']:
        assert_runtime(row['live'], plan, row)
        assert json.loads((Path(row['live']) / 'package.json').read_text())['version'] == VERSION, row['live']
    cache = receipt['registryCacheTransitionProof']
    assert cache['path'] == str(activate.HOST_POLICY.parent / 'registry.json')
    assert cache['originalBackup'] == str(root / 'registry-cache-before.json')
    assert cache['originalRawSha256'] == plan['protectedFiles'][cache['path']]
    assert cache['candidateCatalogSha256'] == receipt['startupProof']['registrySha256']
    for path, digest in plan['protectedFiles'].items():
        if path == cache['path']:
            registry_cache.assert_preserved(cache, candidate_runtime=plan['runtimes'][0]['live'], node=activate.NODE, allow_derived=True)
        else:
            assert stage.sha(path) == digest, path
    # owner files installed together with the runtimes (only when the attempt shipped a payload), backups present, manifest consistent
    planned = plan.get('ownerFiles', [])
    assert len(planned) == len(receipt.get('ownerFiles', [])), 'owner files in the receipt differ from the stage plan'
    for row, done in zip(planned, receipt.get('ownerFiles', [])):
        assert row['dest'] == done['dest'] and stage.sha(row['dest']) == row['newSha256'], row['dest']
        assert stage.sha(done['backup']) == row['oldSha256'], done['backup']
    assets = json.loads((activate.OWNER / 'claude/assets.json').read_text())['files']
    for name, digest in assets.items():
        assert stage.sha(activate.OWNER / 'claude' / name) == digest, name
    for unit, digest in plan['unitFingerprints'].items():
        assert stage.unit_fingerprint(unit) == digest, unit
    runtime = hostpaths.RUNTIME_DIR / 'systemd/user'
    leftovers = [activate.STATE / 'execution-upgrade-hold', runtime / 'milo.service.d' / '98-grunt-runtime-consent.conf']
    leftovers += [runtime / (unit + '.d') / '99-grunt-runtime-cutover.conf' for unit in DAEMON_UNITS]
    for path in leftovers:
        assert not path.exists() and not path.is_symlink(), f'{path} still present'
    stage.assert_memory_policy(plan['memoryPolicy'])
    stage.assert_cpu_policy(plan['cpuPolicy'])
    stage.assert_observer(plan['passiveObserver'])
    for unit in (*DAEMON_UNITS, 'grunt-adventure-activity.service', 'grunt-admin-collector.service'):
        assert unit_value(unit, 'ActiveState') == 'active', unit
    began = receipt_start(receipt)
    for unit in DAEMON_UNITS:
        pid = int(unit_value(unit, 'MainPID'))
        assert pid > 1 and started_at(pid) >= began - 2, f'{unit} was not restarted by this upgrade'
    for port in (8792, 8793):
        assert_pool_status(port, status_reader(port))
    return {'version': VERSION, 'previousVersion': PREVIOUS_VERSION, 'runtimes': len(plan['runtimes']), 'ownerFiles': len(planned), 'protectedFiles': len(plan['protectedFiles'])}


def main():
    try:
        result = verify()
    except (AssertionError, OSError, KeyError, ValueError) as error:
        print(f'FAILED: {type(error).__name__}: {error}', file=sys.stderr)
        return 1
    print(f'Both {VERSION} runtimes, owner files, dependency digests, protected files, units, resources and observer verified; hold and '
          f'temporary restart/consent guards absent; daemons restarted by this upgrade; both pools report the status schema without worker slots.')
    print(json.dumps(result))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
