import { afterEach, expect, it, vi } from 'vitest';
import { createClient } from '@libsql/client';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundledRegistry } from '../registry.js';
import { registryRoutes } from '../registry-routes.js';
import { FEEDBACK_ROUTE_FIELDS, RegistryStore } from '../registry-store.js';
import { FEEDBACK_ROUTE_KEYS, RouteFeedback } from './route-feedback.js';
import { Sources } from './source.js';
import type { ModelRequest, Source } from './source.js';
import { SourceError } from './source.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const step of cleanup.splice(0)) await step(); });
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'grunt-route-feedback-'));
  cleanup.push(() => rm(path, { recursive: true, force: true }));
  return path;
}
const NOW = Date.parse('2026-11-23T12:00:00Z');
const listed = () => bundledRegistry.adapters.map(adapter => adapter.id);

// C3c: the sender's payload is exactly the documented field list.
it('sends only the documented counts, which the registry accepts', async () => {
  expect([...FEEDBACK_ROUTE_KEYS]).toEqual([...FEEDBACK_ROUTE_FIELDS]);
  const feedback = new RouteFeedback({ directory: await directory(), urls: [], listed, retired: id => id === 'kilo', client: '0.10.0', now: () => NOW });
  feedback.record('zro', 'ok', 1840); feedback.record('zro', 'ok', 1840);
  feedback.record('zro', 'upstream'); feedback.record('zro', 'timeout'); feedback.record('zro', 'refused');
  feedback.record('zro', 'quota'); feedback.record('zro', 'logged_out'); feedback.record('zro', 'not_installed'); feedback.record('zro', 'cancelled');
  feedback.record('kilo', 'upstream'); feedback.signup('zro', true); feedback.signup('zro', false);
  feedback.record('not-listed', 'ok', 10);
  const payload = feedback.payload('2026-11-23', 'c'.repeat(32))!;
  expect(Object.keys(payload)).toEqual(['version', 'install', 'client', 'day', 'routes']);
  for (const route of payload.routes) expect(Object.keys(route)).toEqual([...FEEDBACK_ROUTE_KEYS]);
  expect(payload.routes).toEqual([
    { id: 'zro', ok: 2, failed: 3, quota: 1, auth: 2, latency_ms: 1800, signup_ok: 1, signup_failed: 1, retired: false },
    { id: 'kilo', ok: 0, failed: 1, quota: 0, auth: 0, latency_ms: 0, signup_ok: 0, signup_failed: 0, retired: true }
  ]);
});

it('reports to the registry on each exchange, reads nothing back and keeps one private install id', async () => {
  const path = await directory(), registryDirectory = await directory();
  await writeFile(join(registryDirectory, 'registry.json'), JSON.stringify(bundledRegistry));
  const client = createClient({ url: 'file::memory:' });
  cleanup.push(async () => client.close());
  let now = NOW;
  const store = new RegistryStore(client, () => now);
  await store.init();
  const app = registryRoutes({ path: join(registryDirectory, 'registry.json'), store, now: () => now });
  const fetcher = vi.fn<typeof fetch>((input, init) => Promise.resolve(app.request(String(input).replace('https://registry.test', ''), init)));
  const feedback = new RouteFeedback({ directory: path, urls: ['https://registry.test/v1/registry'], listed, retired: () => false, client: '0.10.0', fetcher, now: () => now });
  for (let i = 0; i < 20; i++) feedback.record('zro', 'ok', 1500);
  await feedback.exchange();
  expect(fetcher.mock.calls.map(([url, init]) => [String(url), init?.method ?? 'GET'])).toEqual([
    ['https://registry.test/v1/registry/feedback', 'POST']]);
  expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/scores'))).toBe(false);
  expect('score' in feedback).toBe(false);
  const install = (await readFile(join(path, 'registry-install'), 'utf8')).trim();
  expect(install).toMatch(/^[0-9a-f]{32}$/);
  expect((await stat(join(path, 'registry-install'))).mode & 0o777).toBe(0o600);
  // After midnight, yesterday's final totals go once, then only today's.
  now += 24 * 60 * 60 * 1000;
  feedback.record('zro', 'ok', 1500);
  fetcher.mockClear();
  await feedback.exchange();
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST').map(([, init]) => JSON.parse(String(init!.body)).day)).toEqual(['2026-11-23', '2026-11-24']);
  fetcher.mockClear();
  await feedback.exchange();
  const sent = fetcher.mock.calls.filter(([, init]) => init?.method === 'POST').map(([, init]) => JSON.parse(String(init!.body)));
  expect(sent.map(body => [body.day, body.install])).toEqual([['2026-11-24', install]]);
  expect((await client.execute('SELECT DISTINCT install FROM registry_feedback')).rows.map(row => row.install)).toEqual([install]);
});

it('keeps routing working when the registry cannot be reached', async () => {
  const feedback = new RouteFeedback({ directory: await directory(), urls: ['https://registry.test/v1/registry'], listed, retired: () => false,
    fetcher: vi.fn<typeof fetch>().mockRejectedValue(new Error('offline')), now: () => NOW });
  feedback.record('zro', 'ok', 100);
  await expect(feedback.exchange()).resolves.toBeUndefined();
});

// Q3: the routing draw uses only the git adapter weight and local observations.
const request: ModelRequest = { model: 'grunt', messages: [{ role: 'user', content: 'Complete a synthetic task.' }], cwd: '/tmp', tools: [], stream: false };
const source = (id: string): Source => ({ id, available: async () => true, complete: async () => ({ text: id }) });
it('weights the routing draw by the git adapter weight, not a remote score', async () => {
  expect('setRegistryScores' in Sources.prototype).toBe(false);
  const pick = async (weights: Record<string, number>) => {
    const items = [source('kilo'), source('zro')];
    const pool = new Sources(items, { registry: () => ({ ...bundledRegistry, adapters: items.map(item => ({ ...bundledRegistry.adapters.find(a => a.id === item.id)!, weight: weights[item.id]! })) }), random: () => 0.4 });
    cleanup.push(() => pool.close());
    return (await pool.complete({ ...request, userMessages: ['synthetic task'] }, AbortSignal.timeout(2000))).text;
  };
  expect(await pick({ kilo: 1, zro: 1 })).toBe('kilo');
  expect(await pick({ kilo: 1, zro: 4 })).toBe('zro');
  expect(await pick({ kilo: 4, zro: 1 })).toBe('kilo');
});

it('counts routed replies by outcome for the feedback report', async () => {
  const outcomes: [string, string][] = [];
  const failing: Source = { id: 'zro', available: async () => true, complete: async () => { throw new SourceError('upstream', 'synthetic failure'); } };
  const pool = new Sources([failing, source('kilo')], { registry: () => bundledRegistry, random: () => 0 });
  cleanup.push(() => pool.close());
  pool.setFeedback((id, outcome) => outcomes.push([id, outcome]));
  await pool.complete({ ...request, model: 'grunt', userMessages: ['synthetic task'] }, AbortSignal.timeout(2000));
  await pool.complete({ ...request, model: 'kilo', userMessages: ['synthetic task'] }, AbortSignal.timeout(2000));
  // Automatic routing falls back to Kilo; each settled reply counts once.
  expect(outcomes).toEqual([['zro', 'upstream'], ['kilo', 'ok'], ['kilo', 'ok']]);
});

it('exchanges feedback after every registry refresh without holding up route opening', async () => {
  const { RegistrySync } = await import('./registry.js');
  let release!: () => void;
  const exchange = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
  const synced = vi.fn();
  const sync = new RegistrySync({ directory: await directory(), fetcher: vi.fn<typeof fetch>(async () => new Response(null, { status: 304 })), exchange, synced });
  await sync.sync();
  expect(exchange).toHaveBeenCalledOnce();
  expect(synced).toHaveBeenCalledOnce();
  release();
  await sync.sync();
  expect(exchange).toHaveBeenCalledTimes(2);
  await sync.close();
});
