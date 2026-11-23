import { afterEach, expect, it, vi } from 'vitest';
import { AVAILABILITY_NEGATIVE_MS, SourceAvailability } from './source-availability.js';
import { SourceStatus } from './source-status.js';
import type { Source } from './source.js';

afterEach(() => vi.useRealTimers());
const turn = () => new Promise<void>(resolve => setImmediate(resolve));

it('bounds and deduplicates native checks and cancels them when routing closes', async () => {
  const signals: AbortSignal[] = [];
  const providers: Source[] = Array.from({ length: 6 }, (_, n) => ({ id: `source-${n}`,
    available: vi.fn(signal => new Promise<boolean>((_resolve, reject) => {
      signals.push(signal!); signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
    })), complete: vi.fn(async () => ({ text: 'unused' })) }));
  const observer = new SourceStatus(providers.map(p => p.id)), availability = new SourceAvailability(observer);
  availability.start(providers); availability.start(providers); await turn();
  expect(signals).toHaveLength(4);
  expect(providers.slice(4).every(p => vi.mocked(p.available).mock.calls.length === 0)).toBe(true);
  await availability.close();
  expect(signals.every(signal => signal.aborted)).toBe(true);
  availability.start(providers); await turn();
  expect(signals).toHaveLength(4);
});

it('keeps one real check per uncooperative source after a deadline, and ignores its late result', async () => {
  vi.useFakeTimers();
  let release!: (value: boolean) => void;
  const source: Source = { id: 'slow', available: vi.fn(() => new Promise(resolve => { release = resolve; })), complete: vi.fn() };
  const observer = new SourceStatus(['slow']), availability = new SourceAvailability(observer, 10);
  availability.start([source]);
  await vi.advanceTimersByTimeAsync(11);
  expect(availability.peek(source.id)).toBe(false);
  await vi.advanceTimersByTimeAsync(AVAILABILITY_NEGATIVE_MS + 1);
  availability.start([source]);
  expect(source.available).toHaveBeenCalledOnce();
  release(true); await vi.advanceTimersByTimeAsync(0);
  // A result after the deadline cannot admit a source retroactively.
  expect(availability.peek(source.id)).toBeUndefined();
  await availability.close();
});

it('cancels an admission waiter without launching inference or closing checks shared by another caller', async () => {
  const controller = new AbortController(), stopped: AbortSignal[] = [];
  const source: Source = { id: 'shared', available: signal => new Promise((_resolve, reject) => {
    stopped.push(signal!); signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
  }), complete: vi.fn() };
  const availability = new SourceAvailability(new SourceStatus([source.id]));
  availability.start([source]); await turn();
  const waiting = availability.changed(controller.signal);
  controller.abort();
  await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
  expect(stopped[0]!.aborted).toBe(false);
  expect(source.complete).not.toHaveBeenCalled();
  await availability.close();
  expect(stopped[0]!.aborted).toBe(true);
});
