import { afterEach, expect, it, vi } from 'vitest';
import { bundledRegistry } from '../registry.js';
import { StickyRouter } from './routing.js';
import { SourceAvailability } from './source-availability.js';
import { SourceStatus } from './source-status.js';
import { Sources } from './source.js';
import type { Completion, ModelRequest, Source } from './source.js';

// A first draw whose only ready source is busy waits, for a bounded time, for the admission checks of sources that
// may be idle, so parallel subagents spread on a cold or half-expired availability cache. (0.10.15 drew the busy one.)
const routers: StickyRouter[] = [], availabilities: SourceAvailability[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(routers.splice(0).map(router => router.close()));
  await Promise.all(availabilities.splice(0).map(value => value.close()));
});
const read = { type: 'function' as const, function: { name: 'read', parameters: { type: 'object' } } };
const ask = (content: string, tools = true): ModelRequest => ({ model: 'grunt', messages: [{ role: 'user', content }], cwd: '/tmp', tools: tools ? [read] : [], stream: false });
const delayed = (ms: number, result = true) => vi.fn(async () => { await new Promise(resolve => setTimeout(resolve, ms)); return result; });
const hang = () => vi.fn(() => new Promise<boolean>(() => {}));
function make(id: string, available: Source['available'] | undefined = undefined, bridged = false): Source {
  return { id, supportsFunctionTools: true, ...(bridged ? { jsonToolBridge: true } : {}), available: available ?? vi.fn(async () => true), complete: vi.fn(async () => ({ text: id })) };
}
function gate() { let open!: () => void; const promise = new Promise<void>(resolve => { open = resolve; }); return { promise, open }; }
function pool(items: Source[], attempt: (source: Source, request: ModelRequest, signal: AbortSignal) => Promise<Completion>) {
  const router = new StickyRouter(items, {
    registry: () => ({ ...bundledRegistry, adapters: items.map(item => ({ ...bundledRegistry.adapters.find(a => a.id === item.id)!, weight: 1 })) }),
    random: () => 0, attempt
  });
  routers.push(router);
  return router;
}
// Holds kilo busy with a main task, so a new task finds it ready but busy while the other checks are pending.
async function busyMain(items: Source[]) {
  const picked: string[] = [], hold = gate();
  const router = pool(items, async source => { picked.push(source.id); await hold.promise; return { text: source.id }; });
  const main = router.complete(ask('main task'), AbortSignal.timeout(10000));
  await vi.waitFor(() => expect(picked).toEqual(['kilo']));
  return { picked, hold, router, main };
}

it('spreads cold-cache subagents over idle native sources instead of the busy ready one', async () => {
  const items = [make('kilo'), make('livekit', delayed(50)), make('runcrate', delayed(80)), make('mistral-vibe', undefined, true)];
  const { picked, hold, router, main } = await busyMain(items);
  const subagents = [1, 2].map(n => router.complete(ask(`subagent ${n}`), AbortSignal.timeout(10000)));
  await vi.waitFor(() => expect(picked).toHaveLength(3), { timeout: 2000 });
  await vi.waitFor(() => expect(new Set(picked.slice(1)).size).toBe(2), { timeout: 2000 });
  expect([...picked.slice(1)].sort()).toEqual(['livekit', 'runcrate']);
  hold.open();
  await Promise.all([main, ...subagents]);
});

it('does not wait when the ready source is idle', async () => {
  const items = [make('kilo'), make('livekit', hang()), make('runcrate', hang())];
  const picked: string[] = [];
  const router = pool(items, async source => { picked.push(source.id); return { text: source.id }; });
  const started = Date.now();
  await expect(router.complete(ask('lone task'), AbortSignal.timeout(5000))).resolves.toEqual({ text: 'kilo' });
  expect(Date.now() - started).toBeLessThan(1000);
});

it('stops waiting after FIRST_DRAW_IDLE_WAIT_MS and shares the busy source', { timeout: 10000 }, async () => {
  const items = [make('kilo'), make('livekit', hang()), make('runcrate', hang())];
  const { picked, hold, router, main } = await busyMain(items);
  const sub = router.complete(ask('subagent'), AbortSignal.timeout(20000));
  await new Promise(resolve => setTimeout(resolve, 2500));
  expect(picked).toEqual(['kilo']);
  await vi.waitFor(() => expect(picked).toEqual(['kilo', 'kilo']), { timeout: 1500 });
  hold.open();
  await Promise.all([main, sub]);
});

it('shares the busy source as soon as every pending check has settled negatively', async () => {
  const items = [make('kilo'), make('livekit', delayed(30, false)), make('runcrate', delayed(30, false))];
  const { picked, hold, router, main } = await busyMain(items);
  const started = Date.now();
  const sub = router.complete(ask('subagent'), AbortSignal.timeout(10000));
  await vi.waitFor(() => expect(picked).toEqual(['kilo', 'kilo']), { timeout: 2000 });
  expect(Date.now() - started).toBeLessThan(1500);
  hold.open();
  await Promise.all([main, sub]);
});

it('does not wait on a bridged check for a tools request, but does for a text-only one', async () => {
  const items = [make('kilo'), make('mistral-vibe', delayed(200), true)];
  const { picked, hold, router, main } = await busyMain(items);
  const started = Date.now();
  const tools = router.complete(ask('tools task'), AbortSignal.timeout(10000));
  await vi.waitFor(() => expect(picked).toEqual(['kilo', 'kilo']), { timeout: 2000 });
  expect(Date.now() - started).toBeLessThan(180);
  const plain = router.complete(ask('plain task', false), AbortSignal.timeout(10000));
  await vi.waitFor(() => expect(picked).toHaveLength(3), { timeout: 2000 });
  expect(picked[2]).toBe('mistral-vibe');
  hold.open();
  await Promise.all([main, tools, plain]);
});

it('never makes a healthy bound task wait for pending checks', async () => {
  const items = [make('kilo'), make('livekit', hang())];
  const { picked, hold, router, main } = await busyMain(items);
  hold.open(); await main;
  const other = gate(), again = picked.length;
  const attempts = router as unknown as { options: { attempt: unknown } };
  attempts.options.attempt = async (source: Source) => { picked.push(source.id); await other.promise; return { text: source.id }; };
  const occupied = router.complete(ask('another task'), AbortSignal.timeout(10000));
  await vi.waitFor(() => expect(picked).toHaveLength(again + 1));
  const started = Date.now();
  const resumed = router.complete(ask('main task'), AbortSignal.timeout(10000));
  await vi.waitFor(() => expect(picked).toHaveLength(again + 2), { timeout: 1000 });
  expect(picked.slice(again)).toEqual(['kilo', 'kilo']);
  expect(Date.now() - started).toBeLessThan(500);
  other.open();
  await Promise.all([occupied, resumed]);
});

it('SourceAvailability.changed resolves after maxMs and leaves no listener or timer behind', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const status = new SourceStatus(['a']), availability = new SourceAvailability(status);
  availabilities.push(availability);
  availability.start([make('a', hang())]);
  const controller = new AbortController();
  const before = vi.getTimerCount();
  const waited = availability.changed(controller.signal, 500);
  await vi.advanceTimersByTimeAsync(499);
  let done = false; void waited.then(() => { done = true; });
  await vi.advanceTimersByTimeAsync(0);
  expect(done).toBe(false);
  await vi.advanceTimersByTimeAsync(2);
  await waited;
  expect(vi.getTimerCount()).toBe(before);
  // An abort rejects and also clears the timer.
  const second = availability.changed(controller.signal, 500);
  controller.abort(new Error('stop'));
  await expect(second).rejects.toThrow('stop');
  expect(vi.getTimerCount()).toBe(before);
});

it('probes the most promising sources first: recently positive, then never checked, then denied', async () => {
  let clock = 1_000_000;
  const status = new SourceStatus(['s1', 's2', 's3', 's4', 's5', 's6'], () => clock);
  const prime = async (id: string, result: boolean) => { clock += 1000; await status.available(make(id, vi.fn(async () => result))); };
  await prime('s1', false); await prime('s2', true); await prime('s4', false); await prime('s5', true);   // s3 and s6 never checked
  clock += 40_000;   // every cached answer has expired
  const order: string[] = [];
  const availability = new SourceAvailability(status);
  availabilities.push(availability);
  const probes = ['s1', 's2', 's3', 's4', 's5', 's6'].map(id => make(id, vi.fn(() => { order.push(id); return new Promise<boolean>(() => {}); })));
  expect(availability.start(probes)).toBe(4);
  await vi.waitFor(() => expect(order).toHaveLength(4));
  // s5 answered positively most recently, then s2; never-checked s3 and s6 come before the denied s1 and s4.
  expect(order).toEqual(['s5', 's2', 's3', 's6']);
});

it('reports the age of the last check and whether routing could admit the source now, without changing state', async () => {
  let clock = 5_000_000;
  const items = [make('kilo'), make('livekit')];
  const sources = new Sources(items, { registry: () => ({ ...bundledRegistry, adapters: items.map(item => ({ ...bundledRegistry.adapters.find(a => a.id === item.id)!, weight: 1 })) }), random: () => 0, now: () => clock });
  try {
    const row = (id: string) => sources.status().sources.find(candidate => candidate.id === id)!;
    expect(row('kilo')).not.toHaveProperty('checkedAgoSeconds');
    expect(row('kilo').routable).toBe(false);
    await sources.complete(ask('warm', false), AbortSignal.timeout(2000));
    const { state } = row('kilo');
    expect(row('kilo')).toMatchObject({ checkedAgoSeconds: 0, routable: true, probeFresh: true });
    clock += 31_000;
    expect(row('kilo')).toMatchObject({ checkedAgoSeconds: 31, routable: true, probeFresh: false, state });
    expect(row('livekit')).toMatchObject({ routable: true, probeFresh: false });
  } finally { await sources.close(); }
});
