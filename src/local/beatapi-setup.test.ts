import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setupBeatAPI } from './beatapi-setup.js';
import { BEATAPI_MODEL, BEATAPI_MODELS, BEATAPI_ORIGIN, beatapiGrantPath, readBeatAPIGrant, writeBeatAPIGrant } from './beatapi.js';
import { recordDataSharingConsent } from './data-sharing.js';
import { planSteps } from './fixtures/key-only-goal.js';
let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'grunt-beatapi-setup-test-')); await recordDataSharingConsent(directory, ['beatapi']); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
const credential = { service: 'beatapi', label: 'grunt', reference: 'vault://synthetic-beatapi', field_names: ['value'], allowed_hosts: ['api.beatapi.io'] };
const modelList = (ids: readonly string[] = BEATAPI_MODELS) => Response.json({ data: ids.map(id => ({ id })) });
const freeUsage = () => Response.json({ data: { object: 'usage', credit_balance: 2, credits_settled: 0 } });
function fixture() {
  const squire = { signup: vi.fn(async () => {}), call: vi.fn(async () => ({ credentials: [credential] })), credentials: { list: vi.fn(async () => []), grant: vi.fn(async () => ({ base_url: 'https://trusty-squire-api.fly.dev/v1/egress/g_abcdefghijklmnop', token: 'synthetic-secret-grant' })) }, approveDataSharing: vi.fn() };
  const fetcher = vi.fn(async (input: Parameters<typeof fetch>[0]) => String(input).endsWith('/v1/models') ? modelList() : freeUsage());
  return { squire, fetcher };
}
it('reuses fresh vault metadata after browser free-account/key verification', async () => {
  const f = fixture(); await setupBeatAPI({ directory, ...f }); expect(f.squire.call).toHaveBeenCalledTimes(2); expect(f.squire.credentials.list).not.toHaveBeenCalled(); expect(f.squire.credentials.grant).toHaveBeenCalledExactlyOnceWith(credential.reference);
  expect(f.squire.signup).toHaveBeenCalledWith('beatapi', 'https://beatapi.io/dashboard/apikeys', expect.stringContaining('Go straight to API keys; do not open Credits & billing'));
  expect(planSteps(String((f.squire.signup.mock.calls[0] as unknown[])[2]))).toEqual([]);
  expect(f.squire.signup).toHaveBeenCalledWith('beatapi', 'https://beatapi.io/dashboard/apikeys', expect.stringContaining(`Usage restrictions to allow exactly ${BEATAPI_MODELS.join(' and ')}`));
  expect((await readBeatAPIGrant(directory))).toMatchObject({ version: 2, lifetime_paid: 0, baseline_balance: 2, credit_provenance: 'signup', model: BEATAPI_MODEL, models: BEATAPI_MODELS });
  expect(f.fetcher.mock.calls.map(([url]) => String(url).split('/').at(-1))).toEqual(['usage', 'models']);
});
it('stores a newly captured key when none existed', async () => {
  const f = fixture(); f.squire.call.mockResolvedValueOnce({ credentials: [] }); await setupBeatAPI({ directory, ...f }); expect(f.squire.credentials.grant).toHaveBeenCalledWith(credential.reference);
});
it('provisions a new DeepSeek-only receipt when GLM is unavailable', async () => {
  const f = fixture(), notify = vi.fn();
  f.fetcher.mockResolvedValueOnce(freeUsage()).mockResolvedValueOnce(modelList([BEATAPI_MODEL]));
  await setupBeatAPI({ directory, ...f, notify });
  expect(await readBeatAPIGrant(directory)).toMatchObject({ version: 1, model: BEATAPI_MODEL });
  expect(await readBeatAPIGrant(directory)).not.toHaveProperty('models');
  expect(notify).toHaveBeenCalledWith(expect.stringContaining('GLM 5.3 Flash is unavailable'));
});
it('refuses an unlabeled or substituted capture', async () => {
  const f = fixture(); f.squire.call.mockResolvedValueOnce({ credentials: [] }).mockResolvedValueOnce({ credentials: [{ ...credential, label: 'personal' }] });
  await expect(setupBeatAPI({ directory, ...f })).rejects.toThrow('verification did not complete');
  f.squire.call.mockResolvedValueOnce({ credentials: [credential] }).mockResolvedValueOnce({ credentials: [{ ...credential, reference: 'vault://other-beatapi' }] });
  await expect(setupBeatAPI({ directory, ...f })).rejects.toThrow('verification did not complete');
  expect(f.squire.credentials.grant).not.toHaveBeenCalled();
});
it('refuses a new receipt if the captured key can reach another model', async () => {
  const f = fixture(); f.fetcher.mockImplementation(async input => String(input).endsWith('/v1/models')
    ? modelList([...BEATAPI_MODELS, 'paid-model']) : freeUsage());
  await expect(setupBeatAPI({ directory, ...f })).rejects.toThrow('verification did not complete');
  await expect(readBeatAPIGrant(directory)).rejects.toBeDefined();
});
it('blocks before signup without current consent', async () => {
  const f = fixture(); await rm(join(directory, 'data-sharing-consent.json')); await expect(setupBeatAPI({ directory, ...f, dataSharingApproved: ['beatapi'] })).rejects.toThrow('current grouped'); expect(f.squire.signup).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled();
});
it('invalidates old eligibility when fresh signup is refused and never leaks browser errors', async () => {
  const f = fixture(); await writeFile(beatapiGrantPath(directory), 'old-receipt', { mode: 0o600 }); f.squire.signup.mockRejectedValueOnce(new Error('sk-browser-secret'));
  await expect(setupBeatAPI({ directory, ...f })).rejects.toThrow('BeatAPI free account or key verification did not complete'); await expect(readBeatAPIGrant(directory)).rejects.toBeDefined(); expect(f.squire.credentials.grant).not.toHaveBeenCalled();
});
it('rejects changed account usage and removes an old receipt', async () => {
  const f = fixture(); f.fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ data: { object: 'usage', credit_balance: 12, credits_settled: 0 } })));
  await expect(setupBeatAPI({ directory, ...f })).rejects.toThrow('verification did not complete'); await expect(readBeatAPIGrant(directory)).rejects.toBeDefined();
});
it('cancels a stalled signup and leaves no eligible receipt', async () => {
  const f = fixture(), controller = new AbortController(); f.squire.signup.mockImplementationOnce(async () => new Promise(() => {})); const pending = setupBeatAPI({ directory, ...f, signal: controller.signal }); await vi.waitFor(() => expect(f.squire.signup).toHaveBeenCalled()); controller.abort('sk-cancel-secret'); await expect(pending).rejects.toThrow('verification did not complete'); await expect(readBeatAPIGrant(directory)).rejects.toBeDefined();
});
it('accepts the provider-domain hosts Squire adds when the drive stores the key', async () => {
  const f = fixture(); f.squire.call.mockResolvedValue({ credentials: [{ ...credential, allowed_hosts: ['api.beatapi.io', 'beatapi.io', '*.beatapi.io'] }] });
  await setupBeatAPI({ directory, ...f }); expect(f.squire.credentials.grant).toHaveBeenCalledWith(credential.reference);
});
it('refuses a stored key that also allows a host outside the provider domain', async () => {
  const f = fixture(); f.squire.call.mockResolvedValue({ credentials: [{ ...credential, allowed_hosts: ['api.beatapi.io', 'unrelated.example'] }] });
  await expect(setupBeatAPI({ directory, ...f })).rejects.toThrow('verification did not complete'); expect(f.squire.credentials.grant).not.toHaveBeenCalled();
});
it('refuses a key whose first allowed host could route the grant elsewhere', async () => {
  const f = fixture(); f.squire.call.mockResolvedValue({ credentials: [{ ...credential, allowed_hosts: ['beatapi.io', 'api.beatapi.io'] }] }); await expect(setupBeatAPI({ directory, ...f })).rejects.toThrow('verification did not complete'); expect(f.squire.credentials.grant).not.toHaveBeenCalled();
});

async function savedReceipt() {
  await writeBeatAPIGrant({ version: 1, base_url: 'https://trusty-squire-api.fly.dev/v1/egress/g_abcdefghijklmnop', token: 'synthetic-secret-grant', upstream_origin: BEATAPI_ORIGIN,
    model: BEATAPI_MODEL, verified_at: new Date().toISOString(), free_account_verified: true, lifetime_paid: 0, payment_method_present: false, auto_recharge: false,
    credit_provenance: 'signup', baseline_balance: 2 }, directory);
  return readFile(beatapiGrantPath(directory), 'utf8');
}
function noProvisioning(f: ReturnType<typeof fixture>) {
  expect(f.squire.signup).not.toHaveBeenCalled(); expect(f.squire.call).not.toHaveBeenCalled(); expect(f.squire.credentials.list).not.toHaveBeenCalled();
  expect(f.squire.credentials.grant).not.toHaveBeenCalled(); expect(f.squire.approveDataSharing).not.toHaveBeenCalled();
}
it.each([false, true])('reuses a healthy saved grant with no browser or vault operations (background=%s)', async background => {
  const original = await savedReceipt(), f = fixture(); await setupBeatAPI({ directory, ...f, background });
  noProvisioning(f); expect(f.fetcher).toHaveBeenCalledTimes(1); expect(await readFile(beatapiGrantPath(directory), 'utf8')).toBe(original);
});
it('migrates explicit legacy setup without browser or vault operations after an exact key model check', async () => {
  await savedReceipt();
  const original = await readBeatAPIGrant(directory), f = fixture();
  await setupBeatAPI({ directory, ...f, upgradeExisting: true });
  noProvisioning(f);
  expect((await readBeatAPIGrant(directory))).toMatchObject({ version: 2, models: BEATAPI_MODELS, verified_at: original.verified_at });
});
it('verifies a legacy DeepSeek-only key in the browser before adding GLM', async () => {
  const original = await savedReceipt(), f = fixture();
  f.fetcher.mockResolvedValueOnce(freeUsage()).mockResolvedValueOnce(modelList([BEATAPI_MODEL]));
  f.squire.signup.mockImplementationOnce(async () => { expect(await readFile(beatapiGrantPath(directory), 'utf8')).toBe(original); });
  await setupBeatAPI({ directory, ...f, upgradeExisting: true });
  expect(f.squire.signup).toHaveBeenCalledOnce();
  expect((await readBeatAPIGrant(directory))).toMatchObject({ version: 2, models: BEATAPI_MODELS });
});
it('preserves a verified legacy receipt after unsuccessful browser verification', async () => {
  const original = await savedReceipt(), f = fixture();
  f.fetcher.mockResolvedValueOnce(freeUsage()).mockResolvedValueOnce(modelList([BEATAPI_MODEL]));
  f.squire.signup.mockRejectedValueOnce(new Error('sk-browser-secret'));
  await expect(setupBeatAPI({ directory, ...f, upgradeExisting: true })).rejects.toThrow('verification did not complete');
  expect(await readFile(beatapiGrantPath(directory), 'utf8')).toBe(original);
});
it('preserves a verified legacy receipt when GLM is still unavailable after browser verification', async () => {
  const original = await savedReceipt(), f = fixture(), notify = vi.fn();
  f.fetcher.mockResolvedValueOnce(freeUsage()).mockResolvedValueOnce(modelList([BEATAPI_MODEL]));
  f.fetcher.mockResolvedValueOnce(freeUsage()).mockResolvedValueOnce(modelList([BEATAPI_MODEL]));
  await setupBeatAPI({ directory, ...f, upgradeExisting: true, notify });
  expect(f.squire.signup).toHaveBeenCalledOnce();
  expect(await readFile(beatapiGrantPath(directory), 'utf8')).toBe(original);
  expect(notify).toHaveBeenCalledWith(expect.stringContaining('GLM 5.3 Flash is unavailable'));
});
it.each([402, 403, 503])('preserves a verified legacy receipt on catalog HTTP %s without opening the browser', async status => {
  const original = await savedReceipt(), f = fixture();
  f.fetcher.mockResolvedValueOnce(freeUsage()).mockResolvedValueOnce(new Response(null, { status }));
  await expect(setupBeatAPI({ directory, ...f, upgradeExisting: true })).rejects.toThrow('verification did not complete');
  noProvisioning(f);
  expect(await readFile(beatapiGrantPath(directory), 'utf8')).toBe(original);
});
it('background setup with missing access requests foreground setup without provisioning or file creation', async () => {
  const f = fixture(); await expect(setupBeatAPI({ directory, ...f, background: true })).rejects.toThrow('needs foreground verification');
  noProvisioning(f); expect(f.fetcher).not.toHaveBeenCalled(); await expect(readFile(beatapiGrantPath(directory))).rejects.toMatchObject({ code: 'ENOENT' });
});
it.each(['status', 'billing', 'balance'])('background refresh failure preserves the existing receipt without provisioning (%s)', async reason => {
  const original = await savedReceipt(), f = fixture();
  f.fetcher.mockResolvedValueOnce(reason === 'status' ? new Response('sk-private-upstream-error', { status: 503 }) : new Response(JSON.stringify({ data: { object: 'usage', credit_balance: reason === 'balance' ? 1 : 2, credits_settled: reason === 'billing' ? 1 : 0 } })));
  await expect(setupBeatAPI({ directory, ...f, background: true })).rejects.toThrow('BeatAPI needs foreground verification; run usegrunt add beatapi');
  noProvisioning(f); expect(await readFile(beatapiGrantPath(directory), 'utf8')).toBe(original);
});
it.each([false, true])('cancellation during saved-grant verification preserves the receipt (background=%s)', async background => {
  const original = await savedReceipt(), f = fixture(), controller = new AbortController();
  f.fetcher.mockImplementationOnce(async () => new Promise<Response>(() => {}));
  const pending = setupBeatAPI({ directory, ...f, background, signal: controller.signal }); await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalled());
  controller.abort('sk-private-cancel'); await expect(pending).rejects.toThrow('BeatAPI free account or key verification did not complete');
  noProvisioning(f); expect(await readFile(beatapiGrantPath(directory), 'utf8')).toBe(original);
});
it('pre-cancelled foreground setup preserves even an invalid existing receipt', async () => {
  const f = fixture(), controller = new AbortController(); await writeFile(beatapiGrantPath(directory), 'existing-invalid-receipt', { mode: 0o600 }); controller.abort('sk-private-cancel');
  await expect(setupBeatAPI({ directory, ...f, signal: controller.signal })).rejects.toThrow('verification did not complete');
  noProvisioning(f); expect(f.fetcher).not.toHaveBeenCalled(); expect(await readFile(beatapiGrantPath(directory), 'utf8')).toBe('existing-invalid-receipt');
});
it('foreground setup removes a failed old receipt only when starting fresh verification', async () => {
  const original = await savedReceipt(), f = fixture();
  f.fetcher.mockResolvedValueOnce(new Response('private', { status: 401 })); f.squire.signup.mockImplementationOnce(async () => { await expect(readFile(beatapiGrantPath(directory))).rejects.toMatchObject({ code: 'ENOENT' }); });
  await setupBeatAPI({ directory, ...f }); expect(f.squire.signup).toHaveBeenCalledOnce(); expect(f.squire.credentials.grant).toHaveBeenCalledOnce(); expect(await readFile(beatapiGrantPath(directory), 'utf8')).not.toBe(original);
});
