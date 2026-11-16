"""Offline tests for filesystem, environment and command boundaries."""
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import sandbox


class SandboxTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.state = self.root / 'state'
        self.state.mkdir(mode=0o700)
        self.workspace = self.root / 'workspace'
        self.workspace.mkdir(mode=0o700)
        self.checkout = self.workspace / 'candidates' / 'source'
        self.checkout.mkdir(parents=True)
        self.node = Path(shutil.which('node')).resolve()
        self.config = {'workspace': str(self.workspace), 'node_binary': str(self.node)}

    def fixture_toolchain(self, program='process.exit(0);'):
        root = self.state / 'toolchain'
        root.mkdir(mode=0o700)
        package = root / 'node_modules' / 'pnpm'
        (package / 'bin').mkdir(parents=True)
        (package / 'package.json').write_text(json.dumps({'name': 'pnpm', 'version': sandbox.PNPM_VERSION}))
        (package / 'bin' / 'pnpm.cjs').write_text(program)
        receipt = root / 'receipt.json'
        receipt.write_text(json.dumps(sandbox._descriptor(root, self.node)))
        receipt.chmod(0o600)
        return root

    def runner(self, program='process.exit(0);'):
        self.fixture_toolchain(program)
        return sandbox.SandboxRunner(self.state, self.config)

    @staticmethod
    def argv(action='test'):
        return ['npx', '--yes', 'pnpm@10.34.5', action]

    def test_missing_toolchain_fails_closed(self):
        with self.assertRaises(sandbox.SandboxError):
            sandbox.SandboxRunner(self.state, self.config)

    def test_check_command_uses_minimal_read_only_root_and_no_network(self):
        runner = self.runner()
        command = runner.command(self.argv(), cwd=self.checkout)
        self.assertIn('--unshare-all', command)
        self.assertNotIn('--share-net', command)
        self.assertIn('--clearenv', command)
        self.assertEqual(command[command.index('--remount-ro') + 1], '/')
        self.assertIn('--disable-userns', command)
        self.assertEqual(command[-3:], [sandbox.TOOLS + '/bin/node', sandbox.TOOLS + '/pnpm/bin/pnpm.cjs', 'test'])
        bindings = [(command[index + 1], command[index + 2]) for index, value in enumerate(command)
                    if value in ('--bind', '--ro-bind')]
        self.assertNotIn(('/', '/'), bindings)
        self.assertNotIn((str(Path.home()), str(Path.home())), bindings)
        self.assertEqual([pair for pair in bindings if pair[0] == str(self.checkout)], [(str(self.checkout), str(self.checkout))])

    def test_install_is_only_network_enabled_command(self):
        runner = self.runner()
        install = self.argv('install') + ['--frozen-lockfile', '--ignore-scripts']
        command = runner.command(install, cwd=self.checkout, network=True)
        self.assertIn('--share-net', command)
        self.assertIn('--ignore-pnpmfile', command)
        self.assertIn('--registry=' + sandbox.PUBLIC_REGISTRY, command)
        for argv, network in [(self.argv(), True), (install, False), (self.argv('exec') + ['sh'], False),
                              (['npm', 'test'], False), (self.argv() + ['--filter=one'], False),
                              (self.argv('install'), True)]:
            with self.subTest(argv=argv, network=network):
                with self.assertRaises(sandbox.SandboxError):
                    runner.command(argv, cwd=self.checkout, network=network)

    def test_rejects_outside_checkout_symlink_and_supervisor_state_in_workspace(self):
        runner = self.runner()
        for cwd in (self.root, self.workspace, self.workspace / 'candidates', self.state):
            with self.subTest(cwd=cwd):
                with self.assertRaises(sandbox.SandboxError):
                    runner.command(self.argv(), cwd=cwd)
        link = self.workspace / 'candidates' / 'linked'
        link.symlink_to(self.checkout)
        with self.assertRaises(sandbox.SandboxError):
            runner.command(self.argv(), cwd=link)
        nested_state = self.workspace / 'supervisor'
        nested_state.mkdir(mode=0o700)
        with self.assertRaises(sandbox.SandboxError):
            sandbox.SandboxRunner(nested_state, self.config)

    def test_release_checkout_is_supported(self):
        runner = self.runner()
        release = self.state / 'releases' / 'reviewed-head' / 'checkout'
        release.mkdir(parents=True)
        self.assertIn(str(release), runner.command(self.argv('build'), cwd=release))

    def test_pack_cannot_mount_supervisor_artifact_parent(self):
        runner = self.runner()
        args = ['npm', 'pack', '--ignore-scripts', '--json', '--pack-destination', str(self.checkout)]
        command = runner.command(args, cwd=self.checkout)
        self.assertEqual(command[-6:], ['--config.ignore-scripts=true', '--config.ignore-pnpmfile=true', 'pack', '--json',
                                      '--pack-destination', str(self.checkout)])
        with self.assertRaises(sandbox.SandboxError):
            runner.command(args, cwd=self.checkout, network=True)
        with self.assertRaises(sandbox.SandboxError):
            runner.command([*args[:-1], str(self.state)], cwd=self.checkout)

    def test_pack_stdout_is_projected_to_verified_filename_only(self):
        runner = self.runner()
        args = ['npm', 'pack', '--ignore-scripts', '--json', '--pack-destination', str(self.checkout)]
        output = json.dumps({'filename': 'usegrunt-0.6.11.tgz', 'files': [{'arbitrary': 'private synthetic field'}]})
        with patch.object(sandbox, '_wait', return_value=subprocess.CompletedProcess([], 0, stdout=output)) as wait:
            result = runner(args, cwd=self.checkout, timeout=1, env={}, network=False)
            self.assertTrue(wait.call_args.kwargs['capture_stdout'])
            self.assertEqual(json.loads(result.stdout), [{'filename': 'usegrunt-0.6.11.tgz'}])
        for output in ('not json', '{"filename":"../private.tgz"}', '[{"filename":"usegrunt-0.6.11.tgz"}]'):
            with self.subTest(output=output):
                with patch.object(sandbox, '_wait', return_value=subprocess.CompletedProcess([], 0, stdout=output)):
                    with self.assertRaises(sandbox.SandboxError):
                        runner(args, cwd=self.checkout, timeout=1, env={}, network=False)

    @unittest.skipUnless(shutil.which('bwrap'), 'bubblewrap is not installed')
    def test_real_pack_output_budget_stops_unbounded_process(self):
        runner = self.runner("process.stdout.write('x'.repeat(100000));")
        args = ['npm', 'pack', '--ignore-scripts', '--json', '--pack-destination', str(self.checkout)]
        with self.assertRaisesRegex(sandbox.SandboxError, 'output exceeds'):
            runner(args, cwd=self.checkout, timeout=10, env={}, network=False)

    def test_environment_not_forwarded_or_toolchain_mutation_accepted(self):
        runner = self.runner()
        with patch.object(sandbox, '_wait', return_value=subprocess.CompletedProcess([], 0)) as wait:
            with patch.dict(os.environ, {'SCOUT_SYNTHETIC_SECRET': 'fixture', 'NODE_OPTIONS': '--inspect'}):
                runner(self.argv(), cwd=self.checkout, timeout=1,
                       env={'SCOUT_SYNTHETIC_SECRET': 'fixture', 'NODE_OPTIONS': '--inspect'}, network=False)
            self.assertEqual(wait.call_args.kwargs['env'], {'PATH': '/usr/bin:/bin'})
            self.assertNotIn('SCOUT_SYNTHETIC_SECRET', wait.call_args.args[0])
            self.assertNotIn('NODE_OPTIONS', wait.call_args.args[0])
        (self.state / 'toolchain' / 'node_modules' / 'pnpm' / 'bin' / 'pnpm.cjs').write_text('process.exit(1)')
        with self.assertRaises(sandbox.SandboxError):
            runner(self.argv(), cwd=self.checkout, timeout=1, env={}, network=False)

    def probe_fixture(self, program='process.exit(0);'):
        self.fixture_toolchain()
        config = self.workspace / 'source-private-config'
        config.mkdir(mode=0o700)
        child = self.root / 'trusted-probe-child.mjs'
        child.write_text(program)
        return config, child

    def test_probe_child_sees_only_readonly_checkout_and_private_configuration(self):
        config, child = self.probe_fixture()
        command = sandbox.build_probe_command(self.state, self.config, checkout=self.checkout,
                    config_dir=config, child_script=child,
                    child_args=['--checkout', str(self.checkout)])
        self.assertIn('--share-net', command)
        bindings = [(value, command[index + 1], command[index + 2]) for index, value in enumerate(command)
                    if value in ('--bind', '--ro-bind')]
        self.assertIn(('--ro-bind', str(self.checkout), str(self.checkout)), bindings)
        self.assertIn(('--bind', str(config), str(config)), bindings)
        self.assertEqual([item for item in bindings if item[0] == '--bind'],
                         [('--bind', str(config), str(config))])
        self.assertIn(('--ro-bind', str(child), sandbox.TOOLS + '/probe-child.mjs'), bindings)
        self.assertNotIn(str(self.state), command)

    def test_probe_rejects_wide_config_and_worker_supplied_child(self):
        config, child = self.probe_fixture()
        for unsafe in (self.workspace, self.checkout, self.state):
            unsafe.chmod(0o700)
            with self.subTest(config_dir=unsafe):
                with self.assertRaises(sandbox.SandboxError):
                    sandbox.build_probe_command(self.state, self.config, checkout=self.checkout,
                                                config_dir=unsafe, child_script=child)
        worker_child = self.workspace / 'untrusted-probe.mjs'
        worker_child.write_text('process.exit(0);')
        with self.assertRaises(sandbox.SandboxError):
            sandbox.build_probe_command(self.state, self.config, checkout=self.checkout,
                                        config_dir=config, child_script=worker_child)

    @unittest.skipUnless(shutil.which('bwrap'), 'bubblewrap is not installed')
    def test_real_probe_cannot_modify_checkout_or_access_host_proof(self):
        protected = self.state / 'protected-proof.json'
        protected.write_text('synthetic protected proof')
        marker = self.checkout / 'reviewed-source.ts'
        marker.write_text('reviewed content')
        program = """
import fs from 'node:fs';
const [checkout, config, proof] = process.argv.slice(2);
const checks = {proofHidden: !fs.existsSync(proof)};
try { fs.writeFileSync(checkout + '/reviewed-source.ts', 'changed'); checks.readonly = false; }
catch { checks.readonly = true; }
checks.hostHomeHidden = !fs.existsSync(HOST_HOME + '/.codex');
checks.environmentPrivate = !process.env.SCOUT_SYNTHETIC_SECRET;
fs.writeFileSync(config + '/child-result.json', JSON.stringify(checks));
console.log(JSON.stringify({ok: Object.values(checks).every(Boolean)}));
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
""".replace('HOST_HOME', json.dumps(str(Path.home())))
        config, child = self.probe_fixture(program)
        command = sandbox.build_probe_command(self.state, self.config, checkout=self.checkout,
                    config_dir=config, child_script=child,
                    child_args=[str(self.checkout), str(config), str(protected)])
        result = sandbox._wait(command, cwd='/', timeout=15,
                               env={'SCOUT_SYNTHETIC_SECRET': 'fixture'}, capture_stdout=True)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(json.loads(result.stdout), {'ok': True})
        self.assertEqual(marker.read_text(), 'reviewed content')
        self.assertEqual(protected.read_text(), 'synthetic protected proof')
        self.assertTrue(all(json.loads((config / 'child-result.json').read_text()).values()))

    @unittest.skipUnless(shutil.which('bwrap'), 'bubblewrap is not installed')
    def test_real_probe_preserves_node_dedicated_fd3_protocol(self):
        config, child = self.probe_fixture("import fs from 'node:fs'; fs.writeSync(3, JSON.stringify({protocol: 'fd3'}) + '\\n');")
        command = sandbox.build_probe_command(self.state, self.config, checkout=self.checkout,
                                              config_dir=config, child_script=child)
        self.assertNotIn('--preserve-fds', command)
        host_harness = r"""
const {spawn} = require('node:child_process');
const command = JSON.parse(process.argv[1]);
const child = spawn(command[0], command.slice(1), {
  stdio: ['ignore', 'ignore', 'ignore', 'pipe'], env: {PATH: '/usr/bin:/bin'}
});
let protocol = '';
child.stdio[3].on('data', chunk => { protocol += chunk; });
child.on('error', () => process.exit(2));
child.on('close', code => {
  if (code !== 0) process.exit(3);
  try { if (JSON.parse(protocol).protocol !== 'fd3') process.exit(4); }
  catch { process.exit(5); }
  process.stdout.write(JSON.stringify({protocol: 'fd3'}));
});
setTimeout(() => { child.kill('SIGKILL'); process.exit(6); }, 10000).unref();
"""
        result = sandbox._wait([str(self.node), '-e', host_harness, json.dumps(command)], cwd='/',
                               timeout=15, env={'PATH': '/usr/bin:/bin'}, capture_stdout=True)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(json.loads(result.stdout), {'protocol': 'fd3'})

    def test_prepare_toolchain_installs_only_pinned_public_package_without_credentials(self):
        npm = Path('/usr/bin/true')
        self.config['npm_binary'] = str(npm)

        def fake_install(argv, *, cwd, timeout, env):
            self.assertEqual(argv[:3], [str(self.node), str(npm.resolve()), 'install'])
            self.assertEqual(argv[-1], 'pnpm@10.34.5')
            self.assertIn('--ignore-scripts', argv)
            self.assertIn('--registry=' + sandbox.PUBLIC_REGISTRY, argv)
            self.assertNotEqual(env['npm_config_userconfig'], env['NPM_CONFIG_GLOBALCONFIG'])
            self.assertEqual(Path(env['npm_config_userconfig']).read_text(), '')
            self.assertEqual(Path(env['NPM_CONFIG_GLOBALCONFIG']).read_text(), '')
            self.assertNotIn('SCOUT_SYNTHETIC_SECRET', env)
            self.assertNotIn('NODE_OPTIONS', env)
            stage = Path(argv[argv.index('--prefix') + 1])
            package = stage / 'node_modules' / 'pnpm'
            (package / 'bin').mkdir(parents=True)
            (package / 'package.json').write_text(json.dumps({'name': 'pnpm', 'version': sandbox.PNPM_VERSION}))
            (package / 'bin' / 'pnpm.cjs').write_text('process.exit(0);')
            return subprocess.CompletedProcess(argv, 0)

        with patch.object(sandbox, '_wait', side_effect=fake_install) as install:
            with patch.dict(os.environ, {'SCOUT_SYNTHETIC_SECRET': 'fixture', 'NODE_OPTIONS': '--inspect'}):
                descriptor = sandbox.prepare_toolchain(self.state, self.config)
            self.assertEqual(descriptor['pnpm_version'], '10.34.5')
            self.assertEqual(sandbox.prepare_toolchain(self.state, self.config), descriptor)
            self.assertEqual(install.call_count, 1)
        self.assertEqual(stat.S_IMODE((self.state / 'toolchain' / 'receipt.json').stat().st_mode), 0o600)

    @unittest.skipUnless(shutil.which('bwrap'), 'bubblewrap is not installed')
    def test_real_sandbox_hides_home_and_supervisor_and_preserves_checkout_writes(self):
        # All data is synthetic. No actual host credential file is opened.
        outside = self.root / 'outside'
        outside.write_text('synthetic private data')
        program = """
const fs = require('node:fs');
const checks = {};
checks.privateAbsent = !fs.existsSync(OUTSIDE);
checks.homeAbsent = !fs.existsSync(HOST_HOME + '/.codex');
checks.envAbsent = !process.env.SCOUT_SYNTHETIC_SECRET && !process.env.NODE_OPTIONS;
// This path may exist inside private /tmp. It must not address host storage.
try { fs.writeFileSync(OUTSIDE, 'changed only inside private tmpfs'); } catch {}
try { fs.writeFileSync('/outside-root-write', 'changed'); checks.rootDenied = false; }
catch { checks.rootDenied = true; }
fs.writeFileSync('sandbox-proof.json', JSON.stringify(checks));
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
""".replace('OUTSIDE', json.dumps(str(outside))).replace('HOST_HOME', json.dumps(str(Path.home())))
        runner = self.runner(program)
        with patch.dict(os.environ, {'SCOUT_SYNTHETIC_SECRET': 'fixture', 'NODE_OPTIONS': '--inspect'}):
            result = runner(self.argv(), cwd=self.checkout, timeout=15,
                            env={'SCOUT_SYNTHETIC_SECRET': 'fixture'}, network=False)
        self.assertEqual(result.returncode, 0)
        proof = json.loads((self.checkout / 'sandbox-proof.json').read_text())
        self.assertTrue(all(proof.values()), proof)
        self.assertEqual(outside.read_text(), 'synthetic private data')


if __name__ == '__main__':
    unittest.main()
