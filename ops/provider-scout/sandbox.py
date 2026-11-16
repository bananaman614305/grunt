"""Trusted, minimal-filesystem runner for untrusted candidate checks.

Only the candidate checkout is writable. Host homes, sockets, credentials and
supervisor state are never mounted. Installing the pinned package manager is a
separate host operation; a check never falls back to an unsandboxed execution.
"""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import shutil
import signal
import stat
import subprocess
import tempfile
import time


PNPM_VERSION = '10.34.5'
PUBLIC_REGISTRY = 'https://registry.npmjs.org/'
TOOLS = '/opt/scout-tools'
SAFE_ENV = {'PATH': TOOLS + '/bin:/usr/bin:/bin', 'HOME': '/tmp/scout-home',
            'TMPDIR': '/tmp', 'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8', 'CI': '1',
            'NPM_CONFIG_USERCONFIG': '/tmp/scout-home/user.npmrc',
            'npm_config_userconfig': '/tmp/scout-home/user.npmrc',
            'NPM_CONFIG_GLOBALCONFIG': '/tmp/scout-home/global.npmrc',
            'npm_config_globalconfig': '/tmp/scout-home/global.npmrc',
            'npm_config_registry': PUBLIC_REGISTRY, 'GIT_CONFIG_NOSYSTEM': '1',
            'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_TERMINAL_PROMPT': '0',
            'COREPACK_ENABLE_PROJECT_SPEC': '0', 'PNPM_PACKAGE_MANAGER_STRICT': 'false'}


class SandboxError(OSError):
    """The isolated runner is unavailable or a requested operation is unsafe."""


def _require(condition, message):
    if not condition:
        raise SandboxError(message)


def _plain_path(value, *, must_exist=True):
    path = Path(value).absolute()
    _require(not any(item.is_symlink() for item in (path, *path.parents)),
             'Sandbox paths may not traverse symbolic links')
    if must_exist:
        _require(path.exists(), 'Sandbox path is unavailable')
    return path


def _private_directory(value):
    path = _plain_path(value, must_exist=False)
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = path.stat()
    _require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid()
             and stat.S_IMODE(info.st_mode) == 0o700,
             'Supervisor directories must be private and owned')
    return path


def _digest(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def _tree_digest(root):
    digest = hashlib.sha256()
    for path in sorted(root.rglob('*')):
        _require(not path.is_symlink(), 'Trusted package manager cannot contain symlinks')
        if path.is_file():
            digest.update(str(path.relative_to(root)).encode() + b'\0')
            digest.update(bytes.fromhex(_digest(path)))
        else:
            _require(path.is_dir(), 'Unexpected trusted package manager file type')
    return digest.hexdigest()


def _descriptor(root, node, *, include_npm=True):
    package = root / 'node_modules' / 'pnpm'
    manifest = json.loads((package / 'package.json').read_text())
    _require(manifest.get('name') == 'pnpm' and manifest.get('version') == PNPM_VERSION,
             'Pinned package manager is unavailable')
    entry = package / 'bin' / 'pnpm.cjs'
    _require(entry.is_file(), 'Pinned package manager entry point is unavailable')
    data = {'version': 1, 'pnpm_version': PNPM_VERSION, 'node_binary': str(node),
            'node_sha256': _digest(node), 'pnpm_directory': str(package),
            'pnpm_sha256': _tree_digest(package)}
    if include_npm:
        npm = root / 'npm'
        npm_manifest = json.loads((npm / 'package.json').read_text())
        _require(npm_manifest.get('name') == 'npm' and isinstance(npm_manifest.get('version'), str)
                 and re.fullmatch(r'\d+\.\d+\.\d+', npm_manifest['version'])
                 and (npm / 'bin/npm-cli.js').is_file(), 'Trusted npm is unavailable')
        data.update(version=2, npm_directory=str(npm), npm_version=npm_manifest['version'],
                    npm_sha256=_tree_digest(npm))
    return data


def _toolchain(state_dir, *, allow_legacy=False):
    root = _private_directory(Path(state_dir) / 'toolchain')
    receipt = root / 'receipt.json'
    try:
        _require(not receipt.is_symlink() and stat.S_IMODE(receipt.stat().st_mode) == 0o600,
                 'Trusted toolchain receipt must be private')
        data = json.loads(receipt.read_text())
        node = _plain_path(data['node_binary'])
        _require(node.is_file() and os.access(node, os.X_OK), 'Trusted Node executable is unavailable')
        legacy = data.get('version') == 1 and allow_legacy
        _require(data == _descriptor(root, node, include_npm=not legacy),
                 'Trusted toolchain integrity check failed')
    except (KeyError, ValueError, TypeError, FileNotFoundError):
        raise SandboxError('Prepare the trusted toolchain before candidate checks') from None
    return data


def _retain_npm(root, config):
    setting = config.get('npm_binary') or shutil.which('npm')
    _require(setting, 'Trusted npm path is required')
    cli = _plain_path(Path(setting).resolve(strict=True))
    source = cli.parent.parent
    _require(cli.name == 'npm-cli.js' and cli.parent.name == 'bin', 'A trusted npm CLI module is required')
    manifest = json.loads((source / 'package.json').read_text())
    _require(manifest.get('name') == 'npm', 'Trusted npm module is unavailable')
    source_digest = _tree_digest(source)
    destination = root / 'npm'
    if destination.exists():
        _require(_tree_digest(destination) == source_digest, 'Incomplete npm upgrade requires operator review')
        return
    with tempfile.TemporaryDirectory(prefix='npm-bootstrap-', dir=root) as temporary:
        stage = Path(temporary) / 'npm'
        shutil.copytree(source, stage)
        _require(_tree_digest(stage) == source_digest, 'Trusted npm copy changed')
        os.rename(stage, destination)


def _write_receipt(root, data):
    fd, temporary = tempfile.mkstemp(prefix='receipt-', dir=root)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(data, stream, sort_keys=True)
            stream.write('\n')
        os.replace(temporary, root / 'receipt.json')
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _wait(argv, *, cwd, timeout, env, capture_stdout=False):
    """Do not retain arbitrary candidate output; clean up the whole child group."""
    process = subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                               stdout=subprocess.PIPE if capture_stdout else subprocess.DEVNULL,
                               stderr=subprocess.DEVNULL,
                               start_new_session=True, close_fds=True)
    output = bytearray()
    try:
        if capture_stdout:
            deadline = time.monotonic() + timeout
            with selectors.DefaultSelector() as selector:
                selector.register(process.stdout, selectors.EVENT_READ)
                while selector.get_map():
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise subprocess.TimeoutExpired(argv, timeout)
                    for key, _ in selector.select(min(remaining, 0.2)):
                        chunk = os.read(key.fileobj.fileno(), 8192)
                        if not chunk:
                            selector.unregister(key.fileobj)
                            continue
                        output.extend(chunk)
                        _require(len(output) <= 64 * 1024, 'Package output exceeds its budget')
            code = process.wait(timeout=max(0.01, deadline - time.monotonic()))
        else:
            code = process.wait(timeout=timeout)
    finally:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait()
        if process.stdout:
            process.stdout.close()
    return subprocess.CompletedProcess(argv, code, stdout=output.decode('utf-8'), stderr='')


def _base_command(bwrap, *, network):
    command = [bwrap, '--die-with-parent', '--new-session', '--unshare-all', '--unshare-user',
               '--cap-drop', 'ALL', '--disable-userns', '--tmpfs', '/']
    if network:
        command += ['--share-net']
    for directory in ('/usr', '/bin', '/lib', '/lib64'):
        if Path(directory).exists():
            command += ['--ro-bind', directory, directory]
    command += ['--dir', '/etc']
    for path in ('/etc/ld.so.cache', '/etc/ld.so.conf', '/etc/nsswitch.conf', '/etc/hosts',
                 '/etc/resolv.conf', '/etc/passwd', '/etc/group', '/etc/ssl/certs'):
        if Path(path).exists():
            command += ['--ro-bind', str(Path(path).resolve()), path]
    command += ['--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--tmpfs', '/run',
                '--dir', '/tmp/scout-home', '--dir', TOOLS + '/bin']
    return command


def _environment(command):
    command += ['--clearenv']
    for name, value in SAFE_ENV.items():
        command += ['--setenv', name, value]
    return command


def prepare_toolchain(state_dir: Path, config: dict) -> dict:
    """Install only public, exact-version pnpm; never consult a user's npmrc.

    This is an explicit supervisor operation, not something triggered by candidate
    commands. config may set node_binary/npm_binary to trusted host executables.
    """
    state_dir = _private_directory(state_dir)
    root = _private_directory(state_dir / 'toolchain')
    lock_path = root / 'prepare.lock'
    _require(not lock_path.is_symlink(), 'Unsafe trusted toolchain lock')
    fd = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        if (root / 'receipt.json').exists():
            data = _toolchain(state_dir, allow_legacy=True)
            if data['version'] == 1:
                _retain_npm(root, config)
                data = _descriptor(root, Path(data['node_binary']))
                _write_receipt(root, data)
            return data
        node_setting = config.get('node_binary') or shutil.which('node')
        npm_setting = config.get('npm_binary') or shutil.which('npm')
        _require(node_setting and npm_setting, 'Trusted Node and npm paths are required')
        # Explicit host symlinks are resolved before they become mount sources.
        node = _plain_path(Path(node_setting).resolve(strict=True))
        npm = _plain_path(Path(npm_setting).resolve(strict=True))
        _require(node.is_file() and os.access(node, os.X_OK) and npm.is_file(),
                 'Trusted Node and npm are unavailable')
        with tempfile.TemporaryDirectory(prefix='prepare-', dir=root) as temporary:
            temporary = Path(temporary)
            home = _private_directory(temporary / 'home')
            stage = _private_directory(temporary / 'package')
            # npm refuses the same pathname for global and user configuration,
            # even when both point at /dev/null. Use distinct empty private files.
            user_config, global_config = home / 'user.npmrc', home / 'global.npmrc'
            for empty_config in (user_config, global_config):
                empty_config.touch(mode=0o600)
            env = {key: value for key, value in SAFE_ENV.items() if key not in ('HOME', 'PATH', 'TMPDIR')}
            env.update(HOME=str(home), TMPDIR=str(temporary), PATH=str(node.parent) + ':/usr/bin:/bin',
                       npm_config_cache=str(temporary / 'cache'),
                       NPM_CONFIG_USERCONFIG=str(user_config), npm_config_userconfig=str(user_config),
                       NPM_CONFIG_GLOBALCONFIG=str(global_config), npm_config_globalconfig=str(global_config))
            argv = [str(node), str(npm), 'install', '--prefix', str(stage), '--ignore-scripts',
                    '--no-audit', '--no-fund', '--package-lock=false', '--save=false',
                    '--registry=' + PUBLIC_REGISTRY, 'pnpm@' + PNPM_VERSION]
            result = _wait(argv, cwd=temporary, timeout=300, env=env)
            _require(result.returncode == 0, 'Pinned public package manager installation failed')
            destination = root / 'node_modules'
            _require(not destination.exists(), 'Incomplete toolchain requires operator cleanup')
            # Only the package tree is retained; npm-created .bin links are not.
            package_dir = _private_directory(destination)
            shutil.move(str(stage / 'node_modules' / 'pnpm'), str(package_dir / 'pnpm'))
        _retain_npm(root, config)
        data = _descriptor(root, node)
        _write_receipt(root, data)
        return data
    finally:
        os.close(fd)


class SandboxRunner:
    """Callable accepted by validation.run_checks; no unconfined fallback."""

    def __init__(self, state_dir: Path, config: dict):
        self.state_dir = _private_directory(state_dir)
        self.workspace = _plain_path(config['workspace'])
        _require(not self.state_dir.is_relative_to(self.workspace),
                 'Supervisor state must be outside the worker workspace')
        self.bwrap = str(_plain_path(Path(config.get('bwrap_binary', '/usr/bin/bwrap')).resolve(strict=True)))
        self.tools = _toolchain(self.state_dir)

    def _checkout(self, cwd):
        checkout = _plain_path(cwd)
        _require(checkout.is_dir() and checkout.stat().st_uid == os.getuid(),
                 'Candidate checkout must be an owned directory')
        allowed = (self.workspace / 'candidates', self.state_dir / 'releases')
        _require(any(checkout != root and checkout.is_relative_to(root) for root in allowed),
                 'Candidate checks may run only in candidate or release checkouts')
        return checkout

    def command(self, argv, *, cwd, network=False):
        """Return a checked bubblewrap command; useful for deterministic audits."""
        checkout = self._checkout(cwd)
        _require(isinstance(network, bool), 'Network access must be explicit')
        _require(isinstance(argv, (list, tuple)), 'A fixed check command is required')
        pack = list(argv) == ['npm', 'pack', '--ignore-scripts', '--json', '--pack-destination', str(checkout)]
        npm_version = list(argv) == ['npm', '--version']
        if pack or npm_version:
            _require(not network, 'Packing cannot use the network')
            action = list(argv[1:])
        else:
            _require(len(argv) >= 4 and list(argv[:3]) == ['npx', '--yes', 'pnpm@' + PNPM_VERSION],
                     'Only the pinned package manager is allowed')
            action = list(argv[3:])
        install = ['install', '--frozen-lockfile', '--ignore-scripts']
        _require((action == install if network else action in (['lint'], ['test'], ['build'])) or pack or npm_version,
                 'Check command or network access is outside the fixed validation plan')
        if network:
            action += ['--ignore-pnpmfile', '--registry=' + PUBLIC_REGISTRY,
                       '--store-dir=/tmp/scout-pnpm-store', '--config.manage-package-manager-versions=false']
        command = _base_command(self.bwrap, network=network)
        command += ['--ro-bind', self.tools['node_binary'], TOOLS + '/bin/node',
                    '--ro-bind', self.tools['pnpm_directory'], TOOLS + '/pnpm',
                    '--ro-bind', self.tools['npm_directory'], TOOLS + '/npm',
                    '--symlink', '../npm/bin/npm-cli.js', TOOLS + '/bin/npm',
                    '--symlink', '../npm/bin/npx-cli.js', TOOLS + '/bin/npx',
                    '--bind', str(checkout), str(checkout), '--chdir', str(checkout)]
        _environment(command)
        entry = TOOLS + ('/npm/bin/npm-cli.js' if pack or npm_version else '/pnpm/bin/pnpm.cjs')
        command += ['--remount-ro', '/', '--', TOOLS + '/bin/node', entry, *action]
        return command

    def __call__(self, argv, *, cwd: Path, timeout: int, env: dict, network: bool):
        _require(isinstance(timeout, (int, float)) and not isinstance(timeout, bool) and 0 < timeout <= 900,
                 'Check timeout exceeds its budget')
        # Deliberately ignore the supplied and inherited environments. In
        # particular NODE_OPTIONS, proxy credentials and npm tokens cannot leak.
        _require(_toolchain(self.state_dir) == self.tools, 'Trusted toolchain changed')
        command = self.command(argv, cwd=cwd, network=network)
        pack = list(argv[:2]) == ['npm', 'pack']
        npm_version = list(argv) == ['npm', '--version']
        result = _wait(command, cwd='/', timeout=timeout, env={'PATH': '/usr/bin:/bin'}, capture_stdout=pack or npm_version)
        if pack and result.returncode == 0:
            try:
                packed = json.loads(result.stdout)
                _require(isinstance(packed, list) and len(packed) == 1 and isinstance(packed[0], dict)
                         and isinstance(packed[0].get('filename'), str)
                         and re.fullmatch(r'usegrunt-\d+\.\d+\.\d+\.tgz', packed[0]['filename']),
                         'Unexpected package output')
            except (ValueError, TypeError):
                raise SandboxError('Unexpected package output') from None
            # Project only the expected package filename, never arbitrary files
            # or script output. Promotion independently verifies archive bytes.
            result.stdout = json.dumps([{'filename': packed[0]['filename']}])
        if npm_version and result.returncode == 0:
            _require(result.stdout.strip() == self.tools['npm_version'], 'Trusted npm version changed')
            result.stdout = self.tools['npm_version'] + '\n'
        return result


def build_probe_command(state_dir: Path, config: dict, *, checkout: Path, config_dir: Path,
                        child_script: Path, child_args=()) -> list[str]:
    """Build an isolated candidate-process command for a trusted host harness.

    The host harness owns verification, nonces and proof files. Neither it nor
    its protected outputs are imported or mounted inside this process. The
    private config must belong solely to the candidate source; callers obtain
    approval for that exact capability before invoking this helper.

    The Node harness must open its dedicated protocol channel with stdio[3] set
    to 'pipe'. Bubblewrap inherits that descriptor. There is intentionally no
    --preserve-fds option: the installed bubblewrap does not support that flag.
    """
    runner = SandboxRunner(state_dir, config)
    checkout = runner._checkout(checkout)
    _require(checkout.is_relative_to(runner.workspace / 'candidates'),
             'Live probes require a worker candidate checkout')
    config_dir = _plain_path(config_dir)
    _require(config_dir.is_dir() and config_dir.stat().st_uid == os.getuid()
             and stat.S_IMODE(config_dir.stat().st_mode) == 0o700,
             'Probe configuration must be private and owned')
    _require(config_dir != runner.workspace and config_dir.is_relative_to(runner.workspace)
             and not checkout.is_relative_to(config_dir) and not config_dir.is_relative_to(checkout),
             'Probe configuration must be separate from checkout and supervisor state')
    child_script = _plain_path(child_script)
    _require(child_script.is_file() and child_script.stat().st_uid == os.getuid()
             and not child_script.is_relative_to(runner.workspace),
             'Probe child must be trusted code outside the worker workspace')
    _require(isinstance(child_args, (list, tuple)) and len(child_args) <= 32
             and all(isinstance(item, str) and len(item) < 4096 and '\0' not in item for item in child_args),
             'Invalid probe child arguments')
    command = _base_command(runner.bwrap, network=True)
    command += ['--ro-bind', runner.tools['node_binary'], TOOLS + '/bin/node',
                '--ro-bind', runner.tools['npm_directory'], TOOLS + '/npm',
                '--symlink', '../npm/bin/npm-cli.js', TOOLS + '/bin/npm',
                '--symlink', '../npm/bin/npx-cli.js', TOOLS + '/bin/npx',
                '--ro-bind', str(child_script), TOOLS + '/probe-child.mjs',
                '--ro-bind', str(checkout), str(checkout),
                '--bind', str(config_dir), str(config_dir), '--chdir', str(checkout)]
    _environment(command)
    command += ['--remount-ro', '/', '--', TOOLS + '/bin/node', TOOLS + '/probe-child.mjs', *child_args]
    return command


def main(argv=None):
    parser = argparse.ArgumentParser(description='Build a trusted isolated candidate probe command')
    parser.add_argument('action', choices=['probe-command'])
    for name in ('state-dir', 'workspace', 'checkout', 'config-dir', 'child-script'):
        parser.add_argument('--' + name, required=True)
    args, extra = parser.parse_known_args(argv)
    if extra and extra[0] == '--':
        extra = extra[1:]
    try:
        command = build_probe_command(Path(args.state_dir), {'workspace': args.workspace},
                                      checkout=Path(args.checkout), config_dir=Path(args.config_dir),
                                      child_script=Path(args.child_script), child_args=extra)
    except (OSError, ValueError, KeyError):
        parser.exit(1, 'Isolated probe command is unavailable\n')
    print(json.dumps(command))


if __name__ == '__main__':
    main()
