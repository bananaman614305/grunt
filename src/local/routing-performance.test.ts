import { afterEach, expect, it, vi } from 'vitest';
import { bundledRegistry } from '../registry.js';
import { createLocalApp } from './api.js';
import { SourceError, Sources } from './source.js';
import type { ModelRequest, Source } from './source.js';

const request: ModelRequest = { model: 'grunt', messages: [{ role: 'user', content: 'Complete a synthetic task.' }], cwd: '/tmp', tools: [], stream: false };
const sources: Sources[] = [];
const source = (id: string): Source & { available: ReturnType<typeof vi.fn>; complete: ReturnType<typeof vi.fn> } => ({
  id, available: vi.fn(async () => true), complete: vi.fn(async () => ({ text: id }))
});
function pool(items: Source[], now?: () => number, draw = () => 0) {
  const value = new Sources(items, { registry: () => ({ ...bundledRegistry, adapters: items.map(item => ({ ...bundledRegistry.adapters.find(a => a.id === item.id)!, weight: 1 })) }), random: draw, ...(now ? { now } : {}) });
  sources.push(value);
  return value;
}
function hold() { let release!: (value: boolean) => void; const promise = new Promise<boolean>(resolve => { release = resolve; }); return { promise, release }; }
afterEach(async () => { await Promise.all(sources.splice(0).map(source => source.close())); vi.restoreAllMocks(); });

it.each(['cold', 'warm'] as const)('answers from ready free capacity without awaiting an unrelated hung admission check (%s)', async state => {
  const slow = source('numes'), fast = source('kilo'), pending = hold();
  slow.available.mockImplementation(() => pending.promise);
  const value = pool([slow, fast]);
  if (state === 'warm') await value.complete({ ...request, model: fast.id, userMessages: ['warm the verified source'] }, AbortSignal.timeout(1000));
  const before = fast.complete.mock.calls.length;
  const result = value.complete({ ...request, userMessages: ['new task'] }, AbortSignal.timeout(2000));
  try {
    await vi.waitFor(() => expect(fast.complete).toHaveBeenCalledTimes(before + 1), { timeout: 500 });
    expect((await result).text).toBe(fast.id);
    expect(slow.complete).not.toHaveBeenCalled();
  } finally { pending.release(false); await result.catch(() => {}); }
});

it('admits a healthy backup beyond a wave of unresponsive metadata checks', async () => {
  const hung = ['numes', 'livekit', 'runcrate', 'pollinations'].map(id => ({
    ...source(id), availabilityTimeoutMs: 30
  }));
  const metadata = hung.map(() => hold());
  hung.forEach((item, index) => item.available.mockReturnValue(metadata[index]!.promise));
  const backup = source('kilo'), value = pool([...hung, backup]);
  try {
    await expect(value.complete(request, AbortSignal.timeout(1500))).resolves.toEqual({ text: 'kilo' });
    for (const item of hung) {
      expect(item.available).toHaveBeenCalledOnce();
      expect(item.complete).not.toHaveBeenCalled();
    }
    expect(backup.complete).toHaveBeenCalledOnce();
  } finally { metadata.forEach(item => item.release(false)); }
});

it('keeps concurrent model listings available when another provider ignores its probe deadline', async () => {
  const slow = { ...source('numes'), availabilityTimeoutMs: 20 }, healthy = source('kilo'), pending = hold();
  slow.available.mockReturnValueOnce(pending.promise);
  const value = pool([slow, healthy]), app = createLocalApp(value);
  const models = async () => {
    const result = await app.request('http://127.0.0.1:8788/v1/models');
    expect(result.status).toBe(200);
    return (await result.json()).data.map((row: { id: string }) => row.id);
  };
  try {
    expect(await Promise.all([models(), models()])).toEqual([['grunt', healthy.id], ['grunt', healthy.id]]);
    expect(slow.available).toHaveBeenCalledOnce();
    expect(healthy.available).toHaveBeenCalledOnce();
    expect(slow.available.mock.calls[0]?.[0].aborted).toBe(true);
    expect(await models()).toEqual(['grunt', healthy.id]);
    expect(slow.available).toHaveBeenCalledOnce();
    pending.release(true);
    await pending.promise;
    await new Promise(resolve => setImmediate(resolve));
    expect(value.status().sources.find(row => row.id === slow.id)?.state).toBe('unknown');
    expect(await models()).toEqual(['grunt', slow.id, healthy.id]);
    expect(slow.available).toHaveBeenCalledTimes(2);
  } finally { pending.release(false); }
});

it('reuses only admission metadata and still runs the selected adapter live guard on each dispatch', async () => {
  const guarded = source('kilo'), fallback = source('livekit');
  let funded = false, liveChecks = 0, admitted = 0;
  guarded.complete.mockImplementation(async () => {
    liveChecks++;
    if (funded) throw new SourceError('refused', 'Synthetic current free-access guard rejected funded account');
    admitted++;
    return { text: 'free answer' };
  });
  const value = pool([guarded, fallback]);
  expect((await value.complete({ ...request, userMessages: ['first'] }, AbortSignal.timeout(1000))).text).toBe('free answer');
  funded = true;
  expect((await value.complete({ ...request, userMessages: ['second'] }, AbortSignal.timeout(1000))).text).toBe(fallback.id);
  expect(guarded.available).toHaveBeenCalledOnce();
  expect(liveChecks).toBe(2);
  expect(admitted).toBe(1);
});

it('prefers measured fast healthy providers for new main tasks', async () => {
  let now = 1000;
  const fast = source('kilo'), slow = source('numes');
  fast.complete.mockImplementation(async () => { now += 3000; return { text: fast.id }; });
  slow.complete.mockImplementation(async () => { now += 60000; return { text: slow.id }; });
  const value = pool([fast, slow], () => now, () => .8);
  for (const item of [fast, slow]) for (let i = 0; i < 2; i++) {
    await value.complete({ ...request, model: item.id, userMessages: [`sample-${item.id}-${i}`] }, AbortSignal.timeout(1000));
  }
  expect((await value.complete({ ...request, userMessages: ['interactive turn'] }, AbortSignal.timeout(1000))).text).toBe(fast.id);
});

it('never dispatches a cold provider whose metadata denies admission', async () => {
  const denied = source('kilo'), allowed = source('livekit');
  denied.available.mockResolvedValue(false);
  const value = pool([denied, allowed]);
  expect((await value.complete(request, AbortSignal.timeout(1000))).text).toBe(allowed.id);
  expect(denied.complete).not.toHaveBeenCalled();
});

it('keeps selected dispatch guards active after cached availability expires or setup changes', async () => {
  let now = 1000;
  const one = source('kilo'), two = source('livekit'), value = pool([one, two], () => now);
  await value.models();
  value.pending.add(one.id);
  expect((await value.complete({ ...request, userMessages: ['setup in progress'] }, AbortSignal.timeout(1000))).text).toBe(two.id);
  expect(one.complete).not.toHaveBeenCalled();
  value.pending.delete(one.id); now += 31000;
  one.available.mockResolvedValue(false);
  expect((await value.complete({ ...request, userMessages: ['expired metadata'] }, AbortSignal.timeout(1000))).text).toBe(two.id);
  expect(one.complete).not.toHaveBeenCalled();
});


it('preserves an existing main task binding while that provider is busy with other work', async () => {
  const bound = source('kilo'), idle = source('livekit'), value = pool([bound, idle]);
  const main = { ...request, userMessages: ['existing task'] };
  await value.complete(main, AbortSignal.timeout(1000));
  let release!: () => void;
  bound.complete.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({ text: 'other work' }); }));
  const working = value.complete({ ...request, model: bound.id, userMessages: ['other work'] }, AbortSignal.timeout(2000));
  try {
    await vi.waitFor(() => expect(bound.complete).toHaveBeenCalledTimes(2));
    expect((await value.complete(main, AbortSignal.timeout(1000))).text).toBe(bound.id);
    expect(idle.complete).not.toHaveBeenCalled();
  } finally { release(); await working; }
});

// Fallback after a failed source prefers idle capacity like a first draw; stickiness still wins when healthy.
async function warm(value: Sources, items: Source[]) {
  for (const item of items) await value.complete({ ...request, model: item.id, userMessages: [`warm ${item.id}`] }, AbortSignal.timeout(1000));
  for (const item of items) vi.mocked(item.complete).mockClear();
}
function occupy(value: Sources, busy: ReturnType<typeof source>) {
  let release!: () => void;
  busy.complete.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({ text: 'other work' }); }));
  const working = value.complete({ ...request, model: busy.id, userMessages: ['other work'] }, AbortSignal.timeout(5000));
  return { working, release: () => { release(); return working; } };
}
it('falls back to an idle source rather than one busy with another task', async () => {
  const failing = source('kilo'), busy = source('livekit'), one = source('runcrate'), two = source('pollinations');
  const items = [failing, busy, one, two], value = pool(items);
  await warm(value, items);
  failing.complete.mockRejectedValueOnce(new SourceError('upstream', 'overloaded', 4));
  const other = occupy(value, busy);
  try {
    await vi.waitFor(() => expect(busy.complete).toHaveBeenCalledOnce());
    const answer = await value.complete({ ...request, userMessages: ['new task'] }, AbortSignal.timeout(2000));
    expect(failing.complete).toHaveBeenCalledOnce();
    expect(answer.text).toBe(one.id);
    expect(busy.complete).toHaveBeenCalledOnce();
  } finally { await other.release(); }
});
it('does not fall back onto a busy source while idle sources still have pending admission checks', async () => {
  const failing = source('kilo'), busy = source('livekit'), idle = source('runcrate');
  const items = [failing, busy, idle], value = pool(items);
  await warm(value, [failing, busy]);
  idle.available.mockImplementation(async () => { await new Promise(resolve => setTimeout(resolve, 100)); return true; });
  failing.complete.mockRejectedValueOnce(new SourceError('upstream', 'overloaded', 4));
  const other = occupy(value, busy);
  try {
    await vi.waitFor(() => expect(busy.complete).toHaveBeenCalledOnce());
    const answer = await value.complete({ ...request, userMessages: ['new task'] }, AbortSignal.timeout(2000));
    expect(answer.text).toBe(idle.id);
    expect(busy.complete).toHaveBeenCalledOnce();
  } finally { await other.release(); }
});
it('still falls back to a busy source when no idle source remains', async () => {
  const failing = source('kilo'), busy = source('livekit'), items = [failing, busy], value = pool(items);
  await warm(value, items);
  failing.complete.mockRejectedValueOnce(new SourceError('upstream', 'overloaded', 4));
  const other = occupy(value, busy);
  try {
    await vi.waitFor(() => expect(busy.complete).toHaveBeenCalledOnce());
    const answer = await value.complete({ ...request, userMessages: ['new task'] }, AbortSignal.timeout(2000));
    expect(answer.text).toBe(busy.id);
  } finally { await other.release(); }
});
it('keeps a healthy bound task on its busy source rather than moving to idle capacity', async () => {
  const bound = source('kilo'), idle = source('livekit'), items = [bound, idle], value = pool(items);
  const main = { ...request, userMessages: ['sticky task'] };
  await value.complete(main, AbortSignal.timeout(1000));
  const other = occupy(value, bound);
  try {
    await vi.waitFor(() => expect(bound.complete).toHaveBeenCalledTimes(2));
    expect((await value.complete(main, AbortSignal.timeout(1000))).text).toBe(bound.id);
    expect(idle.complete).not.toHaveBeenCalled();
  } finally { await other.release(); }
});
