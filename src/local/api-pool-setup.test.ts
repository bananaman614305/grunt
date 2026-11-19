import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type * as ClixadSetup from './clixad-setup.js';

const helpers = vi.hoisted(() => ({ pollinations: vi.fn(), beatapi: vi.fn(), clixad: vi.fn(), perch: vi.fn(), kilo: vi.fn() }));
vi.mock('./pollinations-setup.js', () => ({ setupPollinations: helpers.pollinations }));
vi.mock('./beatapi-setup.js', () => ({ setupBeatAPI: helpers.beatapi }));
vi.mock('./clixad-setup.js', async importOriginal => ({ ...await importOriginal<typeof ClixadSetup>(), setupClixad: helpers.clixad }));
vi.mock('./perch-setup.js', () => ({ setupPerch: helpers.perch }));
vi.mock('./kilo.js', () => ({ verifyKiloAccess: helpers.kilo, KILO_PARTICLE: 'particle-ai/particle-1:free' }));
import { BrowserSquire, setup } from './setup.js';
import { setupFallbacks } from './fallback-setup.js';
import { recordDataSharingConsent } from './data-sharing.js';

const directories: string[] = [];
const guardedProviders = ['pollinations', 'beatapi', 'clixad', 'perch'] as const;
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
    signup: vi.fn(), cancelSignup: vi.fn(), call: vi.fn(),
    credentials: { list: vi.fn(), grant: vi.fn() },
    runs: { start: vi.fn(), get: vi.fn() }
  };
}

it('provisions the new sources with their guarded helpers without entering the legacy router path', async () => {
  const location = await directory(), squire = client();
  const providers = ['pollinations', 'beatapi', 'clixad', 'perch'];
  await recordDataSharingConsent(location, providers);
  const signal = new AbortController().signal, notify = vi.fn();
  await expect(setup(notify, providers, { directory: location, squire, signal })).resolves.toEqual({});
  for (const helper of [helpers.pollinations, helpers.beatapi, helpers.clixad, helpers.perch]) {
    expect(helper).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ directory: location, squire, signal,
      dataSharingApproved: expect.arrayContaining(providers), notify }));
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

it.each(['pollinations', 'beatapi', 'clixad', 'perch', 'kilo'])('requires current %s consent before any provisioning', async provider => {
  const location = await directory(), squire = client();
  await expect(setup(vi.fn(), [provider], { directory: location, squire })).rejects.toThrow('grouped setup approval');
  for (const helper of Object.values(helpers)) expect(helper).not.toHaveBeenCalled();
  expect(squire.signup).not.toHaveBeenCalled();
  expect(squire.runs.start).not.toHaveBeenCalled();
});

it.each(guardedProviders)('passes background mode to %s without opening a new Squire connection', async provider => {
  const location = await directory();
  await recordDataSharingConsent(location, [provider]);
  const connect = vi.spyOn(BrowserSquire.prototype, 'connect').mockRejectedValue(new Error('background must not connect'));
  const signup = vi.spyOn(BrowserSquire.prototype, 'signup').mockRejectedValue(new Error('background must not signup'));
  const close = vi.spyOn(BrowserSquire.prototype, 'close').mockResolvedValue();
  const signal = new AbortController().signal, notify = vi.fn();
  try {
    await expect(setup(notify, [provider], { directory: location, signal, background: true })).resolves.toEqual({});
    expect(helpers[provider]).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ directory: location,
      squire: expect.any(BrowserSquire), signal, notify, background: true, dataSharingApproved: [provider] }));
    expect(connect).not.toHaveBeenCalled();
    expect(signup).not.toHaveBeenCalled();
  } finally { connect.mockRestore(); signup.mockRestore(); close.mockRestore(); }
});

it.each(['freebuff', 'apinex'])('refuses retired %s setup before account or credential operations', async provider => {
  const location = await directory(), squire = client();
  await recordDataSharingConsent(location, [provider]);
  await expect(setup(vi.fn(), [provider], { directory: location, squire })).rejects.toThrow('routing is disabled');
  for (const helper of Object.values(helpers)) expect(helper).not.toHaveBeenCalled();
  for (const operation of [squire.signup, squire.call, squire.credentials.list, squire.credentials.grant, squire.runs.start, squire.runs.get]) expect(operation).not.toHaveBeenCalled();
});

it.each([false, true])('dispatches all four guarded pool additions with a shared client (background: %s)', async background => {
  const location = await directory(), squire = client();
  const providers = [...guardedProviders];
  await recordDataSharingConsent(location, providers);
  const signal = new AbortController().signal, notify = vi.fn(), connect = vi.fn(async () => {}), run = vi.fn(async () => {});
  await expect(setupFallbacks({ directory: location, squire, adapters: providers, background, signal, notify, connect, run })).resolves.toEqual({ unavailable: [] });
  for (const provider of providers) expect(helpers[provider]).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    directory: location, squire, signal, notify, dataSharingApproved: providers, ...(background ? { background: true } : {})
  }));
  expect(connect).toHaveBeenCalledTimes(background ? 0 : 1);
  expect(run).not.toHaveBeenCalled();
  expect(squire.signup).not.toHaveBeenCalled();
  expect(squire.runs.start).not.toHaveBeenCalled();
});

it.each(guardedProviders)('leaves a failed %s background check unavailable without retrying interactive provisioning', async provider => {
  const location = await directory(), squire = client();
  await recordDataSharingConsent(location, [provider]);
  const signal = new AbortController().signal, notify = vi.fn(), connect = vi.fn(async () => {}), run = vi.fn(async () => {});
  helpers[provider].mockRejectedValueOnce(new Error('Saved free access needs foreground verification'));
  await expect(setupFallbacks({ directory: location, squire, adapters: [provider], background: true,
    signal, notify, connect, run })).resolves.toEqual({ unavailable: [provider] });
  expect(helpers[provider]).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ background: true, directory: location, squire, signal }));
  for (const operation of [connect, run, squire.signup, squire.call, squire.credentials.grant, squire.runs.start]) expect(operation).not.toHaveBeenCalled();
});

it('continues all other guarded background checks after BeatAPI needs foreground verification', async () => {
  const location = await directory(), squire = client(), providers = [...guardedProviders];
  await recordDataSharingConsent(location, providers);
  const connect = vi.fn(async () => {}), run = vi.fn(async () => {});
  helpers.beatapi.mockRejectedValueOnce(new Error('Saved free access needs foreground verification'));
  await expect(setupFallbacks({ directory: location, squire, adapters: providers, background: true,
    notify: vi.fn(), connect, run })).resolves.toEqual({ unavailable: ['beatapi'] });
  for (const provider of providers) expect(helpers[provider]).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ background: true }));
  for (const operation of [connect, run, squire.signup, squire.call, squire.credentials.grant, squire.runs.start]) expect(operation).not.toHaveBeenCalled();
});

it.each([false, true])('preserves the foreground/background intent at the fallback dispatcher boundary (%s)', async background => {
  const location = await directory(), squire = client(), providers = [...guardedProviders];
  await recordDataSharingConsent(location, providers);
  const setupProvider = vi.fn<typeof setup>(async () => ({}));
  await expect(setupFallbacks({ directory: location, squire, adapters: providers, background,
    notify: vi.fn(), run: vi.fn(), connect: vi.fn(async () => {}), setupProvider })).resolves.toEqual({ unavailable: [] });
  expect(setupProvider).toHaveBeenCalledTimes(providers.length);
  for (const provider of providers) expect(setupProvider).toHaveBeenCalledWith(expect.any(Function), [provider], expect.objectContaining({ background, directory: location, squire }));
});

it('covers parallel cold-start setup jobs using one reusable connection and no retired installers', async () => {
  const location = await directory(), squire = client();
  const providers = ['opencode', 'kilo', 'zro', 'tokenharbor', 'runcrate', 'mistral-vibe', 'livekit', 'pollinations', 'beatapi', 'clixad', 'perch', 'kenari', 'numes'];
  await recordDataSharingConsent(location, providers);
  const signal = new AbortController().signal, notify = vi.fn(), connect = vi.fn(async () => {}), run = vi.fn(async () => {}), verify = vi.fn(async () => {});
  const setupProvider = vi.fn(async (_notify: (line: string) => void, _providers: string[], _options?: Parameters<typeof setup>[2]) => ({}));
  await expect(setupFallbacks({ directory: location, squire, adapters: providers, signal, notify, connect, run, verify, setupProvider })).resolves.toEqual({ unavailable: [] });
  expect(connect).toHaveBeenCalledOnce();
  expect(verify).toHaveBeenCalledOnce();
  expect(run).toHaveBeenCalledExactlyOnceWith('opencode', ['--version']);
  expect(setupProvider.mock.calls.map(call => call[1][0]).sort()).toEqual(providers.filter(id => id !== 'opencode').sort());
  for (const call of setupProvider.mock.calls) expect(call[2]).toMatchObject({ directory: location, squire, signal });
});
