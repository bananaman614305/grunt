import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { RegistrySource } from './registry-source.js';
import { ConsentSource } from './consent-source.js';
import { recordDataSharingConsent } from './data-sharing.js';
import { configure } from './main.js';
import type { ModelRequest } from './source.js';

const directories: string[] = [];
async function directory() { const value = await mkdtemp(join(tmpdir(), 'grunt-consent-source-')); directories.push(value); return value; }
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const request: ModelRequest = { model: 'grunt', messages: [{ role: 'user', content: 'hello' }], tools: [], cwd: process.cwd(), stream: false };

it.each(['freebuff', 'opencode', 'kilo'])('gates %s before consulting installed credentials and rechecks after receipt removal', async id => {
  const path = await directory();
  const delegate = { id, supportsFunctionTools: true, available: vi.fn(async () => true), healthCheck: vi.fn(async () => true), complete: vi.fn(async () => ({ text: 'hello' })), close: vi.fn(async () => {}) };
  const source = new ConsentSource(delegate, path);
  expect(source.supportsFunctionTools).toBe(true);
  expect(await source.available()).toBe(false);
  expect(await source.healthCheck()).toBe(false);
  await expect(source.complete(request, AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'refused' });
  expect(delegate.available).not.toHaveBeenCalled(); expect(delegate.healthCheck).not.toHaveBeenCalled(); expect(delegate.complete).not.toHaveBeenCalled();
  await recordDataSharingConsent(path, [id]);
  expect(await source.available()).toBe(true); expect(await source.healthCheck()).toBe(true);
  await source.complete(request, AbortSignal.timeout(1000)); expect(delegate.complete).toHaveBeenCalledOnce();
  await rm(join(path, 'data-sharing-consent.json'));
  expect(await source.available()).toBe(false);
  await expect(source.complete(request, AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'refused' });
  expect(delegate.complete).toHaveBeenCalledOnce();
  await source.close(); expect(delegate.close).toHaveBeenCalledOnce();
});

it('guards explicit vetted adapters while preserving a Codex source', async () => {
  const sources = configure({ GRUNT_CONFIG_DIR: await directory(), GRUNT_SOURCES: 'freebuff,apinex,opencode,kilo,codex,zro' });
  expect(sources.sources.filter(source => source instanceof RegistrySource && source.source instanceof ConsentSource).map(source => source.id)).toEqual(['opencode', 'kilo']);
  expect(sources.sources.map(source => source.id)).toEqual(['opencode', 'kilo', 'codex', 'zro']);
  for (const source of sources.sources.filter(source => ['opencode', 'kilo'].includes(source.id))) expect(await source.available()).toBe(false);
  await sources.close();
});

it('enforces registry revocation with Codex in the same list', async () => {
  const { bundledRegistry } = await import('../registry.js');
  const registry = structuredClone(bundledRegistry);
  const sources = configure({ GRUNT_CONFIG_DIR: await directory(), GRUNT_SOURCES: 'codex,zro' }, () => registry);
  const zro = sources.sources.find(source => source.id === 'zro')!;
  const legacy = sources.sources.find(source => source.id === 'codex')!;
  expect(zro).toBeInstanceOf(RegistrySource); expect(legacy).not.toBeInstanceOf(RegistrySource);
  const delegate = (zro as RegistrySource).source;
  const available = vi.spyOn(delegate, 'available').mockResolvedValue(true);
  const complete = vi.spyOn(delegate, 'complete').mockResolvedValue({ text: 'hello' });
  expect(await zro.available()).toBe(true);
  await zro.complete(request, AbortSignal.timeout(1000)); expect(complete).toHaveBeenCalledOnce();
  registry.adapters = registry.adapters.filter(adapter => adapter.id !== 'zro');
  expect(await zro.available()).toBe(false);
  await expect(Promise.resolve().then(() => zro.complete(request, AbortSignal.timeout(1000)))).rejects.toMatchObject({ code: 'refused' });
  expect(available).toHaveBeenCalledOnce(); expect(complete).toHaveBeenCalledOnce();
  await sources.close();
});
