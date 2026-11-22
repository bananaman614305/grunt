import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { recordDataSharingConsent } from './data-sharing.js';
import { DARUS_HOST, DARUS_MODEL } from './darus.js';
import { setupDarus } from './darus-setup.js';
import { setupFallbacks } from './fallback-setup.js';

let directory: string;
const notify = vi.fn();
const credential = () => ({ service: 'darus', label: 'Grunt Free', reference: 'vault://synthetic-darus',
  allowed_hosts: [DARUS_HOST, '*.darusalfatah.id'], field_names: ['value'] });
function browser(rows = [credential()]) {
  return { call: vi.fn(async () => ({ credentials: rows })), signup: vi.fn(async () => {}),
    credentials: { list: vi.fn(async () => []), grant: vi.fn(async () => ({ base_url: 'https://trusty-squire-api.fly.dev/v1/egress/g_synthetic', token: 'synthetic-grant' })) } };
}
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'darus-setup-')); });
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await rm(directory, { recursive: true, force: true }); });
const transport = (protectBalance = true) => vi.fn<typeof fetch>(async url => String(url).endsWith('/v1/models')
  ? Response.json({ data: [{ id: DARUS_MODEL, free: true, owned_by: 'Darus Gateway' }] })
  : Response.json({ status: { eligible: true, protectBalance, day: new Date().toISOString().slice(0, 10), allowance: 10000000,
    used: 0, remaining: 10000000, balance: 0, multiplier: 1, tier: { key: 'FREE', tpd: 10000000, minBalance: 0 } } }));

it('requires provider approval before vault or browser access', async () => {
  const squire = browser();
  await expect(setupDarus({ directory, squire, notify, background: false })).rejects.toThrow('approval');
  expect(squire.call).not.toHaveBeenCalled();
  expect(squire.signup).not.toHaveBeenCalled();
});
it('looks up the vault in the background as in foreground', async () => {
  await recordDataSharingConsent(directory, ['darus']);
  vi.stubGlobal('fetch', transport());
  const squire = browser();
  await setupDarus({ directory, squire, notify, background: true });
  expect(squire.call).toHaveBeenCalledWith('list_credentials', { service: 'darus', fields: 'summary' });
});
it.each(['Grunt Free', 'personal-free'])('reuses the existing scoped %s key and stores only a private Squire grant', async label => {
  await recordDataSharingConsent(directory, ['darus']);
  vi.stubGlobal('fetch', transport());
  const squire = browser([{ ...credential(), label }]);
  await setupDarus({ directory, squire, notify, background: false });
  expect(squire.call).toHaveBeenCalledWith('list_credentials', { service: 'darus', fields: 'summary' });
  expect(squire.signup).not.toHaveBeenCalled();
  expect((await stat(join(directory, 'darus.json'))).mode & 0o777).toBe(0o600);
  expect(JSON.parse(await readFile(join(directory, 'darus.json'), 'utf8'))).toMatchObject({ token: 'synthetic-grant' });
  expect(notify.mock.calls.flat().join(' ')).not.toContain('synthetic-grant');
});
it('refuses a key scoped to unrelated hosts and cannot silently replace it', async () => {
  await recordDataSharingConsent(directory, ['darus']);
  const squire = browser([{ ...credential(), allowed_hosts: [DARUS_HOST, 'example.test'] }]);
  await expect(setupDarus({ directory, squire, notify, background: false })).rejects.toThrow('unambiguous');
  expect(squire.credentials.grant).not.toHaveBeenCalled();
  expect(squire.signup).toHaveBeenCalledWith('darus', `https://${DARUS_HOST}/`, expect.stringContaining('Simpan Saldo'));
});
it('does not persist or activate a grant when Protect Balance is off', async () => {
  await recordDataSharingConsent(directory, ['darus']);
  vi.stubGlobal('fetch', transport(false));
  const squire = browser();
  await expect(setupDarus({ directory, squire, notify, background: false })).rejects.toThrow('entitlement');
  await expect(stat(join(directory, 'darus.json'))).rejects.toThrow();
});
it('reaches guarded Darus setup through the real default onboarding task map', async () => {
  await recordDataSharingConsent(directory, ['darus']);
  vi.stubGlobal('fetch', transport());
  const squire = browser(), connect = vi.fn(async () => {}), settled = vi.fn();
  await expect(setupFallbacks({ directory, squire, adapters: ['darus'], notify, connect, run: vi.fn(), onSettled: settled })).resolves.toEqual({ unavailable: [] });
  expect(squire.call).toHaveBeenCalledWith('list_credentials', { service: 'darus', fields: 'summary' });
  expect(squire.credentials.grant).toHaveBeenCalledWith('vault://synthetic-darus');
  expect(settled).toHaveBeenCalledWith('darus', true, undefined);
  expect(connect).toHaveBeenCalledTimes(1);
  expect((await stat(join(directory, 'darus.json'))).mode & 0o777).toBe(0o600);
});
