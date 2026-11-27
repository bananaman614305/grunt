import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BrowserSquire, setup, setupProviders } from './setup.js';
import { setupFallbacks } from './fallback-setup.js';
import { Runcrate, RUNCRATE_DEEPSEEK } from './runcrate.js';
import { Zro, readZroGrant, writeZroGrant } from './zro.js';
import { TokenHarbor } from './tokenharbor.js';
import { recordDataSharingConsent } from './data-sharing.js';
import { SourceError } from './source.js';
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

const rejected = () => new SourceError('logged_out', 'runcrate returned HTTP 401', undefined, undefined, { httpStatus: 401 });
function runcrateBillingResponse(args: Record<string, unknown>) {
  const url = String((args.http as { url?: unknown } | undefined)?.url ?? '');
  if (url.endsWith('/api/v1/billing/balance')) return { response: { status: 200, headers: {}, body: JSON.stringify({ data: { creditsBalance: 0, activeUsageCost: 0 } }), truncated: false } };
  if (url.endsWith('/api/v1/billing/auto-recharge')) return { response: { status: 200, headers: {}, body: JSON.stringify({ data: { enabled: false } }), truncated: false } };
  if (url.endsWith('/api/v1/billing/payment-methods')) return { response: { status: 200, headers: {}, body: JSON.stringify({ data: [] }), truncated: false } };
  return { response: { status: 404, headers: {}, body: '{}', truncated: false } };
}
function squireCalls(provider: string, events: string[], drive?: (goal: string) => Record<string, unknown>) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
    if (String(url).endsWith('/v1/models')) return Response.json({ data: [{ id: RUNCRATE_DEEPSEEK }] });
    return new Response(null, { status: 404 });
  });
  return vi.spyOn(BrowserSquire.prototype, 'call').mockImplementation(async (name, args) => {
    events.push(name);
    const allowedHosts = provider === 'runcrate' ? ['api.runcrate.ai', 'www.runcrate.ai'] : undefined;
    if (name === 'list_credentials') return { credentials: [{ service: provider, reference: `vault://${provider}`, field_names: ['api_key'], ...(allowedHosts ? { allowed_hosts: allowedHosts } : {}) }] };
    if (name === 'operate_drive' && drive) return drive(String(args.goal));
    if (name === 'operate_finish') return {};
    if (name === 'grant_app_access') return { base_url: `https://egress.squire.test/${provider}`, token: 'synthetic-private-grant' };
    if (name === 'use_credential') {
      const targetUrl = new URL(String((args.http as { url?: unknown } | undefined)?.url ?? ''));
      if (allowedHosts && !allowedHosts.includes(targetUrl.hostname)) throw new Error(`Host ${targetUrl.hostname} is not in credential allowed_hosts`);
      return runcrateBillingResponse(args);
    }
    throw new Error('Unexpected Squire call');
  });
}

it.each(['runcrate'] as const)('uses a saved %s vault key that answers without a browser run, then reuses its local grant', async provider => {
  await recordDataSharingConsent(directory, [provider]);
  vi.spyOn(Runcrate.prototype, 'available').mockResolvedValueOnce(false).mockResolvedValue(true);
  const probe = vi.spyOn(Runcrate.prototype, 'complete').mockResolvedValue({ text: 'ready' });
  const connect = vi.spyOn(BrowserSquire.prototype, 'connect').mockResolvedValue();
  vi.spyOn(BrowserSquire.prototype, 'close').mockResolvedValue();
  const events: string[] = [];
  const call = squireCalls(provider, events);
  await expect(setup(() => {}, [provider], { directory })).resolves.toEqual({});
  expect(events).not.toContain('operate_drive');
  expect(probe).toHaveBeenCalledOnce();
  const file = join(directory, `${provider}.json`);
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ free_account_verified: true });
  call.mockClear();
  await setup(() => {}, [provider], { directory });
  expect(call).not.toHaveBeenCalled();
  expect(connect).toHaveBeenCalledTimes(2);
});

it.each(['runcrate'] as const)('opens %s in the browser only after the provider rejects the saved key', async provider => {
  await recordDataSharingConsent(directory, [provider]);
  vi.spyOn(Runcrate.prototype, 'available').mockResolvedValue(false);
  vi.spyOn(Runcrate.prototype, 'complete').mockRejectedValueOnce(rejected()).mockResolvedValue({ text: 'ready' });
  vi.spyOn(BrowserSquire.prototype, 'connect').mockResolvedValue();
  vi.spyOn(BrowserSquire.prototype, 'close').mockResolvedValue();
  const events: string[] = [];
  squireCalls(provider, events, goal => {
    expect(goal).toContain('Use GitHub OAuth for the free path');
    expect(goal).not.toContain('Prefer Google OAuth');
    // Registry providers are vetted as free, so the browser goes straight to the key.
    expect(goal).not.toContain('at least 30 days old');
    expect(goal).not.toContain('automatic top-ups disabled');
    expect(goal).toContain('Do not open or change billing settings');
    expect(goal).not.toMatch(/free tokens|allowance|DeepSeek-V4.1-Flash/);
    expect(goal).toContain('["api.runcrate.ai", "www.runcrate.ai"]');
    expect(goal).toContain('Capture an existing key where the site shows its value');
    return { session_id: `${provider}-session`, status: 'complete' };
  });
  const lines: string[] = [];
  await expect(setup(line => lines.push(line), [provider], { directory })).resolves.toEqual({});
  expect(events.filter(name => name === 'operate_drive')).toHaveLength(1);
  expect(events.indexOf('grant_app_access')).toBeLessThan(events.indexOf('operate_drive'));
  expect(lines).toContain(`${provider}: no saved key works; opening the provider site to capture working access`);
  expect(JSON.parse(await readFile(join(directory, `${provider}.json`), 'utf8'))).toMatchObject({ free_account_verified: true });
});

it.each(['runcrate'] as const)('does not keep %s access when the browser refuses after the saved key was rejected', async provider => {
  await recordDataSharingConsent(directory, [provider]);
  vi.spyOn(Runcrate.prototype, 'available').mockResolvedValue(false);
  vi.spyOn(Runcrate.prototype, 'complete').mockRejectedValue(rejected());
  vi.spyOn(BrowserSquire.prototype, 'connect').mockResolvedValue();
  vi.spyOn(BrowserSquire.prototype, 'close').mockResolvedValue();
  const events: string[] = [];
  squireCalls(provider, events, () => ({ session_id: 'refused', status: 'refused', reason: 'Free plan requirements are not met' }));
  await expect(setup(() => {}, [provider], { directory })).rejects.toThrow(`${provider} setup incomplete`);
  expect(events.filter(name => name === 'operate_drive')).toHaveLength(1);
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

it('delegates Mistral Vibe to native free onboarding', async () => {
  await recordDataSharingConsent(directory, ['mistral-vibe']);
  const native = vi.spyOn(mistralSetup, 'setupMistralVibe').mockResolvedValue();
  const squire = { signup: vi.fn(), credentials: { list: vi.fn(), grant: vi.fn() }, runs: { start: vi.fn(), get: vi.fn() } };
  const controller = new AbortController();
  await expect(setup(() => {}, ['mistral-vibe'], { directory, squire, signal: controller.signal })).resolves.toEqual({});
  expect(native).toHaveBeenCalledWith({ directory, squire, notify: expect.any(Function), signal: controller.signal });
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

it.each(['runcrate', 'zro', 'tokenharbor'] as const)('tries %s vault keys newest first before provisioning and after capture', async provider => {
  // Squire lists credentials newest first.
  const credentials = ['paused', 'working', 'old'].map(reference => ({ service: provider, reference, field_names: ['api_key'] }));
  let captured = false;
  const attempts: string[] = [];
  const squire = {
    credentials: { list: async () => credentials, grant: async (reference: string) => ({ base_url: 'https://grant.test', token: reference }) },
    runs: { start: vi.fn(async () => {
      captured = true;
      credentials.unshift({ service: provider, reference: 'captured', field_names: ['api_key'] });
      return { run: { id: provider, state: 'completed' }, decision: 'silent' as const };
    }), get: vi.fn() }
  };
  let working = true;
  const router = { addGrant: async (_provider: string, grant: { token: string }) => {
    attempts.push(grant.token);
    if (grant.token === 'captured' && captured || grant.token === 'working' && working) return;
    throw rejected();
  } };
  const options = { providers: [provider], notify: () => {} };
  await setupProviders(squire, router, options);
  expect(attempts).toEqual(['paused', 'working']);
  expect(squire.runs.start).not.toHaveBeenCalled();
  working = false; attempts.length = 0;
  await setupProviders(squire, router, options);
  expect(attempts).toEqual(['paused', 'working', 'old', 'captured']);
  expect(squire.runs.start).toHaveBeenCalledOnce();
});

it.each([
  { provider: 'runcrate', adapter: Runcrate },
  { provider: 'zro', adapter: Zro },
  { provider: 'tokenharbor', adapter: TokenHarbor }
] as const)('cancels $provider setup probes for saved and captured grants', async ({ provider, adapter }) => {
  await recordDataSharingConsent(directory, [provider]);
  vi.spyOn(adapter.prototype, 'available').mockResolvedValue(false);
  for (const capture of [false, true]) {
    const controller = new AbortController();
    const cancelled = new Error('setup cancelled during probe');
    let release!: () => void;
    let started!: (signal: AbortSignal) => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const probing = new Promise<AbortSignal>(resolve => { started = resolve; });
    const complete = vi.spyOn(adapter.prototype, 'complete').mockImplementation(async (_request, signal) => {
      started(signal);
      await pending;
      return { text: 'ready' };
    });
    let captured = false;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
      if (String(url).endsWith('/v1/models')) return Response.json({ data: [{ id: RUNCRATE_DEEPSEEK }] });
      return new Response(null, { status: 404 });
    });
    const squire = {
      call: async (name: string, args: Record<string, unknown>) => {
        if (name === 'use_credential') return runcrateBillingResponse(args);
        throw new Error(`Unexpected Squire call: ${name}`);
      },
      credentials: {
        list: async () => capture && !captured ? [] : [{ service: provider, reference: 'vault://probe', field_names: ['api_key'] }],
        grant: async () => ({ base_url: 'https://grant.test', token: 'synthetic-grant' })
      },
      runs: { start: vi.fn(async () => {
        captured = true;
        return { run: { id: provider, state: 'completed' }, decision: 'silent' as const };
      }), get: vi.fn() }
    };
    const notify = vi.fn();
    const work = setup(notify, [provider], { directory, squire, signal: controller.signal });
    const outcome = expect(work).rejects.toBe(cancelled);
    const signal = await probing;
    controller.abort(cancelled);
    expect(signal.aborted).toBe(true);
    release();
    await outcome;
    expect(notify.mock.calls.flat().some(line => /connected/.test(line))).toBe(false);
    expect(squire.runs.start).toHaveBeenCalledTimes(capture ? 1 : 0);
    await expect(stat(join(directory, `${provider}.json`))).rejects.toMatchObject({ code: 'ENOENT' });
    complete.mockRestore();
    fetchSpy.mockRestore();
  }
});

it('cancels the initial Zro readiness request without accepting a late reply or starting signup', async () => {
  await writeZroGrant({ base_url: 'https://grant.test', token: 'synthetic-grant' }, directory);
  const controller = new AbortController();
  const cancelled = new Error('setup cancelled during readiness');
  let release!: (response: Response) => void;
  let started!: (signal: AbortSignal) => void;
  const pending = new Promise<Response>(resolve => { release = resolve; });
  const probing = new Promise<AbortSignal>(resolve => { started = resolve; });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    started(init!.signal as AbortSignal);
    return pending;
  });
  const squire = { credentials: { list: vi.fn(), grant: vi.fn() }, runs: { start: vi.fn(), get: vi.fn() } };
  const notify = vi.fn();
  const work = setup(notify, ['zro'], { directory, squire, signal: controller.signal });
  const outcome = expect(work).rejects.toBe(cancelled);
  const signal = await probing;
  controller.abort(cancelled);
  expect(signal.aborted).toBe(true);
  release(Response.json({ model: 'deepseek-v4.1-flash', choices: [{ message: { content: 'ready' } }] }));
  await outcome;
  expect(notify).not.toHaveBeenCalled();
  expect(squire.runs.start).not.toHaveBeenCalled();
  expect(squire.credentials.list).not.toHaveBeenCalled();
});

it.each(['runcrate', 'zro', 'tokenharbor'] as const)('tries remaining %s credentials after inconclusive failures in either selection pass', async provider => {
  for (const afterCapture of [false, true]) {
    let captured = false;
    const squire = {
      credentials: {
        list: async () => afterCapture && !captured ? [] : ['limited', 'working'].map(reference => ({ service: provider, reference, field_names: ['api_key'] })),
        grant: async (reference: string) => ({ base_url: 'https://grant.test', token: reference })
      },
      runs: { start: vi.fn(async () => {
        captured = true;
        return { run: { id: provider, state: 'completed' }, decision: 'silent' as const };
      }), get: vi.fn() }
    };
    const attempts: string[] = [];
    const router = { addGrant: async (_provider: string, grant: { token: string }) => {
      attempts.push(grant.token);
      if (grant.token === 'limited') throw new SourceError('quota', 'HTTP 429');
    } };
    const result = await setupProviders(squire, router, { providers: [provider], notify: () => {} });
    expect(result.dropped).toEqual([]);
    expect(attempts).toEqual(['limited', 'working']);
    expect(squire.runs.start).toHaveBeenCalledTimes(afterCapture ? 1 : 0);
  }
});

it.each(['runcrate', 'zro', 'tokenharbor'] as const)('does not provision %s after any inconclusive key failure', async provider => {
  const quota = new SourceError('quota', 'HTTP 429');
  const attempts: string[] = [];
  const squire = {
    credentials: {
      list: async () => ['limited', 'rejected'].map(reference => ({ service: provider, reference, field_names: ['api_key'] })),
      grant: async (reference: string) => ({ base_url: 'https://grant.test', token: reference })
    }, runs: { start: vi.fn(), get: vi.fn() }
  };
  const router = { addGrant: async (_provider: string, grant: { token: string }) => {
    attempts.push(grant.token);
    throw grant.token === 'limited' ? quota : rejected();
  } };
  await expect(setupProviders(squire, router, { providers: [provider], notify: () => {} })).rejects.toBe(quota);
  expect(attempts).toEqual(['limited', 'rejected']);
  expect(squire.runs.start).not.toHaveBeenCalled();
});

it.each([true, false])('tries vaulted Zro access after local readiness reports quota (working alternative: %s)', async working => {
  await writeZroGrant({ base_url: 'https://grant.test', token: 'local-limited' }, directory);
  const requests: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const authorization = new Headers(init!.headers).get('authorization')!;
    requests.push(authorization);
    return authorization === 'Bearer working' && working
      ? Response.json({ model: 'deepseek-v4.1-flash', choices: [{ message: { content: 'ready' } }] })
      : new Response(null, { status: 429 });
  });
  const squire = {
    credentials: {
      list: async () => [{ service: 'zro', reference: 'vault://working', field_names: ['api_key'] }],
      grant: async () => ({ base_url: 'https://grant.test', token: 'working' })
    }, runs: { start: vi.fn(), get: vi.fn() }
  };
  if (working) await expect(setup(() => {}, ['zro'], { directory, squire })).resolves.toEqual({});
  else await expect(setup(() => {}, ['zro'], { directory, squire })).rejects.toMatchObject({ code: 'quota' });
  expect(requests).toEqual(['Bearer local-limited', 'Bearer working']);
  expect(squire.runs.start).not.toHaveBeenCalled();
  // A quota reply proves the key works, so a limited key stays installed for recovery at reset.
  await expect(readZroGrant(directory)).resolves.toMatchObject({ token: 'working' });
});

it('removes a Zro key the provider rejects, but not one that is only over quota', async () => {
  const squire = (token: string) => ({
    credentials: {
      list: async () => [{ service: 'zro', reference: `vault://${token}`, field_names: ['api_key'] }],
      grant: async () => ({ base_url: 'https://grant.test', token })
    }, runs: { start: vi.fn(async () => ({ decision: 'drop' as const })), get: vi.fn() }
  });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) =>
    new Response(null, { status: new Headers(init!.headers).get('authorization') === 'Bearer limited' ? 402 : 401 }));
  await setup(() => {}, ['zro'], { directory, squire: squire('revoked') }).catch(() => {});
  await expect(readZroGrant(directory)).rejects.toThrow();
  await expect(setup(() => {}, ['zro'], { directory, squire: squire('limited') })).rejects.toMatchObject({ code: 'quota' });
  await expect(readZroGrant(directory)).resolves.toMatchObject({ token: 'limited' });
});

it.each([false, true])('keeps a quota-limited Zro key when a later candidate is rejected in the same setup (limited key already local: %s)', async local => {
  if (local) await writeZroGrant({ base_url: 'https://grant.test', token: 'limited' }, directory);
  const tokens = local ? ['revoked'] : ['limited', 'revoked'];
  const squire = {
    credentials: {
      list: async () => tokens.map(token => ({ service: 'zro', reference: `vault://${token}`, field_names: ['api_key'] })),
      grant: async (reference: string) => ({ base_url: 'https://grant.test', token: reference.slice('vault://'.length) })
    }, runs: { start: vi.fn(), get: vi.fn() }
  };
  const requests: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const authorization = new Headers(init!.headers).get('authorization')!;
    requests.push(authorization);
    return new Response(null, { status: authorization === 'Bearer limited' ? 402 : 401 });
  });
  await expect(setup(() => {}, ['zro'], { directory, squire })).rejects.toMatchObject({ code: 'quota' });
  expect(requests).toEqual(['Bearer limited', 'Bearer revoked']);
  await expect(readZroGrant(directory)).resolves.toMatchObject({ token: 'limited' });
  expect(squire.runs.start).not.toHaveBeenCalled();
});

it('stops credential selection immediately on cancellation', async () => {
  const controller = new AbortController();
  const cancelled = new Error('setup cancelled');
  const squire = {
    credentials: {
      list: async () => ['older', 'newer'].map(reference => ({ service: 'zro', reference, field_names: ['api_key'] })),
      grant: vi.fn(async () => ({ base_url: 'https://grant.test', token: 'synthetic-grant' }))
    }, runs: { start: vi.fn(), get: vi.fn() }
  };
  const router = { addGrant: async () => { controller.abort(cancelled); throw new SourceError('quota', 'HTTP 429'); } };
  await expect(setupProviders(squire, router, { providers: ['zro'], signal: controller.signal, notify: () => {} })).rejects.toBe(cancelled);
  expect(squire.credentials.grant).toHaveBeenCalledOnce();
  expect(squire.runs.start).not.toHaveBeenCalled();
});
