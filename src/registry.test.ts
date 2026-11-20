import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundledRegistry, disabledAdapters, knownAdapters, validateRegistry } from './registry.js';
import { RegistrySync, REGISTRY_INTERVAL } from './local/registry.js';
import { registryRoutes } from './registry-routes.js';

const directories: string[] = [];
async function directory() { const path = await mkdtemp(join(tmpdir(), 'grunt-registry-')); directories.push(path); return path; }
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

it('preserves the established vetted sources while allowing reviewed pool additions', () => {
  const established = ['opencode', 'kilo', 'zro', 'tokenharbor', 'runcrate', 'mistral-vibe', 'livekit', 'pollinations', 'beatapi', 'clixad', 'perch'];
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
it('syncs at startup and each UTC midnight, and stops syncing on close', async () => {
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
it('keeps daily provisioning scheduled when cleanup fails after a background run', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-15T23:00:00Z'));
  const notify = vi.fn(), afterEnsure = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('Squire close failed')).mockResolvedValue(undefined);
  const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 304 }));
  const sync = new RegistrySync({ directory: await directory(), fetcher, afterEnsure, notify });
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
it('ignores unknown adapter code and retries provisioning known additions without removing installed adapters', async () => {
  const ensure = vi.fn().mockRejectedValueOnce(new Error('needs human')).mockResolvedValue(undefined);
  const unknown = { ...bundledRegistry.adapters.find(adapter => adapter.id === 'kilo')!, id: 'unknown', install: 'npm:unknown' };
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ ...bundledRegistry, published: new Date(Date.parse(bundledRegistry.published) + 1000).toISOString(), adapters: [bundledRegistry.adapters[0], unknown] }, { headers: { ETag: '"first"' } }))
    .mockResolvedValueOnce(new Response(null, { status: 304 }))
    .mockResolvedValueOnce(Response.json({ ...bundledRegistry, published: new Date(Date.parse(bundledRegistry.published) + 2000).toISOString(), adapters: [bundledRegistry.adapters[1]] }));
  const sync = new RegistrySync({ directory: await directory(), fetcher, ensure });
  await sync.load(); await sync.sync(); await sync.sync();
  expect(ensure.mock.calls.map(([adapter]) => adapter.id)).toEqual(['opencode', 'opencode']);
  expect(sync.enabled.map(adapter => adapter.id)).toEqual(['opencode']);
  await sync.sync(); expect(sync.enabled.map(adapter => adapter.id)).toEqual(['kilo']);
});
it('serves only manually published registry data with conditional requests', async () => {
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
it('restricts publication to owner dispatch on main and validates before uploading', async () => {
  const workflow = await readFile('.github/workflows/registry.yml', 'utf8');
  expect(workflow).toContain('workflow_dispatch:');
  expect(workflow).not.toMatch(/^\s+(?:push|pull_request|schedule):/m);
  expect(workflow).toContain('github.actor == github.repository_owner');
  expect(workflow).toContain("github.ref == 'refs/heads/main'");
  expect(workflow.indexOf('dist/registry.js')).toBeLessThan(workflow.indexOf('flyctl ssh'));
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
