import { execFileSync } from 'node:child_process';
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
  collectHostRuntimePrefixes,
  createOpenerBridge,
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
      workDir: '/Users/alice/.config/grunt/apps/demo/tmp/req-1'
    }, '/Users/alice');
    expect(runProfile).toContain('(deny file-read* file-write* (subpath "/Users/alice"))');
    expect(runProfile).toContain('(allow file-read* (subpath "/Users/alice/.config/grunt/apps/demo/pkg"))');
    expect(runProfile).not.toContain('file-write* (subpath "/Users/alice/.config/grunt/apps/demo/pkg")');
    expect(runProfile).toContain('(allow file-read* file-write* (subpath "/Users/alice/.config/grunt/apps/demo/home"))');

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

  it('proves real bwrap containment: hides host $HOME canary, mounts pkg read-only, captures xdg-open via host socket, and cleans up completely', async () => {
    const backend = await detectSandboxBackend();
    if (!backend || backend.kind !== 'bwrap') return;

    const configDir = await makeTemp('grunt-bwrap-cfg-');
    // Put a canary file in host $HOME (or verify host $HOME itself is unmounted)
    const hostHomePath = homedir();
    const paths = await prepareAppDirectories('demo-app', configDir);

    // Build a valid tar.gz containing a node CLI binary
    const archiveSrc = await makeTemp('grunt-tar-good-');
    const cliCode = [
      '#!/usr/bin/env node',
      'const fs = require("node:fs");',
      'const cp = require("node:child_process");',
      'const cmd = process.argv[2];',
      'if (cmd === "probe") {',
      `  const hostHomeExists = fs.existsSync(${JSON.stringify(hostHomePath)});`,
      '  let pkgWritable = true;',
      `  try { fs.writeFileSync(${JSON.stringify(join(SANDBOX_PKG, 'mutated.txt'))}, "x"); } catch { pkgWritable = false; }`,
      `  fs.writeFileSync(${JSON.stringify(join(SANDBOX_HOME, 'saved.txt'))}, "persisted");`,
      '  console.log(JSON.stringify({ hostHomeExists, pkgWritable, home: process.env.HOME, cwd: process.cwd() }));',
      '} else if (cmd === "login") {',
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

    // Run probe inside bwrap
    const reqWork = await makeTemp('grunt-bwrap-work-');
    const { prefixes, nodeBin } = await collectHostRuntimePrefixes(false);
    const probe = await runSandboxedCommand(join(SANDBOX_PKG, 'demo-cli'), ['probe'], {
      mode: 'run',
      pkgDir: paths.pkg,
      homeDir: paths.home,
      workDir: reqWork,
      extraRuntimePrefixes: prefixes
    }, { signal: AbortSignal.timeout(15000), timeoutMs: 15000, backend });
    expect(probe.code).toBe(0);
    const report = JSON.parse(probe.stdout.trim());
    expect(report).toEqual({
      hostHomeExists: false,
      pkgWritable: false,
      home: SANDBOX_HOME,
      cwd: SANDBOX_WORK
    });
    expect(await readFile(join(paths.home, 'saved.txt'), 'utf8')).toBe('persisted');

    // Verify xdg-open host Unix socket capture works even with stdio: 'ignore'
    const opened: string[] = [];
    const bridge = await createOpenerBridge(paths.tmp, nodeBin, url => opened.push(url));
    try {
      const login = await runSandboxedCommand(join(SANDBOX_PKG, 'demo-cli'), ['login'], {
        mode: 'auth',
        pkgDir: paths.pkg,
        homeDir: paths.home,
        workDir: reqWork,
        openerDir: bridge.openerDir,
        openerSocketPath: bridge.socketPath,
        extraRuntimePrefixes: prefixes
      }, { signal: AbortSignal.timeout(15000), timeoutMs: 15000, backend });
      expect(login.code).toBe(0);
      expect(opened).toEqual(['https://auth.demo.example/pair?state=123']);
    } finally {
      await bridge.close();
    }

    // List, prune, and clean leave zero files behind
    expect((await listInstalledApps(configDir)).map(a => a.id)).toEqual(['demo-app']);
    expect(await pruneRetiredAppSandboxes(new Set(['demo-app']), configDir)).toEqual([]);
    expect(await cleanAppSandbox('demo-app', configDir)).toBe(true);
    expect(existsSync(appSandboxPaths('demo-app', configDir).root)).toBe(false);
    expect(existsSync(appSandboxPaths('demo-app', configDir).stateFile)).toBe(false);
    expect(await listInstalledApps(configDir)).toEqual([]);
    await appsCommand(['list'], configDir);
  });
});
