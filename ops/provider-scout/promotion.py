"""Trusted, resumable promotion of a fully reviewed provider into usegrunt."""
import contextlib
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import stat
import subprocess
import tarfile
import tempfile
import time
import urllib.error
import urllib.request

REPOSITORY = 'bananaman614305/milo'
ORIGIN = 'https://github.com/' + REPOSITORY + '.git'
NPM = 'https://registry.npmjs.org/usegrunt'
SHA = re.compile(r'^[0-9a-f]{40}$')
DIGEST = re.compile(r'^[0-9a-f]{64}$')
VERSION = re.compile(r'^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$')
REVIEW_CHECKS = ('model', 'context', 'free_access', 'terms', 'signup', 'consent', 'code_scope')


class PromotionError(Exception):
    """Only fixed reason codes, never subprocess or upstream payloads."""


def _private(path):
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise PromotionError('unsafe_supervisor_directory')


def _write(path, value):
    fd, name = tempfile.mkstemp(prefix=path.name + '.', suffix='.tmp', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(value, stream, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)


def _json_file(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_size > 2 * 1024 * 1024:
        raise PromotionError('unsafe_receipt_file')
    return json.loads(path.read_text())


def _digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _version(value):
    if not isinstance(value, str) or not VERSION.fullmatch(value):
        raise PromotionError('invalid_release_version')
    return tuple(map(int, value.split('.')))


def _fetch(url):
    if url != NPM + '/latest' and not re.fullmatch(re.escape(NPM) + r'/(?:[0-9]+\.[0-9]+\.[0-9]+|-/usegrunt-[0-9]+\.[0-9]+\.[0-9]+\.tgz)', url):
        raise PromotionError('unexpected_registry_url')
    request = urllib.request.Request(url, headers={'Cache-Control': 'no-cache', 'Accept': 'application/json'})
    try:
        # npm endpoints must never redirect the controller to another host.
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *_args, **_kwargs):
                return None
        with urllib.request.build_opener(NoRedirect).open(request, timeout=30) as response:
            data = response.read(16 * 1024 * 1024 + 1)
            if len(data) > 16 * 1024 * 1024:
                raise PromotionError('registry_response_too_large')
            return data
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return None
        raise PromotionError('registry_unavailable') from None


def _json_fetch(fetcher, url):
    value = fetcher(url)
    return json.loads(value) if isinstance(value, (bytes, str)) else value


def _default_run(args, cwd=None, timeout=60):
    allowed = ('HOME', 'PATH', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS')
    env = {key: value for key, value in os.environ.items() if key in allowed}
    env.update(CI='1', GIT_TERMINAL_PROMPT='0', GIT_NO_REPLACE_OBJECTS='1', NPM_CONFIG_USERCONFIG='/dev/null')
    if cwd:
        env['NPM_CONFIG_CACHE'] = str(Path(cwd) / '.npm-cache')
    process = None
    try:
        process = subprocess.Popen(args, cwd=cwd, env=env, text=True, stdout=subprocess.PIPE,
                                   stderr=subprocess.DEVNULL, start_new_session=True)
        stdout, _ = process.communicate(timeout=timeout)
        if process.returncode != 0 or len(stdout) > 2 * 1024 * 1024:
            raise PromotionError('release_command_failed')
        return stdout
    except (OSError, subprocess.SubprocessError):
        raise PromotionError('release_command_failed') from None
    finally:
        # Also runs for supervisor cancellation, which intentionally propagates.
        if process:
            with contextlib.suppress(ProcessLookupError):
                os.killpg(process.pid, signal.SIGTERM)
            if process.poll() is None:
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    pass
            with contextlib.suppress(ProcessLookupError):
                os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=5)
            if process.stdout:
                process.stdout.close()


def _authority(receipt, proof):
    """Validate supervisor-issued gates, independent of mutable worker files."""
    bound = {'head_sha': receipt['head_sha'], 'registry_sha256': receipt['registry_sha256'],
             'source_id': receipt['source_id'], 'model': receipt['model'], 'http_status': 200}
    if receipt.get('probe_verified_by_supervisor') is not True or any(proof.get(key) != value for key, value in bound.items()):
        raise PromotionError('supervisor_probe_not_verified')
    if not all(proof.get(key) is True for key in ('reply_received', 'attribution_verified', 'tool_call_verified', 'free_guard_verified')):
        raise PromotionError('supervisor_probe_incomplete')
    checks = receipt.get('checks', {})
    if checks.get('passed') is not True or checks.get('head_sha') != receipt['head_sha']:
        raise PromotionError('local_checks_not_verified')
    reviews = receipt.get('reviews', [])
    phases = set()
    identifiers = set()
    for review in reviews:
        if (review.get('verdict') != 'approve' or review.get('independent') is not True
                or review.get('head_sha') != receipt['head_sha'] or review.get('base_sha') != receipt['base_sha']
                or not all(review.get('checks', {}).get(key) is True for key in REVIEW_CHECKS)):
            raise PromotionError('review_not_verified')
        identifier = review.get('review_id')
        if not isinstance(identifier, str) or not identifier or identifier in identifiers:
            raise PromotionError('reviews_not_independent')
        identifiers.add(identifier)
        phases.add(review.get('phase'))
    if len(identifiers) < 2 or not {'pre_execution', 'post_validation'}.issubset(phases):
        raise PromotionError('two_independent_reviews_required')


def _receipt(receipt, config, state_dir, run):
    if receipt.get('version') != 1 or receipt.get('qualified') is not True:
        raise PromotionError('unqualified_receipt')
    for key in ('head_sha', 'base_sha'):
        if not isinstance(receipt.get(key), str) or not SHA.fullmatch(receipt[key]):
            raise PromotionError('unbound_receipt')
    for key in ('registry_sha256', 'evidence_sha256', 'trusted_evidence_sha256'):
        if not isinstance(receipt.get(key), str) or not DIGEST.fullmatch(receipt[key]):
            raise PromotionError('unbound_evidence')
    if not re.fullmatch(r'[a-z][a-z0-9-]{0,63}', receipt.get('source_id', '')) or not isinstance(receipt.get('model'), str):
        raise PromotionError('invalid_source_identity')
    workspace = Path(config['workspace']).resolve()
    checkout = Path(receipt['checkout'])
    if checkout.is_symlink() or not checkout.resolve().is_relative_to(workspace / 'candidates'):
        raise PromotionError('untrusted_checkout')
    if state_dir.resolve().is_relative_to(workspace):
        raise PromotionError('supervisor_state_inside_worker_workspace')
    if run(['git', 'rev-parse', 'HEAD'], cwd=checkout).strip() != receipt['head_sha']:
        raise PromotionError('head_changed_after_review')
    if run(['git', 'status', '--porcelain', '--untracked-files=no'], cwd=checkout).strip():
        raise PromotionError('checkout_changed_after_review')
    if run(['git', 'remote', 'get-url', 'origin'], cwd=checkout).strip() != ORIGIN:
        raise PromotionError('unexpected_repository')
    if _digest(checkout / 'registry/adapters.json') != receipt['registry_sha256']:
        raise PromotionError('registry_changed_after_review')
    evidence = Path(receipt['evidence_file'])
    if not evidence.resolve().is_relative_to(workspace) or _digest(evidence) != receipt['evidence_sha256']:
        raise PromotionError('preliminary_evidence_changed')
    trusted = Path(receipt.get('trusted_evidence_file', ''))
    if trusted.is_symlink() or not trusted.resolve().is_relative_to(state_dir.resolve()) or _digest(trusted) != receipt['trusted_evidence_sha256']:
        raise PromotionError('untrusted_supervisor_evidence')
    info = trusted.stat()
    if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600:
        raise PromotionError('unsafe_supervisor_evidence')
    _authority(receipt, _json_file(trusted))
    return checkout


def _release_identity(receipt, checkout, run):
    package = _json_file(checkout / 'package.json')
    base_package = json.loads(run(['git', 'show', receipt['base_sha'] + ':package.json'], cwd=checkout))
    if package.get('name') != 'usegrunt' or package.get('type') != 'module':
        raise PromotionError('unexpected_package')
    base_version, current = _version(base_package['version']), _version(package['version'])
    if current[:2] != base_version[:2] or current[2] <= base_version[2]:
        raise PromotionError('reviewed_patch_version_required')
    registry = _json_file(checkout / 'registry/adapters.json')
    base_registry = json.loads(run(['git', 'show', receipt['base_sha'] + ':registry/adapters.json'], cwd=checkout))
    published = dt.datetime.fromisoformat(registry['published'].replace('Z', '+00:00'))
    previous = dt.datetime.fromisoformat(base_registry['published'].replace('Z', '+00:00'))
    if published <= previous or published > dt.datetime.now(dt.timezone.utc) + dt.timedelta(minutes=5):
        raise PromotionError('new_registry_publication_required')
    entries = [item for item in registry['adapters'] if item['id'] == receipt['source_id']]
    if len(entries) != 1 or receipt['model'] not in [entries[0].get('model'), *(entries[0].get('models') or [])]:
        raise PromotionError('source_not_in_default_pool')
    if any(item['id'] == receipt['source_id'] for item in base_registry['adapters']):
        raise PromotionError('source_is_not_a_new_default')
    return package['version']


def _next_npm_patch(latest, version):
    if latest is not None:
        current = _version(latest['version'])
        if _version(version) != (current[0], current[1], current[2] + 1):
            raise PromotionError('npm_version_requires_fresh_review')


def _artifact(path, version, registry_hash):
    if not path.is_file() or path.is_symlink() or path.stat().st_size > 16 * 1024 * 1024:
        raise PromotionError('unsafe_release_archive')
    with tarfile.open(path, 'r:gz') as archive:
        members, expanded = [], 0
        for item in archive:
            members.append(item)
            expanded += item.size
            if len(members) > 1024 or expanded > 64 * 1024 * 1024:
                raise PromotionError('unsafe_release_archive')
        names = []
        for item in members:
            name = item.name
            if not item.isfile() or not re.fullmatch(r'package/(?:package\.json|README\.md|dist/[A-Za-z0-9_./-]+)', name) or any(part in ('.', '..') for part in name.split('/')):
                raise PromotionError('unsafe_release_archive')
            names.append(name)
        if len(set(names)) != len(names) or 'package/dist/local/main.js' not in names:
            raise PromotionError('unsafe_release_archive')
        package = json.load(archive.extractfile('package/package.json'))
        if package.get('name') != 'usegrunt' or package.get('version') != version:
            raise PromotionError('artifact_identity_mismatch')
        registry = archive.extractfile('package/dist/registry/adapters.json').read()
        if hashlib.sha256(registry).hexdigest() != registry_hash:
            raise PromotionError('artifact_registry_mismatch')
    data = path.read_bytes()
    import base64
    return {'version': version, 'tarball': str(path), 'sha256': hashlib.sha256(data).hexdigest(),
            'integrity': 'sha512-' + base64.b64encode(hashlib.sha512(data).digest()).decode(), 'bytes': len(data)}


def _public(fetcher, artifact):
    document = _json_fetch(fetcher, NPM + '/' + artifact['version'])
    if document is None:
        return False
    expected_url = NPM + '/-/usegrunt-' + artifact['version'] + '.tgz'
    if (document.get('name') != 'usegrunt' or document.get('version') != artifact['version']
            or document.get('dist', {}).get('integrity') != artifact['integrity']
            or document.get('dist', {}).get('tarball') != expected_url):
        raise PromotionError('public_version_artifact_conflict')
    data = fetcher(expected_url)
    if not isinstance(data, bytes) or hashlib.sha256(data).hexdigest() != artifact['sha256']:
        raise PromotionError('public_tarball_integrity_mismatch')
    return True


def _publisher_request(config, artifact, staging):
    reference = config.get('npm_credential_reference')
    if not isinstance(reference, str) or not re.fullmatch(r'vault://[A-Za-z0-9_-]+/[A-Za-z0-9_./-]+', reference):
        raise PromotionError('npm_credential_not_configured')
    module = Path(config.get('squire_module', Path.home() / '.config/milo/runtime/dist/local/setup.js'))
    if not module.is_absolute() or module.is_symlink() or not module.is_file():
        raise PromotionError('trusted_squire_runtime_unavailable')
    return {**artifact, 'package_file': str(staging / 'package.json'), 'readme_file': str(staging / 'README.md'),
            'credential_reference': reference, 'squire_module': str(module)}


def _check(config, args, staging, timeout, network=False):
    runner = config.get('release_check_runner')
    if not callable(runner):
        raise PromotionError('sandboxed_release_check_runner_required')
    env = {'CI': '1', 'NPM_CONFIG_USERCONFIG': '/dev/null', 'npm_config_userconfig': '/dev/null',
           'GIT_CONFIG_NOSYSTEM': '1', 'GIT_TERMINAL_PROMPT': '0'}
    try:
        result = runner(args, cwd=staging, timeout=timeout, env=env, network=network)
        code = result.get('returncode') if isinstance(result, dict) else result.returncode
        if type(code) is not int or code != 0:
            raise PromotionError('sandboxed_release_check_failed')
        return result.get('stdout', '') if isinstance(result, dict) else result.stdout
    except Exception:
        raise PromotionError('sandboxed_release_check_failed') from None


def preflight_publisher(config, state_dir, run=None):
    """Authenticated read only; never uploads a package or exposes a credential."""
    run = run or _default_run
    state_dir = Path(state_dir)
    _private(state_dir)
    request = _publisher_request(config, {}, Path(config.get('source_repo', '.')))
    path, output = state_dir / 'publisher-preflight-request.json', state_dir / 'publisher-preflight.json'
    _write(path, request)
    output.unlink(missing_ok=True)
    try:
        run(['node', str(Path(__file__).with_name('publish.mjs')), '--request', str(path), '--output', str(output), '--preflight'], timeout=120)
    except (PromotionError, OSError):
        if not output.exists():
            raise PromotionError('npm_publisher_preflight_unavailable') from None
    result = _json_file(output)
    if result.get('status') != 'authenticated' or result.get('grantRevoked') is not True:
        raise PromotionError('npm_publisher_approval_or_login_required')
    return result


def promote_candidate(receipt, config, state_dir, run=None, fetcher=None):
    """Merge and publish one reviewed source; retry safely from private checkpoints.

    run(args, cwd=None, timeout=60) returns stdout. fetcher(url) returns public
    registry bytes/dicts or None for 404. Both can be replaced by offline fixtures.
    """
    state_dir = Path(state_dir)
    run, fetcher = run or _default_run, fetcher or _fetch
    if config.get('release_enabled', config.get('publish_enabled')) is not True:
        return {'status': 'disabled', 'reason': 'automatic_release_not_enabled'}
    _private(state_dir)
    lock_fd = os.open(state_dir / 'promotion.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(lock_fd, 'w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return {'status': 'deferred', 'reason': 'another_release_is_running'}
        checkpoint = None
        state = {}
        try:
            if not SHA.fullmatch(receipt.get('head_sha', '')):
                raise PromotionError('unbound_receipt')
            root = state_dir / ('release-' + receipt['head_sha'])
            _private(root)
            checkpoint = root / 'checkpoint.json'
            state = _json_file(checkpoint) if checkpoint.exists() else {}
            stage = root / 'checkout'
            authorization = root / 'authorization.json'
            if authorization.exists() and stage.is_dir():
                saved = _json_file(authorization)
                original = saved['receipt']
                if any(receipt.get(key) != original.get(key) for key in ('head_sha', 'base_sha', 'source_id', 'model')):
                    raise PromotionError('release_resume_identity_conflict')
                _authority(original, saved['trusted_evidence'])
                receipt = original
                branch = saved['branch']
                checkout = stage
                if not stage.is_dir() or stage.is_symlink():
                    raise PromotionError('release_staging_missing')
                version = _release_identity(receipt, checkout, run)
            else:
                checkout = _receipt(receipt, config, state_dir, run)
                version = _release_identity(receipt, checkout, run)
                branch = run(['git', 'branch', '--show-current'], cwd=checkout).strip()
                if not re.fullmatch(r'scout/[a-z0-9][a-z0-9-]{0,80}', branch):
                    raise PromotionError('unexpected_candidate_branch')
                _write(authorization, {'receipt': receipt, 'branch': branch,
                                       'trusted_evidence': _json_file(Path(receipt['trusted_evidence_file'])),
                                       'trusted_evidence_raw': Path(receipt['trusted_evidence_file']).read_text()})
            state = state or {'phase': 'new', 'head_sha': receipt['head_sha'], 'version': version, 'source_id': receipt['source_id']}
            if state.get('head_sha') != receipt['head_sha'] or state.get('version') != version:
                raise PromotionError('release_checkpoint_conflict')
            if not stage.exists():
                run(['git', 'clone', '--no-hardlinks', '--no-checkout', str(checkout), str(stage)], timeout=120)
                run(['git', 'checkout', '--detach', receipt['head_sha']], cwd=stage)
            if run(['git', 'rev-parse', 'HEAD'], cwd=stage).strip() != receipt['head_sha']:
                raise PromotionError('release_staging_head_changed')
            if 'artifact' not in state:
                for args in (['npx', '--yes', 'pnpm@10.34.5', 'install', '--frozen-lockfile', '--ignore-scripts'],
                             ['npx', '--yes', 'pnpm@10.34.5', 'lint'], ['npx', '--yes', 'pnpm@10.34.5', 'test'],
                             ['npx', '--yes', 'pnpm@10.34.5', 'build']):
                    _check(config, args, stage, timeout=600, network='install' in args)
                packed = json.loads(_check(config, ['npm', 'pack', '--ignore-scripts', '--json', '--pack-destination', str(stage)], stage, timeout=120))
                if len(packed) != 1 or packed[0].get('filename') != 'usegrunt-' + version + '.tgz':
                    raise PromotionError('unexpected_pack_output')
                packed_file = stage / packed[0]['filename']
                if packed_file.is_symlink() or not packed_file.is_file():
                    raise PromotionError('unsafe_release_archive')
                shutil.move(packed_file, root / packed[0]['filename'])
                state['artifact'] = _artifact(root / packed[0]['filename'], version, receipt['registry_sha256'])
                state['phase'] = 'artifact_ready'
                _write(checkpoint, state)
            artifact = _artifact(Path(state['artifact']['tarball']), version, receipt['registry_sha256'])
            if artifact != state['artifact']:
                raise PromotionError('release_artifact_changed')
            # Resolve prerequisite approval/auth before any irreversible merge.
            if not state.get('publisher_preflight'):
                preflight_publisher(config, root, run)
                state['publisher_preflight'] = True
                _write(checkpoint, state)
            api = 'repos/' + REPOSITORY
            permissions = json.loads(run(['gh', 'api', api + '/actions/permissions']))
            if permissions.get('enabled') is not False:
                run(['gh', 'api', '--method', 'PUT', api + '/actions/permissions', '-F', 'enabled=false'])
                if json.loads(run(['gh', 'api', api + '/actions/permissions'])).get('enabled') is not False:
                    raise PromotionError('github_actions_must_be_disabled')
            if not state.get('merge_sha'):
                if not re.fullmatch(r'scout/[a-z0-9][a-z0-9-]{0,80}', branch):
                    raise PromotionError('unexpected_candidate_branch')
                pulls = json.loads(run(['gh', 'api', api + '/pulls?state=all&base=main&head=bananaman614305:' + branch]))
                matching = [item for item in pulls if item.get('head', {}).get('sha') == receipt['head_sha'] and item.get('base', {}).get('ref') == 'main']
                if len(matching) > 1:
                    raise PromotionError('ambiguous_candidate_pull_request')
                pull = matching[0] if matching else None
                if pull and pull.get('merged_at'):
                    state['merge_sha'] = pull.get('merge_commit_sha')
                else:
                    current_base = json.loads(run(['gh', 'api', api + '/git/ref/heads/main']))['object']['sha']
                    if current_base != receipt['base_sha']:
                        raise PromotionError('main_changed_requires_fresh_review')
                    latest = _json_fetch(fetcher, NPM + '/latest')
                    _next_npm_patch(latest, version)
                    if not pull:
                        run(['git', 'push', ORIGIN, 'HEAD:refs/heads/' + branch], cwd=stage, timeout=120)
                        body = root / 'pull-request.md'
                        body.write_text('Adds the independently reviewed ' + receipt['source_id'] + ' free provider.\n\n'
                                        'Exact-source reply, native tool calls, recurring free access and spending guards passed. '
                                        'Local lint/tests/build and two independent reviews are bound to `' + receipt['head_sha'] + '`.\n')
                        body.chmod(0o600)
                        run([shutil.which('gh-axi') or 'gh', 'pr', 'create', '--repo', REPOSITORY, '--base', 'main', '--head', branch,
                             '--title', 'v' + version + ' feat: add ' + receipt['source_id'] + ' free provider', '--body-file', str(body)], cwd=stage, timeout=120)
                        pulls = json.loads(run(['gh', 'api', api + '/pulls?state=open&base=main&head=bananaman614305:' + branch]))
                        if len(pulls) != 1:
                            raise PromotionError('pull_request_creation_not_verified')
                        pull = pulls[0]
                    number = pull.get('number')
                    if not isinstance(number, int) or isinstance(number, bool) or number < 1:
                        raise PromotionError('invalid_pull_request_number')
                    detail = json.loads(run(['gh', 'api', api + '/pulls/' + str(number)]))
                    if (detail.get('head', {}).get('sha') != receipt['head_sha'] or detail.get('base', {}).get('sha') != receipt['base_sha']
                            or detail.get('head', {}).get('repo', {}).get('full_name') != REPOSITORY):
                        raise PromotionError('pull_request_binding_changed')
                    if detail.get('draft'):
                        run([shutil.which('gh-axi') or 'gh', 'pr', 'ready', str(number), '--repo', REPOSITORY], cwd=stage)
                    current_base = json.loads(run(['gh', 'api', api + '/git/ref/heads/main']))['object']['sha']
                    if current_base != receipt['base_sha']:
                        raise PromotionError('main_changed_requires_fresh_review')
                    # The wrapper does not support --match-head-commit. Native gh
                    # preserves branch protections and the exact reviewed head.
                    run(['gh', 'pr', 'merge', str(number), '--repo', REPOSITORY, '--squash', '--match-head-commit', receipt['head_sha']], cwd=stage, timeout=120)
                    detail = json.loads(run(['gh', 'api', api + '/pulls/' + str(number)]))
                    if detail.get('merged') is not True or detail.get('head', {}).get('sha') != receipt['head_sha']:
                        raise PromotionError('merge_not_verified')
                    state.update(merge_sha=detail.get('merge_commit_sha'), pr_number=number)
                if not isinstance(state.get('merge_sha'), str) or not SHA.fullmatch(state['merge_sha']):
                    raise PromotionError('merge_commit_not_verified')
                state['phase'] = 'merged'
                _write(checkpoint, state)
            # Verify the exact merged tree still contains the reviewed artifact's
            # source. A squash SHA differs, its tree must not.
            run(['git', 'fetch', ORIGIN, state['merge_sha']], cwd=stage, timeout=120)
            reviewed_tree = run(['git', 'rev-parse', receipt['head_sha'] + '^{tree}'], cwd=stage).strip()
            merged_tree = run(['git', 'rev-parse', state['merge_sha'] + '^{tree}'], cwd=stage).strip()
            if reviewed_tree != merged_tree:
                raise PromotionError('merged_tree_differs_from_reviewed_tree')
            if _public(fetcher, artifact):
                state['phase'] = 'published'
                _write(checkpoint, state)
            elif state['phase'] not in ('publish_requested', 'published'):
                latest = _json_fetch(fetcher, NPM + '/latest')
                _next_npm_patch(latest, version)
                request = _publisher_request(config, artifact, stage)
                request['expected_latest_version'] = latest['version'] if latest else None
                publish_authorization = root / 'publish-authorization.json'
                saved = _json_file(authorization)
                _write(publish_authorization, {'version': 1, 'workspace': config['workspace'],
                                              'release_root': str(root), 'merge_sha': state['merge_sha'],
                                              'receipt': saved['receipt'], 'trusted_evidence': saved['trusted_evidence'],
                                              'trusted_evidence_raw': saved['trusted_evidence_raw'],
                                              'artifact': artifact})
                request['authorization_file'] = str(publish_authorization)
                request_path, output = root / 'publish-request.json', root / 'publish-result.json'
                _write(request_path, request)
                state['phase'] = 'publish_requested'
                _write(checkpoint, state)
                try:
                    run(['node', str(Path(__file__).with_name('publish.mjs')), '--request', str(request_path), '--output', str(output)], timeout=150)
                except (PromotionError, OSError):
                    if not output.exists():
                        raise PromotionError('publication_outcome_unknown') from None
                publication = _json_file(output)
                state['publication'] = publication
                if publication.get('grantRevoked') is not True:
                    raise PromotionError('publisher_grant_cleanup_required')
                if publication.get('status') not in ('accepted', 'published'):
                    if publication.get('requestSent') is False:
                        state['phase'] = 'merged'
                    _write(checkpoint, state)
                    raise PromotionError('publication_approval_or_retry_required')
                _write(checkpoint, state)
            attempts = max(1, min(30, int(config.get('publication_poll_attempts', 12))))
            for attempt in range(attempts):
                if _public(fetcher, artifact):
                    latest = _json_fetch(fetcher, NPM + '/latest')
                    if latest and latest.get('version') == version:
                        state['phase'] = 'published'
                        state['verified_at'] = dt.datetime.now(dt.timezone.utc).isoformat()
                        _write(checkpoint, state)
                        return {'status': 'released', 'source_id': receipt['source_id'], 'model': receipt['model'], 'version': version,
                                'head_sha': receipt['head_sha'], 'merge_sha': state['merge_sha'], 'pr_number': state.get('pr_number'),
                                'artifact_sha256': artifact['sha256'], 'default_pool_verified': True}
                    raise PromotionError('published_version_is_not_latest')
                if attempt + 1 < attempts:
                    time.sleep(max(0, min(30, float(config.get('publication_poll_seconds', 5)))))
            return {'status': 'publication_pending', 'source_id': receipt['source_id'], 'version': version,
                    'head_sha': receipt['head_sha'], 'merge_sha': state['merge_sha'], 'reason': 'awaiting_public_npm_verification'}
        except (PromotionError, OSError, ValueError, TypeError, KeyError, tarfile.TarError) as error:
            reason = str(error) if isinstance(error, PromotionError) else 'invalid_release_state'
            if checkpoint:
                state['last_error'] = reason
                with contextlib.suppress(OSError):
                    _write(checkpoint, state)
            return {'status': 'blocked', 'reason': reason, 'source_id': receipt.get('source_id'),
                    **({'version': state['version']} if state.get('version') else {})}
