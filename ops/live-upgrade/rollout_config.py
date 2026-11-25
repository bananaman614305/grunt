"""Per-attempt rollout scope. This module performs no operations.

`upgrade.py` writes `attempt.json` (version, previousVersion) beside the sealed helper copies of an attempt directory; the version
pair is therefore derived from the target release argument and the installed runtime, never edited by hand. `attempt.json` is part
of the sealed helper set, so a changed scope is refused like any other changed helper.

Outside an attempt directory (the repository checkout, the unit tests) the scope is the placeholder pair below. Neither value can
equal a real package version, so staging, activation and the controller refuse to do anything with it."""
import json
import os
import shutil
from pathlib import Path

ATTEMPT_FILE = 'attempt.json'
EXPECTATIONS_FILE = 'source-expectations.json'
UNSCOPED_VERSION = '0.0.0-unscoped'
UNSCOPED_PREVIOUS_VERSION = '0.0.0-unscoped-previous'
RUNTIME_GUARD_NAME = '99-grunt-runtime-cutover.conf'
CONSENT_GUARD_NAME = '98-grunt-runtime-consent.conf'
HELPER_SUFFIXES = ('.py', '.mjs')


def is_helper(path):
    """The sealed helper set of an attempt directory: every non-test .py/.mjs module plus attempt.json and source-expectations.json."""
    path = Path(path)
    return path.is_file() and (path.name in (ATTEMPT_FILE, EXPECTATIONS_FILE) or path.suffix in HELPER_SUFFIXES and not path.name.startswith('test_'))


def helper_files(directory):
    return sorted(path for path in Path(directory).iterdir() if is_helper(path))


def load_scope(directory=None):
    path = Path(directory or Path(__file__).resolve().parent) / ATTEMPT_FILE
    if not path.is_file():
        return UNSCOPED_VERSION, UNSCOPED_PREVIOUS_VERSION
    value = json.loads(path.read_text())
    version, previous = value.get('version'), value.get('previousVersion')
    for item in (version, previous):
        if type(item) is not str or len(item.split('.')) != 3 or not all(part.isdigit() for part in item.split('.')):
            raise ValueError('attempt.json must name stable x.y.z versions')
    if version == previous:
        raise ValueError('attempt.json names the same version twice')
    return version, previous


VERSION, PREVIOUS_VERSION = load_scope()


def load_node(directory=None):
    """The managed Node binary the daemons run under. `upgrade.py` discovers it from the live unit (milo.service ExecStart) and records it in
    attempt.json, so the sealed helpers compare the daemons' /proc/<pid>/exe with exactly that binary. Outside an attempt directory:
    GRUNT_UPGRADE_NODE, else the first `node` on PATH (tests; nothing live can match it)."""
    path = Path(directory or Path(__file__).resolve().parent) / ATTEMPT_FILE
    value = json.loads(path.read_text()).get('node') if path.is_file() else None
    if value is not None and (type(value) is not str or not os.path.isabs(value)):
        raise ValueError('attempt.json node must be an absolute path')
    return value or os.environ.get('GRUNT_UPGRADE_NODE') or shutil.which('node') or '/usr/bin/node'

# Provider-source expectations the startup gate and the source-transition proof hold the live pools and the candidate release to.
# These defaults are the set reviewed for the 0.9.12 -> 0.10.0 cutover. An attempt directory carries `source-expectations.json`,
# derived by upgrade.py from the candidate release itself (and verified against the live pools before anything is paused), so a
# release no longer needs these constants edited by hand; any drift between the pinned file and what the gate sees fails closed.
DEFAULT_EXPECTATIONS = {
    'eligibleUnion': sorted('opencode kilo zro tokenharbor runcrate mistral-vibe livekit pollinations beatapi perch nous kenari numes goedel fikra openference darus aperture-ai reflection-beam millionseek freepi antseed-vikey'.split()),
    'consentDeferred': ['freepi', 'goedel', 'kilo'],
    'retiredPackagedSources': ['clixad'],
    'legacyAdvertisements': {'8792': ['freellmapi'], '8793': []},
    'ownerOptIns': {'8792': [], '8793': []},
}

# Owner-approved per-port opt-in additions: a source the owner explicitly allowed on ONE pool only, beyond the common set both pools serve.
# This is a reviewed constant, not derived from the candidate release: a release can never add a source to a port by itself, and changing
# what the owner allows takes a reviewed change here. Only the owner pool (8793) can carry one: its launcher names the opt-ins, while the
# primary (8792) takes its opt-ins from its unit, which must never serve these. IFM K2 Horizon: opt-in, manual consent, owner-approved for 8793 only.
OWNER_OPT_INS = {'8792': [], '8793': ['ifm']}
# What the 8793 launcher (free-pool.mjs) passes as GRUNT_OPT_IN_SOURCES before any owner addition. startup_gate_metadata.mjs mirrors it.
LAUNCHER_BASE_OPT_INS = ('antseed-vikey', 'reflection-beam')


def expected_port_sets(expectations):
    """The exact eligible set each pool must serve: the union, minus the owner opt-ins that belong to the other port only."""
    union, owner = expectations['eligibleUnion'], expectations['ownerOptIns']
    return {port: [item for item in union if not any(item in ids for other, ids in owner.items() if other != port)] for port in ('8792', '8793')}


def launcher_opt_ins(expectations):
    """The exact GRUNT_OPT_IN_SOURCES set the 8793 launcher must carry: the base list plus the owner-approved additions."""
    return sorted({*LAUNCHER_BASE_OPT_INS, *expectations['ownerOptIns']['8793']})


def load_expectations(directory=None):
    path = Path(directory or Path(__file__).resolve().parent) / EXPECTATIONS_FILE
    if not path.is_file():
        return json.loads(json.dumps(DEFAULT_EXPECTATIONS))
    value = json.loads(path.read_text())
    if set(value) != set(DEFAULT_EXPECTATIONS):
        raise ValueError('source-expectations.json has an unexpected shape')
    for key in ('eligibleUnion', 'consentDeferred', 'retiredPackagedSources'):
        ids = value[key]
        if not isinstance(ids, list) or ids != sorted(set(ids)) or any(type(item) is not str for item in ids):
            raise ValueError('source-expectations.json lists must be sorted unique ids')
    if not value['eligibleUnion'] or not set(value['consentDeferred']) <= set(value['eligibleUnion']):
        raise ValueError('source-expectations.json deferred sources must be eligible')
    legacy = value['legacyAdvertisements']
    if not isinstance(legacy, dict) or set(legacy) != {'8792', '8793'} or any(not isinstance(ids, list) for ids in legacy.values()):
        raise ValueError('source-expectations.json legacy advertisements are malformed')
    owner = value['ownerOptIns']
    if not isinstance(owner, dict) or set(owner) != {'8792', '8793'}:
        raise ValueError('source-expectations.json owner opt-ins are malformed')
    for port, ids in owner.items():
        if not isinstance(ids, list) or ids != sorted(set(ids)) or any(type(item) is not str for item in ids):
            raise ValueError('source-expectations.json owner opt-ins must be sorted unique ids')
        if not set(ids) <= set(OWNER_OPT_INS[port]) or not set(ids) <= set(value['eligibleUnion']):
            raise ValueError('source-expectations.json owner opt-ins must be reviewed, owner-approved and eligible')
    return value
