import { afterEach, expect, it, vi } from 'vitest';
import { MetadataFlights } from './metadata-flight.js';

afterEach(() => vi.useRealTimers());

it('shares overlapping reads but never reuses completed access evidence', async () => {
  const flights = new MetadataFlights(); let release!: (value: string) => void;
  const read = vi.fn(() => new Promise<string>(resolve => { release = resolve; }));
  const first = flights.run('same-private-grant', read), second = flights.run('same-private-grant', read);
  await Promise.resolve(); expect(read).toHaveBeenCalledOnce(); release('first');
  expect(await Promise.all([first, second])).toEqual(['first', 'first']);
  const fresh = flights.run('same-private-grant', read); await Promise.resolve();
  expect(read).toHaveBeenCalledTimes(2); release('fresh'); expect(await fresh).toBe('fresh');
});

it('does not let one cancelled waiter cancel another waiter or its shared fetch', async () => {
  const flights = new MetadataFlights(); let release!: (value: string) => void, underlying!: AbortSignal;
  const read = vi.fn((signal: AbortSignal) => { underlying = signal; return new Promise<string>(resolve => { release = resolve; }); });
  const caller = new AbortController(), first = flights.run('grant', read, caller.signal), second = flights.run('grant', read);
  const cancelled = expect(first).rejects.toThrow('owner cancelled'); await Promise.resolve();
  caller.abort(new Error('owner cancelled')); await cancelled;
  expect(underlying.aborted).toBe(false); release('allowed'); expect(await second).toBe('allowed');
  expect(read).toHaveBeenCalledOnce();
});

it('aborts underlying work when its final waiter leaves', async () => {
  const flights = new MetadataFlights(); let underlying!: AbortSignal;
  const caller = new AbortController();
  const result = flights.run('grant', signal => new Promise((_resolve, reject) => {
    underlying = signal; signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }), caller.signal);
  const cancelled = expect(result).rejects.toThrow('cancelled'); await Promise.resolve();
  caller.abort(new Error('cancelled')); await cancelled; expect(underlying.aborted).toBe(true);
});

it('releases a cooperatively aborted read before admitting a fresh caller', async () => {
  const flights = new MetadataFlights(), caller = new AbortController();
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const read = vi.fn((signal: AbortSignal) => new Promise<string>((_resolve, reject) => {
    started(); signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  const first = flights.run('grant', read, caller.signal), cancelled = expect(first).rejects.toThrow('cancelled');
  await ready; caller.abort(new Error('cancelled')); await cancelled;
  // Let the actual fetch rejection settle; cancellation alone is not proof it stopped.
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(await flights.run('grant', async () => 'fresh evidence')).toBe('fresh evidence');
  expect(read).toHaveBeenCalledOnce();
});

it('bounds waiter lifetime and does not relaunch an uncooperative timed-out read', async () => {
  vi.useFakeTimers(); const flights = new MetadataFlights(50); let release!: (value: string) => void;
  const read = vi.fn(() => new Promise<string>(resolve => { release = resolve; }));
  const pending = flights.run('grant', read), deadline = expect(pending).rejects.toMatchObject({ code: 'timeout' });
  await vi.advanceTimersByTimeAsync(50); await deadline;
  await expect(flights.run('grant', read)).rejects.toMatchObject({ code: 'timeout' });
  expect(read).toHaveBeenCalledOnce(); release('late'); await vi.advanceTimersByTimeAsync(0);
  const fresh = flights.run('grant', read); await Promise.resolve(); release('new'); expect(await fresh).toBe('new');
  expect(read).toHaveBeenCalledTimes(2);
});

it('separates changed credentials and stops admission after close', async () => {
  const flights = new MetadataFlights(), read = vi.fn(async () => 'allowed');
  expect(await Promise.all([flights.run('old-grant', read), flights.run('new-grant', read)])).toEqual(['allowed', 'allowed']);
  expect(read).toHaveBeenCalledTimes(2); flights.close();
  await expect(flights.run('old-grant', read)).rejects.toMatchObject({ code: 'cancelled' });
  expect(read).toHaveBeenCalledTimes(2);
});

it('releases rejected reads instead of retaining failed access evidence', async () => {
  const flights = new MetadataFlights(), read = vi.fn<() => Promise<string>>()
    .mockRejectedValueOnce(undefined).mockResolvedValueOnce('fresh');
  await expect(flights.run('grant', read)).rejects.toBeUndefined();
  expect(await flights.run('grant', read)).toBe('fresh'); expect(read).toHaveBeenCalledTimes(2);
});
