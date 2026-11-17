import { randomUUID } from 'node:crypto';
import { createClient } from '@libsql/client';
import type { Client } from '@libsql/client';
import { afterEach, expect, it } from 'vitest';
import { AdminStore } from './store.js';
import { validateAdminBatch } from './types.js';
import type { AdminBatch, AdminDiagnosticEvent } from './types.js';

const clients: Client[] = [];
const initial = Date.UTC(2026, 10, 17, 12);
afterEach(() => { for (const client of clients.splice(0)) client.close(); });
async function fixture() {
  let now = initial;
  const client = createClient({ url: 'file::memory:' }); clients.push(client);
  const store = new AdminStore(client, { now: () => now }); await store.init();
  return { store, client, time: (value: number) => { now = value; } };
}
function event(type: AdminDiagnosticEvent['type'], patch: Partial<AdminDiagnosticEvent> = {}): AdminDiagnosticEvent {
  return { version: 1, id: randomUUID(), requestId: randomUUID(), at: initial, kind: 'user', type, ...patch };
}
function batch(events: AdminDiagnosticEvent[] = [], patch: Partial<AdminBatch> = {}): AdminBatch {
  return { version: 1, instanceId: 'chad', observedAt: initial, snapshot: { version: 1, updatedAt: initial, activeRequests: 0, sources: [{ id: 'kilo', state: 'ready', active: 0, model: 'particle-ai/particle-1:free' }] }, events, ...patch };
}

it('projects safe metadata before persistence and excludes raw prose, URLs and credentials from export', async () => {
  const { store } = await fixture();
  const payload = { ...batch([event('request.finish', { outcome: 'passed' })]), authorization: 'Bearer synthetic-private', message: 'private-code',
    system: { version: '0.6.10', nodeVersion: 'v22.14.0', platform: 'linux', memoryTotalBytes: 1024, env: 'private-env' },
    scout: { status: 'failed', runId: '20261117T120000000000Z', reason: 'private-report', candidates: [{ id: 'a'.repeat(24), status: 'integration_pending', model: 'deepseek-v4.1-flash', reference: 'vault://private' }] } };
  Object.assign(payload.snapshot!.sources[0]!, { detail: 'private-upstream-response', token: 'private-token' });
  await store.ingest(payload);
  const result = JSON.stringify(await store.exportData());
  for (const forbidden of ['private-code', 'synthetic-private', 'private-env', 'private-report', 'vault://', 'private-token', 'private-upstream-response']) expect(result).not.toContain(forbidden);
  expect(result).toContain('particle-ai/particle-1:free');
});

it.each([
  { model: 'https://provider.example/key?token=private' }, { model: 'sk-abcdefghijklmnopqrstuv' }, { source: '../../private' },
  { httpStatus: 99 }, { httpStatus: 600 }, { inputTokens: -1 }, { inputTokens: 1.5 }, { outputTokens: Infinity },
  { durationMs: NaN }, { networkCode: 'raw error with private data' }, { endpointLabel: 'https://private' },
  { at: initial + 300001 }, { at: initial - 31 * 86400000 }, { id: 'arbitrary-private-data' }
])('rejects invalid recognized fields without persisting any batch rows: %j', async patch => {
  const { store, client } = await fixture();
  await expect(store.ingest(batch([event('request.start'), event('attempt.finish', patch as Partial<AdminDiagnosticEvent>)]))).rejects.toMatchObject({ code: 'invalid_admin_batch' });
  expect((await client.execute('SELECT count(*) n FROM admin_events')).rows[0]!.n).toBe(0);
  expect((await client.execute('SELECT count(*) n FROM admin_instances')).rows[0]!.n).toBe(0);
});

it('bounds event batches, rejects duplicate IDs and rejects nonsensical system or snapshot data', () => {
  expect(() => validateAdminBatch(batch(Array.from({ length: 201 }, () => event('request.start'))), initial)).toThrow();
  const e = event('request.start'); expect(() => validateAdminBatch(batch([e, e]), initial)).toThrow();
  expect(() => validateAdminBatch(batch([], { system: { loadAverage: [0, -1, 1] } }), initial)).toThrow();
  expect(() => validateAdminBatch(batch([], { snapshot: { version: 1, updatedAt: initial, activeRequests: 0, sources: [{ id: 'kilo', state: 'ready', active: 0 }, { id: 'kilo', state: 'ready', active: 0 }] } }), initial)).toThrow();
  const valid = batch([], { snapshot: { version: 1, updatedAt: initial, activeRequests: 0, sources: [{ id: 'kilo', state: 'limited', active: 0, retryAt: initial + 86400000 }] } });
  expect(validateAdminBatch(valid, initial).snapshot!.sources[0]!.retryAt).toBe(initial + 86400000);
});

it('deduplicates retries and keeps the first immutable event for each instance/id', async () => {
  const { store } = await fixture(); const e = event('attempt.finish', { source: 'kilo', outcome: 'passed', inputTokens: 2, outputTokens: 1 });
  expect(await store.ingest(batch([e]))).toMatchObject({ accepted: true, acceptedEvents: 1, lastEventId: e.id });
  expect(await store.ingest(batch([e]))).toMatchObject({ acceptedEvents: 0 });
  await store.ingest(batch([{ ...e, source: 'zro', inputTokens: 900 }]));
  const exported = await store.exportData(); expect(exported.events).toHaveLength(1); expect(exported.events[0]).toMatchObject({ source: 'kilo', inputTokens: 2 });
});

it('retains latest snapshot across older uploads and reports collector connectivity separately from daemon health', async () => {
  const { store, time } = await fixture();
  await store.ingest(batch());
  await store.ingest(batch([], { observedAt: initial - 1000, snapshot: null, system: { daemonReachable: false } }));
  expect((await store.overview()).health.status).toBe('healthy');
  time(initial + 10000); await store.ingest(batch([], { observedAt: initial + 10000, snapshot: null, system: { daemonReachable: false } }));
  const overview = await store.overview();
  expect(overview.instances[0]).toMatchObject({ connected: true, observedAt: initial + 10000 });
  expect(overview.providers[0]!.lastObservedAt).toBe(initial);
  expect(overview.health).toMatchObject({ status: 'offline', connectedInstances: 1, readyProviders: 0 });
  time(initial + 110000); expect((await store.overview()).instances[0]!.connected).toBe(false);
});

it('bases freshness on server reception and expires metadata during read-only access', async () => {
  const { store, time } = await fixture();
  await store.ingest(batch([], { observedAt: initial + 300000 }));
  expect((await store.overview()).instances[0]).toMatchObject({ observedAt: initial + 300000, lastSeenAt: initial, connected: true });
  expect((await store.overview()).lastUpdated).toBe(initial);
  time(initial + 90001); expect((await store.overview()).instances[0]!.connected).toBe(false);
  time(initial + 31 * 86400000);
  expect((await store.overview()).health.status).toBe('no_data');
  expect((await store.providers()).providers).toEqual([]);
  expect(await store.runs()).toEqual({ maintenance: [], scout: [] });
  expect((await store.exportData()).instances).toEqual([]);
});

it('projects bounded scout gate metadata without exposing protected checkpoint contents', async () => {
  const { store } = await fixture();
  await store.ingest(batch([], { scout: { status: 'completed', candidates: [{ id: 'a'.repeat(24), status: 'integration_pending', model: 'particle-ai/particle-1:free', reasonCode: 'upstream_capacity', phase: 'reviewed', checksPassed: null, supervisorProbePassed: false, approvedReviewCount: 1 }] } }));
  expect((await store.runs()).scout[0]!.candidates[0]).toMatchObject({ reasonCode: 'upstream_capacity', checksPassed: null, supervisorProbePassed: false, approvedReviewCount: 1 });
  expect(() => validateAdminBatch(batch([], { scout: { status: 'completed', candidates: [{ id: 'a'.repeat(24), status: 'integration_pending', published: false as true }] } }), initial)).toThrow();
  expect(() => validateAdminBatch(batch([], { scout: { status: 'completed', candidates: [{ id: 'a'.repeat(24), status: 'integration_pending', approvedReviewCount: 3 }] } }), initial)).toThrow();
});

it('correlates fallback attempts and counts reported attempt usage once while preserving unknown usage', async () => {
  const { store } = await fixture(); const requestId = randomUUID(), a = randomUUID(), b = randomUUID();
  const events = [
    event('request.start', { requestId, model: 'grunt' }),
    event('attempt.start', { requestId, attemptId: a, source: 'kilo', at: initial + 1 }),
    event('transport.finish', { requestId, attemptId: a, source: 'kilo', at: initial + 2, httpStatus: 429, outcome: 'failed' }),
    event('attempt.finish', { requestId, attemptId: a, source: 'kilo', at: initial + 3, errorCode: 'quota', httpStatus: 429, outcome: 'failed', retryAfterSeconds: 60 }),
    event('attempt.start', { requestId, attemptId: b, source: 'zro', at: initial + 4 }),
    event('attempt.finish', { requestId, attemptId: b, source: 'zro', at: initial + 5, outcome: 'passed', inputTokens: 10, outputTokens: 3 }),
    event('request.finish', { requestId, at: initial + 6, outcome: 'passed', httpStatus: 200, inputTokens: 10, outputTokens: 3, durationMs: 6 })
  ];
  await store.ingest(batch(events));
  const trace = await store.request(requestId); expect(trace!.request).toMatchObject({ outcome: 'passed', source: 'zro', sources: ['kilo', 'zro'], attemptCount: 2, inputTokens: 10, outputTokens: 3, httpStatus: 200 });
  expect(trace!.events).toHaveLength(7);
  const usage = (await store.overview()).usage;
  expect(usage).toMatchObject({ inputTokens: 10, outputTokens: 3, knownInputEvents: 1, unknownInputEvents: 1, knownOutputEvents: 1, unknownOutputEvents: 1, requests: 1, attempts: 2, failures: 1 });
});

it('lists only actual attempt sources while retaining skipped providers and availability probes in the timeline', async () => {
  const { store } = await fixture(), requestId = randomUUID(), attemptId = randomUUID();
  const events = [
    event('request.start', { requestId, at: initial, model: 'grunt' }),
    event('transport.finish', { requestId, at: initial + 1, source: 'kilo', outcome: 'passed', endpointLabel: 'models', httpStatus: 200 }),
    event('route.skip', { requestId, at: initial + 2, source: 'kilo', outcome: 'skipped', reason: 'unavailable' }),
    event('attempt.start', { requestId, attemptId, at: initial + 3, source: 'zro' }),
    event('attempt.finish', { requestId, attemptId, at: initial + 4, source: 'zro', outcome: 'passed', inputTokens: 20, outputTokens: 4 }),
    event('request.finish', { requestId, at: initial + 5, source: 'zro', outcome: 'passed' })
  ];
  await store.ingest(batch(events));
  const listed = (await store.requests()).requests;
  expect(listed).toHaveLength(1);
  expect(listed[0]).toMatchObject({ sources: ['zro'], source: 'zro', attemptCount: 1 });
  expect((await store.requests({ source: 'kilo' })).requests).toEqual([]);
  expect((await store.requests({ source: 'zro' })).requests).toHaveLength(1);
  const trace = await store.request(requestId);
  expect(trace!.request.sources).toEqual(['zro']);
  expect(trace!.events).toHaveLength(6);
  expect(trace!.events.filter(row => row.source === 'kilo').map(row => row.type)).toEqual(['transport.finish', 'route.skip']);
});

it('keeps transport-only maintenance out of logical requests and usage while retaining maintenance and export evidence', async () => {
  const { store } = await fixture(), requestId = randomUUID();
  const probe = event('transport.finish', { requestId, kind: 'maintenance', source: 'clixad', outcome: 'passed', httpStatus: 200, endpointLabel: 'models' });
  const maintenance = { version: 1 as const, entries: { clixad: { nextCheckAt: initial + 86400000, lastCheckedAt: initial, outcome: 'passed' as const, evidence: 'metadata' as const } } };
  await store.ingest(batch([probe], { maintenance }));
  expect((await store.requests()).requests).toEqual([]);
  expect(await store.request(requestId)).toBeNull();
  expect((await store.overview()).usage).toMatchObject({ requests: 0, attempts: 0, failures: 0, inputTokens: null, outputTokens: null, unknownInputEvents: 0 });
  expect((await store.runs()).maintenance).toMatchObject([{ instanceId: 'chad', source: 'clixad', outcome: 'passed', evidence: 'metadata' }]);
  expect((await store.exportData()).events).toMatchObject([{ requestId, source: 'clixad', type: 'transport.finish' }]);
});

it('uses request-finish attribution only for legacy traces without attempt lifecycles', async () => {
  const { store } = await fixture(), requestId = randomUUID();
  await store.ingest(batch([
    event('transport.finish', { requestId, source: 'kilo', at: initial, outcome: 'passed', endpointLabel: 'models' }),
    event('request.finish', { requestId, source: 'zro', at: initial + 1, outcome: 'passed' })
  ]));
  const trace = await store.request(requestId);
  expect(trace!.request).toMatchObject({ source: 'zro', sources: ['zro'], attemptCount: 0, startedAt: initial + 1 });
});

it('keeps all-unknown counts null, recognizes reported zero, and closes standalone maintenance attempt traces', async () => {
  const { store } = await fixture(); const first = event('attempt.finish', { kind: 'maintenance', outcome: 'passed', source: 'kilo' });
  await store.ingest(batch([first]));
  expect((await store.overview()).usage).toMatchObject({ inputTokens: null, outputTokens: null, unknownInputEvents: 1 });
  expect((await store.request(first.requestId))!.request.outcome).toBe('passed');
  await store.ingest(batch([event('attempt.finish', { inputTokens: 0, outputTokens: 0, outcome: 'passed' })]));
  expect((await store.overview()).usage).toMatchObject({ inputTokens: 0, outputTokens: 0, knownInputEvents: 1, unknownInputEvents: 1 });
});

it('paginates equal-time request IDs without repeats and scopes every read to an installation', async () => {
  const { store } = await fixture();
  const events = Array.from({ length: 4 }, (_, i) => event('request.finish', { outcome: i % 2 ? 'failed' : 'passed', source: i % 2 ? 'kilo' : 'zro' }));
  await store.ingest(batch(events));
  await store.ingest(batch([event('attempt.finish', { inputTokens: 200, outcome: 'passed', source: 'kilo' })], { instanceId: 'laptop' }));
  const page = await store.requests({ limit: 2, instanceId: 'chad' }); const next = await store.requests({ limit: 2, instanceId: 'chad', before: page.nextCursor! });
  expect(new Set([...page.requests, ...next.requests].map(row => row.id)).size).toBe(4); expect(next.nextCursor).toBeNull();
  expect((await store.requests({ source: 'zro', outcome: 'passed' })).requests).toHaveLength(2);
  expect((await store.overview('laptop')).usage.inputTokens).toBe(200);
  expect((await store.overview('chad')).usage.inputTokens).toBeNull();
  expect((await store.providers('laptop')).providers.every(row => row.instanceId === 'laptop')).toBe(true);
  expect((await store.exportData('laptop')).events).toHaveLength(1);
  await expect(store.requests({ before: 'bad' })).rejects.toMatchObject({ code: 'invalid_admin_filter' });
});

it('does not combine colliding UUIDs across installations and parameterizes request filters', async () => {
  const { store } = await fixture(); const e = event('request.finish', { outcome: 'passed' });
  await store.ingest(batch([e])); await store.ingest(batch([e], { instanceId: 'laptop' }));
  await expect(store.request(e.requestId)).rejects.toMatchObject({ code: 'ambiguous_admin_request' });
  expect((await store.request(e.requestId, 'chad'))!.events).toHaveLength(1);
  expect(await store.request("' OR 1=1 --")).toBeNull();
  expect((await store.providers("' OR 1=1 --")).providers).toEqual([]);
});

it('prunes expired telemetry without changing unrelated application tables', async () => {
  const { store, client, time } = await fixture();
  await client.executeMultiple("CREATE TABLE preserved(value TEXT); INSERT INTO preserved VALUES('keep');");
  await store.ingest(batch([event('request.finish', { outcome: 'passed' })]));
  time(initial + 31 * 86400000);
  await store.ingest(batch([], { observedAt: initial + 31 * 86400000, snapshot: null, instanceId: 'laptop' }));
  expect((await store.exportData()).events).toEqual([]);
  expect((await store.overview()).instances.map(row => row.id)).toEqual(['laptop']);
  expect((await client.execute('SELECT value FROM preserved')).rows[0]!.value).toBe('keep');
});

it('atomically consumes OAuth states once, expires them, and excludes authentication records from exports', async () => {
  const { store, time } = await fixture(); const hash = 'a'.repeat(64), state = { nonce: 'n'.repeat(43), verifier: 'v'.repeat(43), createdAt: initial, expiresAt: initial + 600000 };
  await store.putState(hash, state);
  const attempts = await Promise.all([store.consumeState(hash), store.consumeState(hash)]);
  expect(attempts.filter(Boolean)).toEqual([state]);
  await store.putState(hash, state); time(initial + 600000); expect(await store.consumeState(hash)).toBeUndefined();
  expect(JSON.stringify(await store.exportData())).not.toContain(state.verifier);
  await expect(store.putState('not-a-hash', state)).rejects.toMatchObject({ code: 'invalid_admin_state' });
});

it('stores only hashed session IDs and enforces session expiry/revocation and bounded lifetimes', async () => {
  const { store, client, time } = await fixture(); const hash = 'b'.repeat(64), session = { email: 'Owner@Example.com', subject: 'google-subject', createdAt: initial, expiresAt: initial + 3600000 };
  await store.putSession(hash, session); expect(await store.session(hash)).toEqual({ ...session, email: 'owner@example.com' });
  expect((await client.execute('SELECT hash FROM admin_sessions')).rows[0]!.hash).toBe(hash);
  await store.deleteSession(hash); expect(await store.session(hash)).toBeUndefined();
  await store.putSession(hash, session); time(initial + 3600000); expect(await store.session(hash)).toBeUndefined();
  expect(JSON.stringify(await store.exportData())).not.toContain(session.email.toLowerCase());
  await expect(store.putSession('c'.repeat(64), { ...session, expiresAt: NaN })).rejects.toMatchObject({ code: 'invalid_admin_session' });
});
