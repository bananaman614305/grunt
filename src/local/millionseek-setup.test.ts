import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { recordDataSharingConsent } from './data-sharing.js';
import { MillionSeek } from './millionseek.js';
import { setupMillionSeek } from './millionseek-setup.js';
let directory: string;
const key = () => ({ service: '100milionseek', reference: 'vault://synthetic/key', allowed_hosts: ['100milionseek.top'], field_names: ['value'] });
function fixture() {
  const call = vi.fn(async () => ({ credentials: [key()] }));
  const signup = vi.fn(async () => {}), grant = vi.fn(async () => ({ base_url: 'https://100milionseek.top', token: 'synthetic' }));
  const squire = { call, signup, credentials: { grant } };
  return { squire, options: { directory, squire, notify: vi.fn(), connect: vi.fn(async () => {}), background: false } };
}
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'millionseek-setup-')); });
afterEach(async () => { vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }); });
it('requires exact source consent before provisioning or credentials', async () => {
  const { options, squire } = fixture(); await expect(setupMillionSeek(options)).rejects.toThrow('approval'); expect(squire.call).not.toHaveBeenCalled(); expect(squire.signup).not.toHaveBeenCalled();
});
it('signs up a missing account in the background as in foreground', async () => {
  await recordDataSharingConsent(directory, ['millionseek']); vi.spyOn(MillionSeek.prototype, 'available').mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  const { options, squire } = fixture(); squire.call.mockResolvedValueOnce({ credentials: [] }).mockResolvedValueOnce({ credentials: [key()] });
  await setupMillionSeek({ ...options, background: true }); expect(squire.signup).toHaveBeenCalledTimes(1);
});
it('reuses a verified grant without browser or vault access', async () => {
  await recordDataSharingConsent(directory, ['millionseek']); vi.spyOn(MillionSeek.prototype, 'available').mockResolvedValue(true);
  const { options, squire } = fixture(); await setupMillionSeek(options); expect(squire.call).not.toHaveBeenCalled(); expect(squire.signup).not.toHaveBeenCalled();
});
it('uses scoped metadata, verifies the sealed grant and saves it privately', async () => {
  await recordDataSharingConsent(directory, ['millionseek']); vi.spyOn(MillionSeek.prototype, 'available').mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  const { options, squire } = fixture(); await setupMillionSeek(options);
  expect(squire.call).toHaveBeenCalledWith('list_credentials', { service: '100milionseek', fields: 'summary' }); expect(squire.signup).not.toHaveBeenCalled(); expect(squire.credentials.grant).toHaveBeenCalledWith('vault://synthetic/key');
  expect(JSON.parse(await readFile(join(directory, 'millionseek.json'), 'utf8'))).toEqual({ base_url: 'https://100milionseek.top', token: 'synthetic' }); expect((await stat(join(directory, 'millionseek.json'))).mode & 0o777).toBe(0o600);
});
it('uses the first of several scoped keys that passes the free check', async () => {
  await recordDataSharingConsent(directory, ['millionseek']);
  vi.spyOn(MillionSeek.prototype, 'available').mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  const { options, squire } = fixture(); squire.call.mockResolvedValue({ credentials: [key(), { ...key(), reference: 'vault://synthetic/other' }] });
  await setupMillionSeek(options);
  expect(squire.credentials.grant.mock.calls.map(([reference]) => reference)).toEqual(['vault://synthetic/key', 'vault://synthetic/other']);
  expect(squire.signup).not.toHaveBeenCalled();
});
it('stops when no scoped key passes the free check', async () => {
  await recordDataSharingConsent(directory, ['millionseek']); vi.spyOn(MillionSeek.prototype, 'available').mockResolvedValue(false);
  const { options, squire } = fixture(); squire.call.mockResolvedValue({ credentials: [key(), { ...key(), reference: 'vault://synthetic/other' }] });
  await expect(setupMillionSeek(options)).rejects.toThrow('could not be verified'); expect(squire.credentials.grant).toHaveBeenCalledTimes(2);
  await expect(stat(join(directory, 'millionseek.json'))).rejects.toThrow();
});
it('completes one guarded Squire signup then checks newly captured metadata', async () => {
  await recordDataSharingConsent(directory, ['millionseek']); vi.spyOn(MillionSeek.prototype, 'available').mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  const { options, squire } = fixture(); squire.call.mockResolvedValueOnce({ credentials: [] }).mockResolvedValueOnce({ credentials: [key()] });
  await setupMillionSeek(options); expect(squire.signup).toHaveBeenCalledTimes(1); expect(squire.signup).toHaveBeenCalledWith('100milionseek', 'https://100milionseek.top/signup', expect.stringContaining('Never add payment details')); expect(squire.call).toHaveBeenCalledTimes(2);
});
