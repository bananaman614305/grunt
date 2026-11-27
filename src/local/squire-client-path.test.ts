import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SQUIRE_LATEST_URL,
  SQUIRE_PACKAGE_NAME,
  SQUIRE_RUNTIME_DIR,
  compareSemver,
  parseSemver,
  parseStableSemver,
  resolveNpmCommand,
  resolveSquirePackage,
  squireClientPath
} from './squire-client-path.js';
import type { SquireInstallRun } from './squire-client-path.js';
import { loadEmbeddedSignupSdk } from './signup-mcp.js';

let root: string;
let configDir: string;
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;

async function writeFakeSquirePackage(
  packageDir: string,
  version: string,
  options: { name?: string; signupBody?: string; marker?: string } = {}
) {
  const distDir = join(packageDir, 'dist');
  await mkdir(distDir, { recursive: true });
  await writeFile(
    join(packageDir, 'package.json'),
    JSON.stringify({
      name: options.name ?? SQUIRE_PACKAGE_NAME,
      version,
      type: 'module'
    }),
    { mode: 0o600 }
  );
  const marker = options.marker ?? `sdk-${version}`;
  await writeFile(
    join(distDir, 'signup.js'),
    options.signupBody ?? `export const SDK_MARKER = ${JSON.stringify(marker)};\nexport const SDK_VERSION = ${JSON.stringify(version)};\n`,
    { mode: 0o600 }
  );
  await writeFile(join(distDir, 'bin.js'), 'export default {};\n', { mode: 0o600 });
}

function registryResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function createFakeInstaller(
  installFn?: (prefix: string, requestedVersion: string, args: string[], env: NodeJS.ProcessEnv | undefined) => Promise<void>
): { run: ReturnType<typeof vi.fn<SquireInstallRun>>; calls: { binary: string; args: string[]; env: NodeJS.ProcessEnv | undefined }[] } {
  const calls: { binary: string; args: string[]; env: NodeJS.ProcessEnv | undefined }[] = [];
  const run = vi.fn<SquireInstallRun>(async (binary, args, options) => {
    calls.push({ binary, args, env: options?.env });
    const prefixIndex = args.indexOf('--prefix');
    const prefix = prefixIndex >= 0 ? args[prefixIndex + 1]! : '';
    const pkgJson = JSON.parse(await readFile(join(prefix, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    const requestedVersion = pkgJson.dependencies[SQUIRE_PACKAGE_NAME]!;
    if (installFn) {
      await installFn(prefix, requestedVersion, args, options?.env);
    } else {
      await writeFakeSquirePackage(
        join(prefix, 'node_modules', '@trusty-squire', 'mcp'),
        requestedVersion,
        { marker: `managed-${requestedVersion}` }
      );
    }
    return '';
  });
  return { run, calls };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'grunt-squire-update-'));
  configDir = join(root, 'config');
  await mkdir(configDir, { mode: 0o700 });
});

afterEach(async () => {
  Object.defineProperty(process, 'platform', originalPlatform);
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe('semver helpers', () => {
  it('orders stable releases above prereleases and compares numeric components properly', () => {
    expect(compareSemver(parseSemver('1.2.0')!, parseSemver('1.2.0-rc1')!)).toBeGreaterThan(0);
    expect(compareSemver(parseSemver('1.10.0')!, parseSemver('1.2.9')!)).toBeGreaterThan(0);
    expect(compareSemver(parseSemver('2.0.0')!, parseSemver('1.99.99')!)).toBeGreaterThan(0);
    expect(parseStableSemver('1.2.3')?.raw).toBe('1.2.3');
    expect(parseStableSemver('1.2.3-rc1')).toBeUndefined();
    expect(parseStableSemver('../1.2.3')).toBeUndefined();
  });
});

describe('on-need @trusty-squire/mcp updates', () => {
  it('installs a newer compatible 1.x release into a private managed directory and loads its signup.js', async () => {
    const packagedDir = join(root, 'packaged-1.2.0');
    await writeFakeSquirePackage(packagedDir, '1.2.0', { marker: 'packaged-1.2.0' });

    const fetcher = vi.fn<typeof fetch>(async url => {
      expect(url).toBe(SQUIRE_LATEST_URL);
      return registryResponse({ name: SQUIRE_PACKAGE_NAME, version: '1.2.5' });
    });
    const installer = createFakeInstaller();

    const resolved = await resolveSquirePackage(configDir, {
      packagedDir,
      bundled: false,
      fetcher,
      run: installer.run,
      now: () => 1_700_000_000_000,
      env: {
        PATH: process.env.PATH,
        NODE_OPTIONS: '--require /tmp/evil.js',
        npm_config_registry: 'https://evil.example'
      }
    });

    expect(resolved.source).toBe('managed');
    expect(resolved.version).toBe('1.2.5');
    expect(resolved.updated).toBe(true);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(installer.run).toHaveBeenCalledOnce();

    const call = installer.calls[0]!;
    expect(call.binary).toBe(process.execPath);
    expect(basename(call.args[0]!)).toBe('npm-cli.js');
    expect(call.args[1]).toBe('install');
    expect(call.args).toContain('--ignore-scripts');
    expect(call.args).toContain('--omit=dev');
    expect(call.args).toContain('--registry=https://registry.npmjs.org');
    expect(call.args).toContain('--userconfig');
    expect(call.args).toContain('--globalconfig');
    expect(call.env?.NODE_OPTIONS).toBeUndefined();
    expect(call.env?.npm_config_registry).toBeUndefined();

    if (process.platform !== 'win32') {
      const runtimeInfo = await stat(join(configDir, SQUIRE_RUNTIME_DIR));
      expect(runtimeInfo.mode & 0o777).toBe(0o700);
      const versionInfo = await stat(join(configDir, SQUIRE_RUNTIME_DIR, 'versions', '1.2.5'));
      expect(versionInfo.mode & 0o777).toBe(0o700);
    }

    const sdk = await loadEmbeddedSignupSdk(configDir, {
      packagedDir,
      bundled: false,
      fetcher,
      run: installer.run,
      now: () => 1_700_000_005_000
    }) as unknown as { SDK_MARKER: string; SDK_VERSION: string };
    expect(sdk.SDK_MARKER).toBe('managed-1.2.5');
    expect(sdk.SDK_VERSION).toBe('1.2.5');
    // Within cooldown: no second registry fetch or reinstall.
    expect(fetcher).toHaveBeenCalledOnce();
    expect(installer.run).toHaveBeenCalledOnce();
  });

  it('reuses the installed copy without reinstalling when already up-to-date and respects cooldown', async () => {
    const packagedDir = join(root, 'packaged-1.2.5');
    await writeFakeSquirePackage(packagedDir, '1.2.5', { marker: 'packaged-1.2.5' });

    let clock = 1_700_000_000_000;
    const fetcher = vi.fn<typeof fetch>(async () =>
      registryResponse({ name: SQUIRE_PACKAGE_NAME, version: '1.2.5' })
    );
    const installer = createFakeInstaller();

    const first = await resolveSquirePackage(configDir, {
      packagedDir,
      bundled: false,
      fetcher,
      run: installer.run,
      now: () => clock
    });
    expect(first.source).toBe('packaged');
    expect(first.version).toBe('1.2.5');
    expect(first.updated).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(installer.run).not.toHaveBeenCalled();

    // Still inside cooldown: skips registry check completely.
    clock += 60_000;
    const second = await resolveSquirePackage(configDir, {
      packagedDir,
      bundled: false,
      fetcher,
      run: installer.run,
      now: () => clock
    });
    expect(second.source).toBe('packaged');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(installer.run).not.toHaveBeenCalled();

    // After cooldown expires: checks metadata again, still no reinstall.
    clock += 20 * 60 * 1000;
    const third = await resolveSquirePackage(configDir, {
      packagedDir,
      bundled: false,
      fetcher,
      run: installer.run,
      now: () => clock
    });
    expect(third.source).toBe('packaged');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(installer.run).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'major version bump 2.0.0', payload: { name: SQUIRE_PACKAGE_NAME, version: '2.0.0' } },
    { label: 'prerelease version 1.3.0-rc1', payload: { name: SQUIRE_PACKAGE_NAME, version: '1.3.0-rc1' } },
    { label: 'path traversal version', payload: { name: SQUIRE_PACKAGE_NAME, version: '../1.3.0' } },
    { label: 'mismatched package name', payload: { name: '@evil/mcp', version: '1.3.0' } },
    { label: 'non-semver string', payload: { name: SQUIRE_PACKAGE_NAME, version: 'latest' } }
  ])('safely refuses $label and uses the installed copy', async ({ payload }) => {
    const packagedDir = join(root, 'packaged-1.2.0');
    await writeFakeSquirePackage(packagedDir, '1.2.0', { marker: 'packaged-safe-1.2.0' });

    const fetcher = vi.fn<typeof fetch>(async () => registryResponse(payload));
    const installer = createFakeInstaller();

    const sdk = await loadEmbeddedSignupSdk(configDir, {
      packagedDir,
      bundled: false,
      fetcher,
      run: installer.run,
      now: () => 1_700_000_000_000
    }) as unknown as { SDK_MARKER: string; SDK_VERSION: string };

    expect(sdk.SDK_MARKER).toBe('packaged-safe-1.2.0');
    expect(sdk.SDK_VERSION).toBe('1.2.0');
    expect(installer.run).not.toHaveBeenCalled();
  });

  it('falls back cleanly to the installed copy on registry failure, HTTP error, or npm install failure', async () => {
    const packagedDir = join(root, 'packaged-1.2.0');
    await writeFakeSquirePackage(packagedDir, '1.2.0', { marker: 'fallback-1.2.0' });

    // 1. Network error
    const netFail = vi.fn<typeof fetch>(async () => { throw new Error('ENOTFOUND registry.npmjs.org'); });
    const installer = createFakeInstaller();
    const first = await loadEmbeddedSignupSdk(configDir, {
      packagedDir,
      bundled: false,
      fetcher: netFail,
      run: installer.run,
      now: () => 1_700_000_000_000
    }) as unknown as { SDK_MARKER: string };
    expect(first.SDK_MARKER).toBe('fallback-1.2.0');
    expect(installer.run).not.toHaveBeenCalled();

    // 2. HTTP 429 rate-limit after failure cooldown
    const rateLimited = vi.fn<typeof fetch>(async () => new Response('too many requests', { status: 429 }));
    const second = await resolveSquirePackage(configDir, {
      packagedDir,
      bundled: false,
      fetcher: rateLimited,
      run: installer.run,
      now: () => 1_700_000_300_000
    });
    expect(second.source).toBe('packaged');
    expect(second.updated).toBe(false);
    expect(installer.run).not.toHaveBeenCalled();

    // 3. npm install failure after failure cooldown
    const newerAvailable = vi.fn<typeof fetch>(async () =>
      registryResponse({ name: SQUIRE_PACKAGE_NAME, version: '1.2.9' })
    );
    const brokenInstall = vi.fn<SquireInstallRun>(async () => {
      throw new Error('npm exited with status 1');
    });
    const third = await loadEmbeddedSignupSdk(configDir, {
      packagedDir,
      bundled: false,
      fetcher: newerAvailable,
      run: brokenInstall,
      now: () => 1_700_000_600_000
    }) as unknown as { SDK_MARKER: string };
    expect(third.SDK_MARKER).toBe('fallback-1.2.0');
    expect(brokenInstall).toHaveBeenCalledOnce();
  });

  it('falls back to the installed copy if a managed package fails verification or throws on import', async () => {
    const packagedDir = join(root, 'packaged-1.2.0');
    await writeFakeSquirePackage(packagedDir, '1.2.0', { marker: 'packaged-healthy' });

    // Tampered manifest version during install is rejected before activation.
    const fetcher = vi.fn<typeof fetch>(async () =>
      registryResponse({ name: SQUIRE_PACKAGE_NAME, version: '1.2.4' })
    );
    const tamperedInstaller = createFakeInstaller(async prefix => {
      await writeFakeSquirePackage(
        join(prefix, 'node_modules', '@trusty-squire', 'mcp'),
        '1.2.3', // mismatch!
        { marker: 'tampered' }
      );
    });
    const first = await resolveSquirePackage(configDir, {
      packagedDir,
      bundled: false,
      fetcher,
      run: tamperedInstaller.run,
      now: () => 1_700_000_000_000
    });
    expect(first.source).toBe('packaged');
    expect(first.updated).toBe(false);

    // Managed module that throws during ESM evaluation falls back to packaged copy.
    const throwingInstaller = createFakeInstaller(async (prefix, version) => {
      await writeFakeSquirePackage(
        join(prefix, 'node_modules', '@trusty-squire', 'mcp'),
        version,
        { signupBody: 'throw new Error("broken managed signup module");\n' }
      );
    });
    const sdk = await loadEmbeddedSignupSdk(configDir, {
      packagedDir,
      bundled: false,
      fetcher,
      run: throwingInstaller.run,
      now: () => 1_700_000_300_000
    }) as unknown as { SDK_MARKER: string };
    expect(sdk.SDK_MARKER).toBe('packaged-healthy');
  });

  it('ignores an unsafe managed runtime directory (symlink or group-writable)', async () => {
    if (process.platform === 'win32') return;
    const packagedDir = join(root, 'packaged-1.2.0');
    await writeFakeSquirePackage(packagedDir, '1.2.0', { marker: 'packaged-safe' });

    const externalTarget = join(root, 'external-runtime');
    await mkdir(externalTarget, { mode: 0o700 });
    await symlink(externalTarget, join(configDir, SQUIRE_RUNTIME_DIR));

    const fetcher = vi.fn<typeof fetch>(async () =>
      registryResponse({ name: SQUIRE_PACKAGE_NAME, version: '1.2.7' })
    );
    const installer = createFakeInstaller();

    const resolved = await resolveSquirePackage(configDir, {
      packagedDir,
      bundled: false,
      fetcher,
      run: installer.run,
      now: () => 1_700_000_000_000
    });
    expect(resolved.source).toBe('packaged');
    expect(resolved.updated).toBe(false);
    expect(installer.run).not.toHaveBeenCalled();

    // Replace symlink with group-writable directory (0o755)
    await rm(join(configDir, SQUIRE_RUNTIME_DIR));
    await mkdir(join(configDir, SQUIRE_RUNTIME_DIR), { mode: 0o755 });
    await chmod(join(configDir, SQUIRE_RUNTIME_DIR), 0o755);

    const second = await resolveSquirePackage(configDir, {
      packagedDir,
      bundled: false,
      fetcher,
      run: installer.run,
      now: () => 1_700_000_300_000
    });
    expect(second.source).toBe('packaged');
    expect(second.updated).toBe(false);
    expect(installer.run).not.toHaveBeenCalled();
  });

  it('resolves hinted and managed paths cleanly in bundled daemon mode (GRUNT_DAEMON_BUNDLE)', async () => {
    const hintedDir = join(root, 'cli-cache-1.2.0');
    await writeFakeSquirePackage(hintedDir, '1.2.0', { marker: 'hinted-1.2.0' });
    const hintedBin = join(hintedDir, 'dist', 'bin.js');
    await writeFile(join(configDir, 'squire-client-path'), hintedBin, { mode: 0o600 });

    // Offline bundled daemon resolves hinted path cleanly.
    expect(await squireClientPath(configDir, { bundled: true, packagedDir: null })).toBe(hintedBin);
    const offlineSdk = await loadEmbeddedSignupSdk(configDir, {
      bundled: true,
      packagedDir: null,
      fetcher: vi.fn<typeof fetch>(async () => { throw new Error('offline'); }),
      now: () => 1_700_000_000_000
    }) as unknown as { SDK_MARKER: string };
    expect(offlineSdk.SDK_MARKER).toBe('hinted-1.2.0');

    // Online bundled daemon refreshes to 1.2.6 into managed runtime and prefers it over older hint.
    const fetcher = vi.fn<typeof fetch>(async () =>
      registryResponse({ name: SQUIRE_PACKAGE_NAME, version: '1.2.6' })
    );
    const installer = createFakeInstaller();
    const updatedSdk = await loadEmbeddedSignupSdk(configDir, {
      bundled: true,
      packagedDir: null,
      fetcher,
      run: installer.run,
      now: () => 1_700_000_300_000
    }) as unknown as { SDK_MARKER: string; SDK_VERSION: string };
    expect(updatedSdk.SDK_MARKER).toBe('managed-1.2.6');
    expect(updatedSdk.SDK_VERSION).toBe('1.2.6');

    const resolvedBin = await squireClientPath(configDir, { bundled: true, packagedDir: null });
    expect(resolvedBin).toBe(
      join(configDir, SQUIRE_RUNTIME_DIR, 'versions', '1.2.6', 'node_modules', '@trusty-squire', 'mcp', 'dist', 'bin.js')
    );

    // Even if the CLI npx cache disappears, bundled daemon still loads from managed runtime.
    await rm(hintedDir, { recursive: true, force: true });
    const afterCacheCleanup = await loadEmbeddedSignupSdk(configDir, {
      bundled: true,
      packagedDir: null,
      autoUpdate: false
    }) as unknown as { SDK_MARKER: string };
    expect(afterCacheCleanup.SDK_MARKER).toBe('managed-1.2.6');
  });

  it('prefers a newer packaged copy over an older managed copy and prunes old managed versions', async () => {
    const oldPackaged = join(root, 'packaged-1.2.0');
    await writeFakeSquirePackage(oldPackaged, '1.2.0', { marker: 'packaged-1.2.0' });
    const installer = createFakeInstaller();
    let clock = 1_700_000_000_000;

    for (const version of ['1.2.1', '1.2.2', '1.2.3']) {
      await resolveSquirePackage(configDir, {
        packagedDir: oldPackaged,
        bundled: false,
        fetcher: vi.fn<typeof fetch>(async () => registryResponse({ name: SQUIRE_PACKAGE_NAME, version })),
        run: installer.run,
        now: () => clock
      });
      clock += 20 * 60 * 1000;
    }

    const retained = (await readdir(join(configDir, SQUIRE_RUNTIME_DIR, 'versions'))).sort();
    expect(retained).toEqual(['1.2.2', '1.2.3']);

    // After usegrunt upgrades to ship 1.4.0, packaged 1.4.0 wins over older managed 1.2.3.
    const newerPackaged = join(root, 'packaged-1.4.0');
    await writeFakeSquirePackage(newerPackaged, '1.4.0', { marker: 'packaged-1.4.0' });
    const resolved = await resolveSquirePackage(configDir, {
      packagedDir: newerPackaged,
      bundled: false,
      autoUpdate: false
    });
    expect(resolved.source).toBe('packaged');
    expect(resolved.version).toBe('1.4.0');
  });

  it('launches npm-cli.js through process.execPath on Windows via real execFile and loads the upgraded SDK', async () => {
    const packagedDir = join(root, 'packaged-1.2.0');
    await writeFakeSquirePackage(packagedDir, '1.2.0', { marker: 'win-packaged-1.2.0' });

    // Simulate a standard Windows Node directory layout:
    //   <winNodeDir>/node
    //   <winNodeDir>/npm.cmd (must never be executed)
    //   <winNodeDir>/node_modules/npm/bin/npm-cli.js
    const winNodeDir = join(root, 'win-node');
    const npmBinDir = join(winNodeDir, 'node_modules', 'npm', 'bin');
    await mkdir(npmBinDir, { recursive: true });
    const fakeNode = join(winNodeDir, 'node');
    await symlink(process.execPath, fakeNode);
    await writeFile(join(winNodeDir, 'npm.cmd'), '@echo off\r\nexit /b 99\r\n', { mode: 0o600 });
    const fakeNpmCli = join(npmBinDir, 'npm-cli.js');
    await writeFile(
      fakeNpmCli,
      `const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const args = process.argv.slice(2);
if (args[0] !== 'install') throw new Error('expected install subcommand');
if (!args.includes('--ignore-scripts') || !args.includes('--omit=dev')) throw new Error('missing safety flags');
if (process.env.NODE_OPTIONS || process.env.npm_config_registry) throw new Error('env was not sanitized');
const prefix = args[args.indexOf('--prefix') + 1];
const manifest = JSON.parse(readFileSync(join(prefix, 'package.json'), 'utf8'));
const version = manifest.dependencies['@trusty-squire/mcp'];
const pkgDir = join(prefix, 'node_modules', '@trusty-squire', 'mcp');
const distDir = join(pkgDir, 'dist');
mkdirSync(distDir, { recursive: true });
writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@trusty-squire/mcp', version, type: 'module' }));
writeFileSync(join(distDir, 'bin.js'), 'export default {};\\n');
writeFileSync(join(distDir, 'signup.js'), 'export const SDK_MARKER = ' + JSON.stringify('win-managed-' + version) + ';\\nexport const SDK_VERSION = ' + JSON.stringify(version) + ';\\n');
`,
      { mode: 0o600 }
    );

    Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'win32' });

    const command = await resolveNpmCommand(['install', '--prefix', '/tmp/example'], {
      execPath: fakeNode,
      env: { Path: '' },
      platform: 'win32'
    });
    expect(command.binary).toBe(fakeNode);
    expect(command.args).toEqual([fakeNpmCli, 'install', '--prefix', '/tmp/example']);

    // Run without stubbing `run`: exercises the real execFile path end to end.
    const fetcher = vi.fn<typeof fetch>(async () =>
      registryResponse({ name: SQUIRE_PACKAGE_NAME, version: '1.2.8' })
    );
    const sdk = await loadEmbeddedSignupSdk(configDir, {
      packagedDir,
      bundled: false,
      fetcher,
      execPath: fakeNode,
      now: () => 1_700_000_000_000,
      env: {
        Path: '',
        NODE_OPTIONS: '--require /tmp/should-be-stripped.js',
        npm_config_registry: 'https://evil.example'
      }
    }) as unknown as { SDK_MARKER: string; SDK_VERSION: string };

    expect(sdk.SDK_MARKER).toBe('win-managed-1.2.8');
    expect(sdk.SDK_VERSION).toBe('1.2.8');

    // Also verify Windows Path lookup (mixed-case `Path`) when npm-cli.js is not adjacent to execPath.
    const bareNodeDir = join(root, 'bare-node');
    await mkdir(bareNodeDir, { recursive: true });
    const bareNode = join(bareNodeDir, 'node.exe');
    await writeFile(bareNode, '', { mode: 0o600 });
    await writeFile(join(bareNodeDir, 'npm.cmd'), '@echo off\r\nexit /b 99\r\n', { mode: 0o600 });

    const pathLookupCommand = await resolveNpmCommand(['install'], {
      execPath: bareNode,
      env: { Path: `"${winNodeDir}"` },
      platform: 'win32'
    });
    expect(pathLookupCommand.binary).toBe(bareNode);
    expect(pathLookupCommand.args).toEqual([fakeNpmCli, 'install']);

    // Never fall back to npm.cmd on Windows if npm-cli.js is unavailable.
    await expect(
      resolveNpmCommand(['install'], {
        execPath: bareNode,
        env: { Path: bareNodeDir },
        platform: 'win32'
      })
    ).rejects.toThrow('npm-cli.js');
  });
});
