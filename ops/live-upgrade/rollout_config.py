"""Per-attempt rollout scope. This module performs no operations.

`upgrade.py` writes `attempt.json` (version, previousVersion) beside the sealed helper copies of an attempt directory; the version
pair is therefore derived from the target release argument and the installed runtime, never edited by hand. `attempt.json` is part
of the sealed helper set, so a changed scope is refused like any other changed helper.

Outside an attempt directory (the repository checkout, the unit tests) the scope is the placeholder pair below. Neither value can
equal a real package version, so staging, activation and the controller refuse to do anything with it."""
import json
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

# Provider-source expectations the startup gate and the source-transition proof hold the live pools and the candidate release to.
# These defaults are the set reviewed for the 0.9.12 -> 0.10.0 cutover. An attempt directory carries `source-expectations.json`,
# derived by upgrade.py from the candidate release itself (and verified against the live pools before anything is paused), so a
# release no longer needs these constants edited by hand; any drift between the pinned file and what the gate sees fails closed.
DEFAULT_EXPECTATIONS = {
    'eligibleUnion': sorted('opencode kilo zro tokenharbor runcrate mistral-vibe livekit pollinations beatapi perch nous kenari numes goedel fikra openference darus aperture-ai reflection-beam millionseek freepi antseed-vikey'.split()),
    'consentDeferred': ['freepi', 'goedel', 'kilo'],
    'retiredPackagedSources': ['clixad'],
    'legacyAdvertisements': {'8792': ['freellmapi'], '8793': []},
}


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
    return value
