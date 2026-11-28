import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundledRegistry, publishedRegistry, publishedV1Registry } from '../registry.js';
import type { Registry } from '../registry.js';
import { REGISTRY_URLS, RegistrySync } from './registry.js';

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
  const path = await directory(), notify = vi.fn(), synced = vi.fn();
  const fetcher = vi.fn<typeof fetch>(async () => Response.json(published(-1000), { headers: { ETag: '"stale"' } }));
  const sync = new RegistrySync({ directory: path, fetcher, notify, synced });
  await sync.sync();
  expect(sync.current).toEqual(bundledRegistry);
  expect(synced).toHaveBeenCalledOnce();
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
  const equivalent = {
    ...(bundledRegistry.candidates ? { candidates: structuredClone(bundledRegistry.candidates) } : {}),
    adapters: structuredClone(bundledRegistry.adapters),
    published: new Date(Date.parse(bundledRegistry.published)).toISOString().replace(/Z$/, '0Z'),
    version: 1
  };
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json(equivalent, { headers: { ETag: '"same-data"' } }))
    .mockResolvedValueOnce(new Response(null, { status: 304 }));
  const sync = new RegistrySync({ directory: await directory(), url: 'https://registry.test/v1/registry', fetcher });
  await sync.sync(); await sync.sync();
  expect(sync.current).toEqual(equivalent);
  expect(fetcher.mock.calls[1]![1]?.headers).toEqual({ 'If-None-Match': '"same-data"' });
});

it('accepts a later revocation and persists it through an offline restart', async () => {
  const path = await directory(), fresh = published(1000), changed = vi.fn(), synced = vi.fn();
  const sync = new RegistrySync({ directory: path, changed, synced,
    fetcher: async () => Response.json(fresh, { headers: { ETag: '"revoked"' } }) });
  await sync.sync();
  expect(sync.enabled.map(adapter => adapter.id)).toEqual(['kilo']);
  expect(changed).toHaveBeenCalledWith(fresh);
  expect(synced).toHaveBeenCalledTimes(1);
  expect((await stat(join(path, 'registry.json'))).mode & 0o777).toBe(0o600);
  const fetcher = vi.fn<typeof fetch>(async () => { throw new Error('offline'); });
  const restarted = new RegistrySync({ directory: path, fetcher });
  await restarted.load(); await restarted.sync();
  expect(restarted.current).toEqual(fresh);
  expect(fetcher.mock.calls[0]![1]?.headers).toEqual({ 'If-None-Match': '"revoked"' });
});

it('syncs from static GitHub Pages URL with raw GitHub fallback, redirect: error, and GRUNT_REGISTRY_URL override', async () => {
  expect(REGISTRY_URLS).toEqual([
    'https://grunt.run/v2/registry.json',
    'https://raw.githubusercontent.com/bananaman614305/grunt/main/registry/adapters.json'
  ]);
  const path = await directory(), fresh = published(1000);
  const fetcher = vi.fn<typeof fetch>()
    .mockRejectedValueOnce(new TypeError('fetch failed: redirect mode is set to error'))
    .mockResolvedValueOnce(Response.json(fresh, { headers: { ETag: '"github-raw"' } }))
    .mockResolvedValueOnce(new Response(null, { status: 304 }));
  const sync = new RegistrySync({ directory: path, fetcher });
  await sync.sync();
  expect(fetcher.mock.calls.map(([url, init]) => [url, init?.redirect])).toEqual([
    ['https://grunt.run/v2/registry.json', 'error'],
    ['https://raw.githubusercontent.com/bananaman614305/grunt/main/registry/adapters.json', 'error']
  ]);
  expect(sync.current).toEqual(fresh);

  await sync.sync();
  expect(fetcher.mock.calls[2]![0]).toBe('https://grunt.run/v2/registry.json');
  expect(fetcher.mock.calls[2]![1]).toMatchObject({ headers: { 'If-None-Match': '"github-raw"' }, redirect: 'error' });

  const customFetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('custom offline'));
  const override = new RegistrySync({ directory: await directory(), url: 'https://override.example/registry.json', fetcher: customFetcher });
  await override.sync();
  expect(customFetcher).toHaveBeenCalledOnce();
  expect(customFetcher.mock.calls[0]![0]).toBe('https://override.example/registry.json');
  expect(customFetcher.mock.calls[0]![1]?.redirect).toBe('error');
});

it('upgrades a pre-v2 cached v1 feed cleanly to the v2 feed containing Omi at both same and newer timestamps', async () => {
  // 1. Legacy v1 feed at the bundled timestamp omits declarative:app (omi) so <= 0.10.23 accepts it cleanly.
  const sameTimeV1 = publishedV1Registry(bundledRegistry);
  expect(sameTimeV1.adapters.some(adapter => adapter.id === 'omi')).toBe(false);
  const sameTimeDir = await directory();
  await writeFile(join(sameTimeDir, 'registry.json'), JSON.stringify({ registry: sameTimeV1, etag: '"v1-same"' }), { mode: 0o600 });
  const sameTimeSync = new RegistrySync({
    directory: sameTimeDir,
    fetcher: async () => Response.json(publishedRegistry(bundledRegistry), { headers: { ETag: '"v2-same"' } })
  });
  await sameTimeSync.load();
  expect(sameTimeSync.enabled.some(adapter => adapter.id === 'omi')).toBe(true);
  await sameTimeSync.sync();
  expect(JSON.parse(await readFile(join(sameTimeDir, 'registry.json'), 'utf8'))).toMatchObject({ etag: '"v2-same"', feed: 2 });

  // 2. A newer publication cached by <= 0.10.23 from /registry.json (no `feed: 2`, no `omi`)
  //    upgrades at the same timestamp once the upgraded >= 0.10.24 client syncs /v2/registry.json.
  const futureV2 = {
    ...structuredClone(publishedRegistry(bundledRegistry)),
    published: new Date(Date.parse(bundledRegistry.published) + 60_000).toISOString()
  };
  const futureV1 = publishedV1Registry(futureV2);
  expect(futureV1.adapters.some(adapter => adapter.id === 'omi')).toBe(false);
  expect(futureV2.adapters.some(adapter => adapter.id === 'omi')).toBe(true);

  const upgradeDir = await directory();
  await writeFile(join(upgradeDir, 'registry.json'), JSON.stringify({ registry: futureV1, etag: '"v1-future"' }), { mode: 0o600 });
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json(futureV2, { headers: { ETag: '"v2-future"' } }))
    .mockResolvedValueOnce(Response.json(futureV1, { headers: { ETag: '"v1-conflict"' } }));
  const upgraded = new RegistrySync({ directory: upgradeDir, fetcher });
  await upgraded.load();
  expect(upgraded.enabled.some(adapter => adapter.id === 'omi')).toBe(false);

  await upgraded.sync();
  expect(fetcher.mock.calls[0]![0]).toBe('https://grunt.run/v2/registry.json');
  expect(upgraded.enabled.some(adapter => adapter.id === 'omi')).toBe(true);
  expect(JSON.parse(await readFile(join(upgradeDir, 'registry.json'), 'utf8'))).toMatchObject({ etag: '"v2-future"', feed: 2 });

  // After upgrading to feed 2, a conflicting same-timestamp payload (like v1) is rejected again.
  await upgraded.sync();
  expect(upgraded.enabled.some(adapter => adapter.id === 'omi')).toBe(true);
});

it('rejects same-timestamp content changes on custom GRUNT_REGISTRY_URL and tampered default feed migrations', async () => {
  const futureV2 = {
    ...structuredClone(publishedRegistry(bundledRegistry)),
    published: new Date(Date.parse(bundledRegistry.published) + 60_000).toISOString()
  };
  const futureV1 = publishedV1Registry(futureV2);

  // 1. Custom GRUNT_REGISTRY_URL never allows same-timestamp replacement even from a pre-v2 cache.
  const customDir = await directory();
  await writeFile(join(customDir, 'registry.json'), JSON.stringify({ registry: futureV1, etag: '"custom-v1"' }), { mode: 0o600 });
  const customFetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json(futureV2, { headers: { ETag: '"custom-v2"' } }))
    .mockResolvedValueOnce(new Response(null, { status: 304 }));
  const custom = new RegistrySync({ directory: customDir, url: 'https://custom.example/registry.json', fetcher: customFetcher });
  await custom.load();
  await custom.sync();
  expect(custom.current).toEqual(futureV1);
  expect(custom.enabled.some(adapter => adapter.id === 'omi')).toBe(false);
  await custom.sync();
  expect(customFetcher.mock.calls[1]![1]?.headers).toEqual({ 'If-None-Match': '"custom-v1"' });

  // 2. Default feed migration still rejects same-timestamp changes to non-declarative:app entries.
  const tampered = structuredClone(futureV2);
  tampered.adapters.find(adapter => adapter.id === 'zro')!.hints = 'Tampered hint at same timestamp.';
  const defaultDir = await directory();
  await writeFile(join(defaultDir, 'registry.json'), JSON.stringify({ registry: futureV1, etag: '"v1-future"' }), { mode: 0o600 });
  const defaultSync = new RegistrySync({
    directory: defaultDir,
    fetcher: async () => Response.json(tampered, { headers: { ETag: '"tampered"' } })
  });
  await defaultSync.load();
  await defaultSync.sync();
  expect(defaultSync.current).toEqual(futureV1);
  expect(defaultSync.enabled.some(adapter => adapter.id === 'omi')).toBe(false);
});
