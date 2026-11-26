import { afterEach, expect, it, vi } from 'vitest';
import { Sources, SourceError } from './source.js';
import type { Completion, ModelRequest, Source } from './source.js';
import { bundledRegistry } from '../registry.js';

// Freebuff is not in the published pool; give the router a test entry for it.
const opencode = bundledRegistry.adapters.find(adapter => adapter.id === 'opencode')!;
const registry = { ...bundledRegistry, adapters: [{ ...opencode, id: 'freebuff', install: 'npm:freebuff', weight: 0.5 }, { ...opencode, weight: 0.5 }] };
const request: ModelRequest = { model: 'grunt', messages: [{ role: 'user', content: 'Finish the task' }], cwd: '/tmp', tools: [], stream: false };
const chain = (sources: Source[], sticky: boolean, deadline: number) =>
  new Sources(sources, sticky ? { registry: () => registry, random: () => 0 } : undefined, new Set(), deadline);
const next = () => ({ id: 'opencode', available: async () => true, complete: vi.fn(async () => ({ text: 'next answer' })) });
let log: ReturnType<typeof vi.spyOn>;
afterEach(() => { log?.mockRestore(); vi.unstubAllEnvs(); });

it.each([false, true])('a source with no first output falls through to the next source at the deadline (sticky=%s)', async sticky => {
  log = vi.spyOn(console, 'error').mockImplementation(() => {});
  let seen: AbortSignal | undefined;
  const failed = vi.fn();
  const hang: Source = { id: 'freebuff', reportsOutput: true, available: async () => true, failed,
    complete: (_request, signal) => { seen = signal; return new Promise<Completion>(() => {}); } };
  const after = next();
  const started = Date.now();
  expect(await chain([hang, after], sticky, 100).complete(request, new AbortController().signal)).toEqual({ text: 'next answer' });
  expect(Date.now() - started).toBeLessThan(1000);
  expect(seen?.aborted).toBe(true);
  expect(after.complete).toHaveBeenCalledOnce();
  expect(failed).toHaveBeenCalledOnce();
  expect(failed.mock.calls[0]![0]).toMatchObject({ code: 'timeout', message: 'freebuff produced no output within 0.1 seconds' });
  expect(log.mock.calls.flat().join('\n')).toMatch(/grunt source: freebuff failed \(timeout\)/);
});

it.each([false, true])('a source that produces first output before the deadline is not cut off (sticky=%s)', async sticky => {
  log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const failed = vi.fn();
  const slow: Source = { id: 'freebuff', reportsOutput: true, available: async () => true, failed,
    complete: async (_request, signal, output) => {
      await new Promise(resolve => setTimeout(resolve, 20)); output!();
      await new Promise(resolve => setTimeout(resolve, 300));
      signal.throwIfAborted();
      return { text: 'slow but healthy' };
    } };
  const after = next();
  expect(await chain([slow, after], sticky, 100).complete(request, new AbortController().signal)).toEqual({ text: 'slow but healthy' });
  expect(after.complete).not.toHaveBeenCalled();
  expect(failed).not.toHaveBeenCalled();
});

it('a source that does not report output keeps only its own timeouts', async () => {
  const quiet: Source = { id: 'freebuff', available: async () => true,
    complete: async () => { await new Promise(resolve => setTimeout(resolve, 300)); return { text: 'own timeout only' }; } };
  const after = next();
  expect(await chain([quiet, after], false, 100).complete(request, new AbortController().signal)).toEqual({ text: 'own timeout only' });
  expect(after.complete).not.toHaveBeenCalled();
});

it('caller cancellation is not a source failure', async () => {
  log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const failed = vi.fn();
  const hang: Source = { id: 'freebuff', reportsOutput: true, available: async () => true, failed,
    complete: (_request, signal) => new Promise<Completion>((_, reject) => signal.addEventListener('abort', () => reject(new SourceError('cancelled', 'stopped')))) };
  const after = next();
  const controller = new AbortController();
  const pending = chain([hang, after], false, 5000).complete(request, controller.signal);
  controller.abort();
  await expect(pending).rejects.toThrow();
  expect(failed).not.toHaveBeenCalled();
  expect(after.complete).not.toHaveBeenCalled();
});

it('arms the deadline before synchronous first output and preserves legacy first-output-only sources', async () => {
  const after = next();
  const complete = vi.fn<Source['complete']>(async (_request, signal, output) => {
    output!();
    await new Promise(resolve => setTimeout(resolve, 100));
    signal.throwIfAborted();
    return { text: 'synchronous start, healthy finish' };
  });
  const source: Source = { id: 'freebuff', reportsOutput: true, available: async () => true, complete };
  expect(await chain([source, after], false, 30).complete(request, AbortSignal.timeout(1000)))
    .toEqual({ text: 'synchronous start, healthy finish' });
  expect(complete).toHaveBeenCalledOnce();
  expect(after.complete).not.toHaveBeenCalled();
});

it('falls back once when a progress-reporting source starts output then stalls', async () => {
  log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const after = next(), failed = vi.fn();
  let seen: AbortSignal | undefined;
  const complete = vi.fn<Source['complete']>((_request, signal, output) => {
    seen = signal; output!();
    return new Promise<Completion>(() => {});
  });
  const source = { id: 'freebuff', reportsOutput: true, reportsProgress: true, available: async () => true, complete, failed };
  expect(await chain([source, after], false, 30).complete(request, AbortSignal.timeout(1000))).toEqual({ text: 'next answer' });
  expect(seen?.aborted).toBe(true);
  expect(complete).toHaveBeenCalledOnce();
  expect(after.complete).toHaveBeenCalledOnce();
  expect(failed.mock.calls[0]![0]).toMatchObject({ code: 'timeout', message: 'freebuff produced no further output within 0.03 seconds' });
});

it('keeps a slow reasoning stream alive while meaningful progress continues', async () => {
  const after = next();
  const complete = vi.fn<Source['complete']>(async (_request, signal, output) => {
    for (let i = 0; i < 5; i++) {
      await new Promise(resolve => setTimeout(resolve, 20));
      signal.throwIfAborted(); output!();
    }
    return { text: 'reasoned answer' };
  });
  const source = { id: 'freebuff', reportsOutput: true, reportsProgress: true, available: async () => true, complete };
  expect(await chain([source, after], false, 60).complete(request, AbortSignal.timeout(1000))).toEqual({ text: 'reasoned answer' });
  expect(complete).toHaveBeenCalledOnce();
  expect(after.complete).not.toHaveBeenCalled();
});

it('caller cancellation promptly settles a progress source that ignores its signal without retrying', async () => {
  const after = next(), failed = vi.fn(), controller = new AbortController();
  const complete = vi.fn<Source['complete']>(() => new Promise<Completion>(() => {}));
  const source: Source = { id: 'freebuff', reportsProgress: true, available: async () => true, complete, failed };
  const pending = chain([source, after], false, 1000).complete(request, controller.signal);
  await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce());
  controller.abort(new Error('caller stopped'));
  await expect(Promise.race([pending, new Promise(resolve => setTimeout(() => resolve('still pending'), 80))])).rejects.toThrow('caller stopped');
  expect(failed).not.toHaveBeenCalled();
  expect(after.complete).not.toHaveBeenCalled();
});

it('awaits legacy native-adapter cancellation cleanup before settling without fallback', async () => {
  const after = next(), failed = vi.fn(), controller = new AbortController();
  let finishCleanup!: () => void, cleaned = false, settled = false;
  const cleanup = new Promise<void>(resolve => { finishCleanup = resolve; });
  const complete = vi.fn<Source['complete']>((_request, signal) => new Promise<Completion>((_resolve, reject) => {
    signal.addEventListener('abort', () => { void cleanup.then(() => { cleaned = true; reject(signal.reason); }); }, { once: true });
  }));
  const source: Source = { id: 'freebuff', reportsOutput: true, available: async () => true, complete, failed };
  const pending = chain([source, after], false, 1000).complete(request, controller.signal).catch(error => { settled = true; return error; });
  await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce());
  const reason = new Error('caller stopped'); controller.abort(reason);
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(settled).toBe(false); expect(cleaned).toBe(false);
  finishCleanup();
  expect(await pending).toBe(reason); expect(cleaned).toBe(true);
  expect(failed).not.toHaveBeenCalled();
  expect(after.complete).not.toHaveBeenCalled();
});

it('retains the initial watchdog when a legacy adapter ignores caller cancellation before output', async () => {
  const after = next(), failed = vi.fn(), controller = new AbortController();
  const complete = vi.fn<Source['complete']>(() => new Promise<Completion>(() => {}));
  const source: Source = { id: 'freebuff', reportsOutput: true, available: async () => true, complete, failed };
  const pending = chain([source, after], false, 80).complete(request, controller.signal);
  const rejection = expect(pending).rejects.toThrow();
  await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce());
  controller.abort();
  await rejection;
  expect(failed).not.toHaveBeenCalled();
  expect(after.complete).not.toHaveBeenCalled();
});
