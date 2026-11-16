import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundledRegistry } from '../registry.js';
import type { Registry } from '../registry.js';
import { RegistrySync } from './registry.js';

const directories: string[] = [];
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'grunt-registry-freshness-'));
  directories.push(path);
  return path;
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
function published(delta: number, ids = ['kilo']): Registry {
  return { ...structuredClone(bundledRegistry), published: new Date(Date.parse(bundledRegistry.published) + delta).toISOString(),
    adapters: bundledRegistry.adapters.filter(adapter => ids.includes(adapter.id)) };
}

it.each([-1000, 0])('an npm upgrade ignores an older or conflicting saved pool without sending its ETag (offset %s)', async offset => {
  const path = await directory(), cache = join(path, 'registry.json');
  await writeFile(cache, JSON.stringify({ registry: published(offset), etag: '"old-package"' }), { mode: 0o600 });
  const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 304 }));
  const sync = new RegistrySync({ directory: path, url: 'https://registry.test/v1/registry', fetcher });
  await sync.load();
  expect(sync.current).toEqual(bundledRegistry);
  await sync.sync();
  expect(fetcher.mock.calls[0]![1]?.headers).toEqual({});
  expect(sync.enabled.map(adapter => adapter.id)).toEqual(bundledRegistry.adapters.map(adapter => adapter.id));
});

it('keeps the bundled release when every mirror offers an older pool', async () => {
  const path = await directory(), notify = vi.fn(), ensure = vi.fn(async () => {});
  const fetcher = vi.fn<typeof fetch>(async () => Response.json(published(-1000), { headers: { ETag: '"stale"' } }));
  const sync = new RegistrySync({ directory: path, fetcher, notify, ensure });
  await sync.sync();
  expect(sync.current).toEqual(bundledRegistry);
  expect(ensure.mock.calls).toHaveLength(bundledRegistry.adapters.length);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(notify).toHaveBeenCalledWith('Registry update unavailable; keeping the last good list');
  await expect(stat(join(path, 'registry.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('tries the second mirror when the custom domain serves a stale registry', async () => {
  const fresh = published(1000);
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json(published(-1000), { headers: { ETag: '"old"' } }))
    .mockResolvedValueOnce(Response.json(fresh, { headers: { ETag: '"fresh"' } }));
  const sync = new RegistrySync({ directory: await directory(), fetcher });
  await sync.sync();
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(sync.current).toEqual(fresh);
});

it('retains the last good newer pool, private cache and ETag after a stale response', async () => {
  const path = await directory(), cache = join(path, 'registry.json'), fresh = published(2000), changed = vi.fn();
  const saved = JSON.stringify({ registry: fresh, etag: '"last-good"' });
  await writeFile(cache, saved, { mode: 0o600 });
  const fetcher = vi.fn<typeof fetch>(async () => Response.json(published(1000), { headers: { ETag: '"older"' } }));
  const sync = new RegistrySync({ directory: path, fetcher, changed });
  await sync.load(); changed.mockClear(); await sync.sync();
  expect(sync.current).toEqual(fresh);
  expect(await readFile(cache, 'utf8')).toBe(saved);
  expect(changed).not.toHaveBeenCalled();
  for (const [, options] of fetcher.mock.calls) expect(options?.headers).toEqual({ 'If-None-Match': '"last-good"' });
});

it('refuses changed data at an existing publication timestamp without adopting its ETag', async () => {
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json(published(0), { headers: { ETag: '"conflict"' } }))
    .mockResolvedValueOnce(new Response(null, { status: 304 }));
  const sync = new RegistrySync({ directory: await directory(), url: 'https://registry.test/v1/registry', fetcher });
  await sync.sync(); await sync.sync();
  expect(sync.current).toEqual(bundledRegistry);
  expect(fetcher.mock.calls[1]![1]?.headers).toEqual({});
});

it('accepts identical same-time publications regardless of object-key order or ISO formatting', async () => {
  const equivalent = { adapters: structuredClone(bundledRegistry.adapters), published: new Date(Date.parse(bundledRegistry.published)).toISOString().replace(/Z$/, '0Z'), version: 1 };
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json(equivalent, { headers: { ETag: '"same-data"' } }))
    .mockResolvedValueOnce(new Response(null, { status: 304 }));
  const sync = new RegistrySync({ directory: await directory(), url: 'https://registry.test/v1/registry', fetcher });
  await sync.sync(); await sync.sync();
  expect(sync.current).toEqual(equivalent);
  expect(fetcher.mock.calls[1]![1]?.headers).toEqual({ 'If-None-Match': '"same-data"' });
});

it('accepts a later revocation and persists it through an offline restart', async () => {
  const path = await directory(), fresh = published(1000), changed = vi.fn(), ensure = vi.fn(async () => {});
  const sync = new RegistrySync({ directory: path, changed, ensure,
    fetcher: async () => Response.json(fresh, { headers: { ETag: '"revoked"' } }) });
  await sync.sync();
  expect(sync.enabled.map(adapter => adapter.id)).toEqual(['kilo']);
  expect(changed).toHaveBeenCalledWith(fresh);
  expect(ensure).toHaveBeenCalledTimes(1);
  expect((await stat(join(path, 'registry.json'))).mode & 0o777).toBe(0o600);
  const fetcher = vi.fn<typeof fetch>(async () => { throw new Error('offline'); });
  const restarted = new RegistrySync({ directory: path, fetcher });
  await restarted.load(); await restarted.sync();
  expect(restarted.current).toEqual(fresh);
  expect(fetcher.mock.calls[0]![1]?.headers).toEqual({ 'If-None-Match': '"revoked"' });
});
