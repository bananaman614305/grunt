import { access, readdir, stat, mkdtemp, rm, readFile, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { bundledRegistry } from '../registry.js';
import { currentDiagnosticContext } from './diagnostics.js';
import { answeredBy, SourceError, Sources } from './source.js';
import type { ModelRequest } from './source.js';
import { MAX_WORKER_CONTEXT_BYTES, MAX_WORKER_TASK_BYTES, parseWorkerTask, WorkerPool } from './worker-pool.js';
import type { WorkerAgentWorkspace, WorkerArtifact } from './worker-agent.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const retentionRoots: string[] = [];
afterEach(async () => { await Promise.all(retentionRoots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function retentionRoot() { const path = await mkdtemp(join(tmpdir(), 'grunt-worker-retention-')); retentionRoots.push(path); return path; }
function agentWorkspace(ownedPath = 'file.txt') {
  let content = 'original';
  const workspace: WorkerAgentWorkspace = {
    id: randomUUID(), path: '/private-agent-fixture', capabilities: { filesystem: true, commands: false, sandbox: 'filesystem' },
    tools: [{ type: 'function', function: { name: 'worker_write', parameters: { type: 'object', required: ['content'], additionalProperties: false,
      properties: { content: { type: 'string' } } } } }],
    executeTool: vi.fn(async (_name, args) => { content = (args as { content: string }).content; return { ok: true }; }),
    artifact: vi.fn(async (): Promise<WorkerArtifact> => ({ id: workspace.id, complete: true, truncated: false,
      files: content === 'original' ? [] : [{ path: ownedPath, beforeSha256: hash('original'), afterSha256: hash(content), content }] })),
    cleanup: vi.fn(async () => {})
  };
  return workspace;
}
function agentReply(content = 'updated') {
  const value = { text: '', calls: [{ id: 'call_0', type: 'function' as const, function: { name: 'worker_write', arguments: JSON.stringify({ content }) } }] };
  answeredBy.set(value, 'kilo'); return value;
}

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

it('requires explicit agent mode, normalized ownership and a trusted project scope', async () => {
  const complete = vi.fn(), pool = new WorkerPool({ complete });
  for (const value of [
    { task: 'x', mode: 'agent' }, { task: 'x', mode: 'agent', ownedPaths: [] },
    { task: 'x', mode: 'agent', ownedPaths: ['../escape'] }, { task: 'x', mode: 'agent', ownedPaths: ['/absolute'] },
    { task: 'x', mode: 'agent', ownedPaths: ['.git/config'] }, { task: 'x', mode: 'proposal', ownedPaths: ['file'] },
    { task: 'x', mode: 'agent', ownedPaths: ['file'], projectRoot: '/private' },
  ]) expect(await pool.run(value, signal(), { projectRoot: '/project' })).toEqual({ ok: false, code: 'invalid_task' });
  const task = { task: 'x', mode: 'agent', ownedPaths: ['file.txt'] };
  expect(await pool.run(task, signal())).toEqual({ ok: false, code: 'invalid_task', reason: 'invalid_workspace' });
  expect(await pool.run(task, signal(), { projectRoot: '/project' })).toEqual({ ok: false, code: 'unavailable', reason: 'agent_unavailable' });
  expect(complete).not.toHaveBeenCalled(); await pool.close();
});

it('keeps two agent tool loops alongside the main route and never sends workers to a custom source', async () => {
  const parentHold = block(), workerHold = block();
  const makeSource = (id: string) => ({ id, supportsFunctionTools: true, available: vi.fn(async () => true),
    complete: vi.fn(async (request: ModelRequest) => {
      if (!request.tools.length) { await parentHold.wait; return { text: 'Parent completed' }; }
      if (!request.messages.some(message => message.role === 'tool')) { await workerHold.wait; return {
        text: '', calls: [{ id: 'call_0', type: 'function' as const, function: { name: 'worker_write', arguments: '{"content":"scoped edit"}' } }]
      }; }
      return { text: 'Worker completed' };
    }) });
  const custom = makeSource('custom-paid'), kilo = makeSource('kilo'), zro = makeSource('zro');
  const sources = new Sources([custom, kilo, zro]); sources.setWorkerRegistry(() => bundledRegistry);
  const workspaces: WorkerAgentWorkspace[] = [];
  const pool = new WorkerPool(sources, 3000, { createAgentWorkspace: async options => { const workspace = agentWorkspace(options.ownedPaths[0]); workspaces.push(workspace); return workspace; } });
  const parent = sources.complete({ model: 'grunt', cwd: '/project', messages: [{ role: 'user', content: 'parent' }], tools: [], stream: false }, signal());
  await vi.waitFor(() => expect(custom.complete).toHaveBeenCalledOnce());
  const jobs = ['one.txt', 'two.txt'].map(path => pool.run({ task: 'Independent work', mode: 'agent', ownedPaths: [path] }, signal(), { projectRoot: '/project' }));
  try {
    await vi.waitFor(() => expect(sources.status().activeRequests).toBe(3));
    expect(sources.status().sources.map(source => source.active)).toEqual([1, 1, 1]);
    parentHold.release(); expect((await parent).text).toBe('Parent completed');
    expect(pool.status().active).toHaveLength(2);
    workerHold.release();
    const results = await Promise.all(jobs);
    expect(results.every(result => result.ok && result.source !== custom.id && result.artifact?.complete)).toBe(true);
    expect(custom.complete).toHaveBeenCalledOnce();
    expect(workspaces.every(workspace => vi.mocked(workspace.executeTool).mock.calls.length === 1)).toBe(true);
  } finally { parentHold.release(); workerHold.release(); await Promise.all(jobs); await pool.close(); await sources.close(); }
});

it('retains late partial artifacts after prompt cancellation and protects them with the project scope', async () => {
  const workspace = agentWorkspace(), release = block(), controller = new AbortController(); let count = 0;
  const complete = vi.fn(async (_request: ModelRequest, caller: AbortSignal) => {
    if (++count === 1) return agentReply('partial edit');
    await release.wait; caller.throwIfAborted(); return reply('kilo');
  });
  const pool = new WorkerPool({ complete }, 3000, { createAgentWorkspace: async () => workspace });
  const scope = { projectRoot: '/project' }, job = pool.run({ task: 'Implement', mode: 'agent', ownedPaths: ['file.txt'] }, controller.signal, scope);
  await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(2)); controller.abort();
  const failure = await job; expect(failure).toMatchObject({ ok: false, code: 'cancelled', id: expect.any(String) });
  expect(pool.status().active).toHaveLength(1);
  release.release(); await vi.waitFor(() => expect(pool.status().active).toHaveLength(0));
  const artifact = pool.artifact(failure.id!, scope)!;
  expect(artifact.files[0]!.content).toBe('partial edit');
  expect(pool.artifact(failure.id!, { projectRoot: '/other' })).toBeUndefined();
  expect(pool.retained({ projectRoot: '/other' })).toEqual([]);
  expect(await pool.discardArtifact(failure.id!, { projectRoot: '/other' })).toBe(false);
  artifact.files[0]!.content = 'caller mutation';
  expect(pool.artifact(failure.id!, scope)!.files[0]!.content).toBe('partial edit');
  expect(pool.retained(scope)[0]).toMatchObject({ state: 'cancelled', artifactAvailable: true, waitingForSource: false });
  await pool.close(); expect(workspace.cleanup).not.toHaveBeenCalled();
  expect(await pool.discardArtifact(failure.id!, scope)).toBe(true);
  expect(workspace.cleanup).toHaveBeenCalledOnce(); expect(pool.artifact(failure.id!, scope)).toBeUndefined();
  expect(pool.status().recent[0]!.artifactAvailable).toBe(false);
});

it('passes private initial snapshots only to the trusted workspace factory, not model context or status', async () => {
  const workspace = agentWorkspace(), factory = vi.fn(async () => workspace), transitions: unknown[] = [];
  const snapshot = [{ path: 'file.txt', content: 'private-whole-snapshot', sha256: hash('private-whole-snapshot') }];
  const complete = vi.fn(async (request: ModelRequest) => {
    expect(JSON.stringify(request.messages)).not.toMatch(/private-whole-snapshot|projectRoot|sha256/);
    request.worker!.onWait?.(); request.worker!.onSource('kilo'); return reply('kilo');
  });
  const pool = new WorkerPool({ complete }, 3000, { createAgentWorkspace: factory, onTransition: (status, event) => { transitions.push({ status, event }); } });
  const result = await pool.run({ task: 'Inspect approved files', mode: 'agent', ownedPaths: ['file.txt'], activity: 'review' }, signal(), { projectRoot: '/private-project', initialSnapshot: snapshot });
  expect(result.ok).toBe(true); expect(factory).toHaveBeenCalledWith({ projectRoot: '/private-project', initialSnapshot: snapshot, readOnly: true, ownedPaths: ['file.txt'] }, expect.any(AbortSignal));
  expect(JSON.stringify(transitions)).not.toMatch(/private-whole-snapshot|private-project|Inspect approved|file.txt/);
  expect(transitions).toEqual(expect.arrayContaining([expect.objectContaining({ event: 'waiting', status: expect.objectContaining({ waitingForSource: true }) }),
    expect.objectContaining({ event: 'source', status: expect.objectContaining({ waitingForSource: false, source: 'kilo' }) })]));
  expect(pool.status().recent[0]).toMatchObject({ mode: 'agent', turns: 1, toolCalls: 0, capabilities: { filesystem: true, commands: false }, artifactAvailable: true });
  await pool.close();
});

it('recovers durable quota artifacts, ownership and retry metadata across independent pool instances', async () => {
  const directory = await retentionRoot(), workspace = { ...agentWorkspace(), recoveryId: 'worker-test_recovery' }, scope = { projectRoot: '/project', projectIdentity: hash('original project inode') };
  const restore = vi.fn(async () => workspace);
  const complete = vi.fn().mockResolvedValueOnce(agentReply('durable partial')).mockRejectedValueOnce(new SourceError('quota', 'private upstream', 120));
  const options = { createAgentWorkspace: async () => workspace, restoreAgentWorkspace: restore, retentionDirectory: directory };
  const first = new WorkerPool({ complete }, 3000, options);
  const result = await first.run({ task: 'secret task text', context: 'secret reference', mode: 'agent', ownedPaths: ['file.txt'] }, signal(), scope);
  expect(result).toMatchObject({ ok: false, code: 'quota', artifact: { files: [{ content: 'durable partial' }] } });
  await first.close();
  const body = await readFile(join(directory, `${result.id}.json`), 'utf8');
  expect(body).not.toMatch(/secret task text|secret reference|private upstream/);
  expect((await stat(join(directory, `${result.id}.json`))).mode & 0o077).toBe(0);
  const restarted = new WorkerPool({ complete: vi.fn() }, 3000, options); await restarted.ready();
  expect(restore).toHaveBeenCalledWith({ workspaceId: workspace.id, recoveryId: workspace.recoveryId }, expect.any(AbortSignal));
  expect(restarted.retained(scope)).toMatchObject([{ id: result.id, state: 'failed', code: 'quota', nextAttemptAt: expect.any(Number), artifactAvailable: true }]);
  expect(restarted.artifact(result.id!, scope)?.files[0]!.content).toBe('durable partial');
  expect(restarted.artifactOwnership(result.id!, scope)).toEqual(['file.txt']);
  expect(restarted.artifactOwnership(result.id!, { projectRoot: '/other' })).toBeUndefined();
  const replacement = { projectRoot: scope.projectRoot, projectIdentity: hash('replacement project inode') };
  expect(restarted.artifact(result.id!, replacement)).toBeUndefined();
  expect(restarted.artifact(result.id!, { projectRoot: scope.projectRoot })).toBeUndefined();
  expect(restarted.artifactOwnership(result.id!, replacement)).toBeUndefined();
  expect(restarted.retained(replacement)).toEqual([]);
  expect(await restarted.discardArtifact(result.id!, replacement)).toBe(false);
  const ownership = restarted.artifactOwnership(result.id!, scope)!; ownership.push('other');
  expect(restarted.artifactOwnership(result.id!, scope)).toEqual(['file.txt']);
  expect(await restarted.discardArtifact(result.id!, scope)).toBe(true); await restarted.close();
  const third = new WorkerPool({ complete: vi.fn() }, 3000, options); await third.ready();
  expect(third.retained(scope)).toEqual([]); expect(workspace.cleanup).toHaveBeenCalledOnce(); await third.close();
});

it('marks interrupted durable jobs cancelled and recaptures later disk changes without resuming inference', async () => {
  const directory = await retentionRoot(), workspace = { ...agentWorkspace(), recoveryId: 'worker-crash_recovery' }, scope = { projectRoot: '/project' };
  const options = { createAgentWorkspace: async () => workspace, restoreAgentWorkspace: async () => workspace, retentionDirectory: directory };
  const first = new WorkerPool({ complete: vi.fn(async () => reply('kilo')) }, 3000, options);
  const result = await first.run({ task: 'job', mode: 'agent', ownedPaths: ['file.txt'] }, signal(), scope); await first.close();
  const path = join(directory, `${result.id}.json`), record = JSON.parse(await readFile(path, 'utf8'));
  record.status.state = 'running'; delete record.status.finishedAt;
  await writeFile(path, JSON.stringify(record), { mode: 0o600 });
  await workspace.executeTool('worker_write', { content: 'latest crash-time partial' }, signal());
  const complete = vi.fn(), restarted = new WorkerPool({ complete }, 3000, options); await restarted.ready();
  expect(restarted.retained(scope)).toMatchObject([{ state: 'cancelled', code: 'cancelled', waitingForSource: false }]);
  expect(restarted.artifact(result.id!, scope)?.files[0]!.content).toBe('latest crash-time partial');
  expect(complete).not.toHaveBeenCalled();
  expect(await restarted.run({ task: 'overlap', mode: 'agent', ownedPaths: ['file.txt'] }, signal(), scope)).toEqual({ ok: false, code: 'busy' });
  await restarted.close();
});

it('fails closed on corrupt or symlinked retention records without inferring or discarding them', async () => {
  const directory = await retentionRoot(), id = randomUUID(), target = join(await retentionRoot(), 'private.json');
  await writeFile(target, '{}', { mode: 0o600 }); await symlink(target, join(directory, `${id}.json`));
  const complete = vi.fn(), restore = vi.fn(), pool = new WorkerPool({ complete }, 3000, { retentionDirectory: directory, restoreAgentWorkspace: restore, createAgentWorkspace: vi.fn() });
  await expect(pool.ready()).rejects.toBeTruthy();
  expect(await pool.run({ task: 'job', mode: 'agent', ownedPaths: ['file.txt'] }, signal(), { projectRoot: '/project' })).toMatchObject({ ok: false, code: 'unavailable' });
  expect(complete).not.toHaveBeenCalled(); expect(restore).not.toHaveBeenCalled();
  expect(await readFile(target, 'utf8')).toBe('{}');
  const corruptDirectory = await retentionRoot(); await writeFile(join(corruptDirectory, `${randomUUID()}.json`), '{broken', { mode: 0o600 });
  const corrupt = new WorkerPool({ complete }, 3000, { retentionDirectory: corruptDirectory, restoreAgentWorkspace: restore });
  await expect(corrupt.ready()).rejects.toBeTruthy(); expect(restore).not.toHaveBeenCalled();
});

it('refuses more than twenty durable artifacts instead of silently evicting retained work', async () => {
  const directory = await retentionRoot();
  for (let index = 0; index < 21; index++) await writeFile(join(directory, `${randomUUID()}.json`), '{}', { mode: 0o600 });
  const restore = vi.fn(), pool = new WorkerPool({ complete: vi.fn() }, 3000, { retentionDirectory: directory, restoreAgentWorkspace: restore });
  await expect(pool.ready()).rejects.toThrow(/bounds/); expect(restore).not.toHaveBeenCalled();
  expect(await readdir(directory)).toHaveLength(21);
});

it('does not overwrite ownership leases or silently evict retained agent work', async () => {
  const workspace = agentWorkspace(), hold = block();
  const complete = vi.fn(async () => { await hold.wait; return reply('kilo'); });
  const pool = new WorkerPool({ complete }, 3000, { createAgentWorkspace: async () => workspace });
  const scope = { projectRoot: '/project' }, input = { task: 'Implement', mode: 'agent', ownedPaths: ['src'] };
  const job = pool.run(input, signal(), scope);
  expect(await pool.run({ ...input, ownedPaths: ['src/file.ts'] }, signal(), scope)).toEqual({ ok: false, code: 'busy' });
  hold.release(); const result = await job;
  expect(await pool.run(input, signal(), scope)).toEqual({ ok: false, code: 'busy' });
  expect(await pool.discardArtifact(result.id!, scope)).toBe(true);
  expect((await pool.run(input, signal(), scope)).ok).toBe(true);
  await pool.close();
});
