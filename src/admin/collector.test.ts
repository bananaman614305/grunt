import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createClient } from '@libsql/client';
import { DiagnosticsStore, diagnosticReasons } from '../local/diagnostics.js';
import type { DiagnosticEvent } from '../local/diagnostics.js';
import { AdminStore } from './store.js';
import { validateAdminBatch, validateAdminEvent } from './types.js';
import { AdminCollector, collectorConfig, projectCollectorMaintenance, projectCollectorScout, projectCollectorSnapshot } from './collector.js';

const roots: string[] = [];
const now = 1800000000000;
const stream = 'b20c885a-c398-4d30-b4ae-65217877272b';
const oldStream = 'eceef747-361b-4bc4-a234-d847ce06bb48';
const requestId = '7028ed80-baaa-472a-8112-a3f6da298531';
const event = (seq = 1) => ({ version: 1, id: seq === 1 ? '350127b8-dd39-484e-8698-7c43bd808e5b' : 'edfbab64-9512-4fa0-9aac-c6a064096d00',
  at: now - 100, seq, requestId, type: 'attempt.finish', kind: 'user', source: 'kilo', model: 'particle-ai/particle-1:free', outcome: 'passed', inputTokens: 0 });
const snapshot = () => ({ version: 1, updatedAt: now, activeRequests: 0, sources: [{ id: 'kilo', state: 'ready', active: 0, model: 'particle-ai/particle-1:free', detail: 'sensitive free-form diagnostic text' }] });
async function directory() { const path = await mkdtemp(join(tmpdir(), 'grunt-admin-collector-')); roots.push(path); return path; }
async function fixture(options: { failUpload?: boolean; rejectAck?: boolean; unavailable?: boolean; stream?: string } = {}) {
  const directoryPath = await directory(), uploads: { body: Record<string, unknown>; authorization: string | null }[] = [], gets: string[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === '127.0.0.1') {
      gets.push(url.pathname + url.search);
      expect(init?.headers).toBeUndefined();
      if (options.unavailable) return new Response('synthetic private daemon error', { status: 503 });
      if (url.pathname === '/v1/status') return Response.json(snapshot());
      if (url.pathname === '/v1/diagnostics/summary') return Response.json({ streamId: options.stream ?? stream });
      if (url.pathname === '/v1/diagnostics/events') return Response.json({ streamId: options.stream ?? stream,
        events: [{ ...event(), prompt: 'synthetic private prompt', output: 'synthetic private output', authorization: 'synthetic token' }], nextCursor: '1' });
      throw new Error('Unexpected local path');
    }
    expect(url.href).toBe('https://api.grunt.run/admin/ingest');
    expect(init?.redirect).toBe('error');
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    uploads.push({ body, authorization: new Headers(init?.headers).get('Authorization') });
    if (options.failUpload) return new Response('synthetic sensitive upstream error', { status: 429 });
    return Response.json({ accepted: true, acceptedEvents: 1, lastEventId: options.rejectAck ? requestId : event().id });
  });
  const collector = new AdminCollector({ url: 'https://api.grunt.run/admin/ingest', ingestKey: 'synthetic-machine-key', instanceId: 'chad',
    directory: directoryPath, daemonPort: 8792, scoutDirectory: join(directoryPath, 'missing-scout'), fetcher, now: () => now });
  return { collector, directory: directoryPath, uploads, gets, fetcher, options };
}
afterEach(async () => { vi.useRealTimers(); await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

it.each(['mixed', 'local-only'] as const)('advances acknowledged %s pages past local measurements without extending the admin wire schema', async mode => {
  const f = await fixture(), original = f.fetcher.getMockImplementation()!;
  const measurement = (seq: number, type: DiagnosticEvent['type']) => ({ ...event(seq),
    id: `60163cdf-3325-4fa9-8c57-${String(seq).padStart(12, '0')}`, type,
    kind: 'diagnostic', actor: 'worker', runtimeVersion: '0.9.7', stage: 'task', workDisposition: 'fresh',
    prompt: 'synthetic private prompt', task: 'synthetic private task', command: 'synthetic private command', path: '/synthetic/private', authorization: 'synthetic token' });
  const measurements = [measurement(1, 'release.marker'), measurement(3, 'work.start'), measurement(4, 'work.finish')];
  for (const local of measurements) expect(() => validateAdminEvent(local, now)).toThrow('invalid_admin_batch');
  const normal = { ...event(2), runtimeVersion: '0.9.7', prompt: 'synthetic private prompt', command: 'synthetic private command' };
  const page = mode === 'mixed' ? [measurements[0]!, normal, ...measurements.slice(1)] : measurements;
  let rejectUpload = true;
  f.fetcher.mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === '/v1/diagnostics/events') {
      f.gets.push(url.pathname + url.search);
      const after = url.searchParams.get('after');
      return Response.json({ streamId: stream, events: after === '4' ? [] : page, nextCursor: '4' });
    }
    if (url.hostname === '127.0.0.1') return original(input, init);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const accepted = validateAdminBatch(body, now);
    f.uploads.push({ body, authorization: new Headers(init?.headers).get('Authorization') });
    if (rejectUpload) return new Response('synthetic sensitive upstream error', { status: 503 });
    return Response.json({ accepted: true, acceptedEvents: accepted.events.length,
      ...(accepted.events.length ? { lastEventId: accepted.events.at(-1)!.id } : {}) });
  });
  const statePath = join(f.directory, 'admin-collector-state.json');
  await expect(f.collector.cycle()).rejects.toThrow('upload_failed');
  await expect(stat(statePath)).rejects.toMatchObject({ code: 'ENOENT' });
  rejectUpload = false;
  await expect(f.collector.cycle()).resolves.toEqual({ uploadedEvents: mode === 'mixed' ? 1 : 0, daemonReachable: true });
  expect(f.uploads[0]!.body.events).toEqual(f.uploads[1]!.body.events);
  expect(f.uploads[1]!.body.events).toEqual(mode === 'mixed' ? [event(2)] : []);
  expect(f.uploads[1]!.body.system).toMatchObject({ diagnosticsAvailable: true });
  expect(JSON.stringify(f.uploads)).not.toMatch(/synthetic private|synthetic token|synthetic\/private|work\.start|work\.finish|release\.marker|runtimeVersion|workDisposition/);
  expect(JSON.parse(await readFile(statePath, 'utf8'))).toMatchObject({ cursor: '4', streamId: stream });
  const restarted = new AdminCollector({ url: 'https://api.grunt.run/admin/ingest', ingestKey: 'synthetic-machine-key', instanceId: 'chad',
    directory: f.directory, daemonPort: 8792, scoutDirectory: join(f.directory, 'missing-scout'), fetcher: f.fetcher, now: () => now });
  await expect(restarted.cycle()).resolves.toEqual({ uploadedEvents: 0, daemonReachable: true });
  expect(f.gets.filter(path => path.startsWith('/v1/diagnostics/events'))).toEqual([
    '/v1/diagnostics/events?limit=200', '/v1/diagnostics/events?limit=200', '/v1/diagnostics/events?limit=200&after=4'
  ]);
  expect(JSON.parse(await readFile(statePath, 'utf8'))).toMatchObject({ cursor: '4', streamId: stream });
  f.collector.stop(); restarted.stop();
});

it('uploads a public-context skip and advances past it without exposing private fields', async () => {
  const f = await fixture(), original = f.fetcher.getMockImplementation()!;
  f.fetcher.mockImplementation(async (input, init) => {
    if (new URL(String(input)).pathname === '/v1/diagnostics/events') return Response.json({ streamId: stream,
      events: [{ ...event(), type: 'route.skip', source: 'goedel', outcome: 'skipped', reason: 'context_not_approved',
        prompt: 'synthetic private prompt', authorization: 'synthetic token' }], nextCursor: '1' });
    return original(input, init);
  });
  await expect(f.collector.cycle()).resolves.toMatchObject({ uploadedEvents: 1 });
  expect(validateAdminBatch(f.uploads[0]!.body, now).events[0]).toMatchObject({ source: 'goedel', outcome: 'skipped', reason: 'context_not_approved' });
  expect(JSON.stringify(f.uploads[0]!.body)).not.toMatch(/synthetic private|synthetic token/);
  expect(JSON.parse(await readFile(join(f.directory, 'admin-collector-state.json'), 'utf8')).cursor).toBe('1');
  f.collector.stop();
});

it('accepts exactly the bounded local diagnostic reason vocabulary at the admin boundary', () => {
  for (const reason of diagnosticReasons) expect(validateAdminEvent({ ...event(), reason }, now).reason).toBe(reason);
  for (const reason of ['arbitrary-provider-message', 'https://private.example', 'context_not_approved private']) {
    expect(() => validateAdminEvent({ ...event(), reason }, now)).toThrow('invalid_admin_batch');
  }
});

it('requires an explicit private machine key and instance, and only accepts owned HTTPS ingestion destinations', () => {
  expect(() => collectorConfig({})).toThrow('invalid_configuration');
  const env = { GRUNT_ADMIN_INGEST_KEY: 'synthetic-machine-key', GRUNT_ADMIN_INSTANCE_ID: 'chad' };
  expect(collectorConfig(env)).toMatchObject({ daemonPort: 8792, url: 'https://api.grunt.run/admin/ingest', instanceId: 'chad' });
  expect(collectorConfig({ ...env, MILO_PORT: '8793', GRUNT_PORT: '8794', GRUNT_ADMIN_DAEMON_PORT: '8792' }).daemonPort).toBe(8792);
  expect(collectorConfig({ ...env, GRUNT_CONFIG_DIR: '/owned/grunt', MILO_CONFIG_DIR: '/legacy/milo' }).directory).toBe('/owned/grunt');
  for (const url of ['http://api.grunt.run/admin/ingest', 'https://127.0.0.1/admin/ingest', 'https://example.com/admin/ingest',
    'https://api.grunt.run/admin/ingest?token=synthetic', 'https://user:pass@api.grunt.run/admin/ingest', 'https://api.grunt.run/admin/ingest#fragment']) {
    expect(() => collectorConfig({ ...env, GRUNT_ADMIN_COLLECTOR_URL: url })).toThrow('invalid_configuration');
  }
  for (const port of ['0', '65536', '8792/other', '1e3']) expect(() => collectorConfig({ ...env, GRUNT_ADMIN_DAEMON_PORT: port })).toThrow('invalid_configuration');
});

it('projects snapshots and maintenance to known source IDs and fixed metadata fields', () => {
  const raw = { ...snapshot(), cwd: '/private/project', sources: [...snapshot().sources,
    { id: 'unknown-custom-secret', state: 'ready', active: 0 }, { id: 'opencode', state: 'ready', active: 0, model: 'vault://synthetic/private' }] };
  const result = projectCollectorSnapshot(raw);
  expect(result.sources).toHaveLength(2);
  expect(result.sources[0]).not.toHaveProperty('detail'); expect(result.sources[1]).not.toHaveProperty('model');
  expect(JSON.stringify(result)).not.toMatch(/private|secret|cwd|vault/);
  expect(projectCollectorMaintenance({ version: 1, entries: { kilo: { nextCheckAt: now, lastAttemptAt: now - 50, outcome: 'failed', code: 'quota', raw: 'private' },
    custom: { nextCheckAt: now, code: 'private' } } })).toEqual({ version: 1, entries: { kilo: { nextCheckAt: now, lastAttemptAt: now - 50, outcome: 'failed', code: 'quota' } } });
});

it('projects only approved worker status fields and tolerates an older daemon', () => {
  const active = { id: requestId, state: 'running', createdAt: now, activity: 'review', source: 'kilo', task: 'private task', context: 'private context' };
  const observed = projectCollectorSnapshot({ ...snapshot(), workers: { active: [active], queued: [], recent: [] } });
  expect(observed.workers).toEqual({ active: [{ id: requestId, state: 'running', createdAt: now, activity: 'review', source: 'kilo' }], queued: [], recent: [] });
  expect(projectCollectorSnapshot(snapshot())).not.toHaveProperty('workers');
  for (const source of ['https://secret.example', 'unknown-private-label']) {
    expect(projectCollectorSnapshot({ ...snapshot(), workers: { active: [{ ...active, source }], queued: [], recent: [] } })).not.toHaveProperty('workers');
  }
});

it('projects both known opt-in sources and their worker status without admitting arbitrary adapter IDs', () => {
  const sources = [
    { id: 'antseed-vikey', state: 'limited', errorCode: 'quota', active: 0 },
    { id: 'reflection-beam', state: 'answering', active: 1 },
    { id: 'private-custom', state: 'available', active: 0 }
  ];
  const active = [{ id: requestId, state: 'running', createdAt: now, source: 'reflection-beam' }];
  const observed = projectCollectorSnapshot({ ...snapshot(), sources, workers: { active, queued: [], recent: [] } });
  expect(observed.sources).toEqual(sources.slice(0, 2));
  expect(observed.workers?.active).toEqual(active);
});

it('exports numeric Vikey base limits without seller or wallet identifiers', () => {
  const snapshot = projectCollectorSnapshot({ version: 1, updatedAt: Date.now(), activeRequests: 0, sources: [
    { id: 'antseed-vikey', state: 'available', active: 0, sellerQuota: { perAddress: 10, perIp: 100, windowSeconds: 86400, wallet: 'private' } },
    { id: 'zro', state: 'available', active: 0, sellerQuota: { perAddress: 100, windowSeconds: 86400 } }
  ] });
  expect(snapshot.sources).toEqual([
    { id: 'antseed-vikey', state: 'available', active: 0, sellerQuota: { perAddress: 10, perIp: 100, windowSeconds: 86400 } },
    { id: 'zro', state: 'available', active: 0 }
  ]);
});

it('projects provider quota windows without arbitrary account metadata', () => {
  const startedAt = now - 86400000, resetAt = startedAt + 7 * 86400000;
  const sources = [
    { id: 'tokenharbor', state: 'limited', active: 0, quotaWindow: { startedAt, resetAt, account: 'private' } },
    { id: 'zro', state: 'available', active: 0, quotaWindow: { startedAt, resetAt: startedAt } }
  ];
  expect(projectCollectorSnapshot({ ...snapshot(), sources }).sources).toEqual([
    { id: 'tokenharbor', state: 'limited', active: 0, quotaWindow: { startedAt, resetAt } },
    { id: 'zro', state: 'available', active: 0 }
  ]);
});

it('projects scouting progress without report prose, account metadata, URLs, paths or vault references', () => {
  const result = projectCollectorScout({ id: '20261116T140001689663Z', status: 'failed', reason: 'private account error',
    started_at: '2026-11-16T14:00:01.689897+00:00', config: { secret: 'private' } }, { candidates: {
    ['a'.repeat(24)]: { model: 'particle-ai/particle-1:free', status: 'integration_pending', pipeline_status: 'deferred', pipeline_reason: 'upstream_capacity_429_during_preliminary_qualification', reason: 'private long prose', release_request: { config_dir: '/private' } },
    ['b'.repeat(24)]: { model: 'vault://secret/token', status: 'rejected', homepage: 'https://private.example' },
    'private candidate id': { status: 'rejected' }
  } });
  expect(result).toMatchObject({ runId: '20261116T140001689663Z', status: 'failed', candidates: [
    { id: 'a'.repeat(24), model: 'particle-ai/particle-1:free', status: 'integration_pending', pipelineStatus: 'deferred', reasonCode: 'upstream_capacity' },
    { id: 'b'.repeat(24), status: 'rejected' }
  ] });
  expect(result.startedAt).toBe(Date.parse('2026-11-16T14:00:01.689897+00:00'));
  expect(JSON.stringify(result)).not.toMatch(/private|secret|vault|https|release_request|config/);
});

it('uploads the oldest local events, strips content, preserves unknown usage, and persists only an acknowledged cursor', async () => {
  const f = await fixture();
  expect(await f.collector.cycle()).toEqual({ uploadedEvents: 1, daemonReachable: true });
  expect(f.gets).toContain('/v1/diagnostics/events?limit=200');
  const upload = f.uploads[0]!;
  expect(upload.authorization).toBe('Bearer synthetic-machine-key');
  expect(upload.body).toMatchObject({ version: 1, instanceId: 'chad', observedAt: now, events: [event()] });
  const wire = JSON.stringify(upload.body);
  expect(wire).not.toMatch(/synthetic-machine-key|synthetic private|authorization|sensitive free-form|prompt|output"|cwd/);
  const events = upload.body.events as Record<string, unknown>[];
  expect(events[0]).toHaveProperty('inputTokens', 0); expect(events[0]).not.toHaveProperty('outputTokens');
  const statePath = join(f.directory, 'admin-collector-state.json');
  expect((await stat(statePath)).mode & 0o777).toBe(0o600);
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  expect(state).toMatchObject({ version: 1, cursor: '1', streamId: stream, lastAcknowledgedAt: now });
  expect(JSON.stringify(state)).not.toContain('synthetic-machine-key');
});

it('does not advance on upload failure and replays the same event until an explicit acknowledgment', async () => {
  const f = await fixture({ failUpload: true });
  await expect(f.collector.cycle()).rejects.toThrow('upload_failed');
  await expect(stat(join(f.directory, 'admin-collector-state.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  f.options.failUpload = false;
  await f.collector.cycle();
  expect(f.uploads).toHaveLength(2);
  expect(f.uploads[0]!.body.events).toEqual(f.uploads[1]!.body.events);
  expect(f.gets.filter(path => path.startsWith('/v1/diagnostics/events'))).toEqual(['/v1/diagnostics/events?limit=200', '/v1/diagnostics/events?limit=200']);
});

it('rejects acknowledgments for another final event rather than losing unacknowledged history', async () => {
  const f = await fixture({ rejectAck: true });
  await expect(f.collector.cycle()).rejects.toThrow('invalid_acknowledgment');
  await expect(stat(join(f.directory, 'admin-collector-state.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('resets a saved cursor when the local diagnostic database stream changes', async () => {
  const f = await fixture();
  await writeFile(join(f.directory, 'admin-collector-state.json'), JSON.stringify({ version: 1, instanceId: 'chad', destination: 'https://api.grunt.run/admin/ingest', cursor: '900', streamId: oldStream }), { mode: 0o600 });
  await f.collector.cycle();
  expect(f.gets).toContain('/v1/diagnostics/events?limit=200');
  expect(f.gets.some(path => path.includes('900'))).toBe(false);
  expect(JSON.parse(await readFile(join(f.directory, 'admin-collector-state.json'), 'utf8'))).toMatchObject({ cursor: '1', streamId: stream });
});

it('restarts from the oldest retained event when the stream resets between summary and event reads', async () => {
  const f = await fixture();
  await writeFile(join(f.directory, 'admin-collector-state.json'), JSON.stringify({ version: 1, instanceId: 'chad', destination: 'https://api.grunt.run/admin/ingest', cursor: '900', streamId: oldStream }), { mode: 0o600 });
  const prior = f.fetcher.getMockImplementation()!;
  f.fetcher.mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === '/v1/diagnostics/summary') return Response.json({ streamId: oldStream });
    return prior(input, init);
  });
  await f.collector.cycle();
  expect(f.gets.filter(path => path.startsWith('/v1/diagnostics/events'))).toEqual([
    '/v1/diagnostics/events?limit=200&after=900', '/v1/diagnostics/events?limit=200'
  ]);
  expect(JSON.parse(await readFile(join(f.directory, 'admin-collector-state.json'), 'utf8'))).toMatchObject({ cursor: '1', streamId: stream });
});

it('uploads an offline observation without fabricating healthy provider state', async () => {
  const f = await fixture({ unavailable: true });
  // No events were submitted; the server can acknowledge the empty batch.
  f.fetcher.mockImplementation(async (input, init) => {
    if (String(input).startsWith('http://127.0.0.1')) return new Response('synthetic daemon error', { status: 503 });
    f.uploads.push({ body: JSON.parse(String(init?.body)), authorization: new Headers(init?.headers).get('Authorization') });
    return Response.json({ accepted: true, acceptedEvents: 0 });
  });
  expect(await f.collector.cycle()).toEqual({ uploadedEvents: 0, daemonReachable: false });
  expect(f.uploads[0]!.body).toMatchObject({ snapshot: null, events: [], system: { daemonReachable: false, diagnosticsAvailable: false,
    collectorErrors: ['daemon_unavailable', 'diagnostics_unavailable', 'maintenance_unavailable', 'scout_unavailable'] } });
});

it('rejects a public or symlinked checkpoint before making any request', async () => {
  for (const mode of ['public', 'symlink'] as const) {
    const f = await fixture();
    const path = join(f.directory, 'admin-collector-state.json');
    if (mode === 'public') await writeFile(path, '{}', { mode: 0o644 });
    else { const target = join(f.directory, 'untouched.json'); await writeFile(target, '{}', { mode: 0o600 }); await symlink(target, path); }
    await expect(f.collector.cycle()).rejects.toThrow('private_state_required');
    expect(f.fetcher).not.toHaveBeenCalled();
  }
});

it('coalesces overlapping collection cycles instead of uploading or advancing twice', async () => {
  const f = await fixture();
  const one = f.collector.cycle(), two = f.collector.cycle(); expect(two).toBe(one);
  await one; expect(f.uploads).toHaveLength(1);
});

it('reports protected release progress only for the exact current candidate and never uploads review prose or configs', async () => {
  const f = await fixture(), scout = join(f.directory, 'missing-scout'), head = 'c'.repeat(40), candidateId = 'a'.repeat(24);
  const directory = join(scout, 'releases', `pipeline-${head}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(scout, 'last-run.json'), JSON.stringify({ id: '20261116T140001689663Z', status: 'completed' }), { mode: 0o600 });
  await writeFile(join(scout, 'ledger.json'), JSON.stringify({ candidates: { [candidateId]: { model: 'particle-ai/particle-1:free',
    status: 'ready_for_review', pipeline_status: 'publication_pending', release_request: { head_sha: head, source_id: 'openrouter-particle' } } } }), { mode: 0o600 });
  const checks = Object.fromEntries(['model', 'context', 'free_access', 'terms', 'signup', 'consent', 'code_scope'].map(key => [key, true]));
  await writeFile(join(directory, 'checkpoint.json'), JSON.stringify({ phase: 'promotion', result: { status: 'publication_pending' },
    receipt: { head_sha: head, source_id: 'openrouter-particle', model: 'particle-ai/particle-1:free', config_dir: '/private/credentials',
      checks: { head_sha: head, passed: true, commands: ['install', 'lint', 'test', 'build'].map(name => ({ name, passed: true })) },
      probe_verified_by_supervisor: true, reviews: [{ review_id: 'e'.repeat(32), head_sha: head, independent: true, verdict: 'approve', checks, reasons: ['private report prose'] }] } }), { mode: 0o600 });
  await f.collector.cycle();
  expect(f.uploads[0]!.body.scout).toMatchObject({ candidates: [{ id: candidateId, phase: 'promotion', checksPassed: true,
    supervisorProbePassed: true, approvedReviewCount: 1 }] });
  expect((f.uploads[0]!.body.scout as { candidates: unknown[] }).candidates[0]).not.toHaveProperty('published');
  expect(JSON.stringify(f.uploads[0]!.body.scout)).not.toMatch(/private|credentials|reasons|config_dir/);
});

it('leaves unexecuted checks and probes unknown and refuses old-head evidence for a repaired candidate', async () => {
  const f = await fixture(), scout = join(f.directory, 'missing-scout'), head = 'c'.repeat(40), candidateId = 'a'.repeat(24);
  const directory = join(scout, 'releases', `pipeline-${head}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(scout, 'last-run.json'), JSON.stringify({ status: 'completed' }), { mode: 0o600 });
  await writeFile(join(scout, 'ledger.json'), JSON.stringify({ candidates: { [candidateId]: { model: 'particle-ai/particle-1:free',
    status: 'integration_pending', release_request: { head_sha: head, source_id: 'openrouter-particle' } } } }), { mode: 0o600 });
  const checkpoint = { phase: 'validated', result: { status: 'blocked' }, receipt: { head_sha: head, model: 'particle-ai/particle-1:free',
    source_id: 'openrouter-particle', checks: { head_sha: head, passed: false }, reviews: [] } };
  await writeFile(join(directory, 'checkpoint.json'), JSON.stringify(checkpoint), { mode: 0o600 });
  await f.collector.cycle();
  expect(f.uploads[0]!.body.scout).toMatchObject({ candidates: [{ checksPassed: null, supervisorProbePassed: null, approvedReviewCount: 0 }] });
  checkpoint.receipt.head_sha = 'd'.repeat(40);
  await writeFile(join(directory, 'checkpoint.json'), JSON.stringify(checkpoint), { mode: 0o600 });
  // Restart from scratch to inspect a second uploaded snapshot without supplying
  // an obsolete event cursor to this small fixed-event fixture.
  await rm(join(f.directory, 'admin-collector-state.json'));
  const newCollector = new AdminCollector({ url: 'https://api.grunt.run/admin/ingest', ingestKey: 'synthetic-machine-key', instanceId: 'chad',
    directory: f.directory, daemonPort: 8792, scoutDirectory: scout, fetcher: f.fetcher, now: () => now });
  await newCollector.cycle();
  const row = (f.uploads[1]!.body.scout as { candidates: Record<string, unknown>[] }).candidates[0]!;
  expect(row).not.toHaveProperty('phase'); expect(row).not.toHaveProperty('checksPassed'); expect(row).not.toHaveProperty('supervisorProbePassed');
});

it('moves actual durable journal events into the owner store exactly once across collector restarts', async () => {
  const local = await directory(), journal = await DiagnosticsStore.open({ directory: local, now: () => now, runtimeVersion: '0.9.7' });
  const client = createClient({ url: 'file::memory:' }), remote = new AdminStore(client, { now: () => now }); await remote.init();
  try {
    journal.record({ ...event(), id: 'b45a32dd-b630-4dba-95c8-8fab8c97d2cd', type: 'work.start', kind: 'diagnostic', actor: 'worker', stage: 'tool' } as DiagnosticEvent);
    journal.record(event() as DiagnosticEvent);
    journal.record({ ...event(), id: 'fc30da2a-0755-458c-ac63-32375505dce1', type: 'work.finish', kind: 'diagnostic', actor: 'worker', stage: 'tool' } as DiagnosticEvent);
    await journal.flush();
    expect((await journal.list()).events.map(row => row.type)).toEqual(['release.marker', 'work.start', 'attempt.finish', 'work.finish']);
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname === '127.0.0.1') {
        if (url.pathname === '/v1/status') return Response.json(snapshot());
        if (url.pathname === '/v1/diagnostics/summary') return Response.json(await journal.summary());
        return Response.json(await journal.list(url.searchParams.has('after') ? { after: url.searchParams.get('after')! } : {}));
      }
      return Response.json(await remote.ingest(JSON.parse(String(init?.body))));
    });
    const config = { url: 'https://api.grunt.run/admin/ingest', ingestKey: 'synthetic-machine-key', instanceId: 'chad',
      directory: local, daemonPort: 8792, scoutDirectory: join(local, 'missing-scout'), fetcher, now: () => now };
    expect(await new AdminCollector(config).cycle()).toMatchObject({ uploadedEvents: 1 });
    expect(await new AdminCollector(config).cycle()).toMatchObject({ uploadedEvents: 0 });
    const exported = await remote.exportData();
    expect(exported.events).toHaveLength(1);
    expect(exported.events[0]).toMatchObject({ id: event().id, inputTokens: 0 });
    expect(exported.events[0]).not.toHaveProperty('outputTokens');
    expect(exported.events[0]).not.toHaveProperty('runtimeVersion');
  } finally { await journal.close(); client.close(); }
});
