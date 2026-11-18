import { access, readdir, stat } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import { currentDiagnosticContext } from './diagnostics.js';
import { answeredBy, SourceError } from './source.js';
import type { ModelRequest } from './source.js';
import { MAX_WORKER_CONTEXT_BYTES, MAX_WORKER_TASK_BYTES, parseWorkerTask, WorkerPool } from './worker-pool.js';

const signal = () => new AbortController().signal;

function reply(source: string, text = 'Proposed change') {
  const completion = { text };
  answeredBy.set(completion, source);
  return completion;
}

function block() {
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  return { wait, release };
}

it('validates exact fields and counts UTF-8 bytes', async () => {
  const complete = vi.fn();
  const pool = new WorkerPool({ complete });
  for (const input of [null, [], '', {}, { task: ' ' }, { task: 'x', cwd: '/home' }, { task: 'x', context: {} },
    { task: 'é'.repeat(MAX_WORKER_TASK_BYTES / 2 + 1) }, { task: 'x', context: 'x'.repeat(MAX_WORKER_CONTEXT_BYTES + 1) }]) {
    expect(parseWorkerTask(input)).toBeUndefined();
    expect(await pool.run(input, signal())).toEqual({ ok: false, code: 'invalid_task' });
  }
  const valid = { task: 'é'.repeat(MAX_WORKER_TASK_BYTES / 2), context: 'x'.repeat(MAX_WORKER_CONTEXT_BYTES) };
  expect(parseWorkerTask(valid)).toEqual(valid);
  expect(complete).not.toHaveBeenCalled();
  expect(pool.status()).toEqual({ active: [], queued: [], recent: [] });
  await pool.close();
});

it('runs two independent jobs, schedules the others in queue order, and keeps metadata only', async () => {
  const first = block(), second = block();
  const requests: ModelRequest[] = [];
  const complete = vi.fn(async (request: ModelRequest) => {
    const position = requests.push(request);
    expect(currentDiagnosticContext()).toMatchObject({ requestId: request.worker!.id, kind: 'user' });
    expect(request).toMatchObject({ model: 'grunt', tools: [], maxTokens: 4096, stream: false });
    expect(await readdir(request.cwd)).toEqual([]);
    expect((await stat(request.cwd)).mode & 0o777).toBe(0o700);
    request.worker!.onSource('kilo');
    if (position < 3) await (position === 1 ? first : second).wait;
    request.worker!.onSource('zro');
    return reply('zro', 'Private answer');
  });
  const pool = new WorkerPool({ complete });
  const jobs = ['Private prompt', 'Private prompt', 'Third job', 'Fourth job'].map(task => pool.run({ task, context: 'Private reference' }, signal()));
  try {
    await vi.waitFor(() => expect(pool.status().active.map(worker => worker.source)).toEqual(['kilo', 'kilo']));
    const { active, queued } = pool.status();
    expect(new Set([...active, ...queued].map(worker => worker.id)).size).toBe(4);
    expect(new Set(requests.map(request => request.cwd)).size).toBe(2);
    expect(complete).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(pool.status())).not.toMatch(/Private|Third job|Fourth job|cwd/);
    first.release();
    await Promise.all(jobs.slice(2));
    expect(requests.slice(2).map(request => request.messages.at(-1)?.content)).toEqual([
      'Task\nThird job\n\nContext\nPrivate reference', 'Task\nFourth job\n\nContext\nPrivate reference'
    ]);
  } finally {
    first.release(); second.release();
    await Promise.all(jobs);
    await pool.close();
  }
  expect(await jobs[0]).toMatchObject({ ok: true, source: 'zro', text: 'Private answer' });
  expect(pool.status().recent).toHaveLength(4);
  expect(pool.status().recent.every(({ state, source }) => state === 'completed' && source === 'zro')).toBe(true);
  expect(JSON.stringify(pool.status())).not.toContain('Private');
  for (const request of requests) await expect(access(request.cwd)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('bounds pending jobs, removes a disconnected job, and cancels active and queued work on close', async () => {
  const complete = vi.fn(async (_request: ModelRequest, caller: AbortSignal) => {
    caller.throwIfAborted();
    return new Promise<never>((_, reject) => caller.addEventListener('abort', () => reject(caller.reason), { once: true }));
  });
  const pool = new WorkerPool({ complete });
  const callers = Array.from({ length: 18 }, () => new AbortController());
  const jobs = callers.map(caller => pool.run({ task: 'queued job' }, caller.signal));
  try {
    expect(pool.status().active).toHaveLength(2);
    expect(pool.status().queued).toHaveLength(16);
    expect(await pool.run({ task: 'over capacity' }, signal())).toEqual({ ok: false, code: 'busy' });
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(2));
    callers[2]!.abort();
    expect(await jobs[2]).toMatchObject({ ok: false, code: 'cancelled' });
    expect(pool.status().queued).toHaveLength(15);
    expect(complete).toHaveBeenCalledTimes(2);
  } finally { await pool.close(); }
  expect((await Promise.all(jobs)).every(result => !result.ok && result.code === 'cancelled')).toBe(true);
  expect(pool.status().active).toHaveLength(0);
  expect(pool.status().queued).toHaveLength(0);
  expect(await pool.run({ task: 'after shutdown' }, signal())).toEqual({ ok: false, code: 'cancelled' });
});

it('returns the deadline promptly while retaining slots until upstream cancellation settles', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const entered = block(), finish = block();
  let running = 0;
  const complete = vi.fn(async (_request: ModelRequest, caller: AbortSignal) => {
    if (++running === 2) entered.release();
    await finish.wait;
    caller.throwIfAborted();
    return reply('zro');
  });
  const pool = new WorkerPool({ complete }, 500);
  const jobs = ['one', 'two', 'three'].map(task => pool.run({ task }, signal()));
  try {
    await entered.wait;
    await vi.advanceTimersByTimeAsync(500);
    expect((await Promise.all(jobs)).every(result => !result.ok && result.code === 'timeout')).toBe(true);
    expect(pool.status().active).toHaveLength(2);
    expect(pool.status().queued).toHaveLength(0);
    expect(complete).toHaveBeenCalledTimes(2);
  } finally {
    finish.release();
    await pool.close();
    vi.useRealTimers();
  }
  expect(pool.status().recent.every(({ state, code }) => state === 'failed' && code === 'timeout')).toBe(true);
});

it('reports typed failures and retry time without returning provider error bodies or untrusted attribution', async () => {
  const complete = vi.fn()
    .mockRejectedValueOnce(new SourceError('quota', 'Private upstream body', 42.1, 'Private upstream output'))
    .mockResolvedValueOnce(reply('https://private-host', 'Private text'));
  const pool = new WorkerPool({ complete });
  try {
    const limited = await pool.run({ task: 'Private task' }, signal());
    expect(limited).toEqual({ ok: false, code: 'quota', retryAfter: 43, id: expect.any(String) });
    const invalid = await pool.run({ task: 'Private task' }, signal());
    expect(invalid).toEqual({ ok: false, code: 'unavailable', id: expect.any(String) });
    expect(JSON.stringify(pool.status())).not.toMatch(/Private|private-host/);
  } finally { await pool.close(); }
});
