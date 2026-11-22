import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createClient } from '@libsql/client';
import { DiagnosticsStore, sanitizeDiagnosticEvent } from './diagnostics.js';
import type { DiagnosticEvent } from './diagnostics.js';
import { DIAGNOSTIC_LATENCY_BOUNDS_MS, DIAGNOSTIC_METRIC_MAX_SEEN, DIAGNOSTIC_METRIC_MAX_SERIES_PER_HOUR } from './diagnostic-metrics.js';

const paths: string[] = [], stores: DiagnosticsStore[] = [];
const start = 1795363200000;
const event = (patch: Partial<DiagnosticEvent> = {}): DiagnosticEvent => ({ version: 1, id: randomUUID(), requestId: randomUUID(), at: start + 1000, type: 'request.finish', kind: 'user', actor: 'client', outcome: 'passed', source: 'fixture', ...patch });
async function open(path?: string, options: Omit<Parameters<typeof DiagnosticsStore.open>[0], 'directory'> = {}) {
  if (!path) { path = await mkdtemp(join(tmpdir(), 'grunt-metrics-')); paths.push(path); }
  const value = await DiagnosticsStore.open({ directory: path, now: () => start + 10000, ...options }); stores.push(value); return { value, path };
}
afterEach(async () => { await Promise.all(stores.splice(0).map(value => value.close())); await Promise.all(paths.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

it('retains hourly aggregates after raw count pruning and restart without counting replayed IDs twice', async () => {
  const { value, path } = await open(undefined, { maxEvents: 100, runtimeVersion: '0.9.7' });
  const events = Array.from({ length: 350 }, () => event({ durationMs: 25 }));
  events.forEach(row => value.record(row));
  expect((await value.list({ limit: 500 })).events).toHaveLength(100);
  let result = await value.metrics();
  expect(result.buckets.filter(row => row.dimensions.type === 'request.finish').reduce((sum, row) => sum + row.count, 0)).toBe(350);
  expect(result.coverage.startedAt).toBe(start + 10000);
  await value.close();
  const reopened = (await open(path, { maxEvents: 100, runtimeVersion: '0.9.7' })).value;
  reopened.record(events[0]!); reopened.record(events[0]!);
  result = await reopened.metrics();
  expect(result.buckets.filter(row => row.dimensions.type === 'request.finish').reduce((sum, row) => sum + row.count, 0)).toBe(350);
  expect(result.buckets.filter(row => row.dimensions.type === 'release.marker').reduce((sum, row) => sum + row.count, 0)).toBe(1);
  expect(reopened.health()).toMatchObject({ available: true, queued: 0, droppedEvents: 0 });
});

it('commits raw events and metrics atomically and preserves an existing database on write failure', async () => {
  const { value, path } = await open();
  const db = createClient({ url: pathToFileURL(join(path, 'diagnostics.db')).href });
  await db.execute("CREATE TRIGGER reject_metrics BEFORE INSERT ON diagnostic_metric_hours BEGIN SELECT RAISE(ABORT,'fixture'); END");
  value.record(event()); await value.flush();
  expect(value.health()).toMatchObject({ available: false, error: 'write_failed', droppedEvents: 1 });
  expect((await db.execute('SELECT count(*) AS count FROM diagnostic_events')).rows[0]?.count).toBe(0);
  expect((await db.execute('SELECT count(*) AS count FROM diagnostic_metric_seen')).rows[0]?.count).toBe(0);
  const incomplete = await value.metrics();
  expect(incomplete.coverage.droppedEvents).toBe(1);
  expect(incomplete.ingestionHealth.droppedEvents).toBe(1);
  await db.execute('DROP TRIGGER reject_metrics');
  value.record(event()); await value.flush();
  expect(value.health()).toMatchObject({ available: true, droppedEvents: 1 });
  db.close();
});

it('persists queue overflow and buffered observation loss across restart', async () => {
  const { value, path } = await open();
  for (let i = 0; i < 1100; i++) value.record(event());
  expect(value.health()).toMatchObject({ available: false, error: 'queue_full', droppedEvents: 100 });
  value.recordDropped(7);
  const metrics = await value.metrics();
  expect(metrics.ingestionHealth).toMatchObject({ available: true, queued: 0, droppedEvents: 107 });
  expect(metrics.coverage).toMatchObject({ droppedEvents: 107, persistentDroppedEvents: 107 });
  await value.close();
  const reopened = (await open(path)).value;
  expect((await reopened.metrics()).coverage).toMatchObject({ droppedEvents: 107, persistentDroppedEvents: 107 });
  expect(() => reopened.recordDropped(-1)).toThrow('Invalid diagnostic loss count');
});

it('merges sibling writers and deduplicates shared events and runtime markers', async () => {
  const first = await open(undefined, { runtimeVersion: '0.9.7' }), second = await open(relative(process.cwd(), first.path), { runtimeVersion: '0.9.7' });
  const shared = event();
  for (let i = 0; i < 70; i++) { first.value.record(event()); second.value.record(event()); }
  first.value.record(shared); second.value.record(shared);
  await Promise.all([first.value.flush(), second.value.flush()]);
  const result = await first.value.metrics();
  expect(first.value.health().available).toBe(true); expect(second.value.health().available).toBe(true);
  expect(result.buckets.filter(row => row.dimensions.type === 'request.finish').reduce((sum, row) => sum + row.count, 0)).toBe(141);
  expect(result.buckets.filter(row => row.dimensions.type === 'release.marker').reduce((sum, row) => sum + row.count, 0)).toBe(1);
});

it('atomically aggregates concurrently writing sibling processes', async () => {
  const { value, path } = await open(), commonId = randomUUID();
  const program = `import {DiagnosticsStore} from process.argv[1];`;
  // Static module specifiers are required by ESM; the fixture imports only this trusted checkout.
  const source = program.replace('from process.argv[1]', 'from ' + JSON.stringify(new URL('./diagnostics.ts', import.meta.url).href)) + `
    import {randomUUID} from 'node:crypto';
    const store=await DiagnosticsStore.open({directory:process.argv[1],runtimeVersion:'0.9.7',now:()=>${start + 10000}});
    for(let i=0;i<80;i++)store.record({version:1,id:randomUUID(),requestId:randomUUID(),at:${start + 1000},type:'request.finish',kind:'user',actor:'client',outcome:'passed'});
    store.record({version:1,id:process.argv[2],requestId:process.argv[2],at:${start + 1000},type:'request.finish',kind:'user',actor:'client',outcome:'passed'});
    await store.flush();process.stdout.write(JSON.stringify(store.health()));await store.close();`;
  const results = await Promise.all(Array.from({ length: 3 }, () => promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source, path, commonId], { cwd: process.cwd(), timeout: 15000 })));
  for (const result of results) expect(JSON.parse(result.stdout)).toMatchObject({ available: true, droppedEvents: 0 });
  const metrics = await value.metrics();
  expect(metrics.buckets.filter(row => row.dimensions.type === 'request.finish').reduce((sum, row) => sum + row.count, 0)).toBe(241);
  expect(metrics.buckets.filter(row => row.dimensions.type === 'release.marker').reduce((sum, row) => sum + row.count, 0)).toBe(1);
}, 20000);

it('records explicit histogram bounds, missing duration and unknown token usage separately', async () => {
  const { value } = await open();
  for (const durationMs of [0, 1, 5, 5.5, 3600001]) value.record(event({ type: 'attempt.finish', durationMs, inputTokens: 0, outputTokens: 3 }));
  value.record(event({ type: 'attempt.finish' }));
  const result = await value.metrics(), bucket = result.buckets[0]!;
  expect(result.histogram).toEqual({ upperBoundsMs: DIAGNOSTIC_LATENCY_BOUNDS_MS, overflowBucket: true, cumulative: false });
  expect(bucket).toMatchObject({ count: 6, durationCount: 5, durationSumMs: 3600012.5, durationMaxMs: 3600001, inputTokens: 0, outputTokens: 15, unknownInput: 1, unknownOutput: 1 });
  expect(bucket.durationHistogram.slice(0, 3)).toEqual([2, 1, 1]); expect(bucket.durationHistogram.at(-1)).toBe(1);
  expect(bucket.durationHistogram.reduce((a, b) => a + b, 0)).toBe(bucket.durationCount);
});

it('bounds series cardinality and reports overflow rather than implying complete breakdowns', async () => {
  const { value } = await open();
  for (let i = 0; i < 280; i++) value.record(event({ source: 'fixture-' + i }));
  const result = await value.metrics();
  expect(result.buckets).toHaveLength(DIAGNOSTIC_METRIC_MAX_SERIES_PER_HOUR);
  expect(result.buckets.reduce((sum, row) => sum + row.count, 0)).toBe(280);
  expect(result.coverage.overflowEvents).toBe(25);
  expect(result.buckets.find(row => row.dimensions.type === 'overflow')?.count).toBe(25);
});

it('expires whole old hours and rejects stale ID replays outside aggregate retention', async () => {
  let now = start + 10000;
  const { value } = await open(undefined, { now: () => now });
  const old = event(); value.record(old); await value.flush();
  now += 31 * 86400000;
  value.record(event({ at: now })); await value.flush(); value.record(old);
  const result = await value.metrics();
  expect(result.buckets.reduce((sum, row) => sum + row.count, 0)).toBe(1);
  expect(result.coverage.droppedLateEvents).toBe(1);
  expect(result.coverage.deduplicationFloor).toBeGreaterThan(old.at);
});

it('bounds the retained ID ledger and refuses to recount IDs below its explicit coverage floor', async () => {
  const { value, path } = await open();
  const old = event(); value.record(old); await value.flush();
  const db = createClient({ url: pathToFileURL(join(path, 'diagnostics.db')).href });
  await db.execute({ sql: `WITH RECURSIVE fixture(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM fixture WHERE n<?)
    INSERT INTO diagnostic_metric_seen(id,at) SELECT 'fixture-'||n,? FROM fixture`, args: [DIAGNOSTIC_METRIC_MAX_SEEN, start + 1000] });
  value.record(event({ at: start + 2000 })); await value.flush();
  expect(Number((await db.execute('SELECT count(*) AS count FROM diagnostic_metric_seen')).rows[0]?.count)).toBeLessThanOrEqual(DIAGNOSTIC_METRIC_MAX_SEEN);
  // Prune the raw ID to simulate replay after both rolling retention layers advance.
  await db.execute({ sql: 'DELETE FROM diagnostic_events WHERE id=?', args: [old.id] });
  value.record(old);
  const result = await value.metrics();
  expect(result.coverage.deduplicationFloor).toBe(start + 1001);
  expect(result.coverage.droppedLateEvents).toBe(1);
  expect(result.buckets.reduce((sum, row) => sum + row.count, 0)).toBe(2);
  db.close();
});

it('attributes trusted runtime versions and limits work metadata to safe enums and UUIDs', async () => {
  const parentId = randomUUID();
  const input = event({ type: 'work.finish', stage: 'verification', workDisposition: 'reused', parentId, runtimeVersion: '9.9.9' });
  const safe = sanitizeDiagnosticEvent({ ...input, command: 'SECRET', text: 'SECRET', stage: '/private', parentId: 'SECRET', runtimeVersion: 'SECRET' });
  expect(safe).not.toHaveProperty('parentId'); expect(safe).not.toHaveProperty('stage'); expect(safe).not.toHaveProperty('runtimeVersion');
  const { value } = await open(undefined, { runtimeVersion: '0.9.7' }); value.record(input);
  const trace = await value.trace(input.requestId);
  expect(trace.events[0]).toMatchObject({ type: 'work.finish', stage: 'verification', workDisposition: 'reused', parentId, runtimeVersion: '0.9.7' });
  expect(JSON.stringify(await value.metrics())).not.toMatch(/SECRET|9\.9\.9|private/);
  await expect(open(undefined, { runtimeVersion: 'SECRET' })).rejects.toThrow('Invalid runtime version');
});

it('marks version transitions once and labels metrics windows as whole hours', async () => {
  const first = await open(undefined, { runtimeVersion: '0.9.6' }); await first.value.close();
  const second = await open(first.path, { runtimeVersion: '0.9.7' });
  const result = await second.value.metrics({ since: start + 500, until: start + 9000 });
  expect(result.window).toEqual({ since: start + 500, until: start + 9000, alignedSince: start, alignedUntil: start + 3600000 });
  expect(result.buckets.filter(row => row.dimensions.type === 'release.marker').map(row => row.dimensions.runtimeVersion).sort()).toEqual(['0.9.6', '0.9.7']);
  await expect(second.value.metrics({ since: start + 10001 })).rejects.toThrow('Invalid diagnostic metrics window');
});
