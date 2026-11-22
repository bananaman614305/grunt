import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { APERTURE_HOST, APERTURE_ID, APERTURE_MODEL } from './aperture.js';
import { setupAperture } from './aperture-setup.js';
import { setupFallbacks } from './fallback-setup.js';
import { recordDataSharingConsent } from './data-sharing.js';

let directory: string;
const notify = vi.fn();
const credential = () => ({ service: APERTURE_ID, label: 'Grunt Free', reference: 'vault://synthetic-aperture', allowed_hosts: ['aperture-ai.run', APERTURE_HOST, '*.aperture-ai.run'], field_names: ['value'] });
function browser(rows = [credential()]) {
  return { call: vi.fn(async () => ({ credentials: rows })), signup: vi.fn(async () => {}),
    credentials: { list: vi.fn(async () => []), grant: vi.fn(async () => ({ base_url: 'https://trusty-squire-api.fly.dev/v1/egress/g_synthetic', token: 'synthetic-grant' })) } };
}
const transport = (plan = 'free') => vi.fn<typeof fetch>(async url => String(url).endsWith('/auth/me') ? Response.json({ valid: true, plan }) : Response.json({ data: [{ id: APERTURE_MODEL,
  context_length: 1024000, supported_parameters: ['tools'], pricing: { prompt: '0', completion: '0' }, expiration_date: null }] }));
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'aperture-setup-')); });
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); notify.mockClear(); await rm(directory, { recursive: true, force: true }); });
it('requires current provider consent before vault or browser access', async () => {
  const squire = browser();
  await expect(setupAperture({ directory, squire, notify, background: false })).rejects.toThrow('approval');
  expect(squire.call).not.toHaveBeenCalled();
  expect(squire.signup).not.toHaveBeenCalled();
});
it('reuses the scoped vault key and saves only a private verified grant', async () => {
  await recordDataSharingConsent(directory, [APERTURE_ID]);
  vi.stubGlobal('fetch', transport());
  const squire = browser();
  await setupAperture({ directory, squire, notify, background: false });
  expect(squire.call).toHaveBeenCalledWith('list_credentials', { service: APERTURE_ID, fields: 'summary' });
  expect(squire.signup).not.toHaveBeenCalled();
  expect((await stat(join(directory, `${APERTURE_ID}.json`))).mode & 0o777).toBe(0o600);
  expect(JSON.parse(await readFile(join(directory, `${APERTURE_ID}.json`), 'utf8')).token).toBe('synthetic-grant');
  expect(notify.mock.calls.flat().join(' ')).not.toContain('synthetic-grant');
});
it('looks up the vault in background mode as in foreground', async () => {
  await recordDataSharingConsent(directory, [APERTURE_ID]);
  vi.stubGlobal('fetch', transport());
  const squire = browser();
  await setupAperture({ directory, squire, notify, background: true });
  expect(squire.call).toHaveBeenCalledWith('list_credentials', { service: APERTURE_ID, fields: 'summary' });
  expect(squire.credentials.grant).toHaveBeenCalledWith('vault://synthetic-aperture');
});
it('routes default onboarding through guarded setup rather than throwing Unsupported vetted adapter', async () => {
  await recordDataSharingConsent(directory, [APERTURE_ID]);
  vi.stubGlobal('fetch', transport());
  const squire = browser(), settled = vi.fn(), connect = vi.fn(async () => {});
  await expect(setupFallbacks({ directory, squire, adapters: [APERTURE_ID], notify, connect, onSettled: settled, run: vi.fn() })).resolves.toEqual({ unavailable: [] });
  expect(settled).toHaveBeenCalledWith(APERTURE_ID, true, undefined);
  expect(squire.credentials.grant).toHaveBeenCalledWith('vault://synthetic-aperture');
  expect(connect).toHaveBeenCalledTimes(1);
});
it('keeps a working grant without reconnecting Squire during repeated setup', async () => {
  await recordDataSharingConsent(directory, [APERTURE_ID]);
  vi.stubGlobal('fetch', transport());
  const squire = browser();
  await setupAperture({ directory, squire, notify, background: false });
  squire.call.mockClear();
  const connect = vi.fn(async () => { throw new Error('Squire offline'); });
  await expect(setupFallbacks({ directory, squire, adapters: [APERTURE_ID], notify, connect, run: vi.fn() })).resolves.toEqual({ unavailable: [] });
  expect(squire.call).not.toHaveBeenCalled();
  expect(connect).not.toHaveBeenCalled();
});
it('uses the ordinary chat Dashboard capture path and stops if no scoped key results', async () => {
  await recordDataSharingConsent(directory, [APERTURE_ID]);
  const squire = browser([]);
  await expect(setupAperture({ directory, squire, notify, background: false })).rejects.toThrow('unambiguous');
  expect(squire.signup).toHaveBeenCalledWith(APERTURE_ID, 'https://www.aperture-ai.run/login.html', expect.stringContaining('open /chat.html'));
  expect(squire.signup.mock.calls[0]![2]).toContain('complete any verification the account requests');
  expect(squire.credentials.grant).not.toHaveBeenCalled();
});
it('does not save an unverifiable or paid account grant', async () => {
  await recordDataSharingConsent(directory, [APERTURE_ID]);
  vi.stubGlobal('fetch', transport('pro'));
  await expect(setupAperture({ directory, squire: browser(), notify, background: false })).rejects.toThrow('could not be verified');
  await expect(stat(join(directory, `${APERTURE_ID}.json`))).rejects.toThrow();
});
