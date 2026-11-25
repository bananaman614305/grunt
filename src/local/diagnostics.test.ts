import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, stat, chmod, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { DiagnosticsStore, diagnosticFetch, recordAttemptFailure, sanitizeDiagnosticEvent, sanitizeSafeDiagnosticMetadata, withDiagnosticContext } from './diagnostics.js';
import type { DiagnosticEvent } from './diagnostics.js';
import { Sources, SourceError, preventReplay } from './source.js';
import type { ModelRequest, Source, Completion } from './source.js';
import { createLocalApp } from './api.js';
import { bundledRegistry } from '../registry.js';

const directories: string[] = [], stores: DiagnosticsStore[] = [];
const event = (patch: Partial<DiagnosticEvent> = {}): DiagnosticEvent => ({ version: 1, id: randomUUID(), at: Date.now(), type: 'attempt.finish', requestId: randomUUID(), kind: 'user', source: 'kilo', outcome: 'passed', ...patch });
async function directory() { const path = await mkdtemp(join(tmpdir(), 'grunt-diagnostics-')); directories.push(path); return path; }
async function store(path?: string, options: { maxEvents?: number; maxAgeMs?: number; now?: () => number } = {}) { const value = await DiagnosticsStore.open({ directory: path ?? await directory(), ...options }); stores.push(value); return value; }
const request: ModelRequest = { model: 'grunt', messages: [{ role: 'user', content: 'SECRET_PROMPT_CONTENT' }], cwd: '/private/SECRET_PROJECT', stream: false, tools: [] };
const source = (id: string, complete: Source['complete'] = async () => ({ text: 'SECRET_ANSWER_CONTENT' })): Source => ({ id, available: vi.fn(async () => true), complete: vi.fn(complete) });
afterEach(async () => { await Promise.all(stores.splice(0).map(value => value.close())); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); vi.restoreAllMocks(); });

it('projects only allowed metadata and rejects credential-bearing model and endpoint values', () => {
  const base = event();
  for (const model of ['https://secret.example/path', 'file:///private/code', 'vault://credential/key', 'Bearer secret', 'sk-abcdefghijklmnopqrstuvwxyz', 'model?token=secret', 'private model', 'user@example.com']) {
    expect(sanitizeDiagnosticEvent({ ...base, model, endpointLabel: 'https://secret.example', authorization: 'Bearer SECRET', cwd: '/private', text: 'SECRET' })).toEqual(base);
  }
  expect(sanitizeDiagnosticEvent({ ...base, id: 'SECRET' })).toBeNull();
  expect(sanitizeDiagnosticEvent({ ...base, model: 'particle-ai/particle-1:free' })).toMatchObject({ model: 'particle-ai/particle-1:free' });
  expect(sanitizeSafeDiagnosticMetadata({ httpStatus: 429, source: 'attacker', requestId: randomUUID(), headers: { authorization: 'SECRET' }, networkCode: 'SECRET' })).toEqual({ httpStatus: 429 });
  expect(sanitizeDiagnosticEvent({ ...base, outcome: 'failed', failureReason: 'SECRET_UPSTREAM_MESSAGE' })).toEqual({ ...base, outcome: 'failed' });
  expect(sanitizeSafeDiagnosticMetadata({ failureReason: 'completion_usage', rawBody: 'SECRET_UPSTREAM_MESSAGE' })).toEqual({ failureReason: 'completion_usage' });
  for (const invalid of [1e20, Infinity, NaN]) expect(sanitizeDiagnosticEvent({ ...base, retryAfterSeconds: invalid, durationMs: invalid })).toEqual(base);
});

it('persists private bounded history across restart with stable stream identity and exclusive cursors', async () => {
  const path = await directory(), first = await store(path);
  const events = [event(), event(), event()]; events.forEach(value => first.record(value));
  const page = await first.list({ limit: 2 });
  expect(page.events.map(value => value.id)).toEqual(events.slice(0, 2).map(value => value.id));
  expect(page.nextCursor).toBe(String(page.events.at(-1)!.seq));
  expect((await stat(join(path, 'diagnostics.db'))).mode & 0o777).toBe(0o600);
  await first.close();
  const reopened = await store(path), next = await reopened.list({ after: page.nextCursor!, limit: 2 });
  expect(next.events.map(value => value.id)).toEqual([events[2]!.id]); expect(next.streamId).toBe(page.streamId);
  expect((await reopened.list({ after: next.nextCursor! })).nextCursor).toBe(next.nextCursor);
  expect((await reopened.list({ after: next.nextCursor! })).events).toEqual([]);
  await expect(reopened.list({ after: '../secret' })).rejects.toThrow();
  await expect(reopened.list({ limit: 501 })).rejects.toThrow();
});

async function withDatabaseWriter(path: string, holdMs: number, inspect: () => Promise<void>) {
  const program = `import {createClient} from '@libsql/client'; import {pathToFileURL} from 'node:url';
    process.umask(0o077);
    const db=createClient({url:pathToFileURL(process.argv[1]).href});
    const transaction=await db.transaction('write');
    process.send?.('locked');
    await new Promise(resolve=>setTimeout(resolve,Number(process.argv[2])));
    await transaction.rollback();db.close();process.disconnect?.();`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', program, join(path, 'diagnostics.db'), String(holdMs)],
    { cwd: process.cwd(), stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const ended = new Promise<void>(resolve => child.once('exit', () => resolve()));
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('message', message => message === 'locked' ? resolve() : reject(new Error('Unexpected fixture state')));
      child.once('error', reject);
      child.once('exit', () => reject(new Error('Writer exited before taking the lock')));
    });
    await inspect();
  } finally { child.kill(); await ended; }
}

it('opens a shared diagnostic stream after a brief writer lock in another process', async () => {
  const path = await directory(), first = await store(path), before = event();
  first.record(before); const saved = await first.list();
  await withDatabaseWriter(path, 250, async () => {
    const second = await store(path);
    expect(second.health()).toMatchObject({ available: true, droppedEvents: 0 });
    const after = event(); second.record(after);
    const rows = await first.list();
    expect(rows.streamId).toBe(saved.streamId);
    expect(rows.events.map(row => row.id)).toEqual([before.id, after.id]);
  });
});

it('fails closed after bounded contention rather than waiting for a long database writer', async () => {
  const path = await directory(); await store(path);
  await withDatabaseWriter(path, 5000, async () => {
    const blocked = await store(path);
    expect(blocked.health()).toMatchObject({ available: false, error: 'storage_unavailable' });
  });
}, 7500);

it('treats URI punctuation in a private directory as filename data', async () => {
  const parent = await directory(), path = join(parent, 'private?mode=shared'), value = await store(path);
  expect(value.health().available).toBe(true); value.record(event()); expect((await value.list()).events).toHaveLength(1);
  expect((await stat(join(path, 'diagnostics.db'))).mode & 0o777).toBe(0o600);
  await expect(stat(join(parent, 'private'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('bounds count and age without resetting the durable sequence', async () => {
  let now = 100000;
  const value = await store(undefined, { maxEvents: 100, maxAgeMs: 60000, now: () => now });
  for (let i = 0; i < 105; i++) value.record(event({ at: now }));
  const page = await value.list({ limit: 500 }); expect(page.events).toHaveLength(100); expect(page.events[0]!.seq).toBe(6);
  now += 60001; value.record(event({ at: now }));
  const latest = await value.list({ limit: 500 }); expect(latest.events).toHaveLength(1); expect(latest.events[0]!.seq).toBe(106);
});

it('keeps missing usage unknown, counts genuine zero usage, and excludes HTTP events from model attempts', async () => {
  const value = await store();
  value.record(event({ inputTokens: 0, outputTokens: 0 })); value.record(event());
  value.record(event({ type: 'transport.finish', httpStatus: 200, inputTokens: 999999 }));
  const summary = await value.summary();
  expect(summary.attempts).toMatchObject({ total: 2, inputTokens: 0, outputTokens: 0, unknownInput: 1, unknownOutput: 1 });
  expect(summary.providers[0]).toMatchObject({ source: 'kilo', total: 2, unknownInput: 1 });
});

it('correlates failed HTTP attempts, automatic fallback, final delivery and safe diagnostics', async () => {
  const value = await store();
  const fetcher = diagnosticFetch(vi.fn<typeof fetch>(async () => new Response('RAW_SECRET_UPSTREAM_BODY', { status: 429, headers: { 'retry-after': '12', 'set-cookie': 'SECRET' } })), 'limited', 'chat.completions');
  const limited = source('limited', async () => { await fetcher('https://egress.example/v1/grant/SECRET', { method: 'POST', headers: { authorization: 'Bearer SECRET' }, body: 'SECRET_PROMPT_CONTENT' }); throw new SourceError('quota', 'RAW_SECRET_ERROR', 12, 'RAW_SECRET_OUTPUT', { httpStatus: 429, transport: 'http' }); });
  const good = source('good', async () => ({ text: 'SECRET_ANSWER_CONTENT', inputTokens: 150, outputTokens: 12 }));
  const sources = new Sources([limited, good]); sources.setDiagnostics(value);
  const result = await sources.complete(request, new AbortController().signal); expect(result.text).toBe('SECRET_ANSWER_CONTENT');
  const events = (await value.list()).events, requestId = events[0]!.requestId;
  expect(events.every(item => item.requestId === requestId)).toBe(true);
  expect(events.filter(item => item.type === 'attempt.finish').map(item => [item.source, item.outcome])).toEqual([['limited', 'failed'], ['good', 'passed']]);
  expect(events.find(item => item.type === 'transport.finish')).toMatchObject({ httpStatus: 429, retryAfterSeconds: 12, httpMethod: 'POST' });
  expect(events.find(item => item.type === 'request.finish')).toMatchObject({ source: 'good', outcome: 'passed' });
  expect(events.find(item => item.type === 'request.output')).toMatchObject({ source: 'good' });
  expect(JSON.stringify(events)).not.toMatch(/SECRET|Bearer|egress\.example|\/private/);
  expect((await value.summary()).attempts).toMatchObject({ total: 2, succeeded: 1, failed: 1, inputTokens: 150, outputTokens: 12, unknownInput: 1 });
});

it('keeps concurrent requests in independent contexts', async () => {
  const value = await store(), resolve: ((value: Completion) => void)[] = [];
  const sources = new Sources([source('good', async () => new Promise(done => resolve.push(done)))]); sources.setDiagnostics(value);
  const ids = [randomUUID(), randomUUID()];
  const requests = ids.map(requestId => withDiagnosticContext({ requestId, kind: 'user' }, () => sources.complete(request, new AbortController().signal)));
  await vi.waitFor(() => expect(resolve).toHaveLength(2)); resolve[1]!({ text: 'second' }); resolve[0]!({ text: 'first' }); await Promise.all(requests);
  for (const id of ids) {
    const events = (await value.trace(id)).events; expect(events).toHaveLength(6); expect(new Set(events.map(row => row.requestId))).toEqual(new Set([id]));
    const attempts = events.filter(row => row.attemptId); expect(new Set(attempts.map(row => row.attemptId)).size).toBe(1);
  }
});

it('records known eligibility, replayable failure, backup dispatch and accepted output in order', async () => {
  const value = await store();
  const primary = source('kilo', async () => {
    const metadata = { failureReason: 'response_empty', httpStatus: 200 } as const;
    recordAttemptFailure('kilo', metadata, true);
    throw new SourceError('upstream', 'PRIVATE', undefined, undefined, metadata);
  });
  const backup = source('livekit');
  const registry = { ...bundledRegistry, adapters: bundledRegistry.adapters.filter(a => [primary.id, backup.id].includes(a.id)) };
  const pool = new Sources([primary, backup], { registry: () => registry, random: () => 0 });
  pool.setDiagnostics(value);
  try {
    // Seed successful availability evidence for both routes before dispatch.
    await pool.available(primary);
    await pool.available(backup);
    await pool.complete({ ...request, cwd: await directory() }, AbortSignal.timeout(5000));
    const { events } = await value.list();
    const details = events.filter(e => ['route.eligible', 'attempt.start', 'attempt.failure', 'request.output'].includes(e.type));
    expect(details.map(e => [e.type, e.source])).toEqual([
      ['route.eligible', 'kilo'], ['route.eligible', 'livekit'],
      ['attempt.start', 'kilo'], ['attempt.failure', 'kilo'],
      ['attempt.start', 'livekit'], ['request.output', 'livekit']
    ]);
    expect(details[3]).toMatchObject({ attemptId: details[2]!.attemptId, replaySafe: true, failureReason: 'response_empty' });
    expect(JSON.stringify(events)).not.toContain('PRIVATE');
  } finally { await pool.close(); }
});

it('records the replay guard and leaves the backup idle after an unsafe failure', async () => {
  const value = await store();
  const first = source('opencode', async () => { throw preventReplay(new Error('PRIVATE'), 'Native work failed'); });
  const backup = source('livekit'), pool = new Sources([first, backup]);
  pool.setDiagnostics(value);
  try {
    await expect(pool.complete(request, AbortSignal.timeout(5000))).rejects.toMatchObject({ replay: 'unsafe' });
    const { events } = await value.list();
    expect(events.find(e => e.type === 'attempt.failure')).toMatchObject({ replaySafe: false, source: 'opencode' });
    expect(backup.complete).not.toHaveBeenCalled();
    expect(JSON.stringify(events)).not.toContain('PRIVATE');
  } finally { await pool.close(); }
});

it.each([false, true])('timestamps a backup probe during the primary attempt when allowed (setup pending: %s)', async pending => {
  const startedAt = Date.now();
  let now = startedAt;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const value = await store();
  const primaryStarted = Promise.withResolvers<void>();
  const failPrimary = Promise.withResolvers<void>();
  const admitBackup = Promise.withResolvers<boolean>();
  const primary = source('kilo', async () => {
    primaryStarted.resolve();
    await failPrimary.promise;
    throw new SourceError('upstream', 'provider rejected the response');
  });
  const backup = { ...source('livekit'), available: vi.fn(() => admitBackup.promise) };
  const registry = { ...bundledRegistry, adapters: bundledRegistry.adapters.filter(a => [primary.id, backup.id].includes(a.id)) };
  const pool = new Sources([primary, backup], { registry: () => registry, random: () => 0 });
  pool.setDiagnostics(value);
  await pool.available(primary);
  const requestId = randomUUID(), cwd = await directory();
  const completion = withDiagnosticContext({ requestId, kind: 'user', actor: 'client' },
    () => pool.complete({ ...request, cwd }, AbortSignal.timeout(5000)));
  const eligibility = async () => (await value.trace(requestId)).events.filter(e => e.type === 'route.eligible' && e.source === backup.id);
  try {
    await Promise.race([primaryStarted.promise, completion]);
    expect(backup.available).toHaveBeenCalledOnce();
    if (pending) pool.pending.add(backup.id);
    now = startedAt + 1000;
    admitBackup.resolve(true);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(await eligibility()).toEqual(pending ? [] : [expect.objectContaining({ at: now, actor: 'client' })]);
    expect(backup.complete).not.toHaveBeenCalled();
    now = startedAt + 2000;
    pool.pending.delete(backup.id);
    failPrimary.resolve();
    await expect(completion).resolves.toMatchObject({ text: 'SECRET_ANSWER_CONTENT' });
    expect(await eligibility()).toEqual([expect.objectContaining({ at: pending ? now : startedAt + 1000, actor: 'client' })]);
  } finally {
    admitBackup.resolve(false);
    failPrimary.resolve();
    await completion.catch(() => {});
    await pool.close();
  }
});

it('identifies maintenance and setup verification separately from user traffic', async () => {
  const value = await store(), sources = new Sources([source('good')]); sources.setDiagnostics(value);
  expect((await sources.check('good', new AbortController().signal)).outcome).toBe('passed');
  sources.pending.add('good'); sources.verifying.add('good');
  await sources.complete({ ...request, model: 'good' }, new AbortController().signal);
  const events = (await value.list()).events;
  expect(events.filter(row => row.type === 'attempt.finish').map(row => row.kind)).toEqual(['maintenance', 'setup']);
});

it('does not let persistence failure affect user completion or expose private files', async () => {
  const path = await directory(); await chmod(path, 0o755); const value = await store(path);
  expect(value.health()).toMatchObject({ available: false, error: 'storage_unavailable' });
  const sources = new Sources([source('good')]); sources.setDiagnostics(value);
  await expect(sources.complete(request, new AbortController().signal)).resolves.toMatchObject({ text: 'SECRET_ANSWER_CONTENT' });
  expect(value.health().droppedEvents).toBeGreaterThan(0);
  await expect(stat(join(path, 'diagnostics.db'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('rejects symlinked storage parents and SQLite sidecars before opening files', async () => {
  const path = await directory(), linkParent = await directory(); await symlink(path, join(linkParent, 'linked'));
  expect((await store(join(linkParent, 'linked'))).health()).toMatchObject({ available: false });
  const target = join(path, 'unrelated'); await writeFile(target, 'PRIVATE', { mode: 0o600 });
  await symlink(target, join(path, 'diagnostics.db-wal'));
  expect((await store(path)).health()).toMatchObject({ available: false });
  expect((await stat(target)).size).toBe(7);
});

it('preserves fetch results and network errors when diagnostics recording faults', async () => {
  const value = await store(); vi.spyOn(value, 'record').mockImplementation(() => { throw new Error('storage failed'); });
  const response = new Response('PRIVATE_RESULT');
  const fetcher = diagnosticFetch(async () => response, 'kilo', 'models');
  await expect(withDiagnosticContext({ requestId: randomUUID(), kind: 'user', sink: value }, () => fetcher('https://example.test/SECRET'))).resolves.toBe(response);
  const failure = Object.assign(new Error('PRIVATE_NETWORK_ERROR'), { cause: { code: 'ECONNREFUSED' } });
  const failed = diagnosticFetch(async () => { throw failure; }, 'kilo', 'models');
  await expect(withDiagnosticContext({ requestId: randomUUID(), kind: 'user', sink: value }, () => failed('https://example.test/SECRET'))).rejects.toBe(failure);
});

it('records safe network classification without raw cause payloads', async () => {
  const value = await store(), error = Object.assign(new Error('SECRET_ERROR'), { cause: { code: 'ENOTFOUND', message: 'SECRET_HOST' } });
  const fetcher = diagnosticFetch(async () => { throw error; }, 'kilo', 'models');
  await expect(withDiagnosticContext({ requestId: randomUUID(), kind: 'user', sink: value }, () => fetcher('https://SECRET_HOST'))).rejects.toBe(error);
  const events = (await value.list()).events; expect(events[0]).toMatchObject({ type: 'transport.finish', networkCode: 'ENOTFOUND', errorCode: 'upstream' });
  expect(JSON.stringify(events)).not.toMatch(/SECRET/);
});

it('exposes cached diagnostics through protected loopback routes without new provider calls', async () => {
  const value = await store(), provider = source('good'), sources = new Sources([provider]); sources.setDiagnostics(value);
  const app = createLocalApp(sources);
  for (const path of ['/v1/diagnostics/events', '/v1/diagnostics/summary']) {
    const response = await app.request('http://127.0.0.1:8788' + path); expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    expect((await app.request('http://attacker.invalid:8788' + path)).status).toBe(403);
    expect((await app.request('http://127.0.0.1:8788' + path, { headers: { origin: 'https://attacker.invalid' } })).status).toBe(403);
  }
  expect(provider.available).not.toHaveBeenCalled(); expect(provider.complete).not.toHaveBeenCalled();
  expect((await app.request('http://127.0.0.1:8788/v1/diagnostics/events?limit=99999')).status).toBe(400);
  const response = await app.request('http://127.0.0.1:8788/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'good', cwd: '/tmp', messages: [{ role: 'user', content: 'hello' }], stream: false }) });
  expect(response.status).toBe(200); const id = response.headers.get('x-grunt-request-id'); expect(id).toMatch(/^[a-f0-9-]{36}$/);
  const trace = await app.request('http://127.0.0.1:8788/v1/diagnostics/traces/' + id); expect((await trace.json()).events).toHaveLength(6);
  const legacy = await app.request('http://127.0.0.1:8788/v1/diagnostics/events');
  expect((await legacy.json()).events.map((e: DiagnosticEvent) => e.type)).not.toContain('request.output');
  const detailed = await app.request('http://127.0.0.1:8788/v1/diagnostics/events?details=1');
  expect((await detailed.json()).events.map((e: DiagnosticEvent) => e.type)).toContain('request.output');
  expect((await value.summary()).requests).toMatchObject({ total: 1, succeeded: 1 });
});

it('records malformed JSON, rejected content types and local housekeeping with actual final HTTP status', async () => {
  const value = await store(), provider = source('good'), sources = new Sources([provider]); sources.setDiagnostics(value); const app = createLocalApp(sources);
  const cases = [
    { body: 'SECRET_MALFORMED_JSON', contentType: 'application/json', status: 400 },
    { body: 'SECRET_BAD_CONTENT_TYPE', contentType: 'text/plain', status: 415 },
    { body: JSON.stringify({ model: 'grunt', cwd: '/tmp', messages: [{ role: 'system', content: 'Warm-up probe' }, { role: 'user', content: 'SECRET_HOUSEKEEPING' }] }), contentType: 'application/json', status: 200 }
  ];
  for (const item of cases) {
    const response = await app.request('http://127.0.0.1:8788/v1/chat/completions', { method: 'POST', headers: { 'content-type': item.contentType }, body: item.body });
    expect(response.status).toBe(item.status); const requestId = response.headers.get('X-Grunt-Request-Id'); expect(requestId).toMatch(/^[a-f0-9-]{36}$/);
    const trace = await value.trace(requestId!); expect(trace.events.map(row => row.type)).toEqual(['request.start', 'request.finish']);
    expect(trace.events[1]).toMatchObject({ httpStatus: item.status, outcome: item.status === 200 ? 'passed' : 'failed' });
    if (item.status === 200) expect(trace.events[1]).toMatchObject({ reason: 'local' });
    expect(JSON.stringify(trace)).not.toMatch(/SECRET/);
  }
  expect(provider.available).not.toHaveBeenCalled(); expect(provider.complete).not.toHaveBeenCalled();
  expect((await value.summary()).requests).toMatchObject({ total: 3, succeeded: 1, failed: 2 });
  expect((await value.summary()).attempts.total).toBe(0);
});

it('keeps upstream HTTP failure distinct from final API failure and rejects metadata envelope overrides', async () => {
  const value = await store();
  const error = new SourceError('refused', 'SECRET_PROVIDER_ERROR', undefined, undefined, { httpStatus: 403, transport: 'http' });
  Object.assign(error.diagnostics!, { requestId: randomUUID(), source: 'attacker', kind: 'maintenance', inputTokens: 9999999 });
  const provider = source('good', async () => { throw error; }), sources = new Sources([provider]); sources.setDiagnostics(value); const app = createLocalApp(sources);
  const response = await app.request('http://127.0.0.1:8788/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'good', cwd: '/tmp', messages: [{ role: 'user', content: 'hello' }] }) });
  expect(response.status).toBe(503);
  const events = (await value.trace(response.headers.get('X-Grunt-Request-Id')!)).events;
  expect(events.find(row => row.type === 'attempt.finish')).toMatchObject({ source: 'good', httpStatus: 403, kind: 'user', errorCode: 'refused' });
  expect(events.find(row => row.type === 'attempt.finish')).not.toHaveProperty('inputTokens');
  expect(events.at(-1)).toMatchObject({ type: 'request.finish', httpStatus: 503, errorCode: 'refused' });
  expect(JSON.stringify(events)).not.toMatch(/SECRET|attacker/);
  expect((await value.summary()).requests).toMatchObject({ total: 1, failed: 1 });
});


it('allowlists actor identities without guessing legacy or accepting secret-bearing worker IDs', () => {
  const base = event(), workerId = randomUUID();
  expect(sanitizeDiagnosticEvent({ ...base, actor: 'worker', workerId })).toEqual({ ...base, actor: 'worker', workerId });
  expect(sanitizeDiagnosticEvent({ ...base, actor: 'client', workerId })).toEqual({ ...base, actor: 'client' });
  expect(sanitizeDiagnosticEvent({ ...base, workerId })).toEqual(base);
  expect(sanitizeDiagnosticEvent({ ...base, actor: 'main', workerId })).toEqual(base);
  for (const workerId of ['SECRET', '/private/project', 'https://secret.example', 'sk-abcdefghijklmnopqrstuvwxyz']) {
    expect(sanitizeDiagnosticEvent({ ...base, actor: 'worker', workerId })).toEqual({ ...base, actor: 'worker' });
  }
});

it('persists only matching request attribution and does not leak it to unrelated queued writes', async () => {
  const path = await directory(), value = await store(path), workerId = randomUUID(), requestId = randomUUID();
  const matching = event({ requestId }), unrelated = event(), client = event({ actor: 'worker', workerId });
  withDiagnosticContext({ requestId, kind: 'user', actor: 'worker', workerId }, () => {
    value.record(matching); value.record(unrelated);
  });
  withDiagnosticContext({ requestId: client.requestId, kind: 'user', actor: 'client' }, () => value.record(client));
  await value.close();
  const rows = (await (await store(path)).list()).events;
  expect(rows[0]).toMatchObject({ id: matching.id, actor: 'worker', workerId });
  expect(rows[1]).not.toHaveProperty('actor'); expect(rows[1]).not.toHaveProperty('workerId');
  expect(rows[2]).toMatchObject({ id: client.id, actor: 'client' }); expect(rows[2]).not.toHaveProperty('workerId');
});
