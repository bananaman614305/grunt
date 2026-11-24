import { afterEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundledRegistry } from '../registry.js';
import { StickyRouter } from './routing.js';
import { RoutingHistory } from './routing-history.js';
import { SourceStatus } from './source-status.js';
import { SourceError, Sources, requestRefusal } from './source.js';
import type { Completion, ModelRequest, Source } from './source.js';

// Concurrent new tasks claim their source in the same tick as the draw, so they spread over idle sources.
const routers: StickyRouter[] = [], roots: string[] = [], stores: RoutingHistory[] = [];
afterEach(async () => {
  await Promise.all(routers.splice(0).map(router => router.close()));
  await Promise.all(stores.splice(0).map(store => store.close()));
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
const ids = ['kilo', 'livekit', 'runcrate', 'pollinations'];
const source = (id: string): Source => ({ id, available: vi.fn(async () => true), complete: vi.fn(async () => ({ text: id })) });
const ask = (content: string): ModelRequest => ({ model: 'grunt', messages: [{ role: 'user', content }], cwd: '/tmp', tools: [], stream: false });
function gate() { let open!: () => void; const promise = new Promise<void>(resolve => { open = resolve; }); return { promise, open }; }
// The attempt is injected, so only the router's own bookkeeping can mark a source busy.
function pool(count: number, attempt: (source: Source, request: ModelRequest, signal: AbortSignal) => Promise<Completion>, extra: Partial<ConstructorParameters<typeof StickyRouter>[1]> = {}) {
  const items = ids.slice(0, count).map(source);
  const router = new StickyRouter(items, {
    registry: () => ({ ...bundledRegistry, adapters: items.map(item => ({ ...bundledRegistry.adapters.find(a => a.id === item.id)!, weight: 1 })) }),
    random: () => 0, attempt, ...extra
  });
  routers.push(router);
  return { items, router };
}
const never = (signal: AbortSignal) => new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(new SourceError('cancelled', 'Cancelled')), { once: true }));

it('spreads concurrent new tasks across distinct idle sources even with a fixed draw', async () => {
  const picked: string[] = [], hold = gate();
  const { router } = pool(3, async item => { picked.push(item.id); await hold.promise; return { text: item.id }; });
  const tasks = [1, 2, 3].map(n => router.complete(ask(`spread ${n}`), AbortSignal.timeout(5000)));
  await vi.waitFor(() => expect(picked).toHaveLength(3));
  expect(new Set(picked).size).toBe(3);
  hold.open();
  expect((await Promise.all(tasks)).map(result => result.text).sort()).toEqual([...picked].sort());
});

it('still serves every task when there are fewer idle sources than tasks', async () => {
  const picked: string[] = [], hold = gate();
  const { router } = pool(2, async item => { picked.push(item.id); await hold.promise; return { text: item.id }; });
  const tasks = [1, 2, 3, 4].map(n => router.complete(ask(`crowd ${n}`), AbortSignal.timeout(5000)));
  await vi.waitFor(() => expect(picked).toHaveLength(4));
  // The first two spread over both sources; the rest share them as before.
  expect(new Set(picked.slice(0, 2)).size).toBe(2);
  hold.open();
  expect(await Promise.all(tasks)).toHaveLength(4);
  for (const id of ['kilo', 'livekit']) expect(router.busy(id)).toBe(false);
});

it('spreads concurrent fallbacks across idle sources while handoff is still in flight', async () => {
  const picked: string[] = [], hold = gate();
  const { router } = pool(4, async (item, _request) => {
    picked.push(item.id);
    if (item.id === 'kilo' || item.id === 'livekit') throw new SourceError('upstream', 'overloaded', 30);
    await hold.promise;
    return { text: item.id };
  });
  const tasks = [1, 2].map(n => router.complete(ask(`fallback ${n}`), AbortSignal.timeout(5000)));
  await vi.waitFor(() => expect(picked.filter(id => id === 'runcrate' || id === 'pollinations')).toHaveLength(2));
  expect(picked.slice(2).sort()).toEqual(['pollinations', 'runcrate']);
  hold.open();
  await Promise.all(tasks);
});

// The same window through the production path, where busy comes from the shared observation. In a git
// checkout the handoff runs git status and diff, so the draw and the attempt are milliseconds apart.
it('spreads concurrent fallbacks in a real pool and git checkout (handoff awaits between the draw and the attempt)', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'grunt-spread-repo-')); roots.push(repo);
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' });
  git('init', '-q'); await writeFile(join(repo, 'a.txt'), 'one\n'); git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'init');
  const hold = gate(), items = ids.map(id => ({ ...source(id), complete: vi.fn() })), picked: string[] = [];
  for (const item of items) item.complete.mockImplementation(async () => {
    picked.push(item.id);
    if (item.id === 'kilo' || item.id === 'livekit') throw new SourceError('upstream', 'overloaded', 30);
    await hold.promise;
    return { text: item.id };
  });
  const pooled = new Sources(items, { registry: () => ({ ...bundledRegistry, adapters: items.map(item => ({ ...bundledRegistry.adapters.find(a => a.id === item.id)!, weight: 1 })) }), random: () => 0 });
  try {
    const tasks = [1, 2].map(n => pooled.complete({ ...ask(`real ${n}`), cwd: repo }, AbortSignal.timeout(5000)));
    // Checkpoints finish at different times, so which tasks fail first varies; the two that end on a
    // healthy source must hold different ones.
    const serving = () => picked.filter(id => id === 'runcrate' || id === 'pollinations');
    await vi.waitFor(() => expect(serving()).toHaveLength(2));
    expect(serving().sort()).toEqual(['pollinations', 'runcrate']);
    hold.open();
    await Promise.all(tasks);
  } finally { await pooled.close(); }
});

it('releases the claim after success, failure, cancellation and an abandoned selection', async () => {
  // Success.
  let pooled = pool(2, async item => ({ text: item.id }));
  await pooled.router.complete(ask('ok'), AbortSignal.timeout(1000));
  expect(pooled.items.map(item => pooled.router.busy(item.id))).toEqual([false, false]);
  // Failure, then fallback success.
  pooled = pool(2, async item => { if (item.id === 'kilo') throw new SourceError('upstream', 'down', 30); return { text: item.id }; });
  expect((await pooled.router.complete(ask('fail'), AbortSignal.timeout(1000))).text).toBe('livekit');
  expect(pooled.items.map(item => pooled.router.busy(item.id))).toEqual([false, false]);
  // Cancellation mid-attempt.
  const controller = new AbortController();
  let started = false;
  pooled = pool(2, async (_item, _request, signal) => { started = true; return never(signal); });
  const cancelled = pooled.router.complete(ask('cancel'), controller.signal);
  await vi.waitFor(() => expect(started).toBe(true));
  expect(pooled.router.busy('kilo')).toBe(true);
  controller.abort(new SourceError('cancelled', 'Cancelled'));
  await expect(cancelled).rejects.toMatchObject({ code: 'cancelled' });
  expect(pooled.items.map(item => pooled.router.busy(item.id))).toEqual([false, false]);
  // Selection dropped before dispatch: livekit goes pending between the draw and the live check.
  let calls = 0;
  const pending = { has: (id: string) => id === 'livekit' && ++calls >= 3 } as ReadonlySet<string>;
  const picked: string[] = [];
  pooled = pool(3, async item => { picked.push(item.id); if (item.id === 'kilo') throw new SourceError('upstream', 'down', 30); return { text: item.id }; }, { pending });
  expect((await pooled.router.complete(ask('abandon'), AbortSignal.timeout(1000))).text).toBe('runcrate');
  expect(picked).toEqual(['kilo', 'runcrate']);
  expect(pooled.items.map(item => pooled.router.busy(item.id))).toEqual([false, false, false]);
});

it('releases the claim when the attempt rejects with a non-source error', async () => {
  const { router, items } = pool(1, async () => { throw new Error('boom'); });
  await expect(router.complete(ask('boom'), AbortSignal.timeout(1000))).rejects.toBeInstanceOf(SourceError);
  expect(router.busy(items[0]!.id)).toBe(false);
});

// request_* refusals are Grunt's or the caller's fault: no failure sample, no reliability loss, no feedback.
it('never lowers a source weight for historical request_* refusals, in memory or after restart', async () => {
  const path = await mkdtemp(join(tmpdir(), 'grunt-spread-history-')); roots.push(path);
  let now = 1_000_000;
  const status = new SourceStatus(['millionseek'], () => now), feedback = vi.fn();
  status.setFeedback(feedback);
  const store = await RoutingHistory.open(path); stores.push(store);
  await status.setRoutingHistory(store);
  const refusing: Source = { id: 'millionseek', available: async () => true, complete: async () => { now += 100; throw requestRefusal('Synthetic tool refusal'); } };
  const input = { ...ask('refused work'), tools: [{ type: 'function' as const, function: { name: 'read', parameters: {} } }] };
  for (let i = 0; i < 28; i++) await expect(status.complete(refusing, input, new AbortController().signal)).rejects.toMatchObject({ code: 'refused' });
  expect(status.routingWeight('millionseek', false, 'interactive-tools')).toBe(1);
  expect(status.routingWeight('millionseek')).toBe(1);
  expect(feedback).not.toHaveBeenCalled();
  expect(status.snapshot({ ids: ['millionseek'], disabled: new Set(), pending: new Set(), verifying: new Set(), preparing: new Set() }).sources[0]).toMatchObject({ state: 'unknown' });
  await store.close(); stores.splice(0);
  const restarted = new SourceStatus(['millionseek'], () => now);
  await restarted.setRoutingHistory(await RoutingHistory.open(path).then(value => { stores.push(value); return value; }));
  expect(restarted.routingWeight('millionseek', false, 'interactive-tools')).toBe(1);
  // A real upstream failure still counts.
  const failing: Source = { id: 'millionseek', available: async () => true, complete: async () => { now += 100; throw new SourceError('upstream', 'down'); } };
  for (let i = 0; i < 3; i++) await restarted.complete(failing, input, new AbortController().signal).catch(() => {});
  expect(restarted.routingWeight('millionseek', false, 'interactive-tools')).toBeLessThan(1);
});
