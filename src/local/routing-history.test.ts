import { afterEach, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { mergeRoutingBackoff, RoutingHistory, MAX_ADAPTIVE_BACKOFF_SECONDS, ROUTING_HISTORY_TTL_MS, withRoutingWorkload } from './routing-history.js';
import { SourceStatus } from './source-status.js';
import { RETIRE_AFTER_FAILURES, StickyRouter } from './routing.js';
import { SourceError } from './source.js';
import type { ModelRequest, Source } from './source.js';
import type { Client } from '@libsql/client';
import { bundledRegistry } from '../registry.js';

const roots: string[] = [], stores: RoutingHistory[] = [], routers: StickyRouter[] = [];
async function directory() { const path = await mkdtemp(join(tmpdir(), 'grunt-routing-history-')); roots.push(path); return path; }
async function open(path: string) { const store = await RoutingHistory.open(path); stores.push(store); return store; }
const request: ModelRequest = { model: 'grunt', messages: [{ role: 'user', content: 'PRIVATE_PROMPT' }], tools: [], cwd: '/tmp', stream: false };
const source = (id: string): Source & { complete: ReturnType<typeof vi.fn> } => ({ id, available: vi.fn(async () => true), healthCheck: vi.fn(async () => true), complete: vi.fn(async () => ({ text: 'PRIVATE_ANSWER' })) });
function router(sources: Source[], status: SourceStatus, now: () => number) {
  const value = new StickyRouter(sources, { registry: () => ({ ...bundledRegistry, adapters: sources.map(s => ({ ...bundledRegistry.adapters.find(a => a.id === s.id)!, weight: 1 })) }), observation: status, now, random: () => 0 }); routers.push(value); return value;
}
afterEach(async () => { await Promise.all(routers.splice(0).map(r => r.close())); await Promise.all(stores.splice(0).map(s => s.close())); await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); vi.restoreAllMocks(); });

it('restores completed-call weights across restart without granting availability or readiness', async () => {
  let now = 10000; const path = await directory(), store = await open(path), status = new SourceStatus(['kilo'], () => now);
  await status.setRoutingHistory(store);
  const one = source('kilo'); one.complete.mockImplementation(async () => { now += 2000; return { text: 'PRIVATE_ANSWER' }; });
  await status.complete(one, request, new AbortController().signal); await status.complete(one, request, new AbortController().signal);
  const weight = status.routingWeight('kilo'); expect(weight).toBeGreaterThan(1);
  await store.close(); stores.splice(stores.indexOf(store), 1);
  const restarted = new SourceStatus(['kilo'], () => now); await restarted.setRoutingHistory(await open(path));
  expect(restarted.routingWeight('kilo')).toBe(weight);
  expect(restarted.routingAvailability('kilo', 30000, 5000)).toBeUndefined();
  expect(restarted.snapshot({ ids: ['kilo'], disabled: new Set(), pending: new Set(), verifying: new Set(), approvals: new Set(), preparing: new Set() }).sources[0]).toMatchObject({ state: 'unknown', active: 0 });
  expect(JSON.stringify(restarted.snapshot({ ids: ['kilo'], disabled: new Set(), pending: new Set(), verifying: new Set(), approvals: new Set(), preparing: new Set() }))).not.toContain('lastSuccessAt');
});

it('serializes sibling writers without losing observations and projects only allowlisted numeric metadata', async () => {
  const path = await directory(), first = await open(path), second = await open(path);
  await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? first : second).record('kilo', 'interactive-text', true, 1200, 10000 + i)));
  const value = (await first.snapshot(11000)).performance.find(x => x.profile === 'all')!.value;
  expect(value.samples).toBe(20);
  const failure = new SourceError('upstream', 'PRIVATE_ERROR sk-private-secret', undefined, 'PRIVATE_OUTPUT', { failureReason: 'response_json', httpStatus: 200 });
  await first.failure('kilo', failure, 900, true, 12000);
  const text = (await readFile(join(path, 'routing-history.db'))).toString('utf8');
  expect(text).not.toMatch(/PRIVATE_|sk-private|prompt|output/);
  expect((await second.snapshot(12000)).backoff[0]!.value.signature).toBe('upstream:200:response_json:');
});

it('penalizes slow failed attempts and keeps workload-specific suitability separate', async () => {
  let now = 10000; const status = new SourceStatus(['kilo'], () => now), one = source('kilo');
  for (let i = 0; i < 3; i++) await withRoutingWorkload('interactive-text', () => status.complete(one, request, new AbortController().signal));
  const good = status.routingWeight('kilo');
  one.complete.mockImplementation(async () => { now += 60000; throw new SourceError('upstream', 'PRIVATE_ERROR'); });
  for (let i = 0; i < 3; i++) await withRoutingWorkload('background-tools', () => status.complete(one, request, new AbortController().signal)).catch(() => {});
  expect(status.routingWeight('kilo')).toBeLessThan(good);
  expect(status.routingWeight('kilo', false, 'interactive-text')).toBeGreaterThan(status.routingWeight('kilo', true, 'background-tools'));
});

it('uses finite escalating cooldowns for repeated identical failures and resets after an admitted reply', async () => {
  let now = 10000; const path = await directory(), history = await open(path), status = new SourceStatus(['kilo', 'livekit'], () => now); await status.setRoutingHistory(history);
  const failing = source('kilo'), fallback = source('livekit'); failing.complete.mockRejectedValue(new SourceError('upstream', 'PRIVATE_ERROR', undefined, undefined, { failureReason: 'response_json' }));
  let value = router([failing, fallback], status, () => now);
  // The fifth identical failure reaches the ceiling and retires the route (docs/router.md).
  for (let i = 0; i < RETIRE_AFTER_FAILURES; i++) {
    await value.complete({ ...request, userMessages: ['task-' + i] }, AbortSignal.timeout(1000));
    const delay = value.cooldown('kilo')!.until - now;
    expect(delay).toBe(Math.min(MAX_ADAPTIVE_BACKOFF_SECONDS, 900 * 2 ** i) * 1000);
    now = value.cooldown('kilo')!.until + 1;
  }
  failing.complete.mockResolvedValue({ text: 'recovered' });
  await expect(value.complete({ ...request, model: 'kilo', userMessages: ['recover'] }, AbortSignal.timeout(1000))).rejects.toThrow();
  expect(failing.complete).toHaveBeenCalledTimes(RETIRE_AFTER_FAILURES);
  value.verified('kilo');
  await value.complete({ ...request, model: 'kilo', userMessages: ['verified recovery'] }, AbortSignal.timeout(1000));
  failing.complete.mockRejectedValue(new SourceError('upstream', 'PRIVATE_ERROR', undefined, undefined, { failureReason: 'response_json' }));
  value = router([failing, fallback], status, () => now);
  await value.complete({ ...request, userMessages: ['failure after real recovery'] }, AbortSignal.timeout(1000));
  expect(value.cooldown('kilo')!.until - now).toBe(900000);
});

it.each([['quota', 1234, undefined], ['upstream', 4, 503]] as const)('preserves explicit %s timing across repeats and restart', async (code, retry, httpStatus) => {
  let now = 10000; const path = await directory(), history = await open(path), status = new SourceStatus(['kilo', 'livekit'], () => now); await status.setRoutingHistory(history);
  const one = source('kilo'), two = source('livekit'); one.complete.mockRejectedValue(new SourceError(code, 'PRIVATE_ERROR', retry, undefined, httpStatus ? { httpStatus } : undefined));
  const value = router([one, two], status, () => now);
  for (let i = 0; i < 3; i++) { await value.complete({ ...request, userMessages: ['task-' + i] }, AbortSignal.timeout(1000)); expect(value.cooldown('kilo')!.until - now).toBe(retry * 1000); now += retry * 1000 + 1; }
  const restarted = new SourceStatus(['kilo', 'livekit'], () => now); await restarted.setRoutingHistory(await open(path));
  const restored = router([one, two], restarted, () => now); expect(restored.cooldown('kilo')!.until).toBe(value.cooldown('kilo')!.until);
});

it('does not revive cooldowns or performance indefinitely and leaves explicit source guards authoritative', async () => {
  let now = 10000; const path = await directory(), store = await open(path);
  await store.record('kilo', 'interactive-text', true, 1000, now); await store.record('kilo', 'interactive-text', true, 1000, now);
  await store.failure('kilo', new SourceError('upstream', 'PRIVATE'), 900, true, now);
  now += ROUTING_HISTORY_TTL_MS + 1; const status = new SourceStatus(['kilo'], () => now); await status.setRoutingHistory(store);
  expect(status.routingWeight('kilo')).toBe(1); expect(status.routingBackoff('kilo')).toBeUndefined();
  const denied = source('kilo'); denied.acceptsRequest = () => false;
  await expect(router([denied], status, () => now).complete({ ...request, model: 'kilo' }, AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'refused' }); expect(denied.complete).not.toHaveBeenCalled();
});

it('ignores caller cancellations, and metadata cannot erase a repeated failure streak', async () => {
  let now = 10000; const path = await directory(), store = await open(path), status = new SourceStatus(['kilo'], () => now); await status.setRoutingHistory(store);
  const failure = new SourceError('upstream', 'PRIVATE_ERROR'); await status.failureBackoff('kilo', failure, 900, true);
  now += 1000; await status.available(source('kilo'), true); await status.failureBackoff('kilo', failure, 900, true);
  expect(status.routingBackoff('kilo')!.streak).toBe(2);
  const one = source('kilo'), cancel = new AbortController(); one.complete.mockImplementation(async () => { cancel.abort(); throw new SourceError('cancelled', 'PRIVATE'); });
  await expect(status.complete(one, request, cancel.signal)).rejects.toMatchObject({ code: 'cancelled' });
  expect((await store.snapshot(now)).performance).toEqual([]); expect(status.routingBackoff('kilo')!.streak).toBe(2);
});

it('observes a sibling admitted recovery without resurrecting a quota cooldown', async () => {
  let now = 10000; const path = await directory(), one = await open(path), two = await open(path), status = new SourceStatus(['kilo'], () => now); await status.setRoutingHistory(one);
  await status.failureBackoff('kilo', new SourceError('upstream', 'PRIVATE'), 900, true);
  now += 1000; await two.record('kilo', 'interactive-text', true, 1000, now); await status.refreshRoutingHistory(); expect(status.routingBackoff('kilo')).toBeUndefined();
  await status.failureBackoff('kilo', new SourceError('quota', 'PRIVATE', 3600), 3600, false); const until = status.routingBackoff('kilo')!.until;
  now += 1000; await two.record('kilo', 'interactive-text', true, 1000, now); await status.refreshRoutingHistory(); expect(status.routingBackoff('kilo')!.until).toBe(until);
});

it('rejects unsafe files and newer schemas without deleting them; malformed advisory rows are ignored', async () => {
  const path = await directory(), db = join(path, 'routing-history.db'); await writeFile(db, 'private corrupt fixture', { mode: 0o600 });
  await expect(RoutingHistory.open(path)).rejects.toBeDefined(); expect(await readFile(db, 'utf8')).toBe('private corrupt fixture');
  await rm(db); const secret = join(path, 'other'); await writeFile(secret, 'PRIVATE', { mode: 0o600 }); await symlink(secret, db); await expect(RoutingHistory.open(path)).rejects.toBeDefined(); await rm(db);
  await writeFile(db, '', { mode: 0o644 }); await expect(RoutingHistory.open(path)).rejects.toBeDefined(); await chmod(db, 0o600);
  const store = await open(path); const { createClient } = await import('@libsql/client'); const client = createClient({ url: pathToFileURL(db).href });
  await client.execute({ sql: 'INSERT INTO routing_performance VALUES (?,?,?,?)', args: ['kilo', 'all', JSON.stringify({ samples: 4, reliability: 2, latencyMs: 1000, failureCostMs: 0, at: 10000, private: 'PRIVATE' }), 10000] });
  expect((await store.snapshot(10000)).performance).toEqual([]);
  await store.close(); stores.splice(stores.indexOf(store), 1); await client.execute('PRAGMA user_version=99'); client.close();
  await expect(RoutingHistory.open(path)).rejects.toThrow('Routing history requires');
});

it('keeps accepted replies and original errors intact when advisory persistence fails', async () => {
  let now = 10000; const history = await open(await directory()), status = new SourceStatus(['kilo'], () => now); await status.setRoutingHistory(history);
  vi.spyOn(history, 'record').mockRejectedValue(new Error('PRIVATE_STORAGE_FAILURE'));
  vi.spyOn(history, 'failure').mockRejectedValue(new Error('PRIVATE_STORAGE_FAILURE'));
  const one = source('kilo'), result = { text: 'accepted' }; one.complete.mockResolvedValue(result);
  expect(await status.complete(one, request, new AbortController().signal)).toBe(result);
  const error = new SourceError('upstream', 'PRIVATE_ERROR'); one.complete.mockRejectedValue(error); now += 1000;
  await expect(status.complete(one, request, new AbortController().signal)).rejects.toBe(error);
  expect((await status.failureBackoff('kilo', error, 900, true)).until).toBe(now + 900000);
  now += 1000; expect((await status.failureBackoff('kilo', error, 900, true)).until).toBe(now + 1800000);
  await Promise.all([history.close(), history.close()]);
});

it('keeps atomic samples across independent runtime processes sharing the private database', async () => {
  const path = await directory(), store = await open(path);
  const script = `const {RoutingHistory}=await import(process.argv[1]); const store=await RoutingHistory.open(process.argv[2]); for(let i=0;i<8;i++)await store.record('kilo','interactive-text',true,1000,10000+i); await store.close();`;
  await Promise.all([0, 1].map(() => promisify(execFile)(process.execPath, ['--import', createRequire(import.meta.url).resolve('tsx'), '--input-type=module', '-e', script, new URL('./routing-history.ts', import.meta.url).href, path], { cwd: process.cwd(), timeout: 15000, env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } })));
  expect((await store.snapshot(11000)).performance.find(row => row.profile === 'all')!.value.samples).toBe(16);
});

it('preserves the outstanding absolute quota deadline against sibling failures and shorter quota hints', async () => {
  const path = await directory(), first = await open(path), second = await open(path);
  const quota = await first.failure('kilo', new SourceError('quota', 'PRIVATE', 86400), 86400, false, 10000);
  expect(await second.failure('kilo', new SourceError('upstream', 'PRIVATE'), 900, true, 11000)).toMatchObject({ code: 'quota', signature: 'upstream:::', streak: 1, until: quota.until });
  const shorter = await second.failure('kilo', new SourceError('quota', 'PRIVATE', 60), 60, false, 12000);
  expect(shorter.until).toBe(quota.until); expect(shorter.at).toBeGreaterThanOrEqual(quota.at);
  const later = await first.failure('kilo', new SourceError('quota', 'PRIVATE', 90000), 90000, false, 13000);
  expect(later.until).toBe(90013000);
  // A stale long quota uses its original deadline, never arrival time plus its old delay.
  const delayed = await second.failure('kilo', new SourceError('quota', 'PRIVATE', 100000), 100000, false, 12500);
  expect(delayed.until).toBe(100012500); expect(delayed.at).toBe(later.at);
});

it('ignores stale adaptive failures instead of rewinding or escalating a newer hold', async () => {
  const path = await directory(), first = await open(path), second = await open(path), error = new SourceError('upstream', 'PRIVATE');
  await first.failure('kilo', error, 900, true, 20000);
  const newest = await second.failure('kilo', error, 900, true, 30000);
  expect(newest).toMatchObject({ at: 30000, streak: 2, until: 1830000 });
  expect(await first.failure('kilo', error, 900, true, 25000)).toEqual(newest);
  expect((await second.snapshot(31000)).backoff[0]!.value).toEqual(newest);
});

it('does not let late admitted replies erase newer failures or fabricate a later recovery timestamp', async () => {
  const path = await directory(), first = await open(path), second = await open(path), error = new SourceError('upstream', 'PRIVATE');
  await first.record('kilo', 'interactive-text', false, 1000, 30000);
  const failure = await first.failure('kilo', error, 900, true, 30000);
  await second.record('kilo', 'interactive-text', true, 1000, 25000);
  const state = await first.snapshot(31000);
  expect(state.backoff[0]!.value).toEqual(failure);
  expect(state.performance.find(row => row.profile === 'all')!.value.lastSuccessAt).toBe(25000);
  await second.record('kilo', 'interactive-text', true, 1000, 32000);
  expect((await first.snapshot(33000)).backoff).toEqual([]);
  const stale = await first.failure('kilo', error, 900, true, 31000);
  expect(stale.until).toBeLessThanOrEqual(32000);
  expect((await second.snapshot(33000)).backoff).toEqual([]);
});

it('uses the same monotonic quota and failure merge in SourceStatus without storage', async () => {
  let now = 10000; const status = new SourceStatus(['kilo'], () => now);
  const quota = await status.failureBackoff('kilo', new SourceError('quota', 'PRIVATE'), 86400, false);
  now = 11000; expect(await status.failureBackoff('kilo', new SourceError('upstream', 'PRIVATE'), 900, true)).toMatchObject({ code: 'quota', signature: 'upstream:::', streak: 1, until: quota.until });
  now = 12000; expect((await status.failureBackoff('kilo', new SourceError('quota', 'PRIVATE'), 60, false)).until).toBe(quota.until);
  status.clearRoutingBackoff('kilo'); now = 20000;
  await status.failureBackoff('kilo', new SourceError('upstream', 'PRIVATE'), 900, true);
  now = 30000; const newest = await status.failureBackoff('kilo', new SourceError('upstream', 'PRIVATE'), 900, true);
  now = 25000; expect(await status.failureBackoff('kilo', new SourceError('upstream', 'PRIVATE'), 900, true)).toEqual(newest);
});

it('installs a stronger sibling quota returned by storage even when its observation timestamp is older', async () => {
  const now = 11000; const path = await directory(), first = await open(path), second = await open(path), status = new SourceStatus(['kilo'], () => now); await status.setRoutingHistory(second);
  const quota = await first.failure('kilo', new SourceError('quota', 'PRIVATE'), 86400, false, 10000);
  expect(await status.failureBackoff('kilo', new SourceError('upstream', 'PRIVATE'), 900, true)).toMatchObject({ code: 'quota', signature: 'upstream:::', streak: 1, until: quota.until });
  expect(status.routingBackoff('kilo')).toMatchObject({ code: 'quota', signature: 'upstream:::', streak: 1, until: quota.until });
});


it('preserves newer in-memory failure and recovery ordering for late completions', async () => {
  let now = 30000; const status = new SourceStatus(['kilo'], () => now), error = new SourceError('upstream', 'PRIVATE');
  const newer = await status.failureBackoff('kilo', error, 900, true);
  now = 25000; await status.complete(source('kilo'), request, new AbortController().signal);
  expect(status.routingRecoveryAt('kilo')).toBe(25000);
  expect(status.routingBackoff('kilo')).toEqual(newer);
  now = 32000; await status.complete(source('kilo'), request, new AbortController().signal);
  expect(status.routingBackoff('kilo')).toBeUndefined();
  now = 31000; expect((await status.failureBackoff('kilo', error, 900, true)).until).toBe(31000);
  expect(status.routingBackoff('kilo')).toBeUndefined();
});

it('returns the newer existing failure when a delayed pre-recovery failure is ignored', async () => {
  let now = 34000; const path = await directory(), first = await open(path), second = await open(path);
  const status = new SourceStatus(['kilo'], () => now); await status.setRoutingHistory(second);
  await first.record('kilo', 'interactive-text', true, 1000, 32000);
  const error = new SourceError('upstream', 'PRIVATE');
  const latest = await status.failureBackoff('kilo', error, 900, true);
  now = 31000;
  expect(await status.failureBackoff('kilo', error, 900, true)).toEqual(latest);
  expect(status.routingBackoff('kilo')).toEqual(latest);
  expect((await first.snapshot(35000)).backoff[0]!.value).toEqual(latest);
});

it('does not restore a persisted failure result after a newer reply finishes during its await', async () => {
  let now = 30000; const history = await open(await directory()), status = new SourceStatus(['kilo'], () => now); await status.setRoutingHistory(history);
  const failure = history.failure.bind(history);
  let release!: () => void, stored!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { stored = resolve; });
  vi.spyOn(history, 'failure').mockImplementation(async (...args) => { const value = await failure(...args); stored(); await wait; return value; });
  const pending = status.failureBackoff('kilo', new SourceError('upstream', 'PRIVATE'), 900, true);
  await ready; now = 32000;
  await status.complete(source('kilo'), request, new AbortController().signal);
  release(); expect((await pending).until).toBeLessThanOrEqual(now);
  expect(status.routingBackoff('kilo')).toBeUndefined();
  expect((await history.snapshot(now)).backoff).toEqual([]);
});


it('replaces a connection poisoned by a failed BEGIN without replaying observations', async () => {
  const path = await directory(), history = await open(path);
  const script = `import {createClient} from '@libsql/client'; const client=createClient({url:process.argv[1]}); const tx=await client.transaction('write'); console.log('locked'); for await (const chunk of process.stdin) {} await tx.rollback(); tx.close(); client.close();`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, pathToFileURL(join(path, 'routing-history.db')).href], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  try {
    await once(child.stdout, 'data');
    // Opening an existing schema must not demand a write lock or rerun DDL.
    expect((await (await open(path)).snapshot(11000)).performance).toEqual([]);
    const pending = history.record('kilo', 'interactive-text', true, 1000, 10000);
    // A healthy sibling can hold the database beyond the old ~110 ms retry budget.
    await new Promise(resolve => setTimeout(resolve, 250)); child.stdin.end();
    await pending;
    expect((await history.snapshot(11000)).performance.find(row => row.profile === 'all')!.value.samples).toBe(1);
  } finally { child.stdin.end(); await exited; }
});


it('retries startup metadata reads behind a short exclusive sibling writer without resetting observations', async () => {
  const path = await directory(), history = await open(path);
  await history.record('kilo', 'interactive-text', true, 1000, 10000);
  const script = `import {createRequire} from 'node:module'; const require=createRequire(import.meta.resolve('@libsql/client')); const Database=require('libsql'); const db=new Database(process.argv[1]); db.exec('BEGIN EXCLUSIVE'); console.log('locked'); for await(const chunk of process.stdin) {} db.exec('ROLLBACK'); db.close();`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, join(path, 'routing-history.db')], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  try {
    await once(child.stdout, 'data');
    const pending = open(path);
    // Attach a handler immediately: the baseline must reject before release.
    const opened = pending.then(value => ({ value }), error => ({ error }));
    // A healthy sibling can hold the database beyond the old ~110 ms retry budget.
    await new Promise(resolve => setTimeout(resolve, 250)); child.stdin.end();
    const result = await opened;
    if ('error' in result) throw result.error;
    expect((await result.value.snapshot(11000)).performance.find(row => row.profile === 'all')!.value.samples).toBe(1);
    await result.value.record('kilo', 'interactive-text', true, 1000, 12000);
    expect((await history.snapshot(13000)).performance.find(row => row.profile === 'all')!.value.samples).toBe(2);
  } finally { child.stdin.end(); await exited; }
});


it('rejects exhausted startup read contention without deleting durable observations', async () => {
  const path = await directory(), history = await open(path);
  await history.record('kilo', 'interactive-text', true, 1000, 10000);
  const script = `import {createRequire} from 'node:module'; const require=createRequire(import.meta.resolve('@libsql/client')); const Database=require('libsql'); const db=new Database(process.argv[1]); db.exec('BEGIN EXCLUSIVE'); console.log('locked'); for await(const chunk of process.stdin) {} db.exec('ROLLBACK'); db.close();`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, join(path, 'routing-history.db')], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  try {
    await once(child.stdout, 'data');
    await expect(RoutingHistory.open(path)).rejects.toMatchObject({ code: 'SQLITE_BUSY' });
  } finally { child.stdin.end(); await exited; }
  expect((await (await open(path)).snapshot(11000)).performance.find(row => row.profile === 'all')!.value.samples).toBe(1);
});

it.each([false, true])('retires repeated HTTP 529 failures while preserving four-second retry hints (stored=%s)', async stored => {
  let now = 10000;
  const path = await directory();
  const status = new SourceStatus(['runcrate', 'livekit'], () => now);
  if (stored) await status.setRoutingHistory(await open(path));
  const failing = source('runcrate'), fallback = source('livekit');
  failing.complete.mockRejectedValue(new SourceError('upstream', 'Temporary overload', 4, undefined, { httpStatus: 529 }));
  const value = router([failing, fallback], status, () => now);
  for (let i = 0; i < RETIRE_AFTER_FAILURES; i++) {
    await value.complete({ ...request, userMessages: [`hinted task ${i}`] }, AbortSignal.timeout(1000));
    expect(value.cooldown('runcrate')!.until - now).toBe(4000);
    now += 4001;
  }
  expect(value.retired('runcrate')).toBe(true);
  await expect(value.complete({ ...request, model: 'runcrate', userMessages: ['retired explicit request'] }, AbortSignal.timeout(1000))).rejects.toThrow();
  expect(failing.complete).toHaveBeenCalledTimes(RETIRE_AFTER_FAILURES);
  if (stored) {
    const restored = new SourceStatus(['runcrate', 'livekit'], () => now);
    await restored.setRoutingHistory(await open(path));
    expect(router([failing, fallback], restored, () => now).retired('runcrate')).toBe(true);
  }
});

it.each([
  [false, 'quota'], [false, 'different'], [true, 'quota'], [true, 'different']
] as const)('keeps retirement with stored=%s after a sixth admitted %s failure', async (stored, later) => {
  let now = 10000;
  const path = await directory();
  const status = new SourceStatus(['runcrate'], () => now);
  if (stored) await status.setRoutingHistory(await open(path));
  const one = source('runcrate');
  const rejects: ((reason: SourceError) => void)[] = [];
  // Admission includes asynchronous filesystem work, so completion order need not match launch order.
  one.complete.mockImplementation((input: ModelRequest) => new Promise((_resolve, reject) => {
    rejects[Number(input.userMessages![0]!.split(' ').at(-1))] = reject;
  }));
  const value = router([one], status, () => now);
  const turns = Array.from({ length: 6 }, (_, i) => value.complete({ ...request, userMessages: [`admitted task ${i}`] }, AbortSignal.timeout(5000))
    .then(() => undefined, error => error));
  try {
    await vi.waitFor(() => expect(rejects.filter(Boolean)).toHaveLength(6));
    for (let i = 0; i < RETIRE_AFTER_FAILURES; i++) {
      rejects[i]!(new SourceError('upstream', 'Synthetic outage'));
      await turns[i];
      now += 1000;
    }
    expect(value.retired('runcrate')).toBe(true);
    const retired = status.routingBackoff('runcrate');
    rejects[5]!(later === 'quota' ? new SourceError('quota', 'Daily limit', 60)
      : new SourceError('upstream', 'Different outage', undefined, undefined, { httpStatus: 502 }));
    await turns[5];
    expect(status.routingBackoff('runcrate')).toEqual({ ...retired, ...(later === 'quota' ? { code: 'quota', quotaUntil: 75000 } : {}) });
    expect(value.retired('runcrate')).toBe(true);
    if (stored) {
      const restored = new SourceStatus(['runcrate'], () => now);
      await restored.setRoutingHistory(await open(path));
      expect(router([one], restored, () => now).retired('runcrate')).toBe(true);
    }
    now += 2 * 60 * 60 * 1000 + 1;
    await expect(value.complete({ ...request, model: 'runcrate', userMessages: ['after late failure'] }, AbortSignal.timeout(1000))).rejects.toThrow();
    expect(one.complete).toHaveBeenCalledTimes(6);
    value.verified('runcrate');
    one.complete.mockResolvedValueOnce({ text: 'verified recovery' });
    await expect(value.complete({ ...request, model: 'runcrate', userMessages: ['after verification'] }, AbortSignal.timeout(1000))).resolves.toEqual({ text: 'verified recovery' });
  } finally {
    for (const reject of rejects) reject(new SourceError('cancelled', 'Test cleanup'));
    await Promise.all(turns);
  }
});

it('preserves retirement when sibling bookkeeping arrives in either order', () => {
  const retired = { code: 'upstream' as const, signature: 'upstream:::', streak: 5, at: 10000, until: 7210000 };
  for (const other of [
    { code: 'quota' as const, signature: 'quota:::', streak: 1, at: 11000, until: 86411000 },
    { code: 'upstream' as const, signature: 'upstream:502::', streak: 1, at: 11000, until: 911000 }
  ]) {
    const until = other.code === 'quota' ? 86411000 : 7210000;
    expect(mergeRoutingBackoff(retired, other)).toEqual({ ...retired, code: other.code === 'quota' ? 'quota' : 'upstream', until, ...(other.code === 'quota' ? { quotaUntil: 86411000 } : {}) });
    expect(mergeRoutingBackoff(other, retired)).toEqual({ ...retired, code: other.code === 'quota' ? 'quota' : 'upstream', until, ...(other.code === 'quota' ? { quotaUntil: 86411000 } : {}) });
  }
});

it.each([false, true])('counts five HTTP 502 failures after an admitted quota response without shortening its deadline (stored=%s)', async stored => {
  let now = 10000;
  const path = await directory();
  const status = new SourceStatus(['runcrate'], () => now);
  if (stored) await status.setRoutingHistory(await open(path));
  const one = source('runcrate');
  const rejects: ((error: SourceError) => void)[] = [];
  // Admission includes asynchronous filesystem work, so completion order need not match launch order.
  one.complete.mockImplementation((input: ModelRequest) => new Promise((_resolve, reject) => {
    rejects[Number(input.userMessages![0]!.split(' ').at(-1))] = reject;
  }));
  const value = router([one], status, () => now);
  const turns = Array.from({ length: 6 }, (_, i) => value.complete({ ...request, userMessages: [`quota-first task ${i}`] }, AbortSignal.timeout(5000))
    .then(() => undefined, error => error));
  try {
    await vi.waitFor(() => expect(rejects.filter(Boolean)).toHaveLength(6));
    rejects[0]!(new SourceError('quota', 'Reset in sixty seconds', 60));
    await turns[0];
    expect(value.cooldown('runcrate')!.until).toBe(70000);
    for (let i = 1; i <= 5; i++) {
      now += 1000;
      rejects[i]!(new SourceError('upstream', 'Temporary upstream error', 4, undefined, { httpStatus: 502 }));
      await turns[i];
      expect(value.cooldown('runcrate')!.until).toBe(70000);
      expect(status.routingBackoff('runcrate')).toMatchObject({ code: 'quota', signature: 'upstream:502::', streak: i });
      expect(value.retired('runcrate')).toBe(i === 5);
    }
    now = 70001;
    await expect(value.complete({ ...request, model: 'runcrate', userMessages: ['after quota reset'] }, AbortSignal.timeout(1000))).rejects.toThrow();
    expect(one.complete).toHaveBeenCalledTimes(6);
    if (stored) {
      const restored = new SourceStatus(['runcrate'], () => now);
      await restored.setRoutingHistory(await open(path));
      expect(router([one], restored, () => now).retired('runcrate')).toBe(true);
    }
  } finally {
    for (const reject of rejects) reject(new SourceError('cancelled', 'Test cleanup'));
    await Promise.all(turns);
  }
});

it.each([false, true])('a successful admitted reply clears the failure streak while retaining the quota hold (stored=%s)', async stored => {
  let now = 10000;
  const path = await directory();
  const status = new SourceStatus(['runcrate'], () => now);
  if (stored) await status.setRoutingHistory(await open(path));
  const one = source('runcrate'), value = router([one], status, () => now);
  await status.failureBackoff('runcrate', new SourceError('quota', 'Daily reset'), 60, false);
  for (let i = 0; i < 5; i++) {
    now += 1000;
    await status.failureBackoff('runcrate', new SourceError('upstream', 'Temporary error', 4, undefined, { httpStatus: 502 }), 4, false);
  }
  expect(value.retired('runcrate')).toBe(true);
  now += 1000;
  await status.complete(one, request, new AbortController().signal);
  expect(value.retired('runcrate')).toBe(false);
  expect(value.cooldown('runcrate')).toEqual({ code: 'quota', until: 70000 });
  if (stored) {
    const restored = new SourceStatus(['runcrate'], () => now);
    await restored.setRoutingHistory(await open(path));
    const reloaded = router([one], restored, () => now);
    expect(reloaded.retired('runcrate')).toBe(false);
    expect(reloaded.cooldown('runcrate')).toEqual({ code: 'quota', until: 70000 });
  }
  await expect(value.complete({ ...request, model: 'runcrate', userMessages: ['still quota held'] }, AbortSignal.timeout(1000))).rejects.toThrow();
  now = 70001;
  await expect(value.complete({ ...request, model: 'runcrate', userMessages: ['after actual reset'] }, AbortSignal.timeout(1000))).resolves.toEqual({ text: 'PRIVATE_ANSWER' });
});

it.each([false, true])('clears a recovered upstream cooldown while preserving the actual sixty-second quota reset (stored=%s)', async stored => {
  let now = 10000;
  const path = await directory();
  const status = new SourceStatus(['runcrate'], () => now);
  if (stored) await status.setRoutingHistory(await open(path));
  const one = source('runcrate');
  const admitted: { resolve(value: { text: string }): void; reject(error: SourceError): void }[] = [];
  // Match deferred replies to their task rather than filesystem-dependent admission order.
  one.complete.mockImplementation((input: ModelRequest) => new Promise((resolve, reject) => {
    admitted[Number(input.userMessages![0]!.split(' ').at(-1))] = { resolve, reject };
  }));
  const value = router([one], status, () => now);
  const turns = Array.from({ length: 3 }, (_, i) => value.complete({ ...request, userMessages: [`quota and recovery ${i}`] }, AbortSignal.timeout(5000))
    .then(result => result, error => error));
  try {
    await vi.waitFor(() => expect(admitted.filter(Boolean)).toHaveLength(3));
    admitted[0]!.reject(new SourceError('quota', 'Reset in sixty seconds', 60));
    await turns[0];
    now = 11000;
    admitted[1]!.reject(new SourceError('upstream', 'Temporary failure', undefined, undefined, { httpStatus: 502 }));
    await turns[1];
    expect(value.cooldown('runcrate')!.until).toBe(911000);
    const sibling = stored ? new SourceStatus(['runcrate'], () => now) : undefined;
    if (sibling) await sibling.setRoutingHistory(await open(path));
    now = 12000;
    admitted[2]!.resolve({ text: 'Sibling recovered' });
    expect(await turns[2]).toEqual({ text: 'Sibling recovered' });
    expect(value.cooldown('runcrate')).toEqual({ code: 'quota', until: 70000 });
    if (sibling) {
      await sibling.refreshRoutingHistory();
      expect(router([one], sibling, () => now).cooldown('runcrate')).toEqual({ code: 'quota', until: 70000 });
      const restored = new SourceStatus(['runcrate'], () => now);
      await restored.setRoutingHistory(await open(path));
      expect(router([one], restored, () => now).cooldown('runcrate')).toEqual({ code: 'quota', until: 70000 });
    }
    await expect(value.complete({ ...request, model: 'runcrate', userMessages: ['before quota reset'] }, AbortSignal.timeout(1000))).rejects.toThrow();
    expect(one.complete).toHaveBeenCalledTimes(3);
    now = 70001;
    one.complete.mockResolvedValueOnce({ text: 'Available at the actual reset' });
    await expect(value.complete({ ...request, model: 'runcrate', userMessages: ['after quota reset'] }, AbortSignal.timeout(1000))).resolves.toEqual({ text: 'Available at the actual reset' });
  } finally {
    for (const turn of admitted) turn.reject(new SourceError('cancelled', 'Test cleanup'));
    await Promise.all(turns);
  }
});


it('retries a real COMMIT reader lock without duplicating samples or shortening quota', async () => {
  const path = await directory(), history = await open(path);
  const quota = await history.failure('kilo', new SourceError('quota', 'PRIVATE'), 86400, false, 10000);
  // A shared reader allows BEGIN IMMEDIATE and the writes, but blocks COMMIT's
  // exclusive lock in DELETE journal mode. Hold it until COMMIT actually fails.
  const script = `import {createRequire} from 'node:module'; const require=createRequire(import.meta.resolve('@libsql/client')); const Database=require('libsql'); const db=new Database(process.argv[1]); db.exec('BEGIN'); db.prepare('SELECT * FROM routing_backoff').all(); console.log('reading'); for await(const chunk of process.stdin) {} db.exec('ROLLBACK'); db.close();`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, join(path, 'routing-history.db')], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  let busy!: (value: unknown) => void;
  const commitBlocked = new Promise<unknown>(resolve => { busy = resolve; });
  const client = (history as unknown as { client: Client }).client, transaction = client.transaction.bind(client);
  const begin = vi.spyOn(client, 'transaction').mockImplementation(async mode => {
    const tx = await transaction(mode), executeMultiple = tx.executeMultiple.bind(tx), commit = tx.commit.bind(tx);
    // Observe either implementation so this fixture also fails promptly on the
    // old settling commit() API, rather than depending on a test timeout.
    vi.spyOn(tx, 'commit').mockImplementation(async () => { try { await commit(); } catch (error) { busy(error); throw error; } });
    vi.spyOn(tx, 'executeMultiple').mockImplementation(async sql => { try { await executeMultiple(sql); } catch (error) { busy(error); throw error; } });
    return tx;
  });
  try {
    await once(child.stdout, 'data');
    const outcome = history.record('kilo', 'interactive-text', true, 1000, 11000).then(value => ({ value }), error => ({ error }));
    expect(await commitBlocked).toMatchObject({ code: 'SQLITE_BUSY' });
    child.stdin.end(); await exited;
    const result = await outcome; if ('error' in result) throw result.error;
    expect(begin).toHaveBeenCalledTimes(1); // Retrying COMMIT must keep ownership and never replay the SQL unit.
    const snapshot = await history.snapshot(12000);
    expect(snapshot.performance.map(row => row.value.samples)).toEqual([1, 1]);
    expect(snapshot.backoff[0]!.value).toMatchObject({ code: 'quota', until: quota.until });
    await history.record('kilo', 'interactive-text', true, 1000, 12000);
    expect((await history.snapshot(13000)).performance.map(row => row.value.samples)).toEqual([2, 2]);
  } finally { child.stdin.end(); await exited; }
});

it('bounds COMMIT reader retries and rolls back all uncommitted observations', async () => {
  const path = await directory(), history = await open(path);
  const quota = await history.failure('kilo', new SourceError('quota', 'PRIVATE'), 86400, false, 10000);
  const script = `import {createRequire} from 'node:module'; const require=createRequire(import.meta.resolve('@libsql/client')); const Database=require('libsql'); const db=new Database(process.argv[1]); db.exec('BEGIN'); db.prepare('SELECT * FROM routing_backoff').all(); console.log('reading'); for await(const chunk of process.stdin) {} db.exec('ROLLBACK'); db.close();`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, join(path, 'routing-history.db')], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  try {
    await once(child.stdout, 'data');
    // Advance only the bounded retry clock, without waiting two real seconds.
    const clock = vi.spyOn(performance, 'now').mockReturnValueOnce(1000).mockReturnValue(4000);
    await expect(history.record('kilo', 'interactive-text', true, 1000, 11000)).rejects.toMatchObject({ code: 'SQLITE_BUSY' });
    clock.mockRestore(); child.stdin.end(); await exited;
    const snapshot = await history.snapshot(12000);
    expect(snapshot.performance).toEqual([]); expect(snapshot.backoff[0]!.value).toEqual(quota);
    await history.record('kilo', 'interactive-text', true, 1000, 12000);
    expect((await history.snapshot(13000)).performance.map(row => row.value.samples)).toEqual([1, 1]);
  } finally { child.stdin.end(); await exited; }
});


it('does not retry non-contention COMMIT failures or keep their uncommitted samples', async () => {
  const history = await open(await directory()), client = (history as unknown as { client: Client }).client;
  const transaction = client.transaction.bind(client), failure = Object.assign(new Error('synthetic disk failure'), { code: 'SQLITE_IOERR' });
  let commits = 0;
  const begin = vi.spyOn(client, 'transaction').mockImplementation(async mode => {
    const tx = await transaction(mode), executeMultiple = tx.executeMultiple.bind(tx);
    vi.spyOn(tx, 'executeMultiple').mockImplementation(async sql => {
      if (sql === 'COMMIT') { commits++; throw failure; }
      await executeMultiple(sql);
    });
    return tx;
  });
  await expect(history.record('kilo', 'interactive-text', true, 1000, 10000)).rejects.toBe(failure);
  expect(begin).toHaveBeenCalledTimes(1); expect(commits).toBe(1);
  expect((await history.snapshot(11000)).performance).toEqual([]);
  begin.mockRestore();
  await history.record('kilo', 'interactive-text', true, 1000, 12000);
  expect((await history.snapshot(13000)).performance.map(row => row.value.samples)).toEqual([1, 1]);
});
