import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
vi.mock('./data-sharing.js', () => ({ readDataSharingConsent: vi.fn(async () => ['freepi']) }));
import { readDataSharingConsent } from './data-sharing.js';
import { setupFreePi } from './freepi-setup.js';
import { readFreePiToken } from './freepi.js';
let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'freepi-setup-')); vi.mocked(readDataSharingConsent).mockResolvedValue(['freepi']); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
function fixture() {
  const signup = vi.fn(async () => {}), notify = vi.fn();
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === '/auth/github/device') return Response.json({ session_id: '12345678-1234-1234-1234-123456789abc', verification_uri: 'https://github.com/login/device', user_code: 'ABCD-EFGH', expires_in: 900, interval: 5 });
    if (path === '/auth/consent') { expect(JSON.parse(String(init?.body)).consent_version).toBe('4'); return Response.json({ ok: true }); }
    if (path === '/auth/token') return Response.json({ token: 'synthetic-token' });
    if (path === '/client-version') return Response.json({ latest: '0.6.25', min: '0.6.21', models: [{ id: 'deepseek-v4.1-flash', free: true, stats_id: 'deepseek/deepseek-v4.1-flash-1017' }] });
    if (path === '/me/stats') return Response.json({ lane: 'standard', refill_at: new Date(Date.now() + 3600000).toISOString(), remaining_usd_today: 1, remaining_credits_today: 1000,
      credit_usd: 0, credit_credits: 0, bonus_credits: 0, bonus_wallet_credits: 0, premium_credits: 0, premium_bought_credits: 0, premium_gifted_credits: 0 });
    throw new Error('Unexpected endpoint');
  });
  return { directory, squire: { signup }, notify, fetcher, background: false };
}
it('requires saved material approval before any activation or browser operation', async () => {
  const f = fixture(); vi.mocked(readDataSharingConsent).mockResolvedValue([]);
  await expect(setupFreePi(f)).rejects.toThrow('trace-sale approval'); expect(f.fetcher).not.toHaveBeenCalled(); expect(f.squire.signup).not.toHaveBeenCalled();
});
it('does not begin new device authentication in background', async () => {
  const f = fixture(); await expect(setupFreePi({ ...f, background: true })).rejects.toThrow('foreground'); expect(f.fetcher).not.toHaveBeenCalled();
});
it('uses current official device consent, Squire GitHub flow and private native credential shape', async () => {
  const f = fixture(); await setupFreePi(f); expect(f.squire.signup).toHaveBeenCalledOnce(); expect(f.squire.signup.mock.calls[0]).toEqual(expect.arrayContaining(['freepi', 'https://github.com/login/device']));
  // The drive types only supplied facts, so the device code must be one.
  expect((f.squire.signup.mock.calls[0] as unknown[])[3]).toEqual({ user_code: 'ABCD-EFGH', device_code: 'ABCD-EFGH' });
  expect(await readFreePiToken(directory)).toBe('synthetic-token'); expect((await stat(join(directory, 'freepi', 'credentials.json'))).mode & 0o777).toBe(0o600);
  const count = f.squire.signup.mock.calls.length; await setupFreePi(f); expect(f.squire.signup.mock.calls).toHaveLength(count);
});
