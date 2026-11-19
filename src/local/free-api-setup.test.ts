import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BrowserSquire, FreeLLMAdmin, setup } from './setup.js';
import { setupFallbacks } from './fallback-setup.js';
import { Runcrate } from './runcrate.js';
import { recordDataSharingConsent } from './data-sharing.js';
import * as mistralSetup from './mistral-vibe-setup.js';

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'grunt-free-api-setup-'));
  vi.stubEnv('GRUNT_CONFIG_DIR', directory);
});
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

it.each(['runcrate'] as const)('verifies a saved %s vault key in the browser before persisting free access, then reuses its verified local grant', async provider => {
  await recordDataSharingConsent(directory, [provider]);
  const source = Runcrate;
  const available = vi.spyOn(source.prototype, 'available').mockResolvedValueOnce(false).mockResolvedValue(true);
  const connect = vi.spyOn(BrowserSquire.prototype, 'connect').mockResolvedValue();
  vi.spyOn(BrowserSquire.prototype, 'close').mockResolvedValue();
  const router = vi.spyOn(FreeLLMAdmin.prototype, 'login');
  const events: string[] = [];
  const call = vi.spyOn(BrowserSquire.prototype, 'call').mockImplementation(async (name, args) => {
    events.push(name);
    if (name === 'list_credentials') return { credentials: [{ service: provider, reference: `vault://${provider}`, field_names: ['api_key'] }] };
    if (name === 'operate_drive') {
      const goal = String(args.goal);
      expect(goal).toContain('Use GitHub OAuth for the free path');
      expect(goal).not.toContain('Prefer Google OAuth');
      // Registry providers are vetted as free, so the browser goes straight to the key.
      expect(goal).not.toContain('at least 30 days old');
      expect(goal).not.toContain('automatic top-ups disabled');
      expect(goal).toContain('Do not open or change billing settings');
      expect(goal).toContain('deepseek-ai/DeepSeek-V4.1-Flash');
      expect(goal).toContain('["api.runcrate.ai"]');
      return { session_id: `${provider}-session`, status: 'complete' };
    }
    if (name === 'operate_finish') return {};
    if (name === 'grant_app_access') return { base_url: `https://egress.squire.test/${provider}`, token: 'synthetic-private-grant' };
    throw new Error('Unexpected Squire call');
  });
  await expect(setup(() => {}, [provider], { directory })).resolves.toEqual({});
  expect(events.indexOf('operate_drive')).toBeLessThan(events.indexOf('grant_app_access'));
  expect(call.mock.calls.filter(([name]) => name === 'operate_drive')).toHaveLength(1);
  const file = join(directory, `${provider}.json`);
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ free_account_verified: true });
  expect(router).not.toHaveBeenCalled();
  expect(available).toHaveBeenCalledTimes(2);
  call.mockClear();
  await setup(() => {}, [provider], { directory });
  expect(call).not.toHaveBeenCalled();
  expect(connect).toHaveBeenCalledTimes(2);
});

it.each(['runcrate'] as const)('does not save %s access when browser free-account verification refuses it', async provider => {
  await recordDataSharingConsent(directory, [provider]);
  vi.spyOn(Runcrate.prototype, 'available').mockResolvedValue(false);
  vi.spyOn(BrowserSquire.prototype, 'connect').mockResolvedValue();
  vi.spyOn(BrowserSquire.prototype, 'close').mockResolvedValue();
  const call = vi.spyOn(BrowserSquire.prototype, 'call').mockImplementation(async name => {
    if (name === 'list_credentials') return { credentials: [{ service: provider, reference: `vault://${provider}`, field_names: ['api_key'] }] };
    if (name === 'operate_drive') return { session_id: 'refused', status: 'refused', reason: 'Free plan requirements are not met' };
    if (name === 'operate_finish') return {};
    throw new Error('Unexpected Squire call');
  });
  await expect(setup(() => {}, [provider], { directory })).rejects.toThrow('refused');
  expect(call.mock.calls.some(([name]) => name === 'grant_app_access')).toBe(false);
  await expect(stat(join(directory, `${provider}.json`))).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each(['runcrate'] as const)('requires grouped approval before connecting Squire for %s', async provider => {
  const connect = vi.spyOn(BrowserSquire.prototype, 'connect');
  await expect(setup(() => {}, [provider], { directory })).rejects.toThrow('grouped setup approval');
  expect(connect).not.toHaveBeenCalled();
});

it('preserves existing APInex state while refusing new provisioning even with saved sharing approval', async () => {
  const saved = JSON.stringify({ base_url: 'https://synthetic.test/apinex', token: 'synthetic-private-grant', free_account_verified: true });
  const path = join(directory, 'apinex.json');
  await writeFile(path, saved, { mode: 0o600 });
  await recordDataSharingConsent(directory, ['apinex']);
  const connect = vi.spyOn(BrowserSquire.prototype, 'connect');
  const call = vi.spyOn(BrowserSquire.prototype, 'call');
  await expect(setup(() => {}, ['apinex'], { directory })).rejects.toThrow('apinex routing is disabled');
  expect(connect).not.toHaveBeenCalled(); expect(call).not.toHaveBeenCalled();
  expect(await readFile(path, 'utf8')).toBe(saved);
});

it('starts Runcrate and Zro concurrently, rejects retired APInex, and isolates a failed free-account check', async () => {
  const started: string[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const connect = vi.fn(async () => {});
  const squire = { signup: vi.fn(), credentials: { list: vi.fn(), grant: vi.fn() }, runs: { start: vi.fn(), get: vi.fn() } };
  const setupProvider = vi.fn<typeof setup>(async (_notify, providers, options) => {
    const provider = providers![0]!;
    started.push(provider);
    expect(options).toMatchObject({ directory, squire });
    if (provider !== 'zro') expect(options?.dataSharingApproved).toEqual(expect.arrayContaining(['runcrate', 'apinex']));
    await gate;
    if (provider === 'runcrate') throw new Error('GitHub account too new');
    return {};
  });
  const pending = setupFallbacks({ directory, adapters: ['runcrate', 'apinex', 'zro'], dataSharingApproved: ['runcrate', 'apinex'],
    run: vi.fn(), notify: vi.fn(), squire, connect, setupProvider });
  await vi.waitFor(() => expect(started).toEqual(['runcrate', 'zro']));
  release();
  expect(await pending).toEqual({ unavailable: ['runcrate', 'apinex'] });
  expect(connect).toHaveBeenCalledOnce();
});

it('skips unapproved free API providers before any browser or setup work while allowing Zro', async () => {
  const squire = { signup: vi.fn(), credentials: { list: vi.fn(), grant: vi.fn() }, runs: { start: vi.fn(), get: vi.fn() } };
  const setupProvider = vi.fn<typeof setup>(async () => ({}));
  const result = await setupFallbacks({ directory, adapters: ['runcrate', 'apinex', 'zro'], run: vi.fn(), notify: vi.fn(), squire, setupProvider });
  expect(result).toEqual({ unavailable: ['runcrate', 'apinex'] });
  expect(setupProvider).toHaveBeenCalledTimes(1);
  expect(setupProvider).toHaveBeenCalledWith(expect.any(Function), ['zro'], expect.any(Object));
  expect(squire.signup).not.toHaveBeenCalled();
});

it('delegates Mistral Vibe to native free onboarding without provisioning an API router', async () => {
  await recordDataSharingConsent(directory, ['mistral-vibe']);
  const native = vi.spyOn(mistralSetup, 'setupMistralVibe').mockResolvedValue();
  const router = vi.spyOn(FreeLLMAdmin.prototype, 'login');
  const squire = { signup: vi.fn(), credentials: { list: vi.fn(), grant: vi.fn() }, runs: { start: vi.fn(), get: vi.fn() } };
  const controller = new AbortController();
  await expect(setup(() => {}, ['mistral-vibe'], { directory, squire, signal: controller.signal })).resolves.toEqual({});
  expect(native).toHaveBeenCalledWith({ directory, squire, notify: expect.any(Function), signal: controller.signal });
  expect(router).not.toHaveBeenCalled();
  expect(squire.runs.start).not.toHaveBeenCalled();
});

it('continues other free setup when native Mistral Vibe onboarding fails', async () => {
  const squire = { signup: vi.fn(), credentials: { list: vi.fn(), grant: vi.fn() }, runs: { start: vi.fn(), get: vi.fn() } };
  const setupProvider = vi.fn<typeof setup>(async (_notify, providers) => {
    if (providers?.includes('mistral-vibe')) throw new Error('Native Python prerequisite unavailable');
    return {};
  });
  const result = await setupFallbacks({ directory, adapters: ['mistral-vibe', 'zro'], dataSharingApproved: ['mistral-vibe'],
    run: vi.fn(), notify: vi.fn(), squire, setupProvider });
  expect(result).toEqual({ unavailable: ['mistral-vibe'] });
  expect(setupProvider).toHaveBeenCalledTimes(2);
});
