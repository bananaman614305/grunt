import { afterEach, expect, it, vi } from 'vitest';
import { Sources, SourceError } from './source.js';
import type { Completion, ModelRequest, Source } from './source.js';
import { bundledRegistry } from '../registry.js';
import { createLocalApp } from './api.js';
import { SourceRecovery } from './recovery.js';
import { recordDataSharingConsent } from './data-sharing.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const request: ModelRequest = { model: 'grunt', messages: [{ role: 'user', content: 'private prompt contents' }], cwd: '/tmp', tools: [], stream: false };
const fake = (id: string): Source => ({ id, available: vi.fn(async () => true), healthCheck: vi.fn(async () => true), complete: vi.fn(async () => ({ text: 'private response' })) });
const registry = { ...bundledRegistry, adapters: ['opencode', 'kilo'].map(id => ({ ...bundledRegistry.adapters.find(a => a.id === id)!, weight: 0.5 })) };
afterEach(() => vi.restoreAllMocks());

it('serves a cached status without probes, inference, private content, or mutable snapshot references', async () => {
  const source = fake('kilo'), sources = new Sources([source], { registry: () => registry }, new Set(['freebuff']));
  const app = createLocalApp(sources);
  for (let i = 0; i < 4; i++) {
    const result = await app.request('http://127.0.0.1:8788/v1/status');
    expect(result.status).toBe(200);
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect((await result.json()).sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'kilo', state: 'unknown', modelKind: 'registry' }),
      expect.objectContaining({ id: 'freebuff', state: 'disabled' })
    ]));
  }
  expect(source.available).not.toHaveBeenCalled(); expect(source.healthCheck).not.toHaveBeenCalled(); expect(source.complete).not.toHaveBeenCalled();
  const snapshot = sources.status(); snapshot.sources[0]!.state = 'error';
  expect(sources.status().sources[0]!.state).toBe('unknown');
});

it('keeps the existing host and origin protections on cached status', async () => {
  const source = fake('kilo'), app = createLocalApp(new Sources([source]));
  expect((await app.request('http://attacker.invalid:8788/v1/status')).status).toBe(403);
  expect((await app.request('http://127.0.0.1:8788/v1/status', { headers: { origin: 'https://attacker.invalid' } })).status).toBe(403);
  expect(source.available).not.toHaveBeenCalled();
});

it('names skipped routes and safe reasons in a streamed tool request’s 429 body', async () => {
  const ids = ['beatapi', 'perch', 'mistral-vibe', 'reflection-beam', 'opencode'];
  const adapters = ids.map(id => bundledRegistry.adapters.find(adapter => adapter.id === id)!);
  const [beatapi, perch, vibe, reflection, opencode] = ids.map(id => ({ ...fake(id), supportsFunctionTools: id !== 'opencode' })) as [Source, Source, Source, Source, Source];
  vi.mocked(beatapi.available).mockResolvedValue(false);
  vi.mocked(perch.available).mockResolvedValue(false);
  vi.mocked(vibe.complete).mockRejectedValue(new SourceError('refused', 'private refusal detail'));
  vi.mocked(reflection.complete).mockRejectedValue(new SourceError('quota', 'private quota detail', 45));
  const sources = new Sources([beatapi, perch, vibe, reflection, opencode], { registry: () => ({ ...bundledRegistry, adapters }) });
  sources.setSetupFailure('beatapi', 'browser could not continue; private browser detail');
  sources.setSetupFailure('perch', 'startup isolation check failed');
  const app = createLocalApp(sources);
  try {
    const response = await app.request('http://127.0.0.1:8788/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'grunt', stream: true, messages: request.messages,
        tools: [{ type: 'function', function: { name: 'probe', parameters: { type: 'object', properties: {} } } }] }) });
    expect(response.status).toBe(429);
    const { error } = await response.json();
    expect(error.message).toContain('beatapi (setup incomplete: Squire could not finish; check Squire and rerun usegrunt setup)');
    expect(error.message).toContain('perch (startup isolation check failed; inspect startup config and rerun usegrunt setup)');
    expect(error.message).toContain('mistral-vibe (route refused the request; check provider access or select another route)');
    expect(error.message).toContain('reflection-beam (free quota or rate limit reached)');
    expect(error.message).toContain('opencode (function tools unsupported)');
    expect(error.message).not.toContain('private');
  } finally { await sources.close(); }
});

it('probes a route again right after its background signup succeeds', async () => {
  const source = fake('pollinations');
  vi.mocked(source.available).mockResolvedValue(false);
  const now = 1000;
  const sources = new Sources([source], { registry: () => bundledRegistry, now: () => now });
  try {
    expect(await sources.available(source)).toBe(false);
    vi.mocked(source.available).mockResolvedValue(true);
    // Within the negative window the stale probe still answers...
    expect(await sources.available(source)).toBe(false);
    // ...until the signup that opened the route settles.
    sources.setSetupFailure('pollinations', undefined);
    expect(await sources.available(source)).toBe(true);
  } finally { await sources.close(); }
});

it('shows failed background setup in owner status and clears it when the route becomes available', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'grunt-setup-status-'));
  const source = fake('beatapi');
  vi.mocked(source.available).mockResolvedValue(false);
  let now = 1000;
  const sources = new Sources([source], { registry: () => bundledRegistry, now: () => now });
  await sources.available(source);
  const recovery = new SourceRecovery({ directory, candidates: async () => ['beatapi'], open: async () => 0,
    setup: async options => {
      await options.onSettled?.('beatapi', false, 'provider refused; private browser detail');
      return { unavailable: ['beatapi'] };
    },
    settled: (id, reason) => sources.setSetupFailure(id, reason),
    notify: () => {} });
  try {
    // BeatAPI needs the existing grouped consent to be eligible for recovery.
    await recordDataSharingConsent(directory, ['beatapi']);
    recovery.trigger();
    const app = createLocalApp(sources);
    await vi.waitFor(async () => {
      const response = await app.request('http://127.0.0.1:8788/v1/status');
      const body = await response.json();
      expect(body.sources[0].detail).toContain('setup incomplete: provider refused access; check provider access and rerun usegrunt setup');
      expect(body.sources[0].detail).not.toContain('private');
    });
    now += 31000;
    vi.mocked(source.available).mockResolvedValue(true);
    await sources.available(source);
    expect(sources.status().sources[0]).toMatchObject({ state: 'available', detail: expect.not.stringContaining('setup incomplete') });
  } finally {
    await recovery.close();
    await sources.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it('distinguishes availability from a verified reply and tracks concurrent activity without storing text', async () => {
  let now = 1000;
  const source = fake('kilo'), sources = new Sources([source], { registry: () => registry, now: () => now });
  await sources.models();
  expect(sources.status().sources[0]).toMatchObject({ state: 'available', active: 0 });
  let resolve!: (value: Completion) => void;
  vi.mocked(source.complete).mockImplementation(() => new Promise<Completion>(done => { resolve = done; }));
  const running = sources.complete(request, new AbortController().signal);
  await vi.waitFor(() => expect(source.complete).toHaveBeenCalledOnce());
  expect(sources.status()).toMatchObject({ activeRequests: 1, sources: [{ state: 'answering', active: 1 }] });
  now = 1750; resolve({ text: 'synthetic-secret-output' }); await running;
  expect(sources.status()).toMatchObject({ activeRequests: 0, sources: [{ state: 'ready', active: 0, lastReplyMs: 750, lastSuccessAt: 1750 }] });
  expect(JSON.stringify(sources.status())).not.toMatch(/private prompt|synthetic-secret-output|\/tmp/);
});

it('counts simultaneous calls independently and does not clear the answering state until the last finishes', async () => {
  const source = fake('custom'), sources = new Sources([source]);
  const resolve: ((value: Completion) => void)[] = [];
  vi.mocked(source.complete).mockImplementation(() => new Promise<Completion>(done => { resolve.push(done); }));
  const first = sources.complete(request, new AbortController().signal), second = sources.complete(request, new AbortController().signal);
  await vi.waitFor(() => expect(source.complete).toHaveBeenCalledTimes(2));
  expect(sources.status()).toMatchObject({ activeRequests: 2, sources: [{ active: 2, state: 'answering' }] });
  resolve[0]!({ text: 'one' }); await first;
  expect(sources.status()).toMatchObject({ activeRequests: 1, sources: [{ active: 1, state: 'answering' }] });
  resolve[1]!({ text: 'two' }); await second;
  expect(sources.status()).toMatchObject({ activeRequests: 0, sources: [{ active: 0, state: 'ready' }] });
});

it('reflects failover cooldown, sanitizes raw errors, and reports expiry without issuing a probe', async () => {
  let now = 1000;
  const a = fake('opencode'), b = fake('kilo'), sources = new Sources([a, b], { registry: () => registry, random: () => 0, now: () => now });
  vi.mocked(a.complete).mockRejectedValue(new SourceError('quota', 'synthetic-secret-error https://private.invalid', 120, 'synthetic-secret-output'));
  await sources.complete(request, new AbortController().signal);
  expect(sources.status().sources).toEqual([
    expect.objectContaining({ id: 'opencode', state: 'limited', errorCode: 'quota', retryAt: 121000, active: 0, model: 'Free model rotation' }),
    expect.objectContaining({ id: 'kilo', state: 'ready', active: 0 })
  ]);
  const calls = vi.mocked(a.available).mock.calls.length;
  expect(JSON.stringify(sources.status())).not.toMatch(/synthetic-secret|private.invalid|private prompt|\/tmp|Infinity/);
  now = 121001;
  expect(sources.status().sources[0]).toMatchObject({ state: 'available' });
  expect(sources.status().sources[0]).not.toHaveProperty('retryAt');
  expect(a.available).toHaveBeenCalledTimes(calls);
});

it('shows login barriers without serializing Infinity and clears them only with existing recovery paths', async () => {
  const a = fake('opencode'), b = fake('kilo'), sources = new Sources([a, b], { registry: () => registry, random: () => 0 });
  vi.mocked(a.complete).mockRejectedValue(new SourceError('logged_out', 'synthetic credential'));
  await sources.complete(request, new AbortController().signal);
  expect(sources.status().sources[0]).toMatchObject({ state: 'unavailable', errorCode: 'logged_out' });
  expect(sources.status().sources[0]).not.toHaveProperty('retryAt');
  sources.healthy('opencode');
  expect(sources.status().sources[0]).toMatchObject({ state: 'available' });
  expect(sources.status().sources[0]).not.toHaveProperty('errorCode');
});

it('reflects the router fallback cooldown even when a provider did not report a reset time', async () => {
  let now = 1000;
  const a = fake('opencode'), b = fake('kilo'), sources = new Sources([a, b], { registry: () => registry, random: () => 0, now: () => now });
  vi.mocked(a.complete).mockRejectedValue(new SourceError('quota', 'synthetic quota'));
  await sources.complete(request, new AbortController().signal);
  expect(sources.status().sources[0]).toMatchObject({ state: 'limited', retryAt: 3601000 });
  now = 3601001;
  expect(sources.status().sources[0]).toMatchObject({ state: 'available' });
  expect(sources.status().sources[0]).not.toHaveProperty('retryAt');
});

it('renders setup gates and retired or removed sources without touching native clients', () => {
  let current = registry;
  const a = fake('opencode'), b = fake('kilo'), sources = new Sources([a, b], { registry: () => current }, new Set(['freebuff', 'apinex']));
  sources.pending.add('opencode'); sources.pending.add('kilo'); sources.verifying.add('kilo');
  expect(sources.status().sources).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'opencode', state: 'connecting' }), expect.objectContaining({ id: 'kilo', state: 'verifying' }),
    expect.objectContaining({ id: 'freebuff', state: 'disabled' }), expect.objectContaining({ id: 'apinex', state: 'disabled' })
  ]));
  current = { ...registry, adapters: [registry.adapters[1]!] };
  expect(sources.status().sources[0]).toMatchObject({ state: 'disabled' });
  expect(a.available).not.toHaveBeenCalled(); expect(b.available).not.toHaveBeenCalled();
});

it('does not let a cancelled call erase a successful observation or become an error', async () => {
  const source = fake('custom'), sources = new Sources([source]);
  await sources.complete(request, new AbortController().signal);
  const controller = new AbortController();
  vi.mocked(source.complete).mockImplementation(async () => { controller.abort(); throw new SourceError('cancelled', 'synthetic cancellation'); });
  await expect(sources.complete(request, controller.signal)).rejects.toThrow();
  expect(sources.status().sources[0]).toMatchObject({ state: 'ready', active: 0 });
  expect(sources.status().sources[0]).not.toHaveProperty('errorCode');
});

it('marks a previously ready source unavailable when a later availability probe rejects', async () => {
  const source = fake('custom'), sources = new Sources([source]);
  await sources.complete(request, new AbortController().signal);
  expect(sources.status().sources[0]).toMatchObject({ state: 'ready' });
  vi.mocked(source.available).mockRejectedValue(new Error('synthetic-private-probe-error'));
  await expect(sources.models()).rejects.toThrow('synthetic-private-probe-error');
  expect(sources.status().sources[0]).toMatchObject({ state: 'unavailable', active: 0 });
  expect(JSON.stringify(sources.status())).not.toContain('synthetic-private-probe-error');
});

it.each(['reject', 'false'] as const)('ignores a stale availability %s after a newer successful reply', async outcome => {
  const source = fake('custom'), sources = new Sources([source]);
  let finish!: () => void;
  vi.mocked(source.available).mockImplementation(() => new Promise<boolean>((resolve, reject) => {
    finish = () => outcome === 'reject' ? reject(new Error('synthetic old probe')) : resolve(false);
  }));
  const probe = sources.models();
  // Observe both outcomes immediately so the rejected probe cannot become an
  // unhandled rejection while the independent successful request finishes.
  const settled = probe.then(() => undefined, () => undefined);
  await sources.complete(request, new AbortController().signal);
  finish(); await settled;
  expect(sources.status().sources[0]).toMatchObject({ state: 'ready', active: 0 });
});

it('keeps an active setup probe verifying until its successful reply is admitted', async () => {
  const source = fake('kilo'), sources = new Sources([source], { registry: () => registry });
  let finish!: (value: Completion) => void;
  vi.mocked(source.complete).mockImplementation(() => new Promise<Completion>(resolve => { finish = resolve; }));
  sources.pending.add('kilo'); sources.verifying.add('kilo');
  const checking = sources.complete({ ...request, model: 'kilo' }, new AbortController().signal);
  expect(sources.status()).toMatchObject({ activeRequests: 1, sources: [{ state: 'verifying', active: 1 }] });
  expect(sources.status().sources[0]).not.toHaveProperty('lastSuccessAt');
  finish({ text: 'verified setup reply' }); await checking;
  expect(sources.status().sources[0]).toMatchObject({ state: 'verifying', active: 0, lastSuccessAt: expect.any(Number) });
  sources.pending.delete('kilo'); sources.verifying.delete('kilo');
  expect(sources.status().sources[0]).toMatchObject({ state: 'ready', active: 0 });
});

it('surfaces providers blocked on human verification as approval state with a usegrunt add resume hint', async () => {
  const source = fake('darus');
  vi.mocked(source.available).mockResolvedValue(false);
  const sources = new Sources([source], { registry: () => bundledRegistry });
  try {
    await sources.available(source);
    sources.setSetupFailure('darus', 'needs human verification; Cloudflare challenge');
    const row = sources.status().sources.find(item => item.id === 'darus')!;
    expect(row.state).toBe('approval');
    expect(row.detail).toContain('browser verification required; run usegrunt add darus');
    expect(row.detail).not.toContain('Cloudflare');
    sources.healthy('darus');
    expect(sources.status().sources.find(item => item.id === 'darus')?.state).toBe('available');
  } finally { await sources.close(); }
});
