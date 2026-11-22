import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { recordDataSharingConsent } from './data-sharing.js';
import { setupKenari } from './kenari-setup.js';
import { setupFallbacks } from './fallback-setup.js';
import { KENARI_FREE_MODEL } from './kenari.js';
import { planSteps } from './fixtures/key-only-goal.js';

let directory: string;
const notify = vi.fn();
const grant = { base_url: 'https://example.invalid/egress', token: 'synthetic' };
const metadata = { reference: 'vault://synthetic-kenari', service: 'kenari', label: 'Grunt Free',
  field_names: ['api_key'], allowed_hosts: ['kenari.id'] };
function squireClient() {
  return {
    call: vi.fn(async (_name: string, _args: Record<string, unknown>): Promise<Record<string, unknown>> => ({ credentials: [metadata] })),
    signup: vi.fn(async () => {}),
    credentials: { list: vi.fn(async () => []), grant: vi.fn(async (_reference: string) => grant) },
    runs: { start: async () => { throw new Error('Unexpected provisioning'); }, get: async () => { throw new Error('Unexpected provisioning'); } }
  };
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'grunt-kenari-setup-'));
  notify.mockClear();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/v1/usage')
    ? Response.json({ object: 'usage.summary' })
    : Response.json({ data: [{ id: KENARI_FREE_MODEL, context_length: 1_024_000, pricing: { free: true }, tool_call: true }] })));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(directory, { recursive: true, force: true });
});

it('keeps signup and grant requests behind current consent', async () => {
  const squire = squireClient();
  await expect(setupKenari({ directory, squire, notify })).rejects.toThrow('data-sharing approval');
  expect(squire.call).not.toHaveBeenCalled();
  expect(squire.signup).not.toHaveBeenCalled();
  expect(squire.credentials.grant).not.toHaveBeenCalled();
});

it('reuses a scoped credential and writes a private grant', async () => {
  const squire = squireClient();
  await recordDataSharingConsent(directory, ['kenari']);
  await setupKenari({ directory, squire, notify });
  expect(squire.call).toHaveBeenCalledExactlyOnceWith('list_credentials', { service: 'kenari', fields: 'summary' });
  expect(squire.credentials.grant).toHaveBeenCalledExactlyOnceWith(metadata.reference);
  expect(squire.signup).not.toHaveBeenCalled();
  const path = join(directory, 'kenari.json');
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(grant);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
});

it('accepts the extra hosts Squire stores after kenari.id', async () => {
  const squire = squireClient();
  squire.call.mockResolvedValueOnce({ credentials: [{ ...metadata, allowed_hosts: ['kenari.id', 'www.kenari.id'] }] });
  await recordDataSharingConsent(directory, ['kenari']);
  await setupKenari({ directory, squire, notify });
  expect(squire.credentials.grant).toHaveBeenCalledExactlyOnceWith(metadata.reference);
});

it('provisions once on the ordinary cold-start flow and grants only after scoped capture', async () => {
  const squire = squireClient();
  squire.call.mockResolvedValueOnce({ credentials: [] });
  await recordDataSharingConsent(directory, ['kenari']);
  await setupKenari({ directory, squire, notify });
  expect(squire.signup).toHaveBeenCalledExactlyOnceWith('kenari', 'https://kenari.id/login', expect.stringContaining(KENARI_FREE_MODEL));
  expect(planSteps(String((squire.signup.mock.calls[0] as unknown[])[2]))).toEqual([]);
  expect(squire.call).toHaveBeenCalledTimes(2);
  expect(squire.credentials.grant).toHaveBeenCalledExactlyOnceWith(metadata.reference);
});

it('uses the first of several credentials that passes the free check, in background as in foreground', async () => {
  const squire = squireClient();
  await recordDataSharingConsent(directory, ['kenari']);
  squire.call.mockResolvedValueOnce({ credentials: [metadata, { ...metadata, reference: 'vault://other-synthetic' }] });
  await setupKenari({ directory, squire, notify, background: true });
  expect(squire.signup).not.toHaveBeenCalled();
  expect(squire.credentials.grant).toHaveBeenCalledExactlyOnceWith(metadata.reference);
});

it.each([
  { allowed_hosts: ['example.invalid', 'kenari.id'] },
  { field_names: ['username', 'password'], auth_strategy: 'username_password' }
])('rejects a mismatched dedicated credential without minting a grant', async invalid => {
  const squire = squireClient();
  squire.call.mockResolvedValueOnce({ credentials: [{ ...metadata, ...invalid }] });
  await recordDataSharingConsent(directory, ['kenari']);
  await expect(setupKenari({ directory, squire, notify })).rejects.toThrow('kenari.id as its first host');
  expect(squire.signup).not.toHaveBeenCalled();
  expect(squire.credentials.grant).not.toHaveBeenCalled();
});

it('keeps a working free route available when Squire is offline during repeat setup', async () => {
  const squire = squireClient();
  const connect = vi.fn(async () => { throw new Error('Squire offline'); });
  await recordDataSharingConsent(directory, ['kenari']);
  await writeFile(join(directory, 'kenari.json'), JSON.stringify(grant), { mode: 0o600 });
  await expect(setupFallbacks({ directory, squire, adapters: ['kenari'], connect, notify,
    run: async () => { throw new Error('Unexpected install'); } })).resolves.toEqual({ unavailable: [] });
  expect(connect).not.toHaveBeenCalled();
  expect(squire.call).not.toHaveBeenCalled();
});
