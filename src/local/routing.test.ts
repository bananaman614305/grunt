import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Sources, SourceError } from './source.js';
import type { ModelRequest, Source } from './source.js';
import { bundledRegistry } from '../registry.js';
import { createLocalApp } from './api.js';

const request: ModelRequest = { model: 'milo', messages: [{ role: 'user', content: 'Finish the task' }], cwd: '/tmp', tools: [], stream: false };
const source = (id: string): Source => ({ id, available: vi.fn(async () => true), complete: vi.fn(async () => ({ text: `${id} done` })) });
function routed(random = () => 0) { const a = source('freebuff'), b = source('opencode'); return { a, b, sources: new Sources([a, b], { registry: () => bundledRegistry, random }) }; }
afterEach(() => vi.restoreAllMocks());
it('sticky within task, tool results and retries; draws again for the next user turn', async () => {
  const random = vi.fn().mockReturnValueOnce(0).mockReturnValue(0.99);
  const { a, b, sources } = routed(random);
  await sources.complete(request, AbortSignal.timeout(1000));
  await sources.complete({ ...request, messages: [...request.messages, { role: 'tool', content: 'result' }] }, AbortSignal.timeout(1000));
  expect(a.complete).toHaveBeenCalledTimes(2); expect(b.complete).not.toHaveBeenCalled(); expect(random).toHaveBeenCalledOnce();
  await sources.complete({ ...request, messages: [...request.messages, { role: 'user', content: 'Next task' }] }, AbortSignal.timeout(1000));
  expect(b.complete).toHaveBeenCalledOnce();
});
it.each([[0.49, 'freebuff'], [0.5, 'opencode']] as const)('renormalizes equal launch weights at draw %s', async (draw, id) => {
  const { sources } = routed(() => draw);
  expect(await sources.complete(request, AbortSignal.timeout(1000))).toEqual({ text: `${id} done` });
});
it.each(['logged_out', 'not_installed'] as const)('keeps %s barred until a successful health check', async code => {
  const { a, sources } = routed();
  vi.mocked(a.complete).mockRejectedValueOnce(new SourceError(code, 'needs setup')).mockResolvedValue({ text: 'recovered' });
  await sources.complete(request, AbortSignal.timeout(1000));
  await sources.complete({ ...request, userMessages: ['next'] }, AbortSignal.timeout(1000));
  expect(a.complete).toHaveBeenCalledOnce();
  sources.healthy('freebuff');
  expect(await sources.complete({ ...request, userMessages: ['after check'] }, AbortSignal.timeout(1000))).toEqual({ text: 'recovered' });
});
it('does not replace a bound adapter when a later availability probe would fail', async () => {
  const { a, b, sources } = routed();
  await sources.complete(request, AbortSignal.timeout(1000));
  vi.mocked(a.available).mockResolvedValue(false);
  await sources.complete(request, AbortSignal.timeout(1000));
  expect(a.complete).toHaveBeenCalledTimes(2); expect(b.complete).not.toHaveBeenCalled();
});
it('disables an unlisted adapter without removing its installation', async () => {
  let registry = bundledRegistry;
  const a = source('freebuff'), b = source('opencode');
  const sources = new Sources([a, b], { registry: () => registry, random: () => 0 });
  await sources.complete(request, AbortSignal.timeout(1000));
  registry = { ...bundledRegistry, adapters: [bundledRegistry.adapters[1]!] };
  expect(await sources.complete(request, AbortSignal.timeout(1000))).toEqual({ text: 'opencode done' });
  expect(await sources.models()).not.toContain('freebuff');
  expect(sources.sources).toContain(a);
});
it('switches only after 429, carries task and previous output, and bars until Retry-After', async () => {
  let now = 1000;
  const a = source('freebuff'), b = source('opencode');
  vi.mocked(a.complete).mockResolvedValueOnce({ text: 'Made progress' }).mockRejectedValue(new SourceError('quota', 'quota', 120));
  const sources = new Sources([a, b], { registry: () => bundledRegistry, random: () => 0, now: () => now });
  await sources.complete(request, AbortSignal.timeout(1000));
  await sources.complete(request, AbortSignal.timeout(1000));
  expect(vi.mocked(b.complete).mock.calls[0]![0].messages.at(-1)!.content).toContain('Made progress');
  expect(vi.mocked(b.complete).mock.calls[0]![0].messages.at(-1)!.content).toContain('Continue this task from the current state. Do not restart.');
  const next = { ...request, userMessages: ['another task'] };
  await sources.complete(next, AbortSignal.timeout(1000)); expect(a.complete).toHaveBeenCalledTimes(2);
  now += 120001;
  vi.mocked(a.complete).mockResolvedValue({ text: 'back' });
  await sources.complete({ ...request, userMessages: ['third task'] }, AbortSignal.timeout(1000)); expect(a.complete).toHaveBeenCalledTimes(3);
});
it.each(['upstream', 'timeout'] as const)('switches after tolerance for %s and resets the count on success', async code => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
  const { a, b, sources } = routed();
  vi.mocked(a.complete).mockRejectedValue(new SourceError(code, 'failed'));
  await expect(sources.complete(request, AbortSignal.timeout(1000))).rejects.toMatchObject({ code });
  await expect(sources.complete(request, AbortSignal.timeout(1000))).rejects.toMatchObject({ code });
  expect(b.complete).not.toHaveBeenCalled();
  expect(await sources.complete(request, AbortSignal.timeout(1000))).toEqual({ text: 'opencode done' });
  vi.mocked(a.complete).mockResolvedValue({ text: 'restored' });
  expect(await sources.complete({ ...request, userMessages: ['before recovery'] }, AbortSignal.timeout(1000))).toEqual({ text: 'opencode done' });
  clock.mockReturnValue(1000 + 15 * 60 * 1000 + 1);
  expect(await sources.complete({ ...request, userMessages: ['after recovery'] }, AbortSignal.timeout(1000))).toEqual({ text: 'restored' });
});
it('success resets failure tolerance and cancellation never switches', async () => {
  const { a, b, sources } = routed();
  vi.mocked(a.complete).mockRejectedValueOnce(new SourceError('upstream', 'failed')).mockResolvedValueOnce({ text: 'ok' }).mockRejectedValue(new SourceError('upstream', 'failed'));
  await expect(sources.complete(request, AbortSignal.timeout(1000))).rejects.toThrow();
  await sources.complete(request, AbortSignal.timeout(1000));
  for (let i = 0; i < 2; i++) await expect(sources.complete(request, AbortSignal.timeout(1000))).rejects.toThrow();
  expect(b.complete).not.toHaveBeenCalled();
  vi.mocked(a.complete).mockRejectedValue(new SourceError('cancelled', 'stop'));
  await expect(sources.complete(request, AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'cancelled' });
  expect(b.complete).not.toHaveBeenCalled();
});
it.each([false, true])('returns HTTP 429 with earliest retry when all candidates run out (stream: %s)', async stream => {
  const { a, b, sources } = routed();
  vi.mocked(a.complete).mockRejectedValue(new SourceError('quota', 'quota', 30));
  vi.mocked(b.complete).mockRejectedValue(new SourceError('quota', 'quota', 90));
  const app = createLocalApp(sources);
  const response = await app.request('http://localhost:8788/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...request, stream }) });
  expect(response.status).toBe(429); expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0); expect(Number(response.headers.get('retry-after'))).toBeLessThanOrEqual(30);
});
it('filters disabled, unavailable and unsupported image adapters before drawing', async () => {
  const { a, b, sources } = routed();
  vi.mocked(a.available).mockResolvedValue(false);
  expect(await sources.complete(request, AbortSignal.timeout(1000))).toEqual({ text: 'opencode done' });
  expect(a.complete).not.toHaveBeenCalled();
  const app = createLocalApp(sources);
  const response = await app.request('http://localhost:8788/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...request, messages: [{ role: 'user', content: [{ type: 'text', text: 'describe' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }] }] }) });
  expect(response.status).toBe(429); expect(b.complete).toHaveBeenCalledOnce();
});
it('hands off the live working tree against a dirty task-start checkpoint', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'grunt-handoff-'));
  try {
    const git = (...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
    git('init'); git('config', 'user.email', 'test@example.test'); git('config', 'user.name', 'Test');
    await writeFile(join(cwd, 'task.txt'), 'baseline\n'); git('add', '.'); git('commit', '-m', 'baseline');
    await writeFile(join(cwd, 'task.txt'), 'user edits\n');
    const before = git('status', '--porcelain'); const head = git('rev-parse', 'HEAD');
    const { a, b, sources } = routed();
    vi.mocked(a.complete).mockImplementation(async () => { await writeFile(join(cwd, 'task.txt'), 'user edits\nagent progress\n'); throw new SourceError('quota', 'quota'); });
    await sources.complete({ ...request, cwd }, AbortSignal.timeout(10000));
    const packet = vi.mocked(b.complete).mock.calls[0]![0].messages.at(-1)!.content;
    expect(packet).toContain('+agent progress'); expect(packet).not.toContain('+user edits');
    expect(git('rev-parse', 'HEAD')).toBe(head); expect(git('stash', 'list')).toBe(''); expect(before).toContain('task.txt');
    expect(await readFile(join(cwd, 'task.txt'), 'utf8')).toContain('user edits');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
