import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { bundledRegistry } from '../registry.js';
import { ConsentSource } from './consent-source.js';
import { Sources, SourceError } from './source.js';
import type { Completion, ModelRequest, Source } from './source.js';

const directories: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const fake = (id = 'kilo'): Source => ({ id, available: vi.fn(async () => true), healthCheck: vi.fn(async () => true), complete: vi.fn(async () => ({ text: 'hello' })) });
const request = (model: string): ModelRequest => ({ model, messages: [{ role: 'user', content: `A real user request for ${model}` }], tools: [], cwd: tmpdir(), stream: false });
const signal = () => new AbortController().signal;

it('performs exactly one bounded source reply in a private empty directory and cleans it up', async () => {
  const source = fake(), sources = new Sources([source], { registry: () => bundledRegistry });
  let scratch = '';
  vi.mocked(source.complete).mockImplementation(async (request, caller) => {
    scratch = request.cwd;
    expect(request).toMatchObject({ model: 'kilo', tools: [], stream: false, maxTokens: 1024 });
    expect(request.messages).toEqual([{ role: 'user', content: 'Say hello in one short sentence.' }]);
    expect((await stat(scratch)).mode & 0o777).toBe(0o700);
    expect(await readdir(scratch)).toEqual([]);
    expect(caller.aborted).toBe(false);
    return { text: 'hello' };
  });
  expect(await sources.check('kilo', signal())).toMatchObject({ outcome: 'passed', evidence: 'reply' });
  expect(source.complete).toHaveBeenCalledOnce(); expect(source.available).not.toHaveBeenCalled(); expect(source.healthCheck).not.toHaveBeenCalled();
  await expect(stat(scratch)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(sources.status().sources[0]).toMatchObject({ state: 'ready', active: 0 });
  expect(sources.sources[0]).toBe(source);
});

it('does not substitute another healthy provider when a maintenance route is limited', async () => {
  const limited = fake(), other = fake('opencode');
  vi.mocked(limited.complete).mockRejectedValue(new SourceError('quota', 'Synthetic private upstream body', 120, 'Synthetic private output'));
  const sources = new Sources([limited, other], { registry: () => bundledRegistry });
  const result = await sources.check('kilo', signal());
  expect(result).toMatchObject({ outcome: 'failed', code: 'quota' });
  expect(result.retryAt).toBeGreaterThan(Date.now());
  expect(other.complete).not.toHaveBeenCalled();
  expect(sources.status().sources[0]).toMatchObject({ state: 'limited', errorCode: 'quota' });
  expect(JSON.stringify(sources.status())).not.toContain('Synthetic private');
  expect(await sources.check('kilo', signal())).toMatchObject({ outcome: 'deferred', code: 'quota' });
  expect(limited.complete).toHaveBeenCalledOnce();
});

it.each([[120, 120], [undefined, 3600]])('skips a maintenance quota until it expires (Retry-After: %s)', async (retryAfter, seconds) => {
  let now = 1000;
  const limited = fake('zro'), fallback = fake('livekit');
  vi.mocked(limited.complete).mockRejectedValueOnce(new SourceError('quota', 'Synthetic quota', retryAfter));
  vi.mocked(fallback.complete).mockResolvedValue({ text: 'fallback' });
  const sources = new Sources([limited, fallback], { registry: () => bundledRegistry, now: () => now, random: () => 0 });
  const retryAt = now + seconds * 1000;
  expect(await sources.check('zro', signal())).toMatchObject({ outcome: 'failed', code: 'quota', retryAt });
  expect(sources.status().sources[0]).toMatchObject({ state: 'limited', retryAt });
  expect(await sources.complete(request('grunt'), signal())).toEqual({ text: 'fallback' });
  expect(limited.complete).toHaveBeenCalledOnce();
  expect(limited.available).not.toHaveBeenCalled();

  now = retryAt;
  expect(await sources.complete({ ...request('grunt'), userMessages: ['After retry'] }, signal())).toEqual({ text: 'hello' });
  expect(limited.complete).toHaveBeenCalledTimes(2);
  expect(sources.status().sources[0]).toMatchObject({ state: 'ready' });
});

it('returns the maintenance quota delay when no other route can answer', async () => {
  const limited = fake('zro');
  vi.mocked(limited.complete).mockRejectedValueOnce(new SourceError('quota', 'Synthetic quota', 120));
  const sources = new Sources([limited], { registry: () => bundledRegistry, now: () => 1000 });
  await sources.check('zro', signal());
  await expect(sources.complete(request('grunt'), signal())).rejects.toMatchObject({ code: 'quota', retryAfter: 120 });
  expect(limited.complete).toHaveBeenCalledOnce();
});

it('skips a source when maintenance observes quota during a pending availability check', async () => {
  const limited = fake('zro'), fallback = fake('livekit');
  let finishAvailability!: (available: boolean) => void;
  vi.mocked(limited.available).mockImplementationOnce(() => new Promise(resolve => { finishAvailability = resolve; }));
  vi.mocked(limited.complete).mockRejectedValueOnce(new SourceError('quota', 'Synthetic quota', 120));
  vi.mocked(fallback.complete).mockResolvedValue({ text: 'fallback' });
  const sources = new Sources([limited, fallback], { registry: () => bundledRegistry, now: () => 1000, random: () => 0 });
  const pending = sources.complete(request('grunt'), signal());
  await vi.waitFor(() => expect(limited.available).toHaveBeenCalledOnce());
  try {
    expect(await sources.check('zro', signal())).toMatchObject({ outcome: 'failed', code: 'quota', retryAt: 121000 });
  } finally {
    finishAvailability(true);
  }
  expect(await pending).toEqual({ text: 'fallback' });
  expect(limited.complete).toHaveBeenCalledOnce();
});

it('counts a recent real user reply without generating more inference, even if another source is busy', async () => {
  let now = 100000000;
  const source = fake(), other = fake('opencode'), sources = new Sources([source, other], { registry: () => bundledRegistry, now: () => now });
  await sources.complete(request('kilo'), signal());
  now += 1000;
  let finish!: (reply: Completion) => void;
  vi.mocked(other.complete).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const busy = sources.complete(request('opencode'), signal());
  await vi.waitFor(() => expect(other.complete).toHaveBeenCalledOnce());
  try {
    expect(await sources.check('kilo', signal())).toEqual({ outcome: 'passed', evidence: 'reply', lastSuccessAt: now - 1000 });
    expect(source.complete).toHaveBeenCalledOnce();
  } finally { finish({ text: 'other completed' }); await busy; }
});

it('defers a fresh check while any coding request is active', async () => {
  const source = fake(), other = fake('opencode'), sources = new Sources([source, other]);
  let finish!: (reply: Completion) => void;
  vi.mocked(other.complete).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const busy = sources.complete(request('opencode'), signal());
  try {
    expect(await sources.check('kilo', signal())).toEqual({ outcome: 'deferred', code: 'busy' });
    expect(source.complete).not.toHaveBeenCalled();
  } finally { finish({ text: 'other completed' }); await busy; }
});

it.each(['pending', 'verifying'] as const)('defers foreground %s without touching a source', async state => {
  const source = fake(), sources = new Sources([source]); sources[state].add('kilo');
  expect(await sources.check('kilo', signal())).toEqual({ outcome: 'deferred', code: 'foreground' });
  expect(source.complete).not.toHaveBeenCalled(); expect(source.available).not.toHaveBeenCalled();
});

it('never probes retired, missing or registry-removed sources', async () => {
  const source = fake(), retired = fake('freebuff');
  const sources = new Sources([source, retired], { registry: () => ({ ...bundledRegistry, adapters: [] }) }, new Set(['freebuff']));
  for (const id of ['freebuff', 'kilo', 'missing']) expect(await sources.check(id, signal())).toEqual({ outcome: 'deferred', code: 'not_installed' });
  expect(source.complete).not.toHaveBeenCalled(); expect(retired.complete).not.toHaveBeenCalled();
});

it.each(['removed', 'foreground'] as const)('rechecks %s eligibility after asynchronous scratch-directory creation', async change => {
  const source = fake();
  let registry = structuredClone(bundledRegistry);
  const sources = new Sources([source], { registry: () => registry });
  const checked = sources.check('kilo', signal());
  // This runs while check() is awaiting its first filesystem operation.
  if (change === 'removed') registry = { ...registry, adapters: [] };
  else sources.pending.add('kilo');
  expect(await checked).toEqual({ outcome: 'deferred', code: change === 'removed' ? 'not_installed' : 'foreground' });
  expect(source.complete).not.toHaveBeenCalled();
});

it('honors changed consent through the same source wrapper without signup or fallback', async () => {
  const path = await mkdtemp(join(tmpdir(), 'grunt-maintenance-consent-')); directories.push(path);
  const source = fake(), sources = new Sources([new ConsentSource(source, path)]);
  expect(await sources.check('kilo', signal())).toEqual({ outcome: 'failed', code: 'refused' });
  expect(source.complete).not.toHaveBeenCalled();
});

it('does not reuse a success older than one day or a success superseded by a failure', async () => {
  let now = 100000000;
  const source = fake(), sources = new Sources([source], { registry: () => bundledRegistry, now: () => now });
  await sources.complete(request('kilo'), signal());
  now += 86400001;
  expect(await sources.check('kilo', signal())).toMatchObject({ outcome: 'passed', evidence: 'reply' });
  expect(source.complete).toHaveBeenCalledTimes(2);
  vi.mocked(source.complete).mockRejectedValueOnce(new SourceError('upstream', 'Synthetic failure'));
  await expect(sources.complete(request('kilo'), signal())).rejects.toThrow('No eligible adapter');
  expect(await sources.check('kilo', signal())).toMatchObject({ outcome: 'deferred' });
  expect(source.complete).toHaveBeenCalledTimes(3);
});

it('rejects empty replies and removes the scratch directory after failure', async () => {
  const source = fake(), sources = new Sources([source]); let scratch = '';
  vi.mocked(source.complete).mockImplementation(async request => { scratch = request.cwd; return { text: '  ' }; });
  expect(await sources.check('kilo', signal())).toEqual({ outcome: 'failed', code: 'upstream' });
  expect(sources.status().sources[0]).toMatchObject({ state: 'error' });
  await expect(stat(scratch)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('awaits native cleanup after caller cancellation before releasing the maintenance check', async () => {
  const source = fake(), sources = new Sources([source]), controller = new AbortController();
  let scratch = '', finish!: () => void;
  const cleanup = new Promise<void>(resolve => { finish = resolve; });
  vi.mocked(source.complete).mockImplementation(async (request, caller) => {
    scratch = request.cwd;
    await new Promise<void>(resolve => caller.addEventListener('abort', () => resolve(), { once: true }));
    await cleanup;
    throw caller.reason;
  });
  let settled = false;
  const checked = sources.check('kilo', controller.signal).finally(() => { settled = true; });
  await vi.waitFor(() => expect(source.complete).toHaveBeenCalledOnce());
  controller.abort(new Error('Synthetic cancellation'));
  await setImmediate(); expect(settled).toBe(false); expect((await stat(scratch)).isDirectory()).toBe(true);
  finish(); await expect(checked).rejects.toThrow('Synthetic cancellation');
  await expect(stat(scratch)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(sources.status().sources[0]).toMatchObject({ state: 'unknown', active: 0 });
});

it('does not let a caller mutate maintenance metadata through a cached snapshot', () => {
  const source = fake(), sources = new Sources([source]);
  const entry = { nextCheckAt: 12345, outcome: 'passed' as const, evidence: 'reply' as const };
  sources.setMaintenance(() => ({ kilo: entry }));
  sources.status().sources[0]!.maintenance!.nextCheckAt = 99;
  expect(sources.status().sources[0]!.maintenance!.nextCheckAt).toBe(12345);
});

it('does not let an earlier accepted maintenance reply clear a newer user quota cooldown', async () => {
  const source = fake(), sources = new Sources([source], { registry: () => bundledRegistry });
  let finish!: (reply: Completion) => void;
  vi.mocked(source.complete).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
    .mockRejectedValueOnce(new SourceError('quota', 'Synthetic newer quota failure', 120));
  const checked = sources.check('kilo', signal());
  await vi.waitFor(() => expect(source.complete).toHaveBeenCalledOnce());
  await expect(sources.complete(request('kilo'), signal())).rejects.toThrow('No eligible adapter');
  finish({ text: 'Earlier accepted reply' });
  expect(await checked).toMatchObject({ outcome: 'deferred', code: 'quota' });
  expect(sources.status().sources[0]).toMatchObject({ state: 'limited', errorCode: 'quota' });
  await expect(sources.complete({ ...request('kilo'), messages: [{ role: 'user', content: 'Next task must honor cooldown' }] }, signal())).rejects.toThrow('No eligible adapter');
  expect(source.complete).toHaveBeenCalledTimes(2);
});

it('does not let an older maintenance failure erase a newer actual user success', async () => {
  const source = fake(), sources = new Sources([source], { registry: () => bundledRegistry });
  let reject!: (error: unknown) => void;
  vi.mocked(source.complete).mockImplementationOnce(() => new Promise((_resolve, failed) => { reject = failed; }));
  const checked = sources.check('kilo', signal());
  await vi.waitFor(() => expect(source.complete).toHaveBeenCalledOnce());
  await sources.complete(request('kilo'), signal());
  reject(new SourceError('upstream', 'Older maintenance request failed'));
  expect(await checked).toMatchObject({ outcome: 'passed', evidence: 'reply' });
  expect(sources.status().sources[0]).toMatchObject({ state: 'ready', active: 0 });
});

it('does not let a late maintenance success erase a newer failed availability observation', async () => {
  const source = fake(), sources = new Sources([source]);
  let finish!: (reply: Completion) => void;
  vi.mocked(source.complete).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const checked = sources.check('kilo', signal());
  await vi.waitFor(() => expect(source.complete).toHaveBeenCalledOnce());
  vi.mocked(source.available).mockResolvedValue(false);
  await sources.models();
  finish({ text: 'Earlier accepted reply' });
  expect(await checked).toEqual({ outcome: 'deferred', code: 'busy' });
  expect(sources.status().sources[0]).toMatchObject({ state: 'unavailable', active: 0 });
});

it('checks Free-Pi metadata without creating a session trace', async () => {
  const source = fake('freepi');
  const sources = new Sources([source]);
  expect(await sources.check('freepi', signal())).toMatchObject({ outcome: 'passed', evidence: 'metadata' });
  expect(source.healthCheck).toHaveBeenCalledOnce();
  expect(source.complete).not.toHaveBeenCalled();
});
