import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { configure } from './main.js';
import { createLocalApp } from './api.js';
import { RegistrySync } from './registry.js';
import { bundledRegistry, knownAdapters, localOptInAdapters } from '../registry.js';
import type { Adapter, Registry } from '../registry.js';

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'grunt-retired-routing-'));
  directories.push(path);
  return path;
}
const retired = ['freebuff', 'apinex', 'clixad'];
function legacyRegistry(offset: number): Registry {
  const adapters: Adapter[] = [
    { id: 'freebuff', kind: 'agent', tier: 'stable', weight: 0.3, modalities: ['text'], install: 'npm:freebuff' },
    { id: 'apinex', kind: 'model', tier: 'stable', weight: 0.3, modalities: ['text'], install: 'builtin:apinex' },
    { ...bundledRegistry.adapters.find(adapter => adapter.id === 'opencode')!, tier: 'stable', weight: 0.4 }
  ];
  return { version: 1, published: new Date(Date.parse(bundledRegistry.published) + offset).toISOString(), adapters };
}

it.each([-1000, 1000])('never re-enables retired routes from stale or freshly republished legacy caches (offset %s)', async offset => {
  const path = await directory(), registry = legacyRegistry(offset);
  const expected = offset < 0 ? bundledRegistry : registry;
  const expectedIds = expected.adapters.filter(adapter => !retired.includes(adapter.id)).map(adapter => adapter.id);
  const saved = JSON.stringify({ registry, etag: '"old-release"' });
  await writeFile(join(path, 'registry.json'), saved, { mode: 0o600 });
  const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 304 }));
  const sync = new RegistrySync({ directory: path, fetcher });
  try {
    await sync.load();
    expect(sync.current).toEqual(expected);
    expect(sync.enabled.map(adapter => adapter.id)).toEqual(expectedIds);
    await sync.sync();
    expect(sync.enabled.map(adapter => adapter.id)).toEqual(expectedIds);
    expect(await readFile(join(path, 'registry.json'), 'utf8')).toBe(saved);
    const sources = configure({ GRUNT_CONFIG_DIR: path }, () => sync.current);
    expect(sources.sources.map(source => source.id)).toEqual(expectedIds);
    await sources.close();
  } finally { await sync.close(); }
});

it.each(['freebuff,apinex,opencode', 'opencode,freebuff,apinex', 'clixad,opencode', 'opencode,clixad'])('filters old saved source selections (%s)', async selection => {
  const sources = configure({ GRUNT_SOURCES: selection, GRUNT_CONFIG_DIR: await directory() });
  expect(sources.sources.map(source => source.id)).toEqual(['opencode']);
  await sources.close();
});

it('still rejects unrecognized saved sources rather than treating every unknown ID as retired', async () => {
  const path = await directory();
  expect(() => configure({ GRUNT_SOURCES: 'unrecognized-source,opencode', GRUNT_CONFIG_DIR: path }))
    .toThrow('Unknown grunt source: unrecognized-source');
});

it.each(['opencode', 'opencode,codex'])('rejects explicit retired models before probing or routing to any remaining source (%s)', async selection => {
  const sources = configure({ GRUNT_SOURCES: selection, GRUNT_CONFIG_DIR: await directory() });
  const available = sources.sources.map(source => vi.spyOn(source, 'available').mockResolvedValue(true));
  const completions = sources.sources.map(source => vi.spyOn(source, 'complete').mockResolvedValue({ text: 'must not answer' }));
  const fetcher = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected network'));
  try {
    const app = createLocalApp(sources);
    for (const model of retired) {
      const response = await app.request('http://localhost:8788/v1/chat/completions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, cwd: await directory(), messages: [{ role: 'user', content: 'Hello' }] })
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: { message: `${model} routing is disabled` } });
    }
    for (const call of [...available, ...completions]) expect(call).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  } finally { await sources.close(); }
});

it.each(['freebuff,apinex', 'clixad', 'freebuff,apinex,clixad', ''])('keeps an empty or retired-only saved installation reachable without silently selecting a replacement (%s)', async selection => {
  const sources = configure({ GRUNT_SOURCES: selection, GRUNT_CONFIG_DIR: await directory() });
  expect(sources.sources).toEqual([]);
  const app = createLocalApp(sources);
  const response = await app.request('http://localhost:8788/v1/models');
  expect(response.status).toBe(200);
  expect((await response.json()).data.map((model: { id: string }) => model.id)).toEqual(['grunt']);
  await expect(sources.complete({ model: 'grunt', cwd: await directory(), messages: [{ role: 'user', content: 'Hello' }], tools: [], stream: false }, new AbortController().signal)).rejects.toThrow();
  await sources.close();
});

it.each(['builtin:clixad', 'npm:clixad'])('never restores removed Clixad from a newer cached registry (%s)', async install => {
  const path = await directory();
  const registry = { version: 1, published: new Date(Date.parse(bundledRegistry.published) + 1000).toISOString(), adapters: [
    { id: 'clixad', kind: 'agent', tier: 'stable', weight: 0.5, modalities: ['text'], install },
    { ...bundledRegistry.adapters.find(adapter => adapter.id === 'opencode')!, tier: 'stable', weight: 0.5 }
  ] };
  const saved = JSON.stringify({ registry, etag: '"removed-provider"' });
  await writeFile(join(path, 'registry.json'), saved, { mode: 0o600 });
  const sync = new RegistrySync({ directory: path, fetcher: vi.fn<typeof fetch>(async () => new Response(null, { status: 304 })) });
  try {
    await sync.load();
    expect(sync.enabled.map(adapter => adapter.id)).not.toContain('clixad');
    expect(knownAdapters.has('clixad')).toBe(false);
    expect(localOptInAdapters.some(adapter => adapter.id === 'clixad')).toBe(false);
    const sources = configure({ GRUNT_CONFIG_DIR: path, GRUNT_OPT_IN_SOURCES: 'clixad' }, () => sync.current);
    expect(sources.sources.map(source => source.id)).not.toContain('clixad');
    await sources.close();
    expect(await readFile(join(path, 'registry.json'), 'utf8')).toBe(saved);
  } finally { await sync.close(); }
});
