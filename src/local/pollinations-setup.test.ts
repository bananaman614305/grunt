import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { setupPollinations } from './pollinations-setup.js';
import type { PollinationsSetupSquire } from './pollinations-setup.js';
import { POLLINATIONS_MODEL, pollinationsGrantPath, readPollinationsGrant, writePollinationsGrant } from './pollinations.js';
import { recordDataSharingConsent } from './data-sharing.js';

let directory: string;
const grant = { base_url: 'https://trusty-squire-api.fly.dev/v1/egress/g_abcdefghijklmnop', token: 'synthetic-private-grant' };
const saved = () => ({ version: 1 as const, ...grant, upstream_origin: 'https://gen.pollinations.ai' as const, model: POLLINATIONS_MODEL,
  verified_at: new Date().toISOString(), free_account_verified: true as const, key_zero_budget_verified: true as const, quest_pollen_only: true as const });
const credential = { service: 'pollinations', reference: 'vault://pollinations-free', field_names: ['api_key'], label: 'grunt-free-pollinations', auth_strategy: 'api_key', allowed_hosts: ['gen.pollinations.ai', 'enter.pollinations.ai', '*.pollinations.ai'] };
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'grunt-pollinations-setup-')); });
afterEach(async () => { vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }); });
function metadata(options: { paid?: number; budget?: number | null; account?: string[]; price?: boolean } = {}) {
  return vi.fn<typeof fetch>(async (input, init) => {
    expect(init?.method ?? 'GET').toBe('GET');
    expect(String(input)).toContain(grant.base_url);
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/account/key')) return Response.json({ valid: true, type: 'secret', expiresAt: null,
      pollenBudget: options.budget === undefined ? 0 : options.budget, questPollenOnly: true,
      permissions: { models: null, account: options.account ?? ['usage'] } });
    if (path.endsWith('/account/balance')) return Response.json({ balance: 0, accountBalance: { total: 0.25, tier: 0.25, paid: options.paid ?? 0 } });
    if (path.endsWith(`/v1/models/${POLLINATIONS_MODEL}`)) return Response.json({ id: POLLINATIONS_MODEL, object: 'model', owned_by: 'OSAII',
      category: 'text', community: true, paid_only: false, pricing: options.price ? { currency: 'pollen', promptText: 0.1 } : { currency: 'pollen' }, supported_endpoints: ['/v1/chat/completions'] });
    throw new Error('Unexpected endpoint; setup must not invoke inference or billing');
  });
}
function squire(existing = false) {
  let complete = false;
  return {
    approveDataSharing: vi.fn(),
    signup: vi.fn(async () => { complete = true; }),
    credentials: {
      list: vi.fn(async () => existing || complete ? [credential] : []),
      grant: vi.fn(async () => grant)
    }
  } satisfies PollinationsSetupSquire;
}

it('captures new private access after consent, verifies server guards, and reuses it without another signup', async () => {
  await recordDataSharingConsent(directory, ['pollinations', 'kilo']);
  const browser = squire(), fetcher = metadata(), notify = vi.fn();
  await setupPollinations({ directory, squire: browser, fetcher, notify });
  expect(browser.signup).toHaveBeenCalledOnce();
  const [provider, url, goal] = browser.signup.mock.calls[0] as unknown as [string, string, string];
  expect([provider, url]).toEqual(['pollinations', 'https://enter.pollinations.ai/keys']);
  expect(goal).toContain('budget must be exactly 0'); expect(goal).toContain('Quest Pollen Only must be enabled');
  expect(goal).toContain('account permissions must be usage only'); expect(goal).toContain('operate_extract');
  expect(goal).toContain('never return or display the key');
  expect(browser.approveDataSharing).toHaveBeenCalledWith(['kilo', 'pollinations']);
  expect(browser.credentials.list).toHaveBeenCalledTimes(2);
  expect(browser.credentials.grant).toHaveBeenCalledWith(credential.reference);
  expect((await stat(pollinationsGrantPath(directory))).mode & 0o777).toBe(0o600);
  expect(await readPollinationsGrant(directory)).toMatchObject({ model: POLLINATIONS_MODEL, key_zero_budget_verified: true, quest_pollen_only: true });
  expect(JSON.stringify(notify.mock.calls)).not.toContain(grant.token);
  browser.signup.mockClear(); browser.credentials.list.mockClear(); browser.credentials.grant.mockClear(); fetcher.mockClear();
  await setupPollinations({ directory, squire: browser, fetcher, notify });
  expect(browser.signup).not.toHaveBeenCalled(); expect(browser.credentials.list).not.toHaveBeenCalled(); expect(browser.credentials.grant).not.toHaveBeenCalled();
  expect(fetcher).toHaveBeenCalledTimes(3);
});

it('verifies a reused vault key through ordinary signup before writing a fresh local receipt', async () => {
  await recordDataSharingConsent(directory, ['pollinations']);
  const browser = squire(true);
  await setupPollinations({ directory, squire: browser, fetcher: metadata() });
  expect(browser.signup).toHaveBeenCalledOnce();
  expect(browser.signup.mock.invocationCallOrder[0]).toBeLessThan(browser.credentials.grant.mock.invocationCallOrder[0]!);
  expect(browser.credentials.grant).toHaveBeenCalledTimes(1);
});

it('refreshes vault metadata and prefers a newly captured key over an older credential with the same label', async () => {
  const browser = squire();
  const old = { ...credential, reference: 'vault://old-unrelated' };
  browser.credentials.list.mockResolvedValueOnce([old]).mockResolvedValueOnce([old, credential]);
  await setupPollinations({ directory, squire: browser, dataSharingApproved: ['pollinations'], fetcher: metadata() });
  expect(browser.credentials.grant).toHaveBeenCalledWith(credential.reference);
});

it.each([
  { allowed_hosts: undefined }, { allowed_hosts: [] }, { allowed_hosts: ['*.pollinations.ai'] },
  { allowed_hosts: ['enter.pollinations.ai', 'gen.pollinations.ai'] }, { allowed_hosts: ['unrelated.example', 'gen.pollinations.ai'] },
  { allowed_hosts: ['https://gen.pollinations.ai'] }, { auth_strategy: 'username_password' }, { auth_strategy: 'oauth' },
  { field_names: ['username', 'password'] }
])('rejects mismatched upstream or non-key credential metadata before requesting a grant (%j)', async invalid => {
  const browser = squire(true), fetcher = metadata();
  browser.credentials.list.mockResolvedValue([{ ...credential, ...invalid }] as typeof credential[]);
  await expect(setupPollinations({ directory, squire: browser, dataSharingApproved: ['pollinations'], fetcher })).rejects.toThrow('free signup or key guard verification did not complete');
  expect(browser.credentials.grant).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  await expect(stat(pollinationsGrantPath(directory))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('skips a newly captured wrong-host credential instead of granting it ahead of verified API metadata', async () => {
  const browser = squire(true), wrongHost = { ...credential, reference: 'vault://wrong-upstream', allowed_hosts: ['enter.pollinations.ai', 'gen.pollinations.ai'] };
  browser.credentials.list.mockResolvedValueOnce([credential]).mockResolvedValueOnce([wrongHost, credential]);
  await setupPollinations({ directory, squire: browser, dataSharingApproved: ['pollinations'], fetcher: metadata() });
  expect(browser.credentials.grant).toHaveBeenCalledOnce(); expect(browser.credentials.grant).toHaveBeenCalledWith(credential.reference);
});

it('requires current grouped approval before any browser, grant, or network work', async () => {
  const browser = squire(), fetcher = metadata();
  await expect(setupPollinations({ directory, squire: browser, fetcher })).rejects.toThrow('grouped setup approval');
  expect(browser.signup).not.toHaveBeenCalled(); expect(browser.credentials.list).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
});

it.each([{ paid: 1 }, { budget: null }, { account: ['usage', 'keys'] }, { price: true }])('does not persist access when ordinary signup completes but free-key guards fail (%j)', async invalid => {
  await recordDataSharingConsent(directory, ['pollinations']);
  await writePollinationsGrant(saved(), directory);
  const browser = squire(true), fetcher = metadata(invalid);
  browser.signup.mockImplementation(async () => {
    await expect(stat(pollinationsGrantPath(directory))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  await expect(setupPollinations({ directory, squire: browser, fetcher })).rejects.toThrow('free signup or key guard verification did not complete');
  await expect(stat(pollinationsGrantPath(directory))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('invalidates an older receipt and sanitizes provider refusal without exposing grant or error secrets', async () => {
  await recordDataSharingConsent(directory, ['pollinations']);
  await writeFile(pollinationsGrantPath(directory), JSON.stringify({ ...saved(), verified_at: new Date(Date.now() - 31 * 86400000).toISOString() }), { mode: 0o600 });
  const browser = squire(true), notify = vi.fn();
  browser.signup.mockRejectedValue(new Error(`Bearer ${grant.token} sk-private-provider-key`));
  const error = await setupPollinations({ directory, squire: browser, fetcher: metadata(), notify }).then(() => null, reason => reason as Error);
  expect(error?.message).toBe('Pollinations free signup or key guard verification did not complete; rerun usegrunt setup');
  expect(JSON.stringify(notify.mock.calls)).not.toContain(grant.token);
  expect(error?.message).not.toContain('sk-private');
  await expect(stat(pollinationsGrantPath(directory))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('cancels a pending Squire promise and leaves no free-access receipt', async () => {
  const browser = squire();
  browser.signup.mockImplementation(async () => { await new Promise<void>(() => {}); });
  const controller = new AbortController();
  const pending = setupPollinations({ directory, squire: browser, dataSharingApproved: ['pollinations'], signal: controller.signal, fetcher: metadata() });
  const rejected = expect(pending).rejects.toThrow('free signup or key guard verification did not complete');
  await vi.waitFor(() => expect(browser.signup).toHaveBeenCalledOnce());
  controller.abort(new Error('sk-never-display-cancel-reason'));
  await rejected;
  await expect(stat(pollinationsGrantPath(directory))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('sanitizes an already cancelled setup before starting external work', async () => {
  const browser = squire(), fetcher = metadata(), controller = new AbortController();
  controller.abort(new Error('sk-private-cancellation-reason'));
  await expect(setupPollinations({ directory, squire: browser, dataSharingApproved: ['pollinations'], signal: controller.signal, fetcher })).rejects.toThrow('free signup or key guard verification did not complete');
  expect(browser.signup).not.toHaveBeenCalled(); expect(browser.credentials.list).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
});

it('enforces a signup deadline even if Squire never resolves its promise', async () => {
  const realTimeout = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: (...args: unknown[]) => void, milliseconds?: number, ...args: unknown[]) => realTimeout(callback, milliseconds === 600000 ? 100 : milliseconds, ...args)) as typeof setTimeout);
  const browser = squire();
  browser.signup.mockImplementation(async () => { await new Promise<void>(() => {}); });
  await expect(setupPollinations({ directory, squire: browser, dataSharingApproved: ['pollinations'], fetcher: metadata() })).rejects.toThrow('free signup or key guard verification did not complete');
  expect(browser.signup).toHaveBeenCalledOnce();
});

it('persists only the scoped backend grant and declared verification facts', async () => {
  const browser = squire();
  await setupPollinations({ directory, squire: browser, dataSharingApproved: ['pollinations'], fetcher: metadata() });
  const value = JSON.parse(await readFile(pollinationsGrantPath(directory), 'utf8'));
  expect(Object.keys(value).sort()).toEqual(['base_url', 'free_account_verified', 'key_zero_budget_verified', 'model', 'quest_pollen_only', 'token', 'upstream_origin', 'verified_at', 'version']);
  expect(value.base_url).toBe(grant.base_url);
});

it('verifies valid background access without changing receipts, approving Squire sharing, or contacting its vault/browser', async () => {
  await recordDataSharingConsent(directory, ['pollinations']); await writePollinationsGrant(saved(), directory);
  const file = pollinationsGrantPath(directory), before = await readFile(file), beforeStat = await stat(file);
  const consent = await readFile(join(directory, 'data-sharing-consent.json')), browser = squire(), fetcher = metadata();
  await setupPollinations({ directory, squire: browser, fetcher, background: true });
  expect(fetcher).toHaveBeenCalledTimes(3); expect(await readFile(file)).toEqual(before); expect((await stat(file)).mtimeMs).toBe(beforeStat.mtimeMs);
  expect(await readFile(join(directory, 'data-sharing-consent.json'))).toEqual(consent);
  expect(browser.approveDataSharing).not.toHaveBeenCalled(); expect(browser.signup).not.toHaveBeenCalled(); expect(browser.credentials.list).not.toHaveBeenCalled(); expect(browser.credentials.grant).not.toHaveBeenCalled();
});

it.each(['guard-failure', 'expired-receipt', 'missing-receipt'])('requires foreground setup without deleting or recreating background state on %s', async mode => {
  await recordDataSharingConsent(directory, ['pollinations']);
  const file = pollinationsGrantPath(directory);
  if (mode !== 'missing-receipt') await writeFile(file, JSON.stringify({ ...saved(), ...(mode === 'expired-receipt' ? { verified_at: new Date(Date.now()-31*86400000).toISOString() } : {}) }), { mode: 0o600 });
  const before = mode === 'missing-receipt' ? undefined : await readFile(file), consent = await readFile(join(directory, 'data-sharing-consent.json'));
  const browser = squire(), fetcher = metadata({ paid: 1 });
  await expect(setupPollinations({ directory, squire: browser, fetcher, background: true })).rejects.toThrow('needs foreground setup');
  if (before) expect(await readFile(file)).toEqual(before); else await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(join(directory, 'data-sharing-consent.json'))).toEqual(consent);
  expect(browser.approveDataSharing).not.toHaveBeenCalled(); expect(browser.signup).not.toHaveBeenCalled(); expect(browser.credentials.list).not.toHaveBeenCalled(); expect(browser.credentials.grant).not.toHaveBeenCalled();
  if (mode !== 'guard-failure') expect(fetcher).not.toHaveBeenCalled();
});

it.each(['pre-aborted', 'in-flight'])('cancels a %s background check without revoking its saved grant or approving/minting/browser operations', async mode => {
  await recordDataSharingConsent(directory, ['pollinations']); await writePollinationsGrant(saved(), directory);
  const file = pollinationsGrantPath(directory), before = await readFile(file), browser = squire(), controller = new AbortController();
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => new Promise((_resolve, reject) => { init?.signal?.addEventListener('abort', () => reject(new Error('private network diagnostic')), { once: true }); }));
  if (mode === 'pre-aborted') controller.abort(new Error('private cancellation reason'));
  const pending = setupPollinations({ directory, squire: browser, fetcher, signal: controller.signal, background: true });
  const rejected = expect(pending).rejects.toThrow('needs foreground setup');
  if (mode === 'in-flight') { await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3)); controller.abort(new Error('private cancellation reason')); }
  await rejected; expect(fetcher).toHaveBeenCalledTimes(mode === 'in-flight' ? 3 : 0);
  expect(await readFile(file)).toEqual(before); expect(browser.approveDataSharing).not.toHaveBeenCalled(); expect(browser.signup).not.toHaveBeenCalled(); expect(browser.credentials.list).not.toHaveBeenCalled(); expect(browser.credentials.grant).not.toHaveBeenCalled();
});

it('does not inherit stale passed approval or contact Squire when background stored consent is missing', async () => {
  await writePollinationsGrant(saved(), directory); const before = await readFile(pollinationsGrantPath(directory)), browser = squire(), fetcher = metadata();
  await expect(setupPollinations({ directory, squire: browser, fetcher, background: true, dataSharingApproved: ['pollinations'] })).rejects.toThrow('needs foreground setup');
  expect(await readFile(pollinationsGrantPath(directory))).toEqual(before); expect(fetcher).not.toHaveBeenCalled(); expect(browser.approveDataSharing).not.toHaveBeenCalled(); expect(browser.signup).not.toHaveBeenCalled(); expect(browser.credentials.list).not.toHaveBeenCalled(); expect(browser.credentials.grant).not.toHaveBeenCalled();
});
