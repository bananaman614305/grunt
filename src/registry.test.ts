import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundledRegistry, validateRegistry } from './registry.js';
import { RegistrySync, REGISTRY_INTERVAL } from './local/registry.js';
import { registryRoutes } from './registry-routes.js';

const directories: string[] = [];
async function directory() { const path = await mkdtemp(join(tmpdir(), 'grunt-registry-')); directories.push(path); return path; }
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

it('ships vetted Freebuff, OpenCode and Kilo and validates tier weights', () => {
  expect(bundledRegistry.adapters.map(adapter => adapter.id)).toEqual(['freebuff', 'opencode', 'kilo']);
  expect(validateRegistry(bundledRegistry)).toEqual(bundledRegistry);
  const experimental = { ...bundledRegistry.adapters[0]!, id: 'future', tier: 'experimental', weight: 0.2 };
  expect(validateRegistry({ ...bundledRegistry, adapters: [...bundledRegistry.adapters.map(a => ({ ...a, weight: a.weight * 0.8 })), experimental] }).adapters).toHaveLength(4);
  expect(() => validateRegistry({ ...bundledRegistry, adapters: [...bundledRegistry.adapters, { ...experimental, weight: 0.3 }] })).toThrow();
});
it.each([
  { version: 2 }, { published: 'invalid' }, { adapters: [] },
  { adapters: [{ ...bundledRegistry.adapters[0], weight: -1 }] },
  { adapters: [{ ...bundledRegistry.adapters[0], modalities: ['video'] }] },
  { adapters: [bundledRegistry.adapters[0], bundledRegistry.adapters[0]] }
])('rejects invalid registries: %j', invalid => { expect(() => validateRegistry({ ...bundledRegistry, ...invalid })).toThrow(); });

it('gateway down keeps cached list and persists private cache', async () => {
  const path = await directory();
  const updated = { ...bundledRegistry, published: '2026-11-12T00:00:00Z', adapters: [bundledRegistry.adapters[1]] };
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
it('syncs at startup and daily, and stops syncing on close', async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 304 }));
  const sync = new RegistrySync({ directory: await directory(), fetcher });
  try {
    await sync.start(); expect(fetcher).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(REGISTRY_INTERVAL - 1); expect(fetcher).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1); expect(fetcher).toHaveBeenCalledTimes(2);
    await sync.close(); await vi.advanceTimersByTimeAsync(REGISTRY_INTERVAL); expect(fetcher).toHaveBeenCalledTimes(2);
  } finally { await sync.close(); vi.useRealTimers(); }
});
it.each([new Response('bad json'), Response.json({ version: 9 }), new Response(null, { status: 503 }), new Response(null, { status: 304 })])('retains the bundled list on invalid or unavailable responses', async response => {
  const sync = new RegistrySync({ directory: await directory(), fetcher: async () => response });
  await sync.load(); await sync.sync(); expect(sync.current).toEqual(bundledRegistry);
});
it('ignores unknown adapter code and retries provisioning known additions without removing installed adapters', async () => {
  const ensure = vi.fn().mockRejectedValueOnce(new Error('needs human')).mockResolvedValue(undefined);
  const unknown = { ...bundledRegistry.adapters[0]!, id: 'unknown' };
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ ...bundledRegistry, adapters: [bundledRegistry.adapters[0], unknown] }, { headers: { ETag: '"first"' } }))
    .mockResolvedValueOnce(new Response(null, { status: 304 }))
    .mockResolvedValueOnce(Response.json({ ...bundledRegistry, adapters: [bundledRegistry.adapters[1]] }));
  const sync = new RegistrySync({ directory: await directory(), fetcher, ensure });
  await sync.load(); await sync.sync(); await sync.sync();
  expect(ensure.mock.calls.map(([adapter]) => adapter.id)).toEqual(['freebuff', 'freebuff']);
  expect(sync.enabled.map(adapter => adapter.id)).toEqual(['freebuff']);
  await sync.sync(); expect(sync.enabled.map(adapter => adapter.id)).toEqual(['opencode']);
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
  expect(workflow).toContain("github.actor == 'lunchboxfortwo'");
  expect(workflow).toContain("github.ref == 'refs/heads/main'");
  expect(workflow.indexOf('dist/registry.js')).toBeLessThan(workflow.indexOf('flyctl ssh'));
});
