import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { recordDataSharingConsent } from './data-sharing.js';
import { Ifm } from './ifm.js';
import { setupIfm } from './ifm-setup.js';

let directory: string;
const key = (extra = {}) => ({ service: 'ifm', label: 'Grunt Free', reference: 'vault://synthetic/key', allowed_hosts: ['api.ifm.ai'], field_names: ['value'], ...extra });
function fixture(credentials: unknown[] = [key()]) {
  const call = vi.fn(async () => ({ credentials }));
  const signup = vi.fn(async () => {});
  const grant = vi.fn(async () => ({ base_url: 'https://api.ifm.ai', token: 'synthetic' }));
  const squire = { call, signup, credentials: { grant } };
  return { squire, options: { directory, squire: squire as never, notify: vi.fn(), connect: vi.fn(async () => {}), background: false } };
}
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'ifm-setup-')); });
afterEach(async () => { vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }); });

it('requires its own consent before touching the vault', async () => {
  const { options, squire } = fixture();
  await expect(setupIfm(options)).rejects.toThrow('approval');
  expect(squire.call).not.toHaveBeenCalled();
});

it('connects a key the person stored, verifies the sealed grant and saves it privately', async () => {
  await recordDataSharingConsent(directory, ['ifm']);
  vi.spyOn(Ifm.prototype, 'available').mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  const { options, squire } = fixture();
  await setupIfm(options);
  expect(squire.call).toHaveBeenCalledWith('list_credentials', { service: 'ifm', fields: 'summary' });
  expect(squire.credentials.grant).toHaveBeenCalledWith('vault://synthetic/key');
  expect(JSON.parse(await readFile(join(directory, 'ifm.json'), 'utf8'))).toEqual({ base_url: 'https://api.ifm.ai', token: 'synthetic' });
  expect((await stat(join(directory, 'ifm.json'))).mode & 0o777).toBe(0o600);
});

it('never signs up: without a stored key it stops and says so', async () => {
  await recordDataSharingConsent(directory, ['ifm']);
  vi.spyOn(Ifm.prototype, 'available').mockResolvedValue(false);
  const { options, squire } = fixture([]);
  await expect(setupIfm(options)).rejects.toThrow('create');
  expect(squire.signup).not.toHaveBeenCalled();
});

it.each([
  ['another label', { label: 'other' }],
  ['an extra host', { allowed_hosts: ['api.ifm.ai', 'example.com'] }],
  ['a login credential', { auth_strategy: 'username_password' }]
])('ignores a vault entry with %s', async (_name, extra) => {
  await recordDataSharingConsent(directory, ['ifm']);
  vi.spyOn(Ifm.prototype, 'available').mockResolvedValue(false);
  const { options, squire } = fixture([key(extra)]);
  await expect(setupIfm(options)).rejects.toThrow();
  expect(squire.credentials.grant).not.toHaveBeenCalled();
});

it('reuses an already verified route without vault access', async () => {
  await recordDataSharingConsent(directory, ['ifm']);
  vi.spyOn(Ifm.prototype, 'available').mockResolvedValue(true);
  const { options, squire } = fixture();
  await setupIfm(options);
  expect(squire.call).not.toHaveBeenCalled();
});
