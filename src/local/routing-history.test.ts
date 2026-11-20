import { afterEach, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { RoutingHistory, MAX_ADAPTIVE_BACKOFF_SECONDS, ROUTING_HISTORY_TTL_MS, withRoutingWorkload } from './routing-history.js';
import { SourceStatus } from './source-status.js';
import { StickyRouter } from './routing.js';
import { SourceError } from './source.js';
import type { ModelRequest, Source } from './source.js';
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
  for (let i = 0; i < 6; i++) {
    await value.complete({ ...request, userMessages: ['task-' + i] }, AbortSignal.timeout(1000));
    const delay = value.cooldown('kilo')!.until - now;
    expect(delay).toBe(Math.min(MAX_ADAPTIVE_BACKOFF_SECONDS, 900 * 2 ** i) * 1000);
    now = value.cooldown('kilo')!.until + 1;
  }
  failing.complete.mockResolvedValue({ text: 'recovered' });
  await value.complete({ ...request, model: 'kilo', userMessages: ['recover'] }, AbortSignal.timeout(1000));
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
  expect(await second.failure('kilo', new SourceError('upstream', 'PRIVATE'), 900, true, 11000)).toEqual(quota);
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
  now = 11000; expect(await status.failureBackoff('kilo', new SourceError('upstream', 'PRIVATE'), 900, true)).toEqual(quota);
  now = 12000; expect((await status.failureBackoff('kilo', new SourceError('quota', 'PRIVATE'), 60, false)).until).toBe(quota.until);
  status.clearRoutingBackoff('kilo'); now = 20000;
  await status.failureBackoff('kilo', new SourceError('upstream', 'PRIVATE'), 900, true);
  now = 30000; const newest = await status.failureBackoff('kilo', new SourceError('upstream', 'PRIVATE'), 900, true);
  now = 25000; expect(await status.failureBackoff('kilo', new SourceError('upstream', 'PRIVATE'), 900, true)).toEqual(newest);
});

it('installs a stronger sibling quota returned by storage even when its observation timestamp is older', async () => {
  const now = 11000; const path = await directory(), first = await open(path), second = await open(path), status = new SourceStatus(['kilo'], () => now); await status.setRoutingHistory(second);
  const quota = await first.failure('kilo', new SourceError('quota', 'PRIVATE'), 86400, false, 10000);
  expect(await status.failureBackoff('kilo', new SourceError('upstream', 'PRIVATE'), 900, true)).toEqual(quota);
  expect(status.routingBackoff('kilo')).toEqual(quota);
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
