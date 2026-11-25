import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { recordDataSharingConsent } from './data-sharing.js';
import { setupFallbacks } from './fallback-setup.js';
import { OPENROUTER_PARTICLE_MODEL } from './openrouter-particle.js';
import { setupOpenRouterParticle } from './openrouter-particle-setup.js';

let directory: string;
const notify = vi.fn();
const credential = (extra: Record<string, unknown> = {}) => ({ service: 'openrouter', label: 'Grunt Free', reference: 'vault://synthetic-grunt-free',
  allowed_hosts: ['openrouter.ai'], field_names: ['value'], ...extra });
function browser(rows: unknown[] = [credential()]) {
  return { call: vi.fn(async () => ({ credentials: rows })), signup: vi.fn(async () => {}),
    credentials: { list: vi.fn(async () => []), grant: vi.fn(async () => ({ base_url: 'https://trusty-squire-api.fly.dev/v1/egress/g_synthetic', token: 'synthetic-grant' })) } };
}
const transport = (patch: { price?: string; management?: boolean } = {}) => vi.fn<typeof fetch>(async url => String(url).endsWith('/key')
  ? Response.json({ data: { is_management_key: patch.management ?? false, is_provisioning_key: false, free_model_daily_requests: { used: 0, limit: 50, remaining: 50 } } })
  : Response.json({ data: { id: OPENROUTER_PARTICLE_MODEL, endpoints: [{ tag: 'particle-ai/us', model_id: OPENROUTER_PARTICLE_MODEL, status: 0, context_length: 1048576,
    max_prompt_tokens: null, pricing: { prompt: patch.price ?? '0', completion: '0' }, supported_parameters: ['tools', 'tool_choice', 'max_tokens'] }] } }));
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'openrouter-particle-setup-')); });
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await rm(directory, { recursive: true, force: true }); });

it('needs OpenRouter Particle’s own approval before any vault or browser access, and Kilo approval does not count', async () => {
  await recordDataSharingConsent(directory, ['kilo', 'reflection-beam']);
  const squire = browser();
  await expect(setupOpenRouterParticle({ directory, squire, notify, background: false })).rejects.toThrow('own data-sharing approval');
  expect(squire.call).not.toHaveBeenCalled();
  expect(squire.signup).not.toHaveBeenCalled();
});
it('reuses the Grunt Free key and stores only a private Squire grant', async () => {
  await recordDataSharingConsent(directory, ['openrouter-particle']);
  vi.stubGlobal('fetch', transport());
  const squire = browser();
  await setupOpenRouterParticle({ directory, squire, notify, background: false });
  expect(squire.call).toHaveBeenCalledWith('list_credentials', { service: 'openrouter', fields: 'summary' });
  expect(squire.signup).not.toHaveBeenCalled();
  expect((await stat(join(directory, 'openrouter-particle.json'))).mode & 0o777).toBe(0o600);
  expect(JSON.parse(await readFile(join(directory, 'openrouter-particle.json'), 'utf8'))).toMatchObject({ token: 'synthetic-grant' });
  expect(notify.mock.calls.flat().join(' ')).not.toContain('synthetic-grant');
});
it('never reuses another OpenRouter key, such as an application inference or management key', async () => {
  await recordDataSharingConsent(directory, ['openrouter-particle']);
  const squire = browser([credential({ label: 'app-live-inference', reference: 'vault://synthetic-app' }),
    credential({ label: 'Grunt Free', reference: 'vault://synthetic-wide', allowed_hosts: ['openrouter.ai', 'example.test'] })]);
  await expect(setupOpenRouterParticle({ directory, squire, notify, background: false })).rejects.toThrow('unambiguous');
  expect(squire.credentials.grant).not.toHaveBeenCalled();
  // Signup is asked to reuse the account, to add no money and to leave account settings alone.
  expect(squire.signup).toHaveBeenCalledWith('openrouter', 'https://openrouter.ai/settings/keys',
    expect.stringMatching(/Do not create another account, add a card, buy or top up credits[\s\S]*credit limit of 0[\s\S]*privacy or logging settings/));
});
it.each([[{ price: '0.00000007' }], [{ management: true }]])('does not persist a grant the free check refuses %j', async patch => {
  await recordDataSharingConsent(directory, ['openrouter-particle']);
  vi.stubGlobal('fetch', transport(patch));
  const squire = browser();
  await expect(setupOpenRouterParticle({ directory, squire, notify, background: false })).rejects.toThrow('could not be verified');
  await expect(stat(join(directory, 'openrouter-particle.json'))).rejects.toThrow();
});
it('reaches guarded setup through the real onboarding task map', async () => {
  await recordDataSharingConsent(directory, ['openrouter-particle']);
  vi.stubGlobal('fetch', transport());
  const squire = browser(), connect = vi.fn(async () => {}), settled = vi.fn();
  await expect(setupFallbacks({ directory, squire, adapters: ['openrouter-particle'], notify, connect, run: vi.fn(), onSettled: settled })).resolves.toEqual({ unavailable: [] });
  expect(squire.credentials.grant).toHaveBeenCalledWith('vault://synthetic-grunt-free');
  expect(settled).toHaveBeenCalledWith('openrouter-particle', true, undefined);
  expect((await stat(join(directory, 'openrouter-particle.json'))).mode & 0o777).toBe(0o600);
});
