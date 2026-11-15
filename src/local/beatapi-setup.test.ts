import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setupBeatAPI } from './beatapi-setup.js';
import { beatapiGrantPath, readBeatAPIGrant } from './beatapi.js';
import { recordDataSharingConsent } from './data-sharing.js';
let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'grunt-beatapi-setup-test-')); await recordDataSharingConsent(directory, ['beatapi']); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
const credential = { service: 'beatapi', label: 'grunt', reference: 'vault://synthetic-beatapi', field_names: ['value'], allowed_hosts: ['api.beatapi.io'] };
function fixture() {
  const squire = { signup: vi.fn(async () => {}), call: vi.fn(async () => ({ credentials: [credential] })), credentials: { list: vi.fn(async () => []), grant: vi.fn(async () => ({ base_url: 'https://trusty-squire-api.fly.dev/v1/egress/g_abcdefghijklmnop', token: 'synthetic-secret-grant' })) }, approveDataSharing: vi.fn() };
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: { object: 'usage', credit_balance: 2, credits_settled: 0 } })));
  return { squire, fetcher };
}
it('reuses fresh vault metadata after browser free-account/key verification', async () => {
  const f = fixture(); await setupBeatAPI({ directory, ...f }); expect(f.squire.call).toHaveBeenCalledTimes(2); expect(f.squire.credentials.list).not.toHaveBeenCalled(); expect(f.squire.credentials.grant).toHaveBeenCalledExactlyOnceWith(credential.reference);
  expect(f.squire.signup).toHaveBeenCalledWith('beatapi', 'https://beatapi.io/dashboard/apikeys', expect.stringContaining('lifetime paid $0'));
  expect((await readBeatAPIGrant(directory))).toMatchObject({ lifetime_paid: 0, baseline_balance: 2, credit_provenance: 'signup', model: 'deepseek-v4.1-flash-free' }); expect(f.fetcher).toHaveBeenCalledTimes(1);
});
it('stores a newly captured key when none existed', async () => {
  const f = fixture(); f.squire.call.mockResolvedValueOnce({ credentials: [] }); await setupBeatAPI({ directory, ...f }); expect(f.squire.credentials.grant).toHaveBeenCalledWith(credential.reference);
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
it('refuses a key whose first allowed host could route the grant elsewhere', async () => {
  const f = fixture(); f.squire.call.mockResolvedValue({ credentials: [{ ...credential, allowed_hosts: ['beatapi.io', 'api.beatapi.io'] }] }); await expect(setupBeatAPI({ directory, ...f })).rejects.toThrow('verification did not complete'); expect(f.squire.credentials.grant).not.toHaveBeenCalled();
});
