import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const helpers = vi.hoisted(() => ({ pollinations: vi.fn(), beatapi: vi.fn(), kilo: vi.fn() }));
vi.mock('./pollinations-setup.js', () => ({ setupPollinations: helpers.pollinations }));
vi.mock('./beatapi-setup.js', () => ({ setupBeatAPI: helpers.beatapi }));
vi.mock('./kilo.js', () => ({ verifyKiloAccess: helpers.kilo, KILO_PARTICLE: 'particle-ai/particle-1:free' }));
import { setup } from './setup.js';
import { recordDataSharingConsent } from './data-sharing.js';

const directories: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'grunt-api-pool-setup-'));
  directories.push(path);
  return path;
}
function client() {
  return {
    signup: vi.fn(), call: vi.fn(),
    credentials: { list: vi.fn(), grant: vi.fn() },
    runs: { start: vi.fn(), get: vi.fn() }
  };
}

it('provisions the new sources with their guarded helpers without entering the legacy router path', async () => {
  const location = await directory(), squire = client();
  const providers = ['pollinations', 'beatapi'];
  await recordDataSharingConsent(location, providers);
  const signal = new AbortController().signal, notify = vi.fn();
  await expect(setup(notify, providers, { directory: location, squire, signal })).resolves.toEqual({});
  for (const helper of [helpers.pollinations, helpers.beatapi]) {
    expect(helper).toHaveBeenCalledExactlyOnceWith({ directory: location, squire, signal,
      dataSharingApproved: expect.arrayContaining(providers), notify });
  }
  expect(squire.runs.start).not.toHaveBeenCalled();
  expect(squire.credentials.grant).not.toHaveBeenCalled();
});

it('checks anonymous Particle access without provisioning an account or a legacy router', async () => {
  const location = await directory(), squire = client();
  await recordDataSharingConsent(location, ['kilo']);
  const signal = new AbortController().signal, notify = vi.fn();
  await expect(setup(notify, ['kilo'], { directory: location, squire, signal })).resolves.toEqual({});
  expect(helpers.kilo).toHaveBeenCalledExactlyOnceWith({ signal });
  expect(notify).toHaveBeenCalledWith(expect.stringContaining('no account or API key required'));
  expect(squire.signup).not.toHaveBeenCalled();
  expect(squire.call).not.toHaveBeenCalled();
  expect(squire.runs.start).not.toHaveBeenCalled();
  expect(squire.credentials.grant).not.toHaveBeenCalled();
});

it.each(['pollinations', 'beatapi', 'kilo'])('requires current %s consent before any provisioning', async provider => {
  const location = await directory(), squire = client();
  await expect(setup(vi.fn(), [provider], { directory: location, squire })).rejects.toThrow('grouped setup approval');
  for (const helper of Object.values(helpers)) expect(helper).not.toHaveBeenCalled();
  expect(squire.signup).not.toHaveBeenCalled();
  expect(squire.runs.start).not.toHaveBeenCalled();
});
