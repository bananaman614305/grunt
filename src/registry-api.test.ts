import { afterEach, expect, it, vi } from 'vitest';
import { createClient } from '@libsql/client';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ADAPTER_FIELDS, CANDIDATE_FIELDS, HINTS_MAX, TIER_TOTALS, bundledRegistry, installers, validateRegistry } from './registry.js';
import type { Registry } from './registry.js';
import { registryRoutes } from './registry-routes.js';
import { RegistryStore } from './registry-store.js';
import type { Scores } from './registry-store.js';
import { EXAMPLE_CANDIDATE } from './registry-instructions.js';
// @ts-expect-error The recorded 0.9.7 validator is plain JavaScript.
import { BUNDLED_PUBLISHED, validateRegistry as validate097 } from './local/fixtures/registry-0.9.7.mjs';

// Synthetic GitHub tokens for an offline fake GitHub API; none is a real credential.
const tokens = {
  owner: 'synthetic-owner-token-0000000000000000000001',
  bananaman: 'synthetic-banana-token-000000000000000000002',
  reader: 'synthetic-reader-token-000000000000000000003',
  revoked: 'synthetic-revoked-token-00000000000000000004'
};
const accounts: Record<string, { login: string; push: boolean }> = {
  [tokens.owner]: { login: 'lunchboxfortwo', push: true },
  [tokens.bananaman]: { login: 'bananaman614305', push: true },
  [tokens.reader]: { login: 'someone-else', push: false }
};
const github = vi.fn<typeof fetch>(async (input, init) => {
  const url = String(input), token = new Headers(init?.headers).get('Authorization')?.replace(/^Bearer /, '') ?? '';
  const account = accounts[token];
  if (!account) return Response.json({ message: 'Bad credentials' }, { status: 401 });
  if (url === 'https://api.github.com/user') return Response.json({ login: account.login });
  if (url === 'https://api.github.com/repos/bananaman614305/grunt') return Response.json({ permissions: { admin: account.login === 'bananaman614305', push: account.push, pull: true } });
  return Response.json({ message: 'Not Found' }, { status: 404 });
});

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); github.mockClear(); for (const step of cleanup.splice(0)) await step(); });
const DAY = 24 * 60 * 60 * 1000;
async function server(options: { published?: Registry | string; start?: number } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'grunt-registry-api-'));
  const client = createClient({ url: 'file::memory:' });
  cleanup.push(async () => { client.close(); await rm(directory, { recursive: true, force: true }); });
  const path = join(directory, 'registry.json');
  if (options.published !== undefined) await writeFile(path, typeof options.published === 'string' ? options.published : JSON.stringify(options.published));
  const clock = { now: options.start ?? Date.parse('2026-11-23T12:00:00Z') };
  const store = new RegistryStore(client, () => clock.now);
  await store.init();
  const app = registryRoutes({ path, store, fetcher: github, now: () => clock.now, commit: 'a'.repeat(40) });
  const request = (method: string, url: string, body?: unknown, token?: string) => app.request(url, {
    method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) })
  });
  const registry = async () => await (await request('GET', '/v1/registry')).json() as Registry;
  const scores = async () => await (await request('GET', '/v1/registry/scores')).json() as Scores;
  return { app, client, path, store, clock, request, registry, scores };
}
const entry = (id: string) => structuredClone(bundledRegistry.adapters.find(adapter => adapter.id === id)!);

// C1: both owners, or their agents, write with their own GitHub credentials.
it('accepts writes from any account that can push to the repository, and no other', async () => {
  const api = await server();
  const errors = vi.spyOn(console, 'error'), logs = vi.spyOn(console, 'log');
  for (const token of [tokens.owner, tokens.bananaman]) {
    const response = await api.request('PUT', '/v1/registry/entries/zro', entry('zro'), token);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ placed: 'adapters', published: expect.any(String), etag: expect.stringMatching(/^"[0-9a-f]{64}"$/) });
  }
  expect((await api.request('PUT', '/v1/registry/entries/zro', entry('zro'), tokens.reader)).status).toBe(403);
  expect((await api.request('PUT', '/v1/registry/entries/zro', entry('zro'), tokens.revoked)).status).toBe(401);
  expect((await api.request('PUT', '/v1/registry/entries/zro', entry('zro'))).status).toBe(401);
  expect((await api.request('PUT', '/v1/registry/entries/zro', entry('zro'), 'short')).status).toBe(401);
  expect((await api.request('DELETE', '/v1/registry/entries/zro', undefined, tokens.reader)).status).toBe(403);
  // The caller's own token reads only its identity and the repository permissions.
  expect(github.mock.calls.map(([url]) => String(url))).toEqual(expect.arrayContaining(['https://api.github.com/user', 'https://api.github.com/repos/bananaman614305/grunt']));
  expect(new Set(github.mock.calls.map(([url]) => String(url)))).toEqual(new Set(['https://api.github.com/user', 'https://api.github.com/repos/bananaman614305/grunt']));
  const writes = await api.store.writes();
  expect(writes.map(write => write.login)).toEqual(['lunchboxfortwo', 'bananaman614305']);
  // No token is written to the database, the published file or a log line.
  const dump = JSON.stringify([writes, (await api.client.execute('SELECT * FROM registry_feedback')).rows, await readFile(api.path, 'utf8'),
    errors.mock.calls, logs.mock.calls]);
  for (const token of Object.values(tokens)) expect(dump).not.toContain(token);
});

it('reports an unreachable GitHub separately from a rejected token', async () => {
  const api = await server();
  github.mockRejectedValueOnce(new Error('offline'));
  expect((await api.request('PUT', '/v1/registry/entries/zro', entry('zro'), tokens.owner)).status).toBe(502);
});

it.each(['user', 'repository'].flatMap(endpoint => [
  ...[429, 500, 503, 599].map(status => ({ status, headers: new Headers() })),
  { status: 403, headers: new Headers({ 'x-ratelimit-remaining': '0' }) },
  { status: 403, headers: new Headers({ 'retry-after': '60' }) },
  { status: 403, headers: new Headers({ 'retry-after': '0' }) }
].map(result => ({ endpoint, ...result }))))(
  'reports GitHub $endpoint HTTP $status with $headers as an upstream failure for every write action', async ({ endpoint, status, headers }) => {
    const api = await server({ published: bundledRegistry });
    const before = await readFile(api.path, 'utf8');
    for (const [method, path, body] of [
      ['PUT', '/v1/registry/entries/zro', entry('zro')],
      ['DELETE', '/v1/registry/entries/zro', undefined],
      ['PUT', '/v1/registry/reverts/1', undefined]
    ] as const) {
      github.mockClear();
      if (endpoint === 'repository') github.mockResolvedValueOnce(Response.json({ login: 'lunchboxfortwo' }));
      github.mockResolvedValueOnce(Response.json({ message: 'Synthetic upstream failure' }, { status, headers }));
      const response = await api.request(method, path, body, tokens.owner);
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({ error: 'GitHub is unavailable' });
      expect(github).toHaveBeenCalledTimes(endpoint === 'user' ? 1 : 2);
      expect(await readFile(api.path, 'utf8')).toBe(before);
      expect(await api.store.writes()).toEqual([]);
    }
  }
);

it.each([
  { endpoint: 'user', upstream: 401, headers: new Headers({ 'x-ratelimit-remaining': '0' }), expected: 401 },
  { endpoint: 'user', upstream: 403, headers: new Headers(), expected: 401 },
  { endpoint: 'repository', upstream: 403, headers: new Headers(), expected: 403 },
  { endpoint: 'repository', upstream: 403, headers: new Headers({ 'x-ratelimit-remaining': '1' }), expected: 403 }
])('preserves authorization failures for $endpoint HTTP $upstream with $headers', async ({ endpoint, upstream, headers, expected }) => {
  const api = await server({ published: bundledRegistry });
  if (endpoint === 'repository') github.mockResolvedValueOnce(Response.json({ login: 'lunchboxfortwo' }));
  github.mockResolvedValueOnce(Response.json({ message: 'Synthetic authorization failure' }, { status: upstream, headers }));
  expect((await api.request('PUT', '/v1/registry/entries/zro', entry('zro'), tokens.owner)).status).toBe(expected);
  expect(github).toHaveBeenCalledTimes(endpoint === 'user' ? 1 : 2);
  expect(await api.store.writes()).toEqual([]);
});

// C2: a write publishes the entry and its signup hints at once.
it('publishes new hints immediately under a newer publication time', async () => {
  const api = await server({ published: bundledRegistry });
  const before = await api.registry();
  const hints = "On /api-keys press 'Create key', type grunt in 'Alias' and press 'Create'. Press 'Copy' so it is stored, then finish.";
  const response = await api.request('PUT', '/v1/registry/entries/zro', { ...entry('zro'), hints }, tokens.owner);
  expect(response.status).toBe(200);
  const { published, etag } = await response.json() as { published: string; etag: string };
  expect(Date.parse(published)).toBeGreaterThan(Date.parse(before.published));
  const served = await api.app.request('/v1/registry');
  expect(served.headers.get('ETag')).toBe(etag);
  const after = await served.json() as Registry;
  expect(after.published).toBe(published);
  expect(after.adapters.find(adapter => adapter.id === 'zro')!.hints).toBe(hints);
  // Re-sending an unchanged entry still advances the publication and keeps every other entry.
  const again = await api.request('PUT', '/v1/registry/entries/zro', { ...entry('zro'), hints }, tokens.owner);
  expect(Date.parse((await again.json() as { published: string }).published)).toBeGreaterThan(Date.parse(published));
  expect((await api.registry()).adapters.map(adapter => adapter.id)).toEqual(bundledRegistry.adapters.map(adapter => adapter.id));
});

it('rejects a written signup without hints, and names the failing field', async () => {
  const api = await server({ published: bundledRegistry });
  const { hints: _hints, ...hintless } = entry('zro');
  const adapter = await api.request('PUT', '/v1/registry/entries/zro', hintless, tokens.owner);
  expect(adapter.status).toBe(422);
  expect(await adapter.json()).toEqual({ errors: [{ field: 'hints', rule: 'is required with signup' }] });
  const candidate = await api.request('PUT', '/v1/registry/entries/newco', { signup: 'https://newco.example/signup' }, tokens.owner);
  expect(candidate.status).toBe(422);
  expect((await candidate.json() as { errors: { field: string }[] }).errors).toEqual([expect.objectContaining({ field: 'hints' })]);
  const fields = await api.request('PUT', '/v1/registry/entries/zro', { ...entry('zro'), tier: 'gold', capture: { service: 'zro' } }, tokens.owner);
  expect((await fields.json() as { errors: { field: string }[] }).errors.map(error => error.field)).toEqual(['capture', 'tier']);
  // Registry data never replaces a shipped adapter's code.
  const code = await api.request('PUT', '/v1/registry/entries/zro', { ...entry('zro'), install: 'npm:zro' }, tokens.owner);
  expect((await code.json() as { errors: { field: string }[] }).errors.map(error => error.field)).toEqual(['install']);
  expect((await api.request('PUT', '/v1/registry/entries/zro', { ...entry('zro'), id: 'kilo' }, tokens.owner)).status).toBe(400);
  expect((await api.request('PUT', '/v1/registry/entries/zro', '{', tokens.owner)).status).toBe(400);
  expect((await api.request('PUT', '/v1/registry/entries/zro', { ...entry('zro'), hints: 'x'.repeat(17000) }, tokens.owner)).status).toBe(413);
  // Entries already published without hints stay valid until they are rewritten.
  expect((await api.registry()).adapters.find(adapter => adapter.id === 'runcrate')!.hints).toBeUndefined();
  expect(await api.store.writes()).toEqual([]);
});

it('serves a document that usegrunt 0.9.7 validates and accepts as newer than its bundle', async () => {
  const api = await server();
  expect((await api.app.request('/v1/registry')).status).toBe(503);
  expect((await api.request('PUT', '/v1/registry/entries/newco', { signup: 'https://newco.example/signup', hints: "Press 'Sign up'." }, tokens.owner)).status).toBe(200);
  expect((await api.request('PUT', '/v1/registry/entries/zro', entry('zro'), tokens.owner)).status).toBe(200);
  const served = await api.registry();
  expect(served.candidates!.map(candidate => candidate.id)).toEqual(['newco']);
  expect(validate097(served)).toEqual(served);
  expect(Date.parse(served.published)).toBeGreaterThan(Date.parse(BUNDLED_PUBLISHED));
  expect(Date.parse(served.published)).toBeGreaterThan(Date.parse(bundledRegistry.published));
});

it('places adapters and candidates, keeps tier totals, and records reversible history', async () => {
  const api = await server({ published: bundledRegistry });
  const npm = { id: 'newtool', kind: 'agent', tier: 'experimental', weight: 0.05, modalities: ['text'], install: 'npm:newtool' };
  expect(await (await api.request('PUT', '/v1/registry/entries/newtool', npm, tokens.owner)).json()).toMatchObject({ placed: 'adapters' });
  expect(await (await api.request('PUT', '/v1/registry/entries/newco', { signup: 'https://newco.example/signup', hints: 'Sign up.' }, tokens.owner)).json()).toMatchObject({ placed: 'candidates' });
  let registry = await api.registry();
  const total = (tier: 'stable' | 'experimental') => registry.adapters.filter(adapter => adapter.tier === tier).reduce((sum, adapter) => sum + adapter.weight, 0);
  expect(total('stable')).toBeCloseTo(TIER_TOTALS.stable, 12);
  expect(total('experimental')).toBeCloseTo(TIER_TOTALS.experimental, 12);
  // A new adapter needs a weight; an update keeps its old one.
  const { weight: _weight, ...unweighted } = { ...npm, id: 'othertool', install: 'npm:othertool' };
  expect(await (await api.request('PUT', '/v1/registry/entries/othertool', unweighted, tokens.owner)).json()).toEqual({ errors: [{ field: 'weight', rule: 'is required for a new adapter entry' }] });
  const { weight: zroWeight, ...zro } = registry.adapters.find(adapter => adapter.id === 'zro')!;
  expect((await api.request('PUT', '/v1/registry/entries/zro', { ...zro, fit: 'great' }, tokens.bananaman)).status).toBe(200);
  registry = await api.registry();
  expect(registry.adapters.find(adapter => adapter.id === 'zro')).toMatchObject({ fit: 'great', weight: expect.closeTo(zroWeight, 12) });
  // Parallel writes serialize; neither is lost.
  const [a, b] = await Promise.all([
    api.request('PUT', '/v1/registry/entries/one', { signup: 'https://one.example/', hints: 'One.' }, tokens.owner),
    api.request('PUT', '/v1/registry/entries/two', { signup: 'https://two.example/', hints: 'Two.' }, tokens.bananaman)]);
  expect([a.status, b.status]).toEqual([200, 200]);
  expect((await api.registry()).candidates!.map(candidate => candidate.id)).toEqual(['newco', 'one', 'two']);
  expect((await api.request('DELETE', '/v1/registry/entries/newco', undefined, tokens.owner)).status).toBe(200);
  expect((await api.request('DELETE', '/v1/registry/entries/newco', undefined, tokens.owner)).status).toBe(404);
  const removed = (await api.store.writes()).at(-1)!;
  expect(removed).toMatchObject({ login: 'lunchboxfortwo', id: 'newco' });
  expect(JSON.parse(removed.after_json!).candidates.map((candidate: { id: string }) => candidate.id)).not.toContain('newco');
  expect((await api.request('PUT', `/v1/registry/reverts/${removed.write}`, undefined, tokens.owner)).status).toBe(200);
  expect((await api.registry()).candidates!.map(candidate => candidate.id)).toContain('newco');
  validateRegistry(JSON.parse(await readFile(api.path, 'utf8')));
});

it('clears an invalid published file on the next write by rebasing on the bundled list', async () => {
  const api = await server({ published: '{"version":1,"published":"2026-11-22T00:00:00Z","adapters":[{"id":"clixad"}]}' });
  expect((await api.app.request('/v1/registry')).status).toBe(503);
  expect((await api.request('PUT', '/v1/registry/entries/zro', entry('zro'), tokens.owner)).status).toBe(200);
  expect((await api.registry()).adapters.map(adapter => adapter.id)).toEqual(bundledRegistry.adapters.map(adapter => adapter.id));
});

// C3: router feedback keeps a decaying liveliness score up to date.
const report = (install: string, day: string, counts: { ok?: number; failed?: number; quota?: number; signup_ok?: number; signup_failed?: number }, id = 'zro') => ({
  version: 1, install, client: '0.10.0', day,
  routes: [{ id, ok: 0, failed: 0, quota: 0, auth: 0, latency_ms: 1800, signup_ok: 0, signup_failed: 0, retired: false, ...counts }]
});
const day = (at: number) => new Date(at).toISOString().slice(0, 10);
it('scores routes from router feedback and decays a dead route to zero', async () => {
  const api = await server({ published: bundledRegistry });
  const installs = ['1'.repeat(32), '2'.repeat(32)];
  for (const install of installs) expect((await api.request('POST', '/v1/registry/feedback', report(install, day(api.clock.now), { ok: 40, failed: 2 }))).status).toBe(204);
  let scores = await api.scores();
  expect(scores.scores.zro).toMatchObject({ state: 'live', installs_7d: 2, last_ok: day(api.clock.now) });
  expect(scores.scores.zro!.score).toBeGreaterThan(80);
  expect(scores.scores.kilo).toMatchObject({ score: null, state: 'unknown' });
  expect(scores.summary).toMatchObject({ entries: bundledRegistry.adapters.length, live: 1 });
  // A replayed cumulative report replaces, never adds.
  const replay = JSON.stringify(scores.scores);
  await api.request('POST', '/v1/registry/feedback', report(installs[0]!, day(api.clock.now), { ok: 40, failed: 2 }));
  expect(JSON.stringify((await api.scores()).scores)).toBe(replay);
  let last = scores.scores.zro!.score!;
  for (let offset = 1; offset <= 14; offset++) {
    api.clock.now += DAY;
    for (const install of installs) await api.request('POST', '/v1/registry/feedback', report(install, day(api.clock.now), { failed: 30 }));
    scores = await api.scores();
    expect(scores.scores.zro!.score!).toBeLessThanOrEqual(offset === 1 ? last - 1 : last);
    last = scores.scores.zro!.score!;
    expect(scores.scores.zro!.state).toBe(offset >= 3 ? 'dead' : 'live');
  }
  expect(scores.scores.zro).toMatchObject({ score: 0, state: 'dead', last_ok: null });
});

it('accepts only the allowlisted feedback schema and stores nothing else', async () => {
  const api = await server({ published: bundledRegistry });
  const today = day(api.clock.now), install = 'a'.repeat(32);
  const valid = report(install, today, { ok: 1 });
  for (const invalid of [
    { ...valid, prompt: 'hello' },
    { ...valid, routes: [{ ...valid.routes[0], error: 'upstream said no' }] },
    { ...valid, routes: [{ ...valid.routes[0], id: 'Not An Id' }] },
    { ...valid, routes: [{ ...valid.routes[0], ok: 1.5 }] },
    { ...valid, routes: [valid.routes[0], valid.routes[0]] },
    { ...valid, day: day(api.clock.now - 2 * DAY) },
    { ...valid, install: 'not-hex' },
    { ...valid, version: 2 },
    'not json'
  ]) expect((await api.request('POST', '/v1/registry/feedback', invalid)).status).toBe(400);
  expect((await api.request('POST', '/v1/registry/feedback', { ...valid, routes: Array(400).fill(valid.routes[0]) })).status).toBe(413);
  expect((await api.client.execute('SELECT COUNT(*) AS n FROM registry_feedback')).rows[0]!.n).toBe(0);
  // A route a newer client ships before the registry lists it is dropped, not the report.
  const unlisted = report(install, day(api.clock.now - DAY), { ok: 1 });
  unlisted.routes.push({ ...unlisted.routes[0]!, id: 'not-listed-yet' });
  expect((await api.request('POST', '/v1/registry/feedback', unlisted)).status).toBe(204);
  expect((await api.client.execute('SELECT id FROM registry_feedback')).rows.map(row => row.id)).toEqual(['zro']);
  expect((await api.client.execute('SELECT COUNT(*) AS n FROM registry_feedback')).rows[0]!.n).toBe(1);
});

// C4: an always-current guide agents follow to add to the registry.
it('publishes instructions generated from the validator and live data, with a working example', async () => {
  const api = await server({ published: bundledRegistry });
  const page = await api.app.request('/v1/registry/instructions');
  expect(page.headers.get('Content-Type')).toContain('text/markdown');
  const text = await page.text();
  expect(text).toContain(bundledRegistry.published);
  expect(text).toContain('a'.repeat(40));
  expect(text).toContain(String(HINTS_MAX));
  expect(text).toContain('bananaman614305/grunt');
  for (const id of Object.keys(installers)) expect(text).toContain(`\`${id}\``);
  for (const field of [...ADAPTER_FIELDS, ...CANDIDATE_FIELDS]) expect(text).toContain(`| \`${field}\` |`);
  // Shipped entries with a signup but no hints are on today's worklist.
  const noHints = text.split('\n').find(line => line.startsWith('- Signup without hints:'))!;
  for (const adapter of bundledRegistry.adapters.filter(adapter => adapter.signup && !adapter.hints)) expect(noHints).toContain(adapter.id);
  const example = JSON.parse(text.match(/```json\n([\s\S]+?)\n```/)![1]!);
  expect(example).toEqual(EXAMPLE_CANDIDATE);
  expect(await (await api.request('PUT', `/v1/registry/entries/${example.id}`, example, tokens.owner)).json()).toMatchObject({ placed: 'candidates' });
  const updated = await (await api.app.request('/v1/registry/instructions')).text();
  expect(updated.split('\n').find(line => line.startsWith('- Candidates waiting for an adapter:'))).toContain(example.id);
  expect(updated).toContain((await api.registry()).published);
});

it('lists dead and low-signup routes from feedback on the worklist', async () => {
  const api = await server({ published: bundledRegistry });
  for (let offset = 3; offset >= 0; offset--) {
    api.clock.now = Date.parse('2026-11-23T12:00:00Z') - offset * DAY;
    await api.request('POST', '/v1/registry/feedback', report('b'.repeat(32), day(api.clock.now), { failed: 5, signup_failed: 2 }, 'kenari'));
  }
  const text = await (await api.app.request('/v1/registry/instructions')).text();
  expect(text.split('\n').find(line => line.startsWith('- Dead in router feedback'))).toContain('`kenari`');
  expect(text.split('\n').find(line => line.startsWith('- Signup success below 30%'))).toContain('`kenari`');
});


it.each(['PUT', 'DELETE'])('keeps the publication unchanged when %s audit persistence fails', async method => {
  const api = await server({ published: bundledRegistry });
  const before = await readFile(api.path, 'utf8');
  vi.spyOn(api.store, 'recordWrite').mockRejectedValueOnce(new Error('database unavailable'));
  const response = await api.request(method, '/v1/registry/entries/zro', method === 'PUT' ? { ...entry('zro'), hints: 'Changed hints.' } : undefined, tokens.owner);
  expect(response.status).toBe(500);
  expect(await readFile(api.path, 'utf8')).toBe(before);
  expect(await api.store.writes()).toEqual([]);
  expect((await api.request(method, '/v1/registry/entries/zro', method === 'PUT' ? entry('zro') : undefined, tokens.owner)).status).toBe(200);
  expect(await api.store.writes()).toHaveLength(1);
});

it.each([
  ['PUT', '/v1/registry/entries/zro', 16 * 1024],
  ['POST', '/v1/registry/feedback', 32 * 1024]
] as const)('bounds streamed %s bodies before consuming the entire request', async (method, url, limit) => {
  const api = await server({ published: bundledRegistry });
  let reads = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      reads++;
      if (reads > 100) controller.close();
      else controller.enqueue(new Uint8Array(1024));
    }
  });
  const request = new Request(`http://localhost${url}`, { method, body: stream, duplex: 'half' } as RequestInit);
  const response = await api.app.request(request);
  expect(response.status).toBe(413);
  expect(reads).toBeLessThanOrEqual(limit / 1024 + 2);
  expect(github).not.toHaveBeenCalled();
  expect(await api.store.writes()).toEqual([]);
  expect((await api.client.execute('SELECT * FROM registry_feedback')).rows).toEqual([]);
});


it('seeds a missing registry once through audited publication and preserves later API writes', async () => {
  const api = await server({ start: Date.parse(bundledRegistry.published) - 1000 });
  await Promise.all([api.app.initialize(), api.app.initialize()]);
  const seeded = await api.registry();
  expect(seeded.adapters).toEqual(bundledRegistry.adapters);
  expect(Date.parse(seeded.published)).toBeGreaterThan(Date.parse(bundledRegistry.published));
  expect(validate097(seeded)).toEqual(seeded);
  expect((await stat(api.path)).mode & 0o777).toBe(0o600);
  const writes = await api.store.writes();
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({ login: 'system', id: 'registry', before_json: null });
  expect(JSON.parse(writes[0]!.after_json!)).toEqual(seeded);
  expect((await api.request('PUT', '/v1/registry/entries/newco', { signup: 'https://newco.example/', hints: 'Press Sign up.' }, tokens.owner)).status).toBe(200);
  const updated = await api.registry();
  const restarted = registryRoutes({ path: api.path, store: api.store });
  await restarted.initialize();
  expect(await (await restarted.request('/v1/registry')).json()).toEqual(updated);
  expect(await api.store.writes()).toHaveLength(2);
});

it('does not publish a startup seed when its audit fails', async () => {
  const api = await server();
  vi.spyOn(api.store, 'recordWrite').mockRejectedValueOnce(new Error('database unavailable'));
  await expect(api.app.initialize()).rejects.toThrow('database unavailable');
  expect((await api.request('GET', '/v1/registry')).status).toBe(503);
  await expect(readFile(api.path)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await api.store.writes()).toEqual([]);
});

it('leaves an existing invalid registry for an authenticated writer to repair', async () => {
  const api = await server({ published: 'invalid' });
  await api.app.initialize();
  expect(await readFile(api.path, 'utf8')).toBe('invalid');
  expect(await api.store.writes()).toEqual([]);
  expect((await api.request('GET', '/v1/registry')).status).toBe(503);
  expect((await api.request('PUT', '/v1/registry/entries/zro', entry('zro'), tokens.owner)).status).toBe(200);
  expect((await api.registry()).adapters.find(adapter => adapter.id === 'zro')?.hints).toBe(entry('zro').hints);
});


it.each([
  'delete stable', 'delete experimental', 'update stable weight', 'update experimental weight',
  'move stable tier', 'move experimental tier', 'adapter to candidate', 'candidate to adapter'
])('reverts %s to byte-identical entries and weights', async mutation => {
  const api = await server({ published: bundledRegistry });
  const tool = { id: 'newtool', kind: 'agent', tier: 'stable', weight: 0.1, modalities: ['text'], install: 'npm:newtool' };
  expect((await api.request('PUT', '/v1/registry/entries/newtool', tool, tokens.owner)).status).toBe(200);
  expect((await api.request('PUT', '/v1/registry/entries/newco', { ...EXAMPLE_CANDIDATE, id: 'newco' }, tokens.owner)).status).toBe(200);
  const before = await api.registry();
  const target = mutation.includes('experimental') ? before.adapters.find(adapter => adapter.tier === 'experimental')! : before.adapters.find(adapter => adapter.id === 'kilo')!;
  let response: Response;
  if (mutation.startsWith('delete')) response = await api.request('DELETE', `/v1/registry/entries/${target.id}`, undefined, tokens.owner);
  else if (mutation === 'adapter to candidate') response = await api.request('PUT', '/v1/registry/entries/newtool', { signup: 'https://newtool.example/', hints: 'Press Sign up.' }, tokens.owner);
  else if (mutation === 'candidate to adapter') response = await api.request('PUT', '/v1/registry/entries/newco', { ...tool, id: 'newco', install: 'npm:newco' }, tokens.owner);
  else response = await api.request('PUT', `/v1/registry/entries/${target.id}`, {
    ...target, ...(target.signup ? { hints: target.hints ?? 'Follow the signup controls.' } : {}),
    ...(mutation.startsWith('update') ? { weight: 0.15 } : { tier: target.tier === 'stable' ? 'experimental' : 'stable' })
  }, tokens.owner);
  expect(response.status).toBe(200);
  const { write } = await response.json() as { write: number };
  const changed = await api.registry();
  const restoredResponse = await api.request('PUT', `/v1/registry/reverts/${write}`, undefined, tokens.bananaman);
  expect(restoredResponse.status).toBe(200);
  const restored = await api.registry();
  expect(JSON.stringify(restored.adapters)).toBe(JSON.stringify(before.adapters));
  expect(JSON.stringify(restored.candidates)).toBe(JSON.stringify(before.candidates));
  expect(Date.parse(restored.published)).toBeGreaterThan(Date.parse(changed.published));
  const history = (await api.store.writes()).at(-1)!;
  expect(history.login).toBe('bananaman614305');
  expect(JSON.parse(history.before_json!)).toEqual(changed);
  expect(JSON.parse(history.after_json!)).toEqual(restored);
  expect((await api.request('PUT', `/v1/registry/reverts/${history.write}`, undefined, tokens.owner)).status).toBe(200);
  expect(JSON.stringify((await api.registry()).adapters)).toBe(JSON.stringify(changed.adapters));
  expect(JSON.stringify((await api.registry()).candidates)).toBe(JSON.stringify(changed.candidates));
});

it('applies authorization, snapshot validation and mandatory auditing to reverts', async () => {
  const api = await server({ published: bundledRegistry });
  const deleted = await api.request('DELETE', '/v1/registry/entries/kilo', undefined, tokens.owner);
  const { write } = await deleted.json() as { write: number };
  const path = `/v1/registry/reverts/${write}`, before = await readFile(api.path, 'utf8');
  expect((await api.request('PUT', path)).status).toBe(401);
  expect((await api.request('PUT', path, undefined, tokens.reader)).status).toBe(403);
  expect((await api.request('PUT', '/v1/registry/reverts/999999', undefined, tokens.owner)).status).toBe(404);
  expect((await api.request('PUT', '/v1/registry/reverts/0', undefined, tokens.owner)).status).toBe(400);
  const invalid = await api.store.recordWrite('system', 'registry', { invalid: true }, bundledRegistry);
  expect((await api.request('PUT', `/v1/registry/reverts/${invalid}`, undefined, tokens.owner)).status).toBe(422);
  vi.spyOn(api.store, 'recordWrite').mockRejectedValueOnce(new Error('database unavailable'));
  expect((await api.request('PUT', path, undefined, tokens.owner)).status).toBe(500);
  expect(await readFile(api.path, 'utf8')).toBe(before);
  expect((await api.request('PUT', path, undefined, tokens.owner)).status).toBe(200);
});


it.each(['PUT', 'DELETE'])('rebases %s on the bundle when persisted candidates are damaged', async method => {
  for (const candidates of [{}, [{ ...EXAMPLE_CANDIDATE, hints: '' }]]) {
    const damaged = { ...bundledRegistry, candidates };
    expect(() => validateRegistry(damaged)).toThrow('Invalid adapter registry');
    const api = await server({ published: JSON.stringify(damaged) });
    expect((await api.request('GET', '/v1/registry')).status).toBe(503);
    expect((await api.request('GET', '/v1/registry/instructions')).status).toBe(200);
    const response = await api.request(method, '/v1/registry/entries/kilo', method === 'PUT' ? entry('kilo') : undefined, tokens.owner);
    expect(response.status).toBe(200);
    const repaired = await api.registry();
    expect(repaired.adapters.map(adapter => adapter.id)).toEqual(bundledRegistry.adapters.filter(adapter => method === 'PUT' || adapter.id !== 'kilo').map(adapter => adapter.id));
    expect(repaired.candidates ?? []).toEqual(bundledRegistry.candidates ?? []);
    expect(JSON.parse((await api.store.writes()).at(-1)!.before_json!)).toEqual(bundledRegistry);
  }
});

it('rejects a saved snapshot with malformed candidates before reverting', async () => {
  const api = await server({ published: bundledRegistry });
  const before = await readFile(api.path, 'utf8');
  const write = await api.store.recordWrite('system', 'registry', { ...bundledRegistry, candidates: {} }, bundledRegistry);
  const response = await api.request('PUT', `/v1/registry/reverts/${write}`, undefined, tokens.owner);
  expect(response.status).toBe(422);
  expect(await response.json()).toEqual({ errors: [{ field: 'registry', rule: 'must be a valid registry snapshot' }] });
  expect(await readFile(api.path, 'utf8')).toBe(before);
  expect(await api.store.writes()).toHaveLength(1);
});
