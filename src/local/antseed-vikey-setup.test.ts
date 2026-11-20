import { mkdtemp, mkdir, readFile, writeFile, rm, chmod, symlink, lstat, readlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { recordDataSharingConsent } from './data-sharing.js';
import { ANTSEED_BUYER_PEER, ANTSEED_BUYER_UNIT, antseedBuyerConfig, antseedBuyerUnit, antseedLock, antseedNativeAsset,
  antseedVikeyPaths, installAntseedVikey, setupAntseedVikey } from './antseed-vikey-setup.js';
import type { AntseedSetupCommand } from './antseed-vikey-setup.js';

let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'grunt-antseed-setup-')); await chmod(directory, 0o700); });
afterEach(async () => { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });
const native = Buffer.from('synthetic pinned native archive');
const nativeAsset = { url: 'https://github.com/synthetic/asset', size: native.length, sha256: createHash('sha256').update(native).digest('hex') };
async function put(path: string, body: string | Buffer) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, body, { mode: 0o600 }); }
function fixture() {
  const calls: { binary: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string }[] = [];
  const command: AntseedSetupCommand = vi.fn(async (binary, args, options) => {
    calls.push({ binary, args, env: options.env, cwd: options.cwd });
    if (args[0] === 'ci') {
      const root = args[args.indexOf('--prefix') + 1]!;
      for (const [name, version] of [['@antseed/cli', '0.1.253'], ['@antseed/router-local', '0.1.53'], ['better-sqlite3', '12.11.1']]) {
        await put(join(root, 'node_modules', name!, 'package.json'), JSON.stringify({ name, version }));
      }
      for (const name of ['dist/cli/index.js', 'dist/cli/commands/buyer/start.js', 'dist/plugins/drift.js', 'dist/plugins/loader.js']) {
        await put(join(root, 'node_modules/@antseed/cli', name), 'audited synthetic CLI');
      }
      await put(join(root, 'node_modules/@antseed/router-local/dist/index.js'), 'audited synthetic router');
    } else if (args[0] === '--extract') {
      const sqlite = args[args.indexOf('--directory') + 1]!;
      await put(join(sqlite, 'build/Release/better_sqlite3.node'), 'synthetic native binary');
    }
  });
  const fetcher = vi.fn(async () => new Response(native)) as unknown as typeof fetch;
  return { command, fetcher, nativeAsset, calls, verify: vi.fn(async () => true), checkPort: vi.fn(async () => true) };
}

it('pins every npm dependency and the exact reviewed native asset instead of using latest or native lifecycle scripts', () => {
  const lock = JSON.parse(antseedLock());
  expect(lock.packages[''].dependencies).toEqual({ '@antseed/cli': '0.1.253', '@antseed/router-local': '0.1.53' });
  expect(Object.keys(lock.packages)).toHaveLength(340);
  for (const [name, value] of Object.entries(lock.packages) as [string, { version: string; resolved?: string; integrity?: string }][]) {
    if (!name) continue;
    expect(value.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(value.resolved).toMatch(/^https:\/\/registry\.npmjs\.org\//);
    expect(value.integrity).toMatch(/^sha512-/);
  }
  expect(antseedNativeAsset('linux', 'x64', '127')?.sha256).toBe('94ce113ea2d9347fcd1cf8e46445cc271d1dbd02d05a64aa460442222f023b11');
  expect(antseedNativeAsset('linux', 'x64', '137')?.sha256).toBe('99c43785639d5d3690c396ba245ee680ac8b469a46b19233a3546f0eb7f8e312');
  expect(antseedNativeAsset('darwin', 'arm64', '127')).toBeUndefined();
  expect(antseedNativeAsset('linux', 'x64', '999')).toBeUndefined();
});
it('isolates HOME and clears ambient wallet/provider overrides while pinning zero-price peer routing', () => {
  vi.stubEnv('ANTSEED_ENABLE_SETTLEMENT', 'true'); vi.stubEnv('ANTSEED_PASSPHRASE', 'synthetic-secret');
  vi.stubEnv('OPENAI_API_KEY', 'synthetic-paid-key'); vi.stubEnv('NODE_OPTIONS', '--require synthetic');
  const unit = antseedBuyerUnit(directory), config = antseedBuyerConfig();
  expect(unit).toContain('"/usr/bin/env" "-i"'); expect(unit).toContain('ANTSEED_ENABLE_SETTLEMENT=false');
  expect(unit).toContain('ANTSEED_SKIP_PLUGIN_UPDATE_CHECK=1'); expect(unit).toContain('ANTSEED_NO_UPDATE_CHECK=1');
  expect(unit).not.toMatch(/synthetic|PASSPHRASE|OPENAI_API_KEY|NODE_OPTIONS/);
  expect(config.buyer.autoSweep).toBe(false); expect(config.buyer.maxPricing.defaults).toEqual({ inputUsdPerMillion: 0, outputUsdPerMillion: 0 });
  expect(config.buyer.routingPreferences.allowedPeerIds).toEqual([ANTSEED_BUYER_PEER]);
  expect(unit).toContain('"--max-input-usd-per-million" "0" "--max-output-usd-per-million" "0"');
});
it('provisions privately from the locked graph and starts only its exact owned unit, without inference', async () => {
  const f = fixture(); await recordDataSharingConsent(directory, ['antseed-vikey']);
  const unitDirectory = join(directory, 'units');
  await expect(setupAntseedVikey({ directory, unitDirectory, ...f })).resolves.toEqual({ port: '8381' });
  const p = antseedVikeyPaths(directory);
  expect((await lstat(p.home)).mode & 0o777).toBe(0o700);
  expect((await lstat(p.receipt)).mode & 0o777).toBe(0o600);
  expect(await readlink(join(p.nativeHome, '.antseed/plugins/node_modules'))).toBe(join(p.runtime, 'node_modules'));
  expect(JSON.parse(await readFile(p.config, 'utf8'))).toEqual(antseedBuyerConfig());
  const ci = f.calls.find(c => c.args[0] === 'ci')!;
  expect(ci.args).toContain('--ignore-scripts'); expect(ci.env).not.toHaveProperty('ANTSEED_PASSPHRASE');
  expect(f.calls.filter(c => c.binary === 'systemctl').map(c => c.args)).toEqual([
    ['--user', 'show-environment'], ['--user', 'daemon-reload'], ['--user', 'enable', '--now', ANTSEED_BUYER_UNIT]
  ]);
  expect(await readFile(join(unitDirectory, ANTSEED_BUYER_UNIT), 'utf8')).toBe(antseedBuyerUnit(directory));
  expect(f.fetcher).toHaveBeenCalledTimes(1);
  const before = f.calls.length; await setupAntseedVikey({ directory, unitDirectory, ...f });
  expect(f.calls.slice(before).every(c => c.binary === 'systemctl')).toBe(true);
  expect(f.fetcher).toHaveBeenCalledTimes(1);
});
it('requires provider consent before any installer or service operation', async () => {
  const f = fixture(); await expect(setupAntseedVikey({ directory, ...f })).rejects.toThrow('setup approval');
  expect(f.calls).toHaveLength(0); expect(f.fetcher).not.toHaveBeenCalled();
});
it('preserves a conflicting existing service without installation or replacement', async () => {
  const f = fixture(); await recordDataSharingConsent(directory, ['antseed-vikey']);
  const unitDirectory = join(directory, 'units'), unit = join(unitDirectory, ANTSEED_BUYER_UNIT);
  await put(unit, '[Service]\nExecStart=/existing/buyer\n');
  await expect(setupAntseedVikey({ directory, unitDirectory, ...f })).rejects.toThrow('existing services were preserved');
  expect(await readFile(unit, 'utf8')).toContain('/existing/buyer'); expect(f.calls).toHaveLength(0);
});
it('preserves another application on the buyer port before creating a service', async () => {
  const f = fixture(); await recordDataSharingConsent(directory, ['antseed-vikey']); f.checkPort.mockResolvedValue(false);
  const unitDirectory = join(directory, 'units');
  await expect(setupAntseedVikey({ directory, unitDirectory, ...f })).rejects.toThrow('belongs to another process');
  expect(f.calls).toHaveLength(0); expect(f.fetcher).not.toHaveBeenCalled();
  await expect(readFile(join(unitDirectory, ANTSEED_BUYER_UNIT))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('skips installation when a user systemd manager is unavailable', async () => {
  const f = fixture(); await recordDataSharingConsent(directory, ['antseed-vikey']);
  const inner = f.command;
  f.command = vi.fn(async (...args) => { if (args[0] === 'systemctl') throw new Error('no user bus'); await inner(...args); });
  await expect(setupAntseedVikey({ directory, unitDirectory: join(directory, 'units'), ...f })).rejects.toThrow('running user systemd manager');
  expect(f.calls).toHaveLength(0); expect(f.fetcher).not.toHaveBeenCalled();
});
it('rejects altered native bytes before extraction or a receipt can authorize startup', async () => {
  const f = fixture(); f.fetcher = vi.fn(async () => new Response(Buffer.from('corrupt'))) as unknown as typeof fetch;
  await expect(installAntseedVikey({ directory, ...f })).rejects.toThrow('setup did not complete');
  expect(f.calls.some(c => c.args[0] === '--extract')).toBe(false);
  await expect(readFile(antseedVikeyPaths(directory).receipt)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('fails closed on installed CLI corruption instead of silently replacing a running runtime', async () => {
  const f = fixture(); const p = await installAntseedVikey({ directory, ...f });
  await writeFile(p.entry, 'changed executable');
  const before = f.calls.length;
  await expect(installAntseedVikey({ directory, ...f })).rejects.toThrow('setup did not complete');
  expect(f.calls).toHaveLength(before); expect(await readFile(p.entry, 'utf8')).toBe('changed executable');
});
it('refuses a changed router lookup rather than importing a different user plugin tree', async () => {
  const f = fixture(), p = await installAntseedVikey({ directory, ...f });
  const link = join(p.nativeHome, '.antseed/plugins/node_modules');
  await rm(link); await symlink(join(directory, 'other-plugins'), link);
  const before = f.calls.length;
  await expect(installAntseedVikey({ directory, ...f })).rejects.toThrow('setup did not complete');
  expect(f.calls).toHaveLength(before);
});
it('does not mark an interrupted installation ready or start services', async () => {
  const f = fixture(), controller = new AbortController(), inner = f.command;
  f.command = vi.fn(async (...args) => { await inner(...args); if (args[1][0] === 'ci') controller.abort(); });
  await expect(installAntseedVikey({ directory, signal: controller.signal, ...f })).rejects.toBeDefined();
  await expect(readFile(antseedVikeyPaths(directory).receipt)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(f.calls.some(c => c.binary === 'systemctl')).toBe(false);
});
it('rejects symlinked state and cancellation without launching installer commands', async () => {
  const f = fixture(), p = antseedVikeyPaths(directory), outside = join(directory, 'outside');
  await mkdir(outside); await symlink(outside, p.home);
  await expect(installAntseedVikey({ directory, ...f })).rejects.toThrow('setup did not complete');
  await rm(p.home); const controller = new AbortController(); controller.abort();
  await expect(installAntseedVikey({ directory, signal: controller.signal, ...f })).rejects.toBeDefined();
  expect(f.calls).toHaveLength(0);
});
it('rejects a symlinked ancestor before installing files outside the private source tree', async () => {
  const f = fixture(), p = antseedVikeyPaths(directory), outside = join(directory, 'outside');
  await mkdir(p.home, { mode: 0o700 }); await mkdir(outside, { mode: 0o700 });
  await symlink(outside, join(p.home, 'state'));
  // A partially pre-existing state directory must not let setup write config
  // outside the owned tree even though the final config itself is not a link.
  await expect(installAntseedVikey({ directory, ...f })).rejects.toThrow('setup did not complete');
  await expect(readFile(join(outside, 'config.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});
