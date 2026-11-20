import { expect, it, vi } from 'vitest';
import { bundledRegistry } from '../registry.js';
import { answeredBy, SourceError, Sources } from './source.js';
import type { ModelRequest, Source } from './source.js';

const request: ModelRequest = { model: 'grunt', messages: [{ role: 'user', content: 'Review this code.' }], cwd: '/tmp', tools: [], stream: false };
const worker = (id: string) => ({
  ...request,
  cwd: '/does-not-exist/grunt-worker-scratch-test',
  worker: { id, onSource: vi.fn(), onWait: vi.fn() }
});
const source = (id: string) => ({
  id,
  available: vi.fn(async () => true),
  complete: vi.fn(async (_request: ModelRequest, _signal: AbortSignal) => ({ text: id }))
});
const routed = (sources: Source[], disabled?: Set<string>) =>
  new Sources(sources, { registry: () => bundledRegistry, random: () => 0 }, disabled);
const signal = () => AbortSignal.timeout(3000);

function pause() {
  let resume!: () => void;
  const blocked = new Promise<void>(resolve => { resume = resolve; });
  return { blocked, resume };
}

it('runs two identical worker prompts alongside the main request on distinct idle providers', async () => {
  const providers = ['kilo', 'runcrate', 'livekit'].map(source);
  const pool = routed(providers);
  const hold = pause();
  for (const provider of providers) {
    provider.complete.mockImplementation(async () => { await hold.blocked; return { text: provider.id }; });
  }
  const main = pool.complete(request, signal());
  await vi.waitFor(() => expect(providers[0]!.complete).toHaveBeenCalledOnce());
  const one = worker('worker-a'), two = worker('worker-b');
  const jobs = Promise.all([main, pool.complete(one, signal()), pool.complete(two, signal())]);
  try {
    await vi.waitFor(() => expect(pool.status().activeRequests).toBe(3));
    expect(pool.status().sources.map(provider => provider.active)).toEqual([1, 1, 1]);
  } finally { hold.resume(); }
  const results = await jobs;
  expect(new Set(results.map(answer => answeredBy.get(answer)))).toEqual(new Set(providers.map(provider => provider.id)));
  expect(one.worker.onSource).toHaveBeenCalledOnce();
  expect(two.worker.onSource).toHaveBeenCalledOnce();
});

it('queues a second worker when both select against the same idle provider', async () => {
  const kilo = source('kilo'), pool = routed([kilo]);
  const entered = pause(), hold = pause();
  let readinessChecks = 0;
  kilo.available.mockImplementation(async () => { readinessChecks++; await entered.blocked; return true; });
  kilo.complete.mockImplementationOnce(async () => { await hold.blocked; return { text: 'first' }; });
  const jobs = Promise.all([pool.complete(worker('worker-a'), signal()), pool.complete(worker('worker-b'), signal())]);
  try {
    await vi.waitFor(() => expect(readinessChecks).toBe(1));
    entered.resume();
    await vi.waitFor(() => expect(kilo.complete).toHaveBeenCalledOnce());
    expect(readinessChecks).toBe(1);
    expect(pool.status().activeRequests).toBe(1);
  } finally { hold.resume(); }
  expect((await jobs).map(answer => answer.text)).toEqual(['first', 'kilo']);
  expect(kilo.complete).toHaveBeenCalledTimes(2);
});

it('cancels a worker waiting on capacity without dispatching an attempt', async () => {
  const kilo = source('kilo'), pool = routed([kilo]);
  const hold = pause(), controller = new AbortController();
  kilo.complete.mockImplementationOnce(async () => { await hold.blocked; return { text: 'first' }; });
  const one = pool.complete(worker('worker-a'), signal()), two = worker('worker-b');
  try {
    await vi.waitFor(() => expect(kilo.complete).toHaveBeenCalledOnce());
    const second = expect(pool.complete(two, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(two.worker.onWait).toHaveBeenCalledOnce());
    controller.abort();
    await second;
    expect(two.worker.onSource).not.toHaveBeenCalled();
    expect(kilo.complete).toHaveBeenCalledOnce();
  } finally {
    controller.abort();
    hold.resume();
  }
  await one;
});

it('cancels concurrent metadata discovery before dispatching any provider attempt', async () => {
  const kilo = source('kilo'), zro = source('zro'), pool = routed([kilo, zro]);
  const entered = pause(), hold = pause(), controller = new AbortController();
  kilo.available.mockImplementationOnce(async () => {
    entered.resume();
    await hold.blocked;
    return true;
  });
  const request = worker('worker-a');
  const result = pool.complete(request, controller.signal);
  await entered.blocked;
  controller.abort();
  hold.resume();
  await expect(result).rejects.toMatchObject({ name: 'AbortError' });
  // Both bounded metadata probes started before cancellation. Neither may
  // dispatch inference merely because its read-only admission check finishes.
  expect(zro.complete).not.toHaveBeenCalled();
  expect(kilo.complete).not.toHaveBeenCalled();
  expect(request.worker.onSource).not.toHaveBeenCalled();
});

it('fails over with scoped input only and never attempts disabled, pending, or agent sources', async () => {
  const agent = source('opencode'), pending = source('zro'), disabled = source('pollinations');
  const kilo = source('kilo'), runcrate = source('runcrate');
  kilo.complete.mockRejectedValue(new SourceError('quota', 'limited', 90, 'unused provider output'));
  const pool = routed([agent, pending, disabled, kilo, runcrate], new Set([disabled.id]));
  pool.pending.add(pending.id);
  const input = { ...worker('worker-a'), model: agent.id };
  expect(await pool.complete(input, signal())).toEqual({ text: runcrate.id });
  expect(runcrate.complete).toHaveBeenCalledWith({ ...request, cwd: input.cwd }, expect.any(AbortSignal));
  expect(input.worker.onSource.mock.calls).toEqual([[kilo.id], [runcrate.id]]);
  for (const provider of [agent, pending, disabled]) expect(provider.complete).not.toHaveBeenCalled();
});

it('returns existing quota hints promptly when the eligible provider is cooling down', async () => {
  const kilo = source('kilo'), pool = routed([kilo]), recover = vi.fn();
  pool.setRecovery(recover);
  kilo.complete.mockRejectedValue(new SourceError('quota', 'limited', 90));
  await expect(pool.complete(worker('worker-a'), signal())).rejects.toMatchObject({ code: 'quota', retryAfter: 90 });
  await expect(pool.complete(worker('worker-b'), signal())).rejects.toMatchObject({ code: 'quota', retryAfter: 90 });
  expect(kilo.complete).toHaveBeenCalledOnce();
  expect(recover).not.toHaveBeenCalled();
});

it('does not fall back to a custom source outside the free model registry', async () => {
  const custom = source('gateway');
  await expect(new Sources([custom]).complete(worker('worker-a'), signal())).rejects.toMatchObject({ code: 'not_installed' });
  expect(custom.complete).not.toHaveBeenCalled();
});

it('uses the eligible model in a mixed configuration and preserves the main fixed chain', async () => {
  const custom = source('gateway'), kilo = source('kilo'), pool = new Sources([custom, kilo]);
  pool.setWorkerRegistry(() => bundledRegistry);
  expect(await pool.complete(request, signal())).toEqual({ text: custom.id });
  expect(await pool.complete(worker('worker-a'), signal())).toEqual({ text: kilo.id });
  expect(custom.complete).toHaveBeenCalledOnce();
  expect(kilo.complete).toHaveBeenCalledOnce();
});

it('honors the shared quota observation when a fixed-chain request frees a busy route', async () => {
  const custom = source('gateway'), kilo = source('kilo'), pool = new Sources([custom, kilo]);
  pool.setWorkerRegistry(() => bundledRegistry);
  const hold = pause(), input = worker('worker-a');
  kilo.complete.mockImplementationOnce(async () => {
    await hold.blocked;
    throw new SourceError('quota', 'limited', 120);
  });
  const main = expect(pool.complete({ ...request, model: kilo.id }, signal())).rejects.toMatchObject({ code: 'quota' });
  try {
    await vi.waitFor(() => expect(kilo.complete).toHaveBeenCalledOnce());
    const subworker = expect(pool.complete(input, signal())).rejects.toMatchObject({ code: 'quota', retryAfter: 120 });
    await vi.waitFor(() => expect(input.worker.onWait).toHaveBeenCalledOnce());
    hold.resume();
    await Promise.all([main, subworker]);
  } finally { hold.resume(); }
  expect(input.worker.onSource).not.toHaveBeenCalled();
  expect(custom.complete).not.toHaveBeenCalled();
  expect(kilo.complete).toHaveBeenCalledOnce();
});

it('does not dispatch from stale eligibility when a model is removed during availability', async () => {
  const kilo = source('kilo');
  let registry = bundledRegistry;
  kilo.available.mockImplementation(async () => {
    registry = { ...bundledRegistry, adapters: bundledRegistry.adapters.filter(adapter => adapter.id !== kilo.id) };
    return true;
  });
  const pool = new Sources([kilo], { registry: () => registry });
  await expect(pool.complete(worker('worker-a'), signal())).rejects.toMatchObject({ code: 'quota' });
  expect(kilo.complete).not.toHaveBeenCalled();
});
