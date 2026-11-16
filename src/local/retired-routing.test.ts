import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { configure } from './main.js';
import { createLocalApp } from './api.js';
import { RegistrySync } from './registry.js';
import { bundledRegistry } from '../registry.js';
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
const retired = ['freebuff', 'apinex'];
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
  const ensure = vi.fn(async (_adapter: Adapter) => {});
  const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 304 }));
  const sync = new RegistrySync({ directory: path, ensure, fetcher });
  try {
    await sync.load();
    expect(sync.current).toEqual(expected);
    expect(sync.enabled.map(adapter => adapter.id)).toEqual(expectedIds);
    await sync.sync();
    expect(ensure.mock.calls.map(([adapter]) => adapter.id)).toEqual(expectedIds);
    expect(await readFile(join(path, 'registry.json'), 'utf8')).toBe(saved);
    const sources = configure({ MILO_CONFIG_DIR: path }, () => sync.current);
    expect(sources.sources.map(source => source.id)).toEqual(expectedIds);
    await sources.close();
  } finally { await sync.close(); }
});

it.each(['freebuff,apinex,opencode', 'opencode,freebuff,apinex'])('filters old saved source selections (%s)', async selection => {
  const sources = configure({ MILO_SOURCES: selection, MILO_CONFIG_DIR: await directory() });
  expect(sources.sources.map(source => source.id)).toEqual(['opencode']);
  await sources.close();
});

it.each(['opencode', 'opencode,codex'])('rejects explicit retired models before probing or routing to any remaining source (%s)', async selection => {
  const sources = configure({ MILO_SOURCES: selection, MILO_CONFIG_DIR: await directory() });
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

it.each(['freebuff,apinex', ''])('keeps an empty or retired-only saved installation reachable without silently selecting a replacement (%s)', async selection => {
  const sources = configure({ MILO_SOURCES: selection, MILO_CONFIG_DIR: await directory() });
  expect(sources.sources).toEqual([]);
  const app = createLocalApp(sources);
  const response = await app.request('http://localhost:8788/v1/models');
  expect(response.status).toBe(200);
  expect((await response.json()).data.map((model: { id: string }) => model.id)).toEqual(['grunt', 'milo']);
  await expect(sources.complete({ model: 'grunt', cwd: await directory(), messages: [{ role: 'user', content: 'Hello' }], tools: [], stream: false }, new AbortController().signal)).rejects.toThrow();
  await sources.close();
});
