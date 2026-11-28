import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type * as Vault from './vault.js';

// Stops setup at the moment it writes the replacement into the vault, as a crash would:
// the write either lands or not, and nothing after it runs.
const crash = vi.hoisted(() => ({ mode: undefined as undefined | 'before' | 'after' }));
vi.mock('./vault.js', async importOriginal => {
  const actual = await importOriginal<typeof Vault>();
  return {
    ...actual,
    writeVaultEntry: async (...args: Parameters<typeof actual.writeVaultEntry>) => {
      if (args[1].api_key === 'working' && crash.mode === 'before') throw new Error('setup stopped before the vault write');
      const written = await actual.writeVaultEntry(...args);
      if (args[1].api_key === 'working' && crash.mode === 'after') throw new Error('setup stopped after the vault write');
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
  crash.mode = undefined;
  await writeVaultEntry('zro', { api_key: 'vault-limited', origin: ZRO_ORIGIN, source: 'local' }, directory);
  await writeZroGrant({ base_url: ZRO_ORIGIN, token: 'vault-limited' }, directory);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) =>
    new Headers(init!.headers).get('authorization') === 'Bearer working'
      ? Response.json({ model: 'deepseek-v4.1-flash', choices: [{ message: { content: 'ready' } }] })
      : new Response(null, { status: 402 }));
});
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});
const squire = () => ({
  credentials: {
    list: async () => [{ service: 'zro', reference: 'vault://working', field_names: ['api_key'] }],
    grant: async () => ({ base_url: ZRO_ORIGIN, token: 'working' })
  },
  runs: { start: vi.fn(), get: vi.fn() },
  materializeDirectVaultGrant: vi.fn(async () => ({ base_url: ZRO_ORIGIN, token: 'working' }))
});

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
