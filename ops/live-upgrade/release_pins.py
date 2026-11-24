"""Release verification for `upgrade.py`: tie the published npm tarball to the CI artifact and to a clean build of the commit that was
published, and write the pins (`release-<version>-public-pins.json`) the stage step re-verifies byte for byte.

Operator tooling only: it reads the public npm registry and GitHub (through `gh`), builds the release commit in a private checkout
inside the attempt directory, and writes only inside that directory. It never touches the live host. Every external effect goes
through an injectable collaborator so the tests run offline."""
import base64
import hashlib
import json
import re
import subprocess
import tarfile
import time
import urllib.error
import urllib.request
from pathlib import Path, PurePosixPath

PUBLISH_WORKFLOW = 'publish.yml'
ARTIFACT_NAME = 'usegrunt-package'
NPM = 'https://registry.npmjs.org'
# Modules removed by the 0.10.0 removal release (subworkers, jobs, checkpoints, Pi release tools). They must never come back through a
# patch release without a reviewed owner-side change; worker-pi.js and execution-pi.js stay as no-op shims and are not listed.
REMOVED_MODULES = ('coordination-store', 'execution-checkpoint-pi', 'execution-checkpoint', 'jobs-cli', 'jobs-pi', 'jobs', 'publication-pi', 'worker-agent-client',
                   'worker-agent', 'worker-client', 'worker-connect', 'worker-coordination', 'worker-integration', 'worker-pool', 'worker-resources', 'worker-runtime',
                   'worker-sandbox', 'worker-scopes', 'worker-tool-helper', 'worker-transport', 'worker-workspace')
VERSION = re.compile(r'^\d+\.\d+\.\d+$')
COMMIT = re.compile(r'^[0-9a-f]{40}$')


class ReleaseError(RuntimeError):
    """The published release could not be tied to a reviewed build; nothing was written to the live host."""


def version_tuple(value):
    if not VERSION.fullmatch(value):
        raise ReleaseError(f'Not a stable x.y.z version: {value!r}')
    return tuple(int(part) for part in value.split('.'))


def sh(command, *, cwd=None, timeout=900, run=subprocess.run, check=True):
    result = run(command, cwd=cwd, capture_output=True, text=True, timeout=timeout)
    if check and result.returncode != 0:
        raise ReleaseError(f'{command[0]} {command[1] if len(command) > 1 else ""} failed: {(result.stderr or result.stdout or "")[-400:]}')
    return result.stdout


def repo_slug(origin_url):
    match = re.search(r'github\.com[:/]([^/\s]+/[^/\s]+?)(?:\.git)?/?$', origin_url.strip())
    if not match:
        raise ReleaseError('The checkout has no github.com origin remote')
    return match.group(1)


def package_version_at(repo, commit, *, run=subprocess.run):
    result = run(['git', '-C', str(repo), 'show', f'{commit}:package.json'], capture_output=True, text=True, timeout=30)
    if result.returncode != 0:
        return None
    try:
        return json.loads(result.stdout).get('version')
    except ValueError:
        return None


def find_publish_run(version, *, repo, slug, run=subprocess.run, limit=40):
    """The newest successful publish run on main whose commit carries package.json version `version`.

    The workflow input is not in `gh run list`, but the workflow refuses a version that differs from package.json at the run's commit,
    so the version of package.json at headSha identifies the run."""
    rows = json.loads(sh(['gh', 'run', 'list', '-R', slug, '-w', PUBLISH_WORKFLOW, '--status', 'success', '-L', str(limit),
                          '--json', 'databaseId,headSha,headBranch,event,createdAt'], run=run, timeout=60))
    rows = sorted(rows, key=lambda row: row['createdAt'], reverse=True)
    sh(['git', '-C', str(repo), 'fetch', '-q', 'origin'], run=run, timeout=300, check=False)
    matches = []
    for row in rows:
        if row.get('event') != 'workflow_dispatch' or row.get('headBranch') != 'main' or not COMMIT.fullmatch(row.get('headSha', '')):
            continue
        if package_version_at(repo, row['headSha'], run=run) == version:
            matches.append(row)
    if not matches:
        raise ReleaseError(f'No successful {PUBLISH_WORKFLOW} run on main published usegrunt {version}; publish it first (or the checkout lacks the commit)')
    chosen = matches[0]
    return {'runId': str(chosen['databaseId']), 'commit': chosen['headSha'], 'createdAt': chosen['createdAt'],
            'otherRunsForVersion': [str(row['databaseId']) for row in matches[1:]]}


def find_pull_request(commit, *, slug, run=subprocess.run):
    """Best effort: the merged PR number for the commit, or None. Recorded in the pins, never trusted for a decision."""
    try:
        rows = json.loads(sh(['gh', 'api', f'repos/{slug}/commits/{commit}/pulls'], run=run, timeout=60))
        return rows[0]['number'] if rows else None
    except (ReleaseError, ValueError, KeyError, IndexError, subprocess.SubprocessError):
        return None


def download_ci_artifact(run_id, destination, *, slug, version, run=subprocess.run):
    destination = Path(destination)
    destination.mkdir(parents=True, exist_ok=True)
    sh(['gh', 'run', 'download', str(run_id), '-R', slug, '-n', ARTIFACT_NAME, '-D', str(destination)], run=run, timeout=300)
    path = destination / f'usegrunt-{version}.tgz'
    if not path.is_file():
        raise ReleaseError(f'The CI artifact does not contain usegrunt-{version}.tgz')
    return path


def acquire_source(origin_url, commit, destination, *, run=subprocess.run):
    """A private detached checkout of exactly `commit`."""
    destination = Path(destination)
    if destination.exists():
        raise ReleaseError(f'{destination} already exists')
    sh(['git', 'clone', '-q', '--no-checkout', origin_url, str(destination)], run=run, timeout=600)
    sh(['git', '-C', str(destination), 'checkout', '-q', '--detach', commit], run=run, timeout=120)
    head = sh(['git', '-C', str(destination), 'rev-parse', 'HEAD'], run=run, timeout=30).strip()
    if head != commit:
        raise ReleaseError('The checkout is not at the published commit')
    if sh(['git', '-C', str(destination), 'status', '--porcelain'], run=run, timeout=60).strip():
        raise ReleaseError('The checkout is not clean')
    on_main = run(['git', '-C', str(destination), 'merge-base', '--is-ancestor', commit, 'origin/main'], capture_output=True, text=True, timeout=60)
    if on_main.returncode != 0:
        raise ReleaseError('The published commit is not an ancestor of origin/main')
    return destination


def clean_build(source, version, destination, *, run=subprocess.run):
    """Install with the lockfile, build, and pack the checkout exactly like the publish workflow (`pnpm build`, `npm pack`)."""
    source, destination = Path(source), Path(destination)
    destination.mkdir(parents=True, exist_ok=True)
    sh(['pnpm', 'install', '--frozen-lockfile', '--ignore-scripts'], cwd=source, run=run, timeout=1200)
    sh(['pnpm', 'build'], cwd=source, run=run, timeout=1200)
    sh(['npm', 'pack', '--ignore-scripts', '--pack-destination', str(destination)], cwd=source, run=run, timeout=600)
    path = destination / f'usegrunt-{version}.tgz'
    if not path.is_file():
        raise ReleaseError('npm pack did not produce the expected tarball')
    return path


def fetch_npm(version, *, opener=urllib.request.urlopen):
    """(metadata, tarball bytes) of the published release, bypassing caches."""
    stamp = time.time_ns()
    try:
        with opener(f'{NPM}/usegrunt/{version}?verify={stamp}', timeout=20) as response:
            metadata = json.load(response)
    except urllib.error.HTTPError as error:
        if error.code != 404:
            raise
        request = urllib.request.Request(f'{NPM}/usegrunt?verify={stamp}', headers={'Accept': 'application/json', 'Cache-Control': 'no-cache'})
        with opener(request, timeout=20) as response:
            versions = json.load(response).get('versions', {})
        if version not in versions:
            raise ReleaseError(f'usegrunt {version} is not on npm yet')
        metadata = versions[version]
    url = f'{NPM}/usegrunt/-/usegrunt-{version}.tgz'
    if metadata.get('name') != 'usegrunt' or metadata.get('version') != version or metadata.get('dist', {}).get('tarball') != url:
        raise ReleaseError('npm metadata does not describe the requested release')
    with opener(f'{url}?verify={stamp}', timeout=60) as response:
        body = response.read()
    integrity = 'sha512-' + base64.b64encode(hashlib.sha512(body).digest()).decode()
    if integrity != metadata['dist'].get('integrity'):
        raise ReleaseError('The downloaded tarball does not match the npm integrity')
    return metadata, body


def package_files(archive, source):
    """sha256 of every packaged file, each proven equal to the file of the reviewed (clean-built) source."""
    files = {}
    with tarfile.open(archive) as package:
        for member in package.getmembers():
            parts = PurePosixPath(member.name).parts
            if not parts or parts[0] != 'package' or any(part in ('.', '..') for part in parts):
                raise ReleaseError('Unsafe package path')
            if member.isdir():
                continue
            if not member.isfile() or len(parts) < 2 or member.size > 20 * 1024 * 1024:
                raise ReleaseError('Unsupported package entry')
            name = '/'.join(parts[1:])
            value = package.extractfile(member).read()
            target = Path(source) / name
            if target.is_symlink() or not target.is_file() or target.read_bytes() != value:
                raise ReleaseError(f'Package file differs from the clean build: {name}')
            if name in files:
                raise ReleaseError('Duplicate package entry')
            files[name] = hashlib.sha256(value).hexdigest()
    return files


def build_pins(*, version, previous, commit, run_id, pull_request, metadata, body, ci_bytes, clean_bytes, source, evidence):
    """Assert the whole chain and write `<evidence>/usegrunt-<version>.tgz` and the pins. Returns the pins."""
    if not (version_tuple(previous) < version_tuple(version)):
        raise ReleaseError(f'{version} is not newer than the installed {previous}')
    if not COMMIT.fullmatch(commit):
        raise ReleaseError('A 40-hex release commit is required')
    if ci_bytes != body:
        raise ReleaseError('The CI artifact differs from the public tarball')
    if clean_bytes != body:
        raise ReleaseError('A clean build of the published commit differs from the public tarball')
    evidence = Path(evidence)
    archive = evidence / f'usegrunt-{version}.tgz'
    archive.write_bytes(body)
    archive.chmod(0o600)
    files = package_files(archive, source)
    if json.loads((Path(source) / 'package.json').read_text())['version'] != version or json.loads(files_json(archive, 'package.json'))['version'] != version:
        raise ReleaseError('The package version differs from the requested release')
    if files.get('dist/registry/adapters.json') != hashlib.sha256((Path(source) / 'registry/adapters.json').read_bytes()).hexdigest():
        raise ReleaseError('The packaged adapter registry differs from the source registry')
    if any('clixad' in name for name in files):
        raise ReleaseError('The retired Clixad adapter is packaged')
    removed = sorted(name for name in files if name in {f'dist/local/{module}.js' for module in REMOVED_MODULES})
    if removed:
        raise ReleaseError('Removed-feature modules are packaged: ' + ', '.join(removed))
    pins = {'version': version, 'previousVersion': previous, 'sourceCommit': commit, 'releaseBranch': 'main', 'pullRequest': pull_request, 'publishRun': run_id,
            'archiveIntegrity': metadata['dist']['integrity'], 'archiveSha256': hashlib.sha256(body).hexdigest(), 'packageFiles': files,
            'ciArchiveIdentical': True, 'cleanBuildIdentical': True}
    path = evidence / f'release-{version}-public-pins.json'
    path.write_text(json.dumps(pins, indent=2) + '\n')
    path.chmod(0o600)
    return pins


def files_json(archive, name):
    with tarfile.open(archive) as package:
        return package.extractfile('package/' + name).read().decode()


def verify_release(version, previous, *, repo, attempt, run=subprocess.run, opener=urllib.request.urlopen, log=print):
    """The whole chain for `version`, evidence under `attempt/evidence` and the reviewed source in `attempt/source`. Returns the pins."""
    attempt = Path(attempt)
    origin = sh(['git', '-C', str(repo), 'remote', 'get-url', 'origin'], run=run, timeout=30).strip()
    slug = repo_slug(origin)
    log(f'[release] looking for the publish run of usegrunt {version} in {slug}')
    found = find_publish_run(version, repo=repo, slug=slug, run=run)
    log(f'[release] run {found["runId"]} at {found["commit"][:12]}')
    metadata, body = fetch_npm(version, opener=opener)
    log('[release] npm tarball downloaded and its integrity checked')
    evidence = attempt / 'evidence'
    evidence.mkdir(mode=0o700, exist_ok=True)
    ci = download_ci_artifact(found['runId'], evidence / 'ci-artifact', slug=slug, version=version, run=run)
    source = acquire_source(origin, found['commit'], attempt / 'source', run=run)
    log('[release] building the published commit from a clean checkout (install, build, pack); this takes a few minutes')
    clean = clean_build(source, version, evidence / 'clean-pack', run=run)
    pins = build_pins(version=version, previous=previous, commit=found['commit'], run_id=found['runId'], pull_request=find_pull_request(found['commit'], slug=slug, run=run),
                      metadata=metadata, body=body, ci_bytes=ci.read_bytes(), clean_bytes=clean.read_bytes(), source=source, evidence=evidence)
    log(f'[release] verified: npm tarball == CI artifact == clean build ({len(pins["packageFiles"])} files, sha256 {pins["archiveSha256"][:12]})')
    return pins
