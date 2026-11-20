import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { recordDataSharingConsent } from './data-sharing.js';
import { setupPromotionalApi } from './promotional-setup.js';
import { PROMOTIONAL_PROVIDERS } from './promotional-api.js';
import type { PromotionalProvider } from './promotional-api.js';

const now = Date.parse('2026-11-20T03:00:00Z');
let directory: string;
const notify = vi.fn();
beforeEach(async () => { vi.spyOn(Date, 'now').mockReturnValue(now); directory = await mkdtemp(join(tmpdir(), 'promotional-setup-')); });
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await rm(directory, { recursive: true, force: true }); });
function squire(id: PromotionalProvider) {
  return { call: vi.fn(async () => ({ credentials: [{ service: id, label: 'Grunt Free', reference: 'vault://synthetic-key',
    allowed_hosts: [PROMOTIONAL_PROVIDERS[id].host], field_names: ['value'] }] })), signup: vi.fn(async () => {}),
  credentials: { list: vi.fn(async () => []), grant: vi.fn(async () => ({ base_url: 'https://trusty-squire-api.fly.dev/v1/egress/g_synthetic', token: 'synthetic-grant' })) } };
}
it('requires foreground source consent before any signup or vault access', async () => {
  const browser = squire('fikra');
  await expect(setupPromotionalApi('fikra', { directory, squire: browser, notify, background: false })).rejects.toThrow('approval');
  expect(browser.call).not.toHaveBeenCalled();
  expect(browser.signup).not.toHaveBeenCalled();
});
it('does not start signup in background', async () => {
  await recordDataSharingConsent(directory, ['fikra']);
  const browser = squire('fikra');
  await expect(setupPromotionalApi('fikra', { directory, squire: browser, notify, background: true })).rejects.toThrow('foreground');
  expect(browser.call).not.toHaveBeenCalled();
  expect(browser.signup).not.toHaveBeenCalled();
});
it('reuses only a scoped credential and saves a private verified proxy grant', async () => {
  await recordDataSharingConsent(directory, ['fikra']);
  const browser = squire('fikra');
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async url => String(url).endsWith('/status.json')
    ? Response.json({ active: true, model_id: PROMOTIONAL_PROVIDERS.fikra.model, used_usd: 1, cap_usd: 1100, checked_at: new Date(now).toISOString(),
      expires_at: new Date(Date.now() + 86400000).toISOString(), tokens_used: 1, tokens_cap: 30000000000 })
    : Response.json({ data: [{ id: PROMOTIONAL_PROVIDERS.fikra.model, pricing: { unit: 'USD_PER_1M_TOKENS', input: 0, output: 0 }, context_window: 1048576 }] })));
  await setupPromotionalApi('fikra', { directory, squire: browser, notify, background: false });
  expect(browser.call).toHaveBeenCalledWith('list_credentials', { service: 'fikra', fields: 'summary' });
  expect(browser.signup).not.toHaveBeenCalled();
  expect((await stat(join(directory, 'fikra.json'))).mode & 0o777).toBe(0o600);
  expect(JSON.parse(await readFile(join(directory, 'fikra.json'), 'utf8')).token).toBe('synthetic-grant');
  expect(notify.mock.calls.flat().join(' ')).not.toContain('synthetic-grant');
});
it('stops when signup cannot produce an eligible key, without persisting a grant', async () => {
  await recordDataSharingConsent(directory, ['openference']);
  const browser = squire('openference');
  browser.call.mockResolvedValue({ credentials: [] });
  await expect(setupPromotionalApi('openference', { directory, squire: browser, notify, background: false })).rejects.toThrow('unambiguous');
  expect(browser.signup).toHaveBeenCalledWith('openference', 'https://openference.com/register', expect.stringContaining('Stop for human verification or CAPTCHA'));
  expect(browser.credentials.grant).not.toHaveBeenCalled();
  await expect(stat(join(directory, 'openference.json'))).rejects.toThrow();
});
