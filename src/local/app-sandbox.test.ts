import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SANDBOX_HOME,
  SANDBOX_PKG,
  SANDBOX_WORK,
  appSandboxPaths,
  appsCommand,
  buildMacOsSandboxProfile,
  cleanAppSandbox,
  collectHostRuntimeMounts,
  createOpenerPipe,
  detectSandboxBackend,
  installDeclarativeApp,
  listInstalledApps,
  prepareAppDirectories,
  pruneRetiredAppSandboxes,
  runSandboxedCommand,
  sandboxPathsFor,
  validateTarGzArchive
} from './app-sandbox.js';

const tempDirs: string[] = [];
async function makeTemp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('app-sandbox', () => {
  it('generates a macOS Seatbelt profile that denies host home and makes pkg read-only at runtime', () => {
    expect(sandboxPathsFor({ kind: 'bwrap', binary: '/usr/bin/bwrap' }, '/host/pkg', '/host/work'))
      .toEqual({ pkg: SANDBOX_PKG, work: SANDBOX_WORK });
    expect(sandboxPathsFor({ kind: 'sandbox-exec', binary: '/usr/bin/sandbox-exec' }, '/host/pkg', '/host/work'))
      .toEqual({ pkg: '/host/pkg', work: '/host/work' });
    const runProfile = buildMacOsSandboxProfile({
      mode: 'run',
      pkgDir: '/Users/alice/.config/grunt/apps/demo/pkg',
      homeDir: '/Users/alice/.config/grunt/apps/demo/home',
      workDir: '/Users/alice/.config/grunt/apps/demo/tmp/req-1',
      openerPipePath: '/Users/alice/.config/grunt/apps/demo/tmp/openers-1/opener.pipe',
      extraRuntimeMounts: [
        { hostPath: '/Users/alice/.local/bin/uv', mountPath: '/opt/grunt-rt/uv/uv', kind: 'file', pathDir: '/opt/grunt-rt/uv' }
      ]
    }, '/Users/alice');
    expect(runProfile).toContain('(deny file-read* file-write* (subpath "/Users/alice"))');
    expect(runProfile).toContain('(allow file-read* (subpath "/Users/alice/.config/grunt/apps/demo/pkg"))');
    expect(runProfile).not.toContain('file-write* (subpath "/Users/alice/.config/grunt/apps/demo/pkg")');
    expect(runProfile).toContain('(allow file-read* file-write* (subpath "/Users/alice/.config/grunt/apps/demo/home"))');
    expect(runProfile).toContain('(allow file-read* (literal "/Users/alice/.local/bin/uv"))');
    expect(runProfile).not.toContain('(subpath "/Users/alice/.local/bin")');
    expect(runProfile).toContain('(allow file-read* file-write* (literal "/Users/alice/.config/grunt/apps/demo/tmp/openers-1/opener.pipe"))');

    const installProfile = buildMacOsSandboxProfile({
      mode: 'install',
      pkgDir: '/tmp/staging/pkg',
      homeDir: '/Users/alice/.config/grunt/apps/demo/home',
      workDir: '/tmp/staging/work'
    }, '/Users/alice');
    expect(installProfile).toContain('(allow file-read* file-write* (subpath "/tmp/staging/pkg"))');
    expect(installProfile).not.toContain('/Users/alice/.config/grunt/apps/demo/home');
  });

  it('rejects tar.gz archives with path traversal or symlinks before extraction', async () => {
    const work = await makeTemp('grunt-tar-bad-');
    const src = join(work, 'src');
    await mkdir(src, { recursive: true });
    await writeFile(join(src, 'real.txt'), 'ok');
    await symlink('/etc/passwd', join(src, 'evil-link'));
    const symlinkTar = join(work, 'symlink.tar.gz');
    execFileSync('tar', ['-czf', symlinkTar, '-C', src, 'evil-link']);
    await expect(validateTarGzArchive(symlinkTar, AbortSignal.timeout(10000))).rejects.toThrow(/disallowed link or special file/i);
  });

  it('proves real bwrap containment: blocks host-home and runtime-sibling canaries, mounts pkg read-only, captures xdg-open via host pipe FD, and cleans up completely', async () => {
    const backend = await detectSandboxBackend();
    if (!backend || backend.kind !== 'bwrap') return;

    const configDir = await makeTemp('grunt-bwrap-cfg-');
    const hostHomePath = homedir();
    const nonce = randomUUID().slice(0, 8);
    // Create an actual canary file inside host $HOME and a home-installed runtime with sibling secrets.
    const hostCanaryPath = join(hostHomePath, `.grunt-bwrap-canary-${nonce}`);
    const homeRtRoot = join(hostHomePath, `.grunt-bwrap-rt-${nonce}`);
    const homeRtBinDir = join(homeRtRoot, 'bin');
    const fakeUvPath = join(homeRtBinDir, 'uv');
    const siblingSecretPath = join(homeRtBinDir, 'sibling-secret.txt');
    const parentSecretPath = join(homeRtRoot, 'parent-secret.txt');

    await writeFile(hostCanaryPath, `HOST_HOME_SECRET_${nonce}\n`, { mode: 0o600 });
    await mkdir(homeRtBinDir, { recursive: true, mode: 0o700 });
    await writeFile(fakeUvPath, '#!/bin/sh\necho fake-uv-ok\n', { mode: 0o755 });
    await writeFile(siblingSecretPath, `SIBLING_SECRET_${nonce}\n`, { mode: 0o600 });
    await writeFile(parentSecretPath, `PARENT_SECRET_${nonce}\n`, { mode: 0o600 });

    try {
      const paths = await prepareAppDirectories('demo-app', configDir);

      // Build a valid tar.gz containing a node CLI binary
      const archiveSrc = await makeTemp('grunt-tar-good-');
      const cliCode = [
        '#!/usr/bin/env node',
        'const fs = require("node:fs");',
        'const cp = require("node:child_process");',
        'const cmd = process.argv[2];',
        'const canRead = p => { try { fs.readFileSync(p, "utf8"); return true; } catch { return false; } };',
        'if (cmd === "probe") {',
        `  const hostHomeCanaryReadable = canRead(${JSON.stringify(hostCanaryPath)});`,
        `  const siblingHostReadable = canRead(${JSON.stringify(siblingSecretPath)});`,
        '  const siblingMountReadable = canRead("/opt/grunt-rt/uv/sibling-secret.txt");',
        `  const parentHostReadable = canRead(${JSON.stringify(parentSecretPath)});`,
        '  const uvCheck = cp.spawnSync("/opt/grunt-rt/uv/uv", [], { encoding: "utf8" });',
        '  let pkgWritable = true;',
        `  try { fs.writeFileSync(${JSON.stringify(join(SANDBOX_PKG, 'mutated.txt'))}, "x"); } catch { pkgWritable = false; }`,
        `  fs.writeFileSync(${JSON.stringify(join(SANDBOX_HOME, 'saved.txt'))}, "persisted");`,
        '  console.log(JSON.stringify({',
        '    hostHomeCanaryReadable,',
        '    siblingHostReadable,',
        '    siblingMountReadable,',
        '    parentHostReadable,',
        '    uvOut: (uvCheck.stdout || "").trim(),',
        '    pkgWritable,',
        '    home: process.env.HOME,',
        '    cwd: process.cwd()',
        '  }));',
        '} else if (cmd === "login-node") {',
        '  cp.spawnSync("xdg-open", ["https://auth.demo.example/pair?state=123"], { stdio: "ignore" });',
        '  console.log("login-done");',
        '}'
      ].join('\n') + '\n';
      await writeFile(join(archiveSrc, 'demo-cli'), cliCode, { mode: 0o755 });
      const archiveFile = join(archiveSrc, 'demo.tar.gz');
      execFileSync('tar', ['-czf', archiveFile, '-C', archiveSrc, 'demo-cli']);
      const archiveBytes = await readFile(archiveFile);

      const installed = await installDeclarativeApp('demo-app', {
        type: 'archive',
        urls: {
          'linux-x64': 'https://releases.demo.example/demo.tar.gz',
          'linux-arm64': 'https://releases.demo.example/demo.tar.gz',
          'darwin-x64': 'https://releases.demo.example/demo.tar.gz',
          'darwin-arm64': 'https://releases.demo.example/demo.tar.gz'
        },
        bin: 'demo-cli'
      }, {
        directory: configDir,
        signal: AbortSignal.timeout(30000),
        backend,
        fetcher: async () => new Response(archiveBytes, { status: 200 })
      });
      expect(installed.state.binaryRelPath).toBe('demo-cli');

      // Run probe inside bwrap with both host-home-installed node and home-installed fake uv mounted
      const reqWork = await makeTemp('grunt-bwrap-work-');
      const { mounts } = await collectHostRuntimeMounts({ needsUv: true, uvPath: fakeUvPath });
      const probe = await runSandboxedCommand(join(SANDBOX_PKG, 'demo-cli'), ['probe'], {
        mode: 'run',
        pkgDir: paths.pkg,
        homeDir: paths.home,
        workDir: reqWork,
        extraRuntimeMounts: mounts
      }, { signal: AbortSignal.timeout(15000), timeoutMs: 15000, backend });
      expect(probe.code).toBe(0);
      const report = JSON.parse(probe.stdout.trim());
      expect(report).toEqual({
        hostHomeCanaryReadable: false,
        siblingHostReadable: false,
        siblingMountReadable: false,
        parentHostReadable: false,
        uvOut: 'fake-uv-ok',
        pkgWritable: false,
        home: SANDBOX_HOME,
        cwd: SANDBOX_WORK
      });
      expect(await readFile(join(paths.home, 'saved.txt'), 'utf8')).toBe('persisted');

      // Verify host-owned pipe FD opener capture works with stdout/stderr ignored:
      // 1) Direct inherited host pipe FD 3 (shell invocation with >/dev/null 2>&1)
      // 2) Host-owned FIFO pipe FD when a Node CLI invokes xdg-open with stdio: 'ignore' (closing FD 3)
      const opened: string[] = [];
      const opener = await createOpenerPipe(paths.tmp, url => opened.push(url));
      try {
        const shellLogin = await runSandboxedCommand('/bin/sh', ['-c', 'xdg-open https://auth.demo.example/fd3 >/dev/null 2>&1'], {
          mode: 'auth',
          pkgDir: paths.pkg,
          homeDir: paths.home,
          workDir: reqWork,
          openerDir: opener.openerDir,
          openerPipePath: opener.pipePath,
          extraRuntimeMounts: mounts
        }, { signal: AbortSignal.timeout(15000), timeoutMs: 15000, backend, onOpenerData: opener.onFd3Data });
        expect(shellLogin.code).toBe(0);

        const nodeLogin = await runSandboxedCommand(join(SANDBOX_PKG, 'demo-cli'), ['login-node'], {
          mode: 'auth',
          pkgDir: paths.pkg,
          homeDir: paths.home,
          workDir: reqWork,
          openerDir: opener.openerDir,
          openerPipePath: opener.pipePath,
          extraRuntimeMounts: mounts
        }, { signal: AbortSignal.timeout(15000), timeoutMs: 15000, backend, onOpenerData: opener.onFd3Data });
        expect(nodeLogin.code).toBe(0);
        expect(opened).toEqual([
          'https://auth.demo.example/fd3',
          'https://auth.demo.example/pair?state=123'
        ]);
      } finally {
        await opener.close();
      }

      // List, prune, and clean leave zero files behind
      expect((await listInstalledApps(configDir)).map(a => a.id)).toEqual(['demo-app']);
      expect(await pruneRetiredAppSandboxes(new Set(['demo-app']), configDir)).toEqual([]);
      expect(await cleanAppSandbox('demo-app', configDir)).toBe(true);
      expect(existsSync(appSandboxPaths('demo-app', configDir).root)).toBe(false);
      expect(existsSync(appSandboxPaths('demo-app', configDir).stateFile)).toBe(false);
      expect(await listInstalledApps(configDir)).toEqual([]);
      await appsCommand(['list'], configDir);
    } finally {
      await rm(hostCanaryPath, { force: true });
      await rm(homeRtRoot, { recursive: true, force: true });
    }
  });
});
