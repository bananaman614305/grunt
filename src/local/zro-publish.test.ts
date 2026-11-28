import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type * as Vault from './vault.js';

// Stops setup at the moment it writes the replacement into the vault, as a crash would:
// the write either lands or not, and nothing after it runs.
const crash = vi.hoisted(() => ({
  mode: undefined as undefined | 'before' | 'after',
  // Per-key behaviour for overlapping runs: waits before the vault write, and where to stop.
  keys: {} as Record<string, { wait?: () => Promise<void>; stop?: 'before' | 'after' }>
}));
vi.mock('./vault.js', async importOriginal => {
  const actual = await importOriginal<typeof Vault>();
  return {
    ...actual,
    writeVaultEntry: async (...args: Parameters<typeof actual.writeVaultEntry>) => {
      const key = args[1].api_key;
      const plan = crash.keys[key] ?? (key === 'working' && crash.mode ? { stop: crash.mode } : {});
      await plan.wait?.();
      if (plan.stop === 'before') throw new Error('setup stopped before the vault write');
      const written = await actual.writeVaultEntry(...args);
      if (plan.stop === 'after') throw new Error('setup stopped after the vault write');
      return written;
    }
  };
});
const { setup } = await import('./setup.js');
const { Zro, readZroGrant, writeZroGrant } = await import('./zro.js');
const { readVaultEntry, writeVaultEntry } = await import('./vault.js');

const ZRO_ORIGIN = 'https://zro.moonmath.ai';
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'grunt-zro-publish-'));
  vi.stubEnv('GRUNT_CONFIG_DIR', directory);
  crash.mode = undefined; crash.keys = {};
  await writeVaultEntry('zro', { api_key: 'vault-limited', origin: ZRO_ORIGIN, source: 'local' }, directory);
  await writeZroGrant({ base_url: ZRO_ORIGIN, token: 'vault-limited' }, directory);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const authorization = new Headers(init!.headers).get('authorization') ?? '';
    if (authorization.startsWith('Bearer working')) return Response.json({ model: 'deepseek-v4.1-flash', choices: [{ message: { content: 'ready' } }] });
    return new Response(null, { status: authorization === 'Bearer stale-vault' ? 401 : 402 });
  });
});
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});
const squire = (token = 'working') => ({
  credentials: {
    list: async () => [{ service: 'zro', reference: `vault://${token}`, field_names: ['api_key'] }],
    grant: async () => ({ base_url: ZRO_ORIGIN, token })
  },
  runs: { start: vi.fn(), get: vi.fn() },
  materializeDirectVaultGrant: vi.fn(async () => ({ base_url: ZRO_ORIGIN, token }))
});
// What the daemon would load now; undefined when it rejects the vault and receipt pair.
const daemonKey = async () => (await readZroGrant(directory).catch(() => undefined))?.token;

it.each([
  { mode: 'before' as const, loads: 'vault-limited' },
  { mode: 'after' as const, loads: 'working' }
])('leaves the daemon a usable Zro key when setup stops $mode writing the verified replacement into the vault', async ({ mode, loads }) => {
  crash.mode = mode;
  const run = squire();
  await expect(setup(() => {}, ['zro'], { directory, squire: run, exportToVault: true })).rejects.toThrow();
  await expect(readVaultEntry('zro', directory)).resolves.toMatchObject({ api_key: loads });
  await expect(readZroGrant(directory)).resolves.toMatchObject({ token: loads });
  await expect(new Zro({ directory }).available()).resolves.toBe(true);
  expect(run.runs.start).not.toHaveBeenCalled();
  // The next run finishes publishing without a signup.
  crash.mode = undefined;
  await expect(setup(() => {}, ['zro'], { directory, squire: run, exportToVault: true })).resolves.toEqual({});
  await expect(readZroGrant(directory)).resolves.toMatchObject({ token: 'working' });
  expect(run.runs.start).not.toHaveBeenCalled();
});

it('keeps a loadable Zro key when two overlapping setup runs publish different replacements and both stop partway', async () => {
  const { credentialFingerprint } = await import('./vault.js');
  const { readFile } = await import('node:fs/promises');
  const receiptNames = async (token: string) => (await readFile(join(directory, 'zro.json'), 'utf8')).includes(credentialFingerprint({ base_url: ZRO_ORIGIN, token }));
  // Run A waits before its vault write until run B has written its transition receipt
  // (or a short time passes, as when B is held off), then writes the vault and stops.
  crash.keys['working-a'] = { stop: 'after', wait: async () => {
    for (let i = 0; i < 30 && !await receiptNames('working-b'); i++) await new Promise(resolve => setTimeout(resolve, 10));
  } };
  crash.keys['working-b'] = { stop: 'before' };
  const runs = [squire('working-a'), squire('working-b')];
  const results = await Promise.allSettled(runs.map(run => setup(() => {}, ['zro'], { directory, squire: run, exportToVault: true })));
  expect(results.map(result => result.status)).toEqual(['rejected', 'rejected']);
  const vault = (await readVaultEntry('zro', directory))?.api_key;
  expect(await daemonKey()).toBe(vault);
  await expect(new Zro({ directory }).available()).resolves.toBe(true);
  for (const run of runs) expect(run.runs.start).not.toHaveBeenCalled();
});

it('never lets an interrupted replacement authorize a vault key that the old receipt did not verify', async () => {
  // The vault key and the receipt disagree, so the daemon already rejects the vault key.
  await writeVaultEntry('zro', { api_key: 'stale-vault', origin: ZRO_ORIGIN, source: 'local' }, directory);
  expect(await daemonKey()).toBeUndefined();
  crash.mode = 'before';
  await expect(setup(() => {}, ['zro'], { directory, squire: squire(), exportToVault: true })).rejects.toThrow();
  await expect(readVaultEntry('zro', directory)).resolves.toMatchObject({ api_key: 'stale-vault' });
  expect(await daemonKey()).toBeUndefined();
  // Finishing the replacement makes the verified key loadable.
  crash.mode = undefined;
  await expect(setup(() => {}, ['zro'], { directory, squire: squire(), exportToVault: true })).resolves.toEqual({});
  expect(await daemonKey()).toBe('working');
});
