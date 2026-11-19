import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { recordDataSharingConsent } from './data-sharing.js';
import { setupNumes } from './numes-setup.js';
import { setupFallbacks } from './fallback-setup.js';
import { FREE_API_PROVIDERS } from './free-api.js';

const NUMES_FREE_MODEL = FREE_API_PROVIDERS.numes.model;

let directory: string;
const notify = vi.fn();
const grant = { base_url: 'https://example.invalid/egress', token: 'synthetic' };
const metadata = { reference: 'vault://synthetic-numes', service: 'numes', label: 'Grunt Free',
  field_names: ['api_key'], allowed_hosts: ['api.numes.ai','numes.ai','auth.numes.ai','*.numes.ai'] };
function squireClient() {
  return {
    call: vi.fn(async (_name: string, _args: Record<string, unknown>): Promise<Record<string, unknown>> => ({ credentials: [metadata] })),
    signup: vi.fn(async () => {}),
    credentials: { list: vi.fn(async () => []), grant: vi.fn(async (_reference: string) => grant) },
    runs: { start: async () => { throw new Error('Unexpected provisioning'); }, get: async () => { throw new Error('Unexpected provisioning'); } }
  };
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'grunt-numes-setup-'));
  notify.mockClear();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/api/v1/key')
    ? Response.json({ data: { disabled: false, is_management_key: false, limit: 0, limit_remaining: 0 } })
    : Response.json({ data: [{ id: NUMES_FREE_MODEL, context_length: 1_048_576, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] })));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(directory, { recursive: true, force: true });
});

it('keeps signup and grant requests behind current consent', async () => {
  const squire = squireClient();
  await expect(setupNumes({ directory, squire, notify })).rejects.toThrow('data-sharing approval');
  expect(squire.call).not.toHaveBeenCalled();
  expect(squire.signup).not.toHaveBeenCalled();
  expect(squire.credentials.grant).not.toHaveBeenCalled();
});

it('reuses a scoped credential and writes a private grant', async () => {
  const squire = squireClient();
  await recordDataSharingConsent(directory, ['numes']);
  await setupNumes({ directory, squire, notify });
  expect(squire.call).toHaveBeenCalledExactlyOnceWith('list_credentials', { service: 'numes', fields: 'summary' });
  expect(squire.credentials.grant).toHaveBeenCalledExactlyOnceWith(metadata.reference);
  expect(squire.signup).not.toHaveBeenCalled();
  const path = join(directory, 'numes.json');
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(grant);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
});

it('provisions once on the ordinary cold-start flow and grants only after scoped capture', async () => {
  const squire = squireClient();
  squire.call.mockResolvedValueOnce({ credentials: [] });
  await recordDataSharingConsent(directory, ['numes']);
  await setupNumes({ directory, squire, notify });
  expect(squire.signup).toHaveBeenCalledExactlyOnceWith('numes', 'https://numes.ai/dashboard', expect.stringContaining(NUMES_FREE_MODEL));
  expect(squire.call).toHaveBeenCalledTimes(2);
  expect(squire.credentials.grant).toHaveBeenCalledExactlyOnceWith(metadata.reference);
});

it('rejects ambiguous credentials and defers background setup without browser actions', async () => {
  const squire = squireClient();
  await recordDataSharingConsent(directory, ['numes']);
  await expect(setupNumes({ directory, squire, notify, background: true })).rejects.toThrow('foreground setup');
  expect(squire.call).not.toHaveBeenCalled();
  squire.call.mockResolvedValueOnce({ credentials: [metadata, { ...metadata, reference: 'vault://other-synthetic' }] });
  await expect(setupNumes({ directory, squire, notify })).rejects.toThrow('unambiguous');
  expect(squire.signup).not.toHaveBeenCalled();
  expect(squire.credentials.grant).not.toHaveBeenCalled();
});

it.each([
  { allowed_hosts: ['api.numes.ai', 'example.invalid'] },
  { field_names: ['username', 'password'], auth_strategy: 'username_password' }
])('rejects a mismatched dedicated credential without minting a grant', async invalid => {
  const squire = squireClient();
  squire.call.mockResolvedValueOnce({ credentials: [{ ...metadata, ...invalid }] });
  await recordDataSharingConsent(directory, ['numes']);
  await expect(setupNumes({ directory, squire, notify })).rejects.toThrow('scoped to api.numes.ai');
  expect(squire.signup).not.toHaveBeenCalled();
  expect(squire.credentials.grant).not.toHaveBeenCalled();
});

it('keeps a working free route available when Squire is offline during repeat setup', async () => {
  const squire = squireClient();
  const connect = vi.fn(async () => { throw new Error('Squire offline'); });
  await recordDataSharingConsent(directory, ['numes']);
  await writeFile(join(directory, 'numes.json'), JSON.stringify(grant), { mode: 0o600 });
  await expect(setupFallbacks({ directory, squire, adapters: ['numes'], connect, notify,
    run: async () => { throw new Error('Unexpected install'); } })).resolves.toEqual({ unavailable: [] });
  expect(connect).not.toHaveBeenCalled();
  expect(squire.call).not.toHaveBeenCalled();
});
