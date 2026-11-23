import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Zro, ZRO_DEEPSEEK, readZroGrant, writeZroGrant } from './zro.js';
import { TokenHarbor, TOKENHARBOR_DEEPSEEK, writeTokenHarborGrant } from './tokenharbor.js';
import { BrowserSquire, FreeLLMAdmin, setup } from './setup.js';
import { Sources } from './source.js';
import { createLocalApp } from './api.js';
import { configure } from './main.js';
import { bundledRegistry } from '../registry.js';
import { recordDataSharingConsent } from './data-sharing.js';
import { setupFallbacks } from './fallback-setup.js';

const directories: string[] = [];
const grant = { base_url: 'https://grant.test/zro', token: 'synthetic-grant' };
async function directory() { const path = await mkdtemp(join(tmpdir(), 'grunt-zro-')); directories.push(path); return path; }
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const payload = { model: 'grunt', messages: [{ role: 'user', content: 'hello' }], max_tokens: 1000 };
const response = (model = ZRO_DEEPSEEK) => Response.json({ model, choices: [{ message: { content: 'Hello' } }], usage: { prompt_tokens: 37, completion_tokens: 2 } });

it('ships Zro by default and keeps unvetted NVIDIA out of fresh signup', async () => {
  expect(bundledRegistry.adapters.map(a => a.id)).toContain('zro');
  expect(bundledRegistry.adapters.map(a => a.id)).not.toContain('nvidia');
  expect(configure({}).sources.find(s => s.id === 'zro')).toBeInstanceOf(Zro);
  const calls: string[] = [];
  const squire = { signup: vi.fn(), runs: { start: vi.fn(), get: vi.fn() }, credentials: { list: vi.fn(), grant: vi.fn() } };
  await setupFallbacks({ directory: await directory(), adapters: ['zro'], squire, run: async () => {}, notify: () => {}, setupProvider: async (_notify, ids) => { calls.push(...ids); return {}; } });
  expect(calls).toEqual(['zro']); expect(squire.runs.start).not.toHaveBeenCalled();
});

it('routes the normal grunt alias through its pinned Zro model', async () => {
  const path = await directory(); await writeZroGrant(grant, path);
  const fetcher = vi.fn<typeof fetch>(async () => response());
  const source = new Zro({ directory: path, fetcher });
  const sources = new Sources([source], { registry: () => bundledRegistry });
  const result = await createLocalApp(sources).request('http://127.0.0.1:8788/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  expect(result.status).toBe(200); expect(result.headers.get('x-grunt-source')).toBe('zro');
  const sent = fetcher.mock.calls.filter(([url]) => String(url).endsWith('/chat/completions')).at(-1)!;
  expect(JSON.parse(String(sent[1]?.body))).toMatchObject({ model: ZRO_DEEPSEEK, max_tokens: 1000 });
  await sources.close();
});

it('requires a private Free-account verification receipt before making Zro available', async () => {
  const path = await directory(); const fetcher = vi.fn<typeof fetch>(async () => response());
  await writeFile(join(path, 'zro.json'), JSON.stringify(grant), { mode: 0o600 });
  expect(await new Zro({ directory: path, fetcher }).available()).toBe(false);
  expect(fetcher).not.toHaveBeenCalled();
  await writeZroGrant(grant, path);
  expect(await readZroGrant(path)).toMatchObject({ ...grant, free_account_verified: true });
  expect((await stat(join(path, 'zro.json'))).mode & 0o777).toBe(0o600);
});

const vaultedZro = (start: () => Promise<{ run: { id: string; state: string }; decision: 'silent' | 'reject'; reason?: string }>) => ({
  credentials: { list: vi.fn(async () => [{ service: 'zro', reference: 'vault://zro', field_names: ['api_key'] }]), grant: vi.fn(async () => grant) },
  runs: { start: vi.fn(start), get: vi.fn() } });
const paused = () => Response.json({ error: { code: 'api_key_paused' } }, { status: 403 });

it('uses a working vaulted Zro key without a browser run or aggregator, then reuses its local grant', async () => {
  const path = await directory();
  const backend = vi.spyOn(FreeLLMAdmin.prototype, 'call').mockRejectedValue(new Error('must not start'));
  const squire = vaultedZro(async () => { throw new Error('must not drive'); });
  const fetcher = vi.fn<typeof fetch>(async () => response());
  vi.stubGlobal('fetch', fetcher);
  for (let i = 0; i < 2; i++) await setup(() => {}, ['zro'], { squire, directory: path });
  expect(squire.runs.start).not.toHaveBeenCalled(); expect(squire.credentials.grant).toHaveBeenCalledOnce(); expect(backend).not.toHaveBeenCalled();
  expect(await readZroGrant(path)).toMatchObject({ free_account_verified: true });
  // Readiness is a chat request, never the model list.
  expect(fetcher.mock.calls.length).toBeGreaterThan(0);
  expect(fetcher.mock.calls.every(([url]) => String(url).endsWith('/v1/chat/completions'))).toBe(true);
});

it('opens Zro in the browser only after the provider rejects the vaulted key, then connects the captured key', async () => {
  const path = await directory();
  let captured = false;
  const squire = vaultedZro(async () => { captured = true; return { run: { id: 'zro', state: 'completed' }, decision: 'silent' }; });
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => captured ? response() : paused()));
  const lines: string[] = [];
  await setup(line => lines.push(line), ['zro'], { squire, directory: path });
  expect(squire.runs.start).toHaveBeenCalledOnce();
  expect(lines).toContain('zro: saved key rejected (HTTP 403); opening the provider site to capture working access');
  expect(lines.at(-1)).toBe('zro: connected through Squire grant');
});

it('does not open Zro in the browser when the vaulted key fails without a rejection', async () => {
  const path = await directory();
  const squire = vaultedZro(async () => { throw new Error('must not drive'); });
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(null, { status: 503 })));
  await expect(setup(() => {}, ['zro'], { squire, directory: path })).rejects.toThrow('zro returned HTTP 503');
  expect(squire.runs.start).not.toHaveBeenCalled();
});

it('reports a Zro paused-key 403 as unavailable, not connected', async () => {
  const path = await directory(); await writeZroGrant(grant, path);
  const fetcher = vi.fn<typeof fetch>(async url => String(url).endsWith('/models') ? Response.json({ data: [{ id: ZRO_DEEPSEEK }] }) : paused());
  expect(await new Zro({ directory: path, fetcher }).available()).toBe(false);
});

it('stops Zro setup when the browser refuses after the vaulted key was rejected', async () => {
  const path = await directory();
  const squire = vaultedZro(async () => ({ run: { id: 'zro', state: 'failed' }, decision: 'reject', reason: 'Paid plan active' }));
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => paused()));
  await expect(setup(() => {}, ['zro'], { squire, directory: path })).rejects.toThrow('refused');
  expect(squire.runs.start).toHaveBeenCalledOnce();
  await expect(stat(join(path, 'zro.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each([
  { status: 200, drives: 0 },
  { status: 403, drives: 1 }
])('tests the vaulted Token Harbor key first and opens the browser only on a rejection (HTTP $status)', async ({ status, drives }) => {
  const path = await directory(); await recordDataSharingConsent(path, ['tokenharbor']);
  let captured = false;
  const squire = { credentials: { list: vi.fn(async () => [{ service: 'tokenharbor', reference: 'vault://tokenharbor', field_names: ['api_key'] }]), grant: vi.fn(async () => grant) },
    runs: { start: vi.fn(async () => { captured = true; return { run: { id: 'tokenharbor', state: 'completed' }, decision: 'silent' as const }; }), get: vi.fn() } };
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => captured || status === 200 ? response(TOKENHARBOR_DEEPSEEK) : new Response(null, { status })));
  await setup(() => {}, ['tokenharbor'], { squire, directory: path });
  expect(squire.runs.start).toHaveBeenCalledTimes(drives);
  expect(JSON.parse(await readFile(join(path, 'tokenharbor.json'), 'utf8'))).toMatchObject(grant);
});

it('requests Google signup, free billing checks, vault capture and no paid account mutation', async () => {
  const squire = new BrowserSquire();
  const call = vi.spyOn(squire, 'call').mockImplementation(async name => name === 'operate_drive' ? { status: 'complete', session_id: 'zro-session' } : {});
  await squire.runs.start({ service: 'zro', plan: 'free', project_name: 'grunt', category: 'ai', cost_cents: 0, recurrence: 'none' });
  const goal = String(call.mock.calls.find(([name]) => name === 'operate_drive')![1].goal);
  expect(goal).toContain('Prefer Google OAuth'); expect(goal).toContain('Go straight to the API keys page'); expect(goal).not.toContain('no purchased usage-pack balance');
  expect(goal).toContain('do not cancel, downgrade'); expect(goal).toContain('api_hosts ["zro.moonmath.ai"]');
});

it('overlaps all three API signup jobs on one Squire connection', async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const started: string[] = [];
  const squire = { signup: vi.fn(), runs: { start: vi.fn(), get: vi.fn() }, credentials: { list: vi.fn(), grant: vi.fn() } };
  const connect = vi.fn(async () => {});
  const path = await directory(); await recordDataSharingConsent(path, ['kilo']);
  const work = setupFallbacks({ directory: path, adapters: ['kilo', 'zro', 'tokenharbor'], squire, connect,
    run: async () => {}, notify: () => {}, dataSharingApproved: ['kilo', 'tokenharbor'],
    setupProvider: async (_notify, ids) => { started.push(...ids); await held; return {}; } });
  await vi.waitFor(() => expect(started).toEqual(['kilo', 'zro', 'tokenharbor']));
  expect(connect).toHaveBeenCalledOnce(); release();
  expect(await work).toEqual({ unavailable: [] });
});

it('keeps grouped approvals on the shared Squire client while another provider sets up', async () => {
  const path = await directory(); await recordDataSharingConsent(path, ['tokenharbor']);
  const squire = new BrowserSquire();
  const call = vi.spyOn(squire, 'call').mockImplementation(async name => {
    if (name === 'list_credentials') return { credentials: [{ service: 'zro', reference: 'vault://zro', field_names: ['api_key'] }] };
    if (name === 'grant_app_access') return grant;
    if (name === 'operate_drive') return { status: 'complete', session_id: 'provider-session' };
    return {};
  });
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => response()));
  await setup(() => {}, ['zro'], { squire, directory: path });
  await squire.runs.start({ service: 'tokenharbor', plan: 'free', project_name: 'grunt', category: 'ai', cost_cents: 0, recurrence: 'none' });
  const goals = call.mock.calls.filter(([name]) => name === 'operate_drive').map(([, args]) => String(args.goal));
  expect(goals.at(-1)).toContain('Grunt setup enables this free source by default');
});

it('fails closed for Token Harbor without data sharing approval, including existing grants and direct requests', async () => {
  const path = await directory(); await writeTokenHarborGrant(grant, path);
  const fetcher = vi.fn<typeof fetch>(async () => response(TOKENHARBOR_DEEPSEEK));
  const source = new TokenHarbor({ directory: path, fetcher });
  expect(await source.available()).toBe(false);
  await expect(source.complete({ ...payload, tools: [], cwd: path, stream: false }, AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'refused' });
  expect(fetcher).not.toHaveBeenCalled();
  await expect(setup(() => {}, ['tokenharbor'], { directory: path })).rejects.toThrow('grouped setup approval');
});

it('routes approved Token Harbor through its exact free ID and stops after consent is removed', async () => {
  const path = await directory(); await recordDataSharingConsent(path, ['tokenharbor']); await writeTokenHarborGrant(grant, path);
  const fetcher = vi.fn<typeof fetch>(async url => String(url).endsWith('/free-tier') ? Response.json({ models_enabled: true, exhausted: false }) : response(TOKENHARBOR_DEEPSEEK));
  const source = new TokenHarbor({ directory: path, fetcher });
  const sources = new Sources([source], { registry: () => bundledRegistry });
  const result = await createLocalApp(sources).request('http://127.0.0.1:8788/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  expect(result.status).toBe(200); expect(result.headers.get('x-grunt-source')).toBe('tokenharbor');
  expect(JSON.parse(String(fetcher.mock.calls.find(([url]) => String(url).endsWith('/chat/completions'))![1]?.body)).model).toBe(TOKENHARBOR_DEEPSEEK);
  await rm(join(path, 'data-sharing-consent.json'));
  await expect(source.complete({ ...payload, tools: [], cwd: path, stream: false }, AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'refused' });
  await sources.close();
});

it('shows exhausted Token Harbor as rate limited and clears the label when free access returns', async () => {
  const path = await directory();
  await recordDataSharingConsent(path, ['tokenharbor']);
  await writeTokenHarborGrant(grant, path);
  let exhausted = true;
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ models_enabled: true, exhausted }));
  const sources = new Sources([new TokenHarbor({ directory: path, fetcher })], { registry: () => bundledRegistry });
  try {
    expect(await sources.models()).not.toContain('tokenharbor');
    expect(sources.status().sources[0]).toMatchObject({ id: 'tokenharbor', state: 'limited', errorCode: 'quota' });
    exhausted = false;
    expect(await sources.models()).toContain('tokenharbor');
    expect(sources.status().sources[0]).toMatchObject({ id: 'tokenharbor', state: 'available' });
    expect(sources.status().sources[0]?.errorCode).toBeUndefined();
    expect(fetcher.mock.calls.every(([url]) => String(url).endsWith('/free-tier'))).toBe(true);
  } finally { await sources.close(); }
});

it('learns the Token Harbor allowance window on the first exhausted request and retries at its reset', async () => {
  const path = await directory();
  await recordDataSharingConsent(path, ['tokenharbor']);
  await writeTokenHarborGrant(grant, path);
  const resetAt = Date.parse('2026-11-22T03:04:18.030Z');
  const startedAt = resetAt - 7 * 86400000;
  let now = resetAt - 60000;
  const fetcher = vi.fn<typeof fetch>(async url => {
    if (!String(url).endsWith('/free-tier')) return response(TOKENHARBOR_DEEPSEEK);
    const cached = now < resetAt + 15000;
    return Response.json({ models_enabled: true, exhausted: cached,
      period_started_at: new Date(cached ? startedAt : resetAt).toISOString(),
      reset_at: new Date(cached ? resetAt : resetAt + 7 * 86400000).toISOString() });
  });
  const sources = new Sources([new TokenHarbor({ directory: path, fetcher, now: () => now })], { registry: () => bundledRegistry, now: () => now });
  const app = createLocalApp(sources);
  const send = () => app.request('http://127.0.0.1:8788/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
  });
  try {
    const first = await send();
    expect(first.status).toBe(429);
    expect(first.headers.get('retry-after')).toBe('60');
    expect(sources.status().sources[0]).toMatchObject({
      id: 'tokenharbor', state: 'limited', retryAt: resetAt, supportsFunctionTools: true, quotaWindow: { startedAt, resetAt }
    });
    expect((await send()).status).toBe(429);
    expect(fetcher).toHaveBeenCalledTimes(1);
    now = resetAt;
    const stale = await send();
    expect(stale.status).toBe(429);
    expect(stale.headers.get('retry-after')).toBe('15');
    expect(sources.status().sources[0]).not.toHaveProperty('quotaWindow');
    now += 15000;
    const next = await send();
    expect(next.status).toBe(200);
    expect(next.headers.get('x-grunt-source')).toBe('tokenharbor');
    expect(sources.status().sources[0]?.quotaWindow).toEqual({ startedAt: resetAt, resetAt: resetAt + 7 * 86400000 });
  } finally { await sources.close(); }
});

it('learns the weekly reset after an earlier short request cooldown expires', async () => {
  const path = await directory();
  await recordDataSharingConsent(path, ['tokenharbor']);
  await writeTokenHarborGrant(grant, path);
  let now = Date.parse('2026-11-21T03:04:18Z');
  let reads = 0;
  const fetcher = vi.fn<typeof fetch>(async url => {
    if (!String(url).endsWith('/free-tier')) return new Response(null, { status: 429, headers: { 'Retry-After': '30' } });
    if (++reads === 2) return new Response(null, { status: 503 });
    return Response.json({ models_enabled: true, exhausted: reads > 2,
      period_started_at: '2026-11-15T03:04:18Z', reset_at: '2026-11-22T03:04:18Z' });
  });
  const sources = new Sources([new TokenHarbor({ directory: path, fetcher, now: () => now })], { registry: () => bundledRegistry, now: () => now });
  const app = createLocalApp(sources);
  const send = (content: string) => app.request('http://127.0.0.1:8788/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, messages: [{ role: 'user', content }] })
  });
  try {
    expect((await send('First synthetic request')).headers.get('retry-after')).toBe('30');
    now += 30000;
    expect((await send('Unrelated synthetic request')).headers.get('retry-after')).toBe('86370');
    expect(sources.status().sources[0]).toMatchObject({ state: 'limited', retryAt: now + 86370000 });
    expect(fetcher).toHaveBeenCalledTimes(4);
  } finally { await sources.close(); }
});

it.each([false, true])('distinguishes a request-rate limit from an exhausted weekly allowance (%s)', async exhausted => {
  const path = await directory();
  await recordDataSharingConsent(path, ['tokenharbor']);
  await writeTokenHarborGrant(grant, path);
  const now = Date.parse('2026-11-21T03:04:18Z');
  const fetcher = vi.fn<typeof fetch>(async url => String(url).endsWith('/free-tier')
    ? Response.json({ models_enabled: true, exhausted, period_started_at: '2026-11-15T03:04:18+00:00', reset_at: '2026-11-22T03:04:18+00:00' })
    : new Response(null, { status: 429, headers: { 'Retry-After': '30' } }));
  const source = new TokenHarbor({ directory: path, fetcher, now: () => now });
  try {
    await expect(source.complete({ ...payload, tools: [], cwd: path, stream: false }, AbortSignal.timeout(1000)))
      .rejects.toMatchObject({ code: 'quota', retryAfter: exhausted ? 86400 : 30 });
    expect(source.quotaWindow()).toEqual({ startedAt: Date.parse('2026-11-15T03:04:18Z'), resetAt: now + 86400000 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  } finally { await source.close(); }
});

it.each(['deepseek-v4-flash', 'deepseek-v3.2', undefined])('does not credit a different or unidentified model to a vetted route (%s)', async model => {
  const path = await directory(); await writeZroGrant(grant, path); await recordDataSharingConsent(path, ['tokenharbor']); await writeTokenHarborGrant(grant, path);
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ ...(model === undefined ? {} : { model }), choices: [{ message: { content: 'unverified model' } }] }));
  const sources = [new Zro({ directory: path, fetcher }), new TokenHarbor({ directory: path, fetcher })];
  for (const source of sources) {
    await expect(source.complete({ ...payload, tools: [], cwd: path, stream: false }, AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'upstream' });
    await source.close();
  }
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('skips every unapproved sharing service while connecting Zro and LiveKit', async () => {
  const run = vi.fn(async () => {}), signup = vi.fn(async () => {}), provider = vi.fn(async (_notify: (line: string) => void, _providers: string[]) => ({}));
  const squire = { signup, runs: { start: vi.fn(), get: vi.fn() }, credentials: { list: vi.fn(), grant: vi.fn() } };
  const providers = bundledRegistry.adapters.map(adapter => adapter.id);
  const result = await setupFallbacks({ directory: await directory(), adapters: providers,
    squire, run, notify: () => {}, setupProvider: provider });
  expect(result.unavailable).toEqual(providers.filter(id => !['zro', 'livekit'].includes(id)));
  expect(run).not.toHaveBeenCalled(); expect(signup).not.toHaveBeenCalled();
  expect(provider).toHaveBeenCalledTimes(2); expect(provider.mock.calls.map(call => call[1])).toEqual([['zro'], ['livekit']]);
});


it('passes grouped sharing approval to custom Freebuff and OpenCode browser goals', async () => {
  const squire = new BrowserSquire({ dataSharingApproved: ['freebuff', 'opencode'] });
  const call = vi.spyOn(squire, 'call').mockResolvedValue({ status: 'complete', session_id: 'signup-session' });
  for (const provider of ['freebuff', 'opencode']) await squire.signup(provider, `https://${provider}.test/login`, 'Complete this free CLI login.');
  const goals = call.mock.calls.filter(([name]) => name === 'operate_drive').map(([, args]) => String(args.goal));
  expect(goals).toHaveLength(2);
  for (const goal of goals) expect(goal).toContain('Grunt setup enables this free source by default');
});
