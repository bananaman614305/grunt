import { chmod, lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { setImmediate, setTimeout as realDelay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DailyMaintenance, MAINTENANCE_CHECK_TIMEOUT, MAINTENANCE_GAP, MAINTENANCE_INTERVAL, MAINTENANCE_JITTER } from './maintenance.js';
import type { MaintenanceResult } from './maintenance.js';

const directories: string[] = [], queues: DailyMaintenance[] = [];
const epoch = Date.parse('2026-11-16T12:00:00Z');
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }); vi.setSystemTime(epoch); });
afterEach(async () => {
  await Promise.all(queues.splice(0).map(queue => queue.close()));
  vi.useRealTimers();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});
async function directory() { const path = await mkdtemp(join(tmpdir(), 'grunt-maintenance-')); directories.push(path); return path; }
function queue(options: ConstructorParameters<typeof DailyMaintenance>[0]) { const item = new DailyMaintenance(options); queues.push(item); return item; }
async function until(test: () => boolean) {
  // The maintenance clock is fake, but private filesystem writes need real time.
  const deadline = performance.now() + 2000;
  while (!test()) {
    if (performance.now() >= deadline) throw new Error('Maintenance did not settle');
    await realDelay(1);
  }
}
async function completed(item: DailyMaintenance, id: string) {
  await until(() => item.snapshot()[id]?.outcome !== undefined && vi.getTimerCount() === 1);
}
const passed = (): MaintenanceResult => ({ outcome: 'passed', evidence: 'metadata' });

it('waits for delayed real work without advancing the maintenance clock', async () => {
  let settled = false;
  const work = realDelay(50).then(() => { settled = true; });
  try { await until(() => settled); }
  finally { await work; }
  expect(Date.now()).toBe(epoch);
  expect(vi.getTimerCount()).toBe(0);
});

it('runs one check at a time and spaces starts from the previous completion, including maximum jitter', async () => {
  const path = await directory(); let finish!: (result: MaintenanceResult) => void;
  const starts: number[] = [];
  const check = vi.fn(async () => {
    starts.push(Date.now());
    if (starts.length === 1) return new Promise<MaintenanceResult>(resolve => { finish = resolve; });
    return passed();
  });
  const item = queue({ directory: path, providers: () => ['kilo', 'perch'], check, random: () => 1 });
  await item.start(); await vi.advanceTimersByTimeAsync(0); await until(() => check.mock.calls.length === 1);
  await vi.advanceTimersByTimeAsync(10 * 60000);
  expect(check).toHaveBeenCalledOnce();
  const finishedAt = Date.now(); finish(passed()); await completed(item, 'kilo');
  await vi.advanceTimersByTimeAsync(89999); expect(check).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1); await until(() => check.mock.calls.length === 2);
  expect(starts).toEqual([epoch, finishedAt + 90000]);
  await completed(item, 'perch');
});

it('deduplicates start calls and preserves the quiet gap and checked providers across a restart', async () => {
  const path = await directory(), firstCheck = vi.fn(async () => passed());
  const first = queue({ directory: path, providers: () => ['kilo', 'perch'], check: firstCheck, random: () => 0 });
  const starting = first.start(); expect(first.start()).toBe(starting); await starting;
  await vi.advanceTimersByTimeAsync(0); await completed(first, 'kilo'); await first.close();
  const nextCheck = vi.fn(async () => passed());
  const next = queue({ directory: path, providers: () => ['kilo', 'perch'], check: nextCheck, random: () => 0 });
  await next.start(); await vi.advanceTimersByTimeAsync(59999); expect(nextCheck).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); await until(() => nextCheck.mock.calls.length === 1);
  expect(nextCheck).toHaveBeenCalledWith('perch', expect.any(AbortSignal));
  expect(next.snapshot().kilo?.nextCheckAt).toBe(epoch + MAINTENANCE_INTERVAL);
  await completed(next, 'perch');
});

it('defers busy work without marking it checked or preventing another due provider from running', async () => {
  const path = await directory();
  const check = vi.fn(async (id: string): Promise<MaintenanceResult> => id === 'kilo' ? { outcome: 'deferred', code: 'busy' } : passed());
  const item = queue({ directory: path, providers: () => ['kilo', 'perch'], check, random: () => 0 });
  await item.start(); await vi.advanceTimersByTimeAsync(0); await completed(item, 'kilo');
  expect(item.snapshot().kilo).toMatchObject({ outcome: 'deferred', code: 'busy', nextCheckAt: epoch + 5 * 60000 });
  expect(item.snapshot().kilo?.lastCheckedAt).toBeUndefined();
  await vi.advanceTimersByTimeAsync(60000); await completed(item, 'perch');
  expect(check.mock.calls.map(call => call[0])).toEqual(['kilo', 'perch']);
});

it('honors a reported retry later than a day and isolates a failed check from the remaining queue', async () => {
  const path = await directory();
  const check = vi.fn(async (id: string): Promise<MaintenanceResult> => id === 'runcrate'
    ? { outcome: 'failed', code: 'quota', retryAt: epoch + 3 * MAINTENANCE_INTERVAL } : passed());
  const item = queue({ directory: path, providers: () => ['runcrate', 'perch'], check, random: () => 0 });
  await item.start(); await vi.advanceTimersByTimeAsync(0); await completed(item, 'runcrate');
  expect(item.snapshot().runcrate?.nextCheckAt).toBe(epoch + 3 * MAINTENANCE_INTERVAL);
  await vi.advanceTimersByTimeAsync(60000); await completed(item, 'perch');
  expect(check).toHaveBeenCalledTimes(2);
});

it('uses a recent real reply as evidence without postponing the next check beyond its own 24-hour window', async () => {
  const path = await directory(), successAt = epoch - 23 * 60 * 60000;
  const item = queue({ directory: path, providers: () => ['kilo'], random: () => 0,
    check: async () => ({ outcome: 'passed', evidence: 'reply', lastSuccessAt: successAt }) });
  await item.start(); await vi.advanceTimersByTimeAsync(0); await completed(item, 'kilo');
  expect(item.snapshot().kilo).toMatchObject({ evidence: 'reply', lastCheckedAt: epoch, nextCheckAt: successAt + MAINTENANCE_INTERVAL });
});

it('reconciles provider removals and additions before dispatch rather than checking a removed source', async () => {
  const path = await directory(); let providers = ['kilo'];
  const check = vi.fn(async () => passed());
  const item = queue({ directory: path, providers: () => providers, check, random: () => 0 });
  await item.start(); await vi.advanceTimersByTimeAsync(0); await completed(item, 'kilo');
  providers = ['perch'];
  await vi.advanceTimersByTimeAsync(60000); await completed(item, 'perch');
  expect(check.mock.calls.map(call => call[0])).toEqual(['kilo', 'perch']);
  expect(item.snapshot().kilo).toBeUndefined();
});

it('aborts shutdown and waits for actual callback cleanup instead of starting another check', async () => {
  const path = await directory(); let cleanup!: () => void; let signal: AbortSignal | undefined;
  const check = vi.fn(async (_id: string, active: AbortSignal) => {
    signal = active;
    await new Promise<void>(resolve => { cleanup = resolve; });
    return passed();
  });
  const item = queue({ directory: path, providers: () => ['kilo', 'perch'], check });
  await item.start(); await vi.advanceTimersByTimeAsync(0); await until(() => Boolean(cleanup));
  let closed = false;
  const closing = item.close().then(() => { closed = true; });
  await setImmediate(); expect(signal?.aborted).toBe(true); expect(closed).toBe(false);
  await vi.advanceTimersByTimeAsync(MAINTENANCE_INTERVAL); expect(check).toHaveBeenCalledOnce();
  cleanup(); await closing;
  expect(item.snapshot().kilo?.lastCheckedAt).toBeUndefined();
  expect(vi.getTimerCount()).toBe(0);
});

it('does not immediately replay a reserved interrupted check after a restart', async () => {
  const path = await directory(); let cleanup!: () => void;
  const first = queue({ directory: path, providers: () => ['kilo'], check: async () => {
    await new Promise<void>(resolve => { cleanup = resolve; }); return passed();
  } });
  await first.start(); await vi.advanceTimersByTimeAsync(0); await until(() => Boolean(cleanup));
  const closing = first.close(); cleanup(); await closing;
  const check = vi.fn(async () => passed());
  const next = queue({ directory: path, providers: () => ['kilo'], check });
  await next.start(); await vi.advanceTimersByTimeAsync(5 * 60000 - 1); expect(check).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); await completed(next, 'kilo'); expect(check).toHaveBeenCalledOnce();
});

it('persists the quiet gap from the end of shutdown cleanup before allowing another provider after restart', async () => {
  const path = await directory(); let cleanup!: () => void;
  const first = queue({ directory: path, providers: () => ['kilo', 'perch'], random: () => 0, check: async () => {
    await new Promise<void>(resolve => { cleanup = resolve; }); return passed();
  } });
  await first.start(); await vi.advanceTimersByTimeAsync(0); await until(() => Boolean(cleanup));
  await vi.advanceTimersByTimeAsync(MAINTENANCE_CHECK_TIMEOUT);
  const closing = first.close();
  await vi.advanceTimersByTimeAsync(30000); cleanup(); await closing;
  const finishedAt = Date.now(), check = vi.fn(async () => passed());
  const next = queue({ directory: path, providers: () => ['kilo', 'perch'], check, random: () => 0 });
  await next.start(); await vi.advanceTimersByTimeAsync(59999); expect(check).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); await completed(next, 'perch');
  expect(check).toHaveBeenCalledExactlyOnceWith('perch', expect.any(AbortSignal));
  expect(next.snapshot().perch?.lastAttemptAt).toBe(finishedAt + 60000);
});

it('preserves the full in-flight crash reservation instead of shortening it to a normal quiet gap on load', async () => {
  const originalPath = await directory(), restartPath = await directory(); let cleanup!: () => void;
  const original = queue({ directory: originalPath, providers: () => ['kilo', 'perch'], check: async () => {
    await new Promise<void>(resolve => { cleanup = resolve; }); return passed();
  } });
  await original.start(); await vi.advanceTimersByTimeAsync(0); await until(() => Boolean(cleanup));
  try {
    // Copy the durable image of a crashed daemon into a separate directory;
    // no old process will update that image while the new daemon reads it.
    await writeFile(join(restartPath, 'maintenance.json'), await readFile(join(originalPath, 'maintenance.json')), { mode: 0o600 });
    await vi.advanceTimersByTimeAsync(120000);
    const check = vi.fn(async () => passed());
    const next = queue({ directory: restartPath, providers: () => ['kilo', 'perch'], check, random: () => 0 });
    await next.start();
    const remaining = MAINTENANCE_CHECK_TIMEOUT + MAINTENANCE_GAP + MAINTENANCE_JITTER - 120000;
    await vi.advanceTimersByTimeAsync(remaining - 1); expect(check).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); await completed(next, 'perch');
    expect(check).toHaveBeenCalledExactlyOnceWith('perch', expect.any(AbortSignal));
  } finally { const closing = original.close(); cleanup(); await closing; }
});

it('pauses rather than running unchecked work when state can no longer be persisted', async () => {
  const path = await directory(), notify = vi.fn();
  const check = vi.fn(async () => { await chmod(path, 0o755); return passed(); });
  const item = queue({ directory: path, providers: () => ['kilo', 'perch'], check, notify });
  await item.start(); await vi.advanceTimersByTimeAsync(0); await until(() => notify.mock.calls.length === 1);
  await vi.advanceTimersByTimeAsync(MAINTENANCE_INTERVAL);
  expect(check).toHaveBeenCalledOnce();
  expect(notify).toHaveBeenCalledWith('Provider maintenance paused; private state could not be updated');
});

it('persists only safe bounded evidence, with private permissions and no raw errors or result extras', async () => {
  const path = await directory();
  const item = queue({ directory: path, providers: () => ['kilo', 'perch'], random: () => 0,
    check: async id => { if (id === 'kilo') throw new Error('synthetic-secret-must-not-be-saved'); return { ...passed(), raw: 'synthetic-extra-must-not-be-saved' }; } });
  await item.start(); await vi.advanceTimersByTimeAsync(0); await completed(item, 'kilo');
  await vi.advanceTimersByTimeAsync(60000); await completed(item, 'perch'); await item.close();
  const saved = await readFile(join(path, 'maintenance.json'), 'utf8');
  expect(saved).not.toContain('synthetic-');
  expect((await lstat(join(path, 'maintenance.json'))).mode & 0o777).toBe(0o600);
  expect(JSON.parse(saved).entries.kilo).toMatchObject({ outcome: 'failed', code: 'upstream' });
  expect((await readdir(path)).filter(name => name.endsWith('.tmp'))).toEqual([]);
});

it('recovers a corrupt private file with a quiet delay and writes a clean state before checking', async () => {
  const path = await directory(); await writeFile(join(path, 'maintenance.json'), 'broken JSON', { mode: 0o600 });
  const check = vi.fn(async () => passed());
  const item = queue({ directory: path, providers: () => ['kilo'], check });
  await item.start(); await vi.advanceTimersByTimeAsync(59999); expect(check).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); await until(() => check.mock.calls.length === 1); await completed(item, 'kilo');
  expect(JSON.parse(await readFile(join(path, 'maintenance.json'), 'utf8')).version).toBe(1);
});

it.each(['directory', 'file', 'symlink'] as const)('refuses unsafe %s state before running a provider', async kind => {
  const path = await directory(), file = join(path, 'maintenance.json');
  if (kind === 'directory') await chmod(path, 0o755);
  else if (kind === 'file') await writeFile(file, '{}', { mode: 0o644 });
  else {
    const target = join(path, 'protected.json'); await writeFile(target, '{"preserved":true}', { mode: 0o600 }); await symlink(target, file);
  }
  const check = vi.fn(async () => passed()), item = queue({ directory: path, providers: () => ['kilo'], check });
  await expect(item.start()).rejects.toThrow('private local state');
  expect(check).not.toHaveBeenCalled();
  if (kind === 'symlink') expect(await readFile(join(path, 'protected.json'), 'utf8')).toBe('{"preserved":true}');
});
