import { chmod, lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { setImmediate, setTimeout as realDelay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { bundledRegistry } from '../registry.js';
import { Sources, SourceError } from './source.js';
import type { ModelRequest } from './source.js';
import { createSourceMaintenance } from './runtime-maintenance.js';
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

it('shares one check and completion gap across sibling daemons without dropping their provider history', async () => {
  const path = await directory(); let finish!: (result: MaintenanceResult) => void;
  const firstCheck = vi.fn(async () => new Promise<MaintenanceResult>(resolve => { finish = resolve; }));
  const first = queue({ directory: path, providers: () => ['kilo'], check: firstCheck, random: () => 0 });
  await first.start(); await vi.advanceTimersByTimeAsync(0); await until(() => Boolean(finish));
  const secondCheck = vi.fn(async () => passed());
  const second = queue({ directory: path, providers: () => ['kilo', 'perch'], check: secondCheck, random: () => 0 });
  await second.start();
  try {
    // A slow native cleanup must retain ownership beyond a nominal crash lease.
    await vi.advanceTimersByTimeAsync(10 * 60000);
    expect(secondCheck).not.toHaveBeenCalled();
  } finally { finish(passed()); }
  await until(() => first.snapshot().kilo?.outcome === 'passed' && vi.getTimerCount() === 2);
  await vi.advanceTimersByTimeAsync(59999); expect(secondCheck).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); await until(() => second.snapshot().perch?.outcome === 'passed' && vi.getTimerCount() === 2);
  expect(secondCheck).toHaveBeenCalledExactlyOnceWith('perch', expect.any(AbortSignal));
  expect(second.snapshot().kilo?.outcome).toBe('passed');
  const saved = JSON.parse(await readFile(join(path, 'maintenance.json'), 'utf8'));
  expect(saved.entries.kilo.outcome).toBe('passed'); expect(saved.entries.perch.outcome).toBe('passed');
});

it('retains sibling schedules when a daemon starts with a different source subset', async () => {
  const path = await directory();
  const first = queue({ directory: path, providers: () => ['kilo'], check: async () => passed(), random: () => 0 });
  await first.start(); await vi.advanceTimersByTimeAsync(0); await completed(first, 'kilo'); await first.close();
  const second = queue({ directory: path, providers: () => ['perch'], check: async () => passed(), random: () => 0 });
  await second.start();
  expect(JSON.parse(await readFile(join(path, 'maintenance.json'), 'utf8')).entries.kilo.outcome).toBe('passed');
  expect(second.snapshot().kilo).toBeUndefined();
});

it('releases ownership after a failed state write so a repaired sibling can resume safely', async () => {
  const path = await directory(), notify = vi.fn();
  const first = queue({ directory: path, providers: () => ['kilo'], check: async () => {
    await chmod(path, 0o755); return passed();
  }, random: () => 0, notify });
  await first.start(); await vi.advanceTimersByTimeAsync(0); await until(() => notify.mock.calls.length === 1);
  await chmod(path, 0o700);
  const check = vi.fn(async () => passed());
  const second = queue({ directory: path, providers: () => ['perch'], check, random: () => 0 }); await second.start();
  await vi.advanceTimersByTimeAsync(MAINTENANCE_CHECK_TIMEOUT + MAINTENANCE_GAP + MAINTENANCE_JITTER);
  await completed(second, 'perch');
  expect(check).toHaveBeenCalledExactlyOnceWith('perch', expect.any(AbortSignal));
});

it('releases cross-process ownership after a crashed daemon without replaying during its live callback', async () => {
  const path = await directory();
  const script = `import { DailyMaintenance } from ${JSON.stringify(new URL('./maintenance.ts', import.meta.url).href)};
    process.stdin.resume();
    const queue = new DailyMaintenance({directory:process.env.MAINTENANCE_TEST_DIRECTORY,now:()=>${epoch},random:()=>0,
      providers:()=>['kilo'],check:async()=>{process.stdout.write('checking\\n');await new Promise(()=>{});}});
    await queue.start();`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)), env: { ...process.env, MAINTENANCE_TEST_DIRECTORY: path }, stdio: ['pipe', 'pipe', 'pipe']
  });
  let output = ''; child.stdout.on('data', chunk => { output += String(chunk); });
  const exited = once(child, 'exit');
  try {
    await until(() => output.includes('checking'));
    const check = vi.fn(async () => passed());
    const item = queue({ directory: path, providers: () => ['kilo'], check, random: () => 0 });
    await item.start(); await vi.advanceTimersByTimeAsync(10 * 60000);
    expect(check).not.toHaveBeenCalled();
    child.kill('SIGKILL'); await exited;
    await vi.advanceTimersByTimeAsync(60000); await completed(item, 'kilo');
    expect(check).toHaveBeenCalledOnce();
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  }
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

it.each(['permissions', 'symlink'] as const)('refuses unsafe coordination %s before running a provider', async kind => {
  const path = await directory(), lock = join(path, 'maintenance-lock.db');
  if (kind === 'permissions') await writeFile(lock, '', { mode: 0o644 });
  else {
    const target = join(path, 'protected.db'); await writeFile(target, 'preserved', { mode: 0o600 }); await symlink(target, lock);
  }
  const check = vi.fn(async () => passed()), item = queue({ directory: path, providers: () => ['kilo'], check });
  await expect(item.start()).rejects.toThrow('private local state'); expect(check).not.toHaveBeenCalled();
  if (kind === 'symlink') expect(await readFile(join(path, 'protected.db'), 'utf8')).toBe('preserved');
});

it('rechecks a recently verified provider at its recovery deadline after the quiet gap', async () => {
  const check = vi.fn(async () => passed());
  const item = queue({ directory: await directory(), providers: () => ['kilo'], check, random: () => 0 });
  await item.start(); await vi.advanceTimersByTimeAsync(0); await completed(item, 'kilo');
  item.scheduleRecovery('kilo', epoch + MAINTENANCE_GAP / 2);
  await vi.advanceTimersByTimeAsync(MAINTENANCE_GAP - 1);
  expect(check).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  await until(() => check.mock.calls.length === 2);
});

it('probes a failed live route at its deadline and reschedules a failed probe', async () => {
  const complete = vi.fn(async () => ({ text: 'healthy' }));
  const sources = new Sources([{ id: 'livekit', available: async () => true, complete }], { registry: () => bundledRegistry });
  const maintenance = createSourceMaintenance(sources, { directory: await directory(), refreshSession: async () => undefined });
  queues.push(maintenance);
  try {
    await maintenance.start();
    await vi.advanceTimersByTimeAsync(0);
    await completed(maintenance, 'livekit');
    expect(complete).toHaveBeenCalledTimes(1);
    const failure = new SourceError('upstream', 'gateway', undefined, undefined, { httpStatus: 502 });
    complete.mockRejectedValueOnce(failure).mockRejectedValueOnce(failure);
    const request = { model: 'livekit', tools: [], messages: [{ role: 'user', content: 'live' }], cwd: tmpdir(), stream: false };
    await expect(sources.complete(request, new AbortController().signal)).rejects.toThrow();
    const first = sources.status().sources[0]!.retryAt!;
    expect(first).toBe(epoch + 300000);
    await vi.advanceTimersByTimeAsync(first - Date.now());
    await until(() => maintenance.snapshot().livekit?.outcome === 'failed' && vi.getTimerCount() === 1);
    expect(complete).toHaveBeenCalledTimes(3);
    const second = sources.status().sources[0]!.retryAt!;
    expect(second).toBe(first + 600000);
    await vi.advanceTimersByTimeAsync(second - Date.now());
    await until(() => complete.mock.calls.length === 4 && maintenance.snapshot().livekit?.outcome === 'passed');
    expect(sources.status().sources[0]!.retryAt).toBeUndefined();
  } finally { await sources.close(); }
});

it('recovers a tool hold only after the provider returns the requested probe call', async () => {
  let returnsCall = false;
  const complete = vi.fn(async (request: ModelRequest) => {
    const name = (request.tools[0] as { function?: { name: string } } | undefined)?.function?.name;
    if (name === 'user_tool') throw new SourceError('upstream', 'invalid call', undefined, undefined, { httpStatus: 200, failureReason: 'response_tools' });
    if (returnsCall && name) return { text: '', calls: [{ id: 'probe', type: 'function' as const, function: { name, arguments: '{}' } }] };
    return { text: 'hello' };
  });
  const sources = new Sources([{ id: 'kilo', supportsFunctionTools: true, available: async () => true, complete }], { registry: () => bundledRegistry });
  const signal = new AbortController().signal;
  try {
    await expect(sources.complete({ model: 'kilo', messages: [], tools: [{ type: 'function', function: { name: 'user_tool', parameters: {} } }], cwd: tmpdir(), stream: false }, signal)).rejects.toThrow();
    const first = sources.status().sources[0]!.retryAt!;
    vi.setSystemTime(first + 1);
    expect(await sources.check('kilo', signal)).toMatchObject({ outcome: 'failed' });
    expect(complete.mock.lastCall?.[0].tools).toHaveLength(1);
    const next = sources.status().sources[0]!.retryAt!;
    expect(next - Date.now()).toBe(60000);
    vi.setSystemTime(next + 1);
    returnsCall = true;
    expect(await sources.check('kilo', signal)).toMatchObject({ outcome: 'passed' });
    expect(sources.status().sources[0]!.retryAt).toBeUndefined();
  } finally { await sources.close(); }
});
