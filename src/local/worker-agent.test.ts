import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { currentDiagnosticContext } from './diagnostics.js';
import { answeredBy, SourceError } from './source.js';
import type { Completion, ModelRequest, ToolCall } from './source.js';
import { MAX_AGENT_CONTEXT_BYTES, MAX_AGENT_OUTPUT_TOKENS, MAX_AGENT_TURNS, runWorkerAgent } from './worker-agent.js';
import type { WorkerAgentInput, WorkerAgentWorkspace, WorkerArtifact } from './worker-agent.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function completion(text = 'Done', calls?: ToolCall[], source = 'kilo'): Completion {
  const value = { text, outputTokens: 30, inputTokens: 2000, ...(calls ? { calls } : {}) };
  answeredBy.set(value, source);
  return value;
}
const call = (name: string, args: unknown, id = 'call_0'): ToolCall => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

async function fixture(initial = 'Initial source\n') {
  const root = await mkdtemp(join(tmpdir(), 'grunt-agent-test-')); directories.push(root);
  const project = join(root, 'original'), path = join(root, 'working');
  await mkdir(join(project, 'src'), { recursive: true }); await mkdir(join(path, 'src'), { recursive: true });
  await writeFile(join(project, 'src', 'file.txt'), initial); await writeFile(join(path, 'src', 'file.txt'), initial);
  const executeTool = vi.fn(async (name: string, args: unknown, signal: AbortSignal): Promise<unknown> => {
    signal.throwIfAborted();
    const input = args as { path: string; content?: string };
    if (input.path !== 'src/file.txt') return { ok: false, error: 'outside_ownership' };
    if (name === 'worker_read') return { ok: true, content: await readFile(join(path, input.path), 'utf8') };
    await writeFile(join(path, input.path), input.content!); return { ok: true };
  });
  const artifact = vi.fn(async (signal?: AbortSignal): Promise<WorkerArtifact> => {
    signal?.throwIfAborted(); const content = await readFile(join(path, 'src', 'file.txt'), 'utf8');
    return { id: 'workspace_1', complete: true, truncated: false, files: content === initial ? []
      : [{ path: 'src/file.txt', beforeSha256: hash(initial), afterSha256: hash(content), content }] };
  });
  const cleanup = vi.fn(async () => { await rm(path, { recursive: true, force: true }); });
  const tools: ModelRequest['tools'] = [
    { type: 'function', function: { name: 'worker_read', parameters: { type: 'object', required: ['path'], additionalProperties: false, properties: { path: { type: 'string' } } } } },
    { type: 'function', function: { name: 'worker_write', parameters: { type: 'object', required: ['path', 'content'], additionalProperties: false, properties: { path: { type: 'string' }, content: { type: 'string' } } } } }
  ];
  const workspace: WorkerAgentWorkspace = { id: 'workspace_1', path, tools, executeTool, artifact, cleanup,
    capabilities: { filesystem: true, commands: false, sandbox: 'filesystem' } };
  const createWorkspace = vi.fn(async () => workspace);
  const input: WorkerAgentInput = { id: 'worker_1', task: 'Update the assigned synthetic file', context: 'Approved reference', ownedPaths: ['src/file.txt'],
    projectRoot: project, signal: new AbortController().signal, createWorkspace };
  return { root, project, path, input, workspace, executeTool, artifact, cleanup, createWorkspace };
}

it('executes a real synthetic read/write loop, keeps the original untouched and returns a complete reviewable artifact', async () => {
  const f = await fixture(), requests: ModelRequest[] = [], ids: string[] = [];
  const complete = vi.fn(async (request: ModelRequest) => {
    requests.push(request); ids.push(currentDiagnosticContext()!.requestId);
    expect(request.model).toBe('grunt'); expect(request.worker!.id).toBe('worker_1'); expect(request.publicContext).toBeUndefined();
    expect(request.messages[1]!.content).not.toContain(f.project);
    request.worker!.onSource('kilo');
    if (requests.length === 1) return completion('', [call('worker_read', { path: 'src/file.txt' })]);
    if (requests.length === 2) {
      expect(JSON.parse(request.messages.at(-1)!.content)).toEqual({ ok: true, content: 'Initial source\n' });
      return completion('Apply the scoped edit', [call('worker_write', { path: 'src/file.txt', content: 'Implemented source\n' })]);
    }
    expect(request.messages.slice(-2).map(message => message.role)).toEqual(['assistant', 'tool']);
    expect(JSON.parse(request.messages.at(-1)!.content)).toEqual({ ok: true });
    return completion('Implemented and ready for parent review', undefined, 'zro');
  });
  const result = await runWorkerAgent({ complete }, f.input);
  expect(result).toMatchObject({ ok: true, source: 'zro', turns: 3, toolCalls: 2, artifact: { complete: true, truncated: false, files: [
    { path: 'src/file.txt', beforeSha256: hash('Initial source\n'), afterSha256: hash('Implemented source\n'), content: 'Implemented source\n' }
  ] } });
  expect(new Set(ids).size).toBe(3); expect(ids).not.toContain(f.input.id);
  expect(await readFile(join(f.project, 'src/file.txt'), 'utf8')).toBe('Initial source\n');
  expect(f.cleanup).not.toHaveBeenCalled();
});

it('marks review workspaces read-only through trusted factory options', async () => {
  const f = await fixture(); const complete = vi.fn(async () => completion('Review complete'));
  expect((await runWorkerAgent({ complete }, { ...f.input, readOnly: true })).ok).toBe(true);
  expect(f.createWorkspace).toHaveBeenCalledWith({ projectRoot: f.project, ownedPaths: ['src/file.txt'], readOnly: true }, f.input.signal);
});

it.each(['unknown_tool', 'duplicate_pending_id', 'invalid_arguments'] as const)('validates the whole tool turn before executing anything: %s', async kind => {
  const f = await fixture(); const first = call('worker_write', { path: 'src/file.txt', content: 'Unsafe partial write' });
  const second = kind === 'unknown_tool' ? call('fetch_account', {}, 'call_1')
    : kind === 'invalid_arguments' ? call('worker_read', { path: 'src/file.txt', credential: 'private' }, 'call_1')
      : call('worker_read', { path: 'src/file.txt' });
  const result = await runWorkerAgent({ complete: vi.fn(async () => completion('', [first, second])) }, f.input);
  expect(result).toMatchObject({ ok: false, code: 'unavailable', reason: 'invalid_completion', turns: 1, toolCalls: 0 });
  expect(f.executeTool).not.toHaveBeenCalled();
  expect(await readFile(join(f.path, 'src/file.txt'), 'utf8')).toBe('Initial source\n');
});

it('preserves partial work and a usable artifact when the free pool becomes quota limited', async () => {
  const f = await fixture(); const complete = vi.fn()
    .mockResolvedValueOnce(completion('', [call('worker_write', { path: 'src/file.txt', content: 'Partial progress' })]))
    .mockRejectedValueOnce(new SourceError('quota', 'private provider body', 60.2));
  const result = await runWorkerAgent({ complete }, f.input);
  expect(result).toMatchObject({ ok: false, code: 'quota', retryAfter: 61, turns: 2, artifact: { complete: true, files: [{ content: 'Partial progress' }] } });
  expect(f.cleanup).not.toHaveBeenCalled();
  expect(JSON.stringify({ ...result, workspace: undefined })).not.toContain('private provider body');
  expect(await readFile(join(f.project, 'src/file.txt'), 'utf8')).toBe('Initial source\n');
});

it('captures partial artifacts with a fresh bounded signal after a caller timeout', async () => {
  const f = await fixture(), controller = new AbortController(); let turns = 0;
  const complete = vi.fn(async (_request: ModelRequest, signal: AbortSignal) => {
    if (++turns === 1) return completion('', [call('worker_write', { path: 'src/file.txt', content: 'Preserved after timeout' })]);
    controller.abort('timeout'); signal.throwIfAborted(); return completion();
  });
  const result = await runWorkerAgent({ complete }, { ...f.input, signal: controller.signal });
  expect(result).toMatchObject({ ok: false, code: 'timeout', artifact: { complete: true, files: [{ content: 'Preserved after timeout' }] } });
  const artifactSignal = f.artifact.mock.calls[0]![0]!;
  expect(artifactSignal).not.toBe(controller.signal); expect(artifactSignal.aborted).toBe(false);
  expect(f.cleanup).not.toHaveBeenCalled();
});

it('requires trustworthy source attribution before any tool side effect', async () => {
  const f = await fixture();
  const complete = vi.fn(async () => ({ text: '', calls: [call('worker_write', { path: 'src/file.txt', content: 'unattributed' })] }));
  expect(await runWorkerAgent({ complete }, f.input)).toMatchObject({ ok: false, reason: 'invalid_completion' });
  expect(f.executeTool).not.toHaveBeenCalled();
});

it('bounds tool turns while retaining the complete workspace', async () => {
  const f = await fixture(); const complete = vi.fn(async () => completion('', [call('worker_read', { path: 'src/file.txt' })]));
  const result = await runWorkerAgent({ complete }, f.input);
  expect(result).toMatchObject({ ok: false, reason: 'turn_limit', turns: MAX_AGENT_TURNS, toolCalls: MAX_AGENT_TURNS, artifact: { complete: true } });
  expect(complete).toHaveBeenCalledTimes(MAX_AGENT_TURNS); expect(f.cleanup).not.toHaveBeenCalled();
});

it('stops over-budget model output before executing calls', async () => {
  const f = await fixture();
  const complete = vi.fn(async () => ({ ...completion('', [call('worker_write', { path: 'src/file.txt', content: 'must not run' })]), outputTokens: MAX_AGENT_OUTPUT_TOKENS + 1 }));
  // Reattach attribution because the spread creates a new completion identity.
  complete.mockImplementation(async () => { const value = { ...completion(), outputTokens: MAX_AGENT_OUTPUT_TOKENS + 1,
    calls: [call('worker_write', { path: 'src/file.txt', content: 'must not run' })] }; answeredBy.set(value, 'kilo'); return value; });
  expect(await runWorkerAgent({ complete }, f.input)).toMatchObject({ ok: false, reason: 'output_limit' });
  expect(f.executeTool).not.toHaveBeenCalled();
});

it('estimates missing or zero usage instead of bypassing the cumulative output budget', async () => {
  const f = await fixture();
  const complete = vi.fn(async () => {
    const value = { ...completion('x'.repeat(50000), [call('worker_read', { path: 'src/file.txt' })]), outputTokens: 0 };
    answeredBy.set(value, 'kilo'); return value;
  });
  expect(await runWorkerAgent({ complete }, f.input)).toMatchObject({ ok: false, reason: 'output_limit', turns: 2, toolCalls: 1 });
  expect(f.executeTool).toHaveBeenCalledTimes(1);
});

it('does not forward oversized tool responses or thrown private errors', async () => {
  const f = await fixture(); let turns = 0;
  f.executeTool.mockResolvedValueOnce({ ok: true, content: 'private-output'.repeat(10000) })
    .mockRejectedValueOnce(new Error('private credential path'));
  const complete = vi.fn(async (request: ModelRequest) => {
    if (++turns === 1) return completion('', [call('worker_read', { path: 'src/file.txt' })]);
    if (turns === 2) {
      expect(JSON.parse(request.messages.at(-1)!.content)).toEqual({ ok: false, error: 'tool_output_limit' });
      return completion('', [call('worker_read', { path: 'src/file.txt' })]);
    }
    expect(JSON.parse(request.messages.at(-1)!.content)).toEqual({ ok: false, error: 'tool_failed' });
    expect(JSON.stringify(request.messages)).not.toMatch(/private-output|private credential path/);
    return completion('Need parent review');
  });
  expect((await runWorkerAgent({ complete }, f.input)).ok).toBe(true);
});

it('compacts only completed tool groups and keeps the current workspace state', async () => {
  const f = await fixture(); let turns = 0; const sizes: number[] = [];
  f.executeTool.mockResolvedValue({ ok: true, content: 'x'.repeat(50000) });
  const complete = vi.fn(async (request: ModelRequest) => {
    sizes.push(Buffer.byteLength(JSON.stringify(request.messages)));
    const pending = new Set<string>();
    for (const message of request.messages) {
      if (message.tool_calls) for (const c of message.tool_calls) { expect(pending.has(c.id)).toBe(false); pending.add(c.id); }
      if (message.role === 'tool') expect(pending.delete(message.tool_call_id!)).toBe(true);
    }
    expect(pending.size).toBe(0);
    expect(request.messages[1]!.content).toContain(f.input.task);
    return ++turns < 8 ? completion('Completed safe inspection', [call('worker_read', { path: 'src/file.txt' })]) : completion('Inspection finished');
  });
  const result = await runWorkerAgent({ complete }, f.input);
  expect(result).toMatchObject({ ok: true, turns: 8 }); expect(Math.max(...sizes)).toBeLessThanOrEqual(MAX_AGENT_CONTEXT_BYTES);
  expect(f.cleanup).not.toHaveBeenCalled(); expect(await readdir(f.path)).toEqual(['src']);
});

it.each(['outside_ownership', 'incorrect_hash', 'truncated'] as const)('retains but refuses unsafe or incomplete artifacts: %s', async mode => {
  const f = await fixture(); const content = 'proposed';
  f.artifact.mockResolvedValue({ id: 'workspace_1', complete: mode !== 'truncated', truncated: mode === 'truncated', files: [
    { path: mode === 'outside_ownership' ? '../elsewhere' : 'src/file.txt', beforeSha256: hash('Initial source\n'),
      afterSha256: mode === 'incorrect_hash' ? hash('different') : hash(content), content }
  ] });
  const result = await runWorkerAgent({ complete: vi.fn(async () => completion('Done')) }, f.input);
  expect(result).toMatchObject({ ok: false, code: 'unavailable', reason: 'workspace_failed', artifact: { complete: false, truncated: true } });
  expect(f.cleanup).not.toHaveBeenCalled();
});

it('reports sandbox unavailability without leaking host paths or invoking inference', async () => {
  const f = await fixture(), complete = vi.fn();
  f.createWorkspace.mockRejectedValue(Object.assign(new Error('/private/host'), { code: 'unsupported_sandbox' }));
  const result = await runWorkerAgent({ complete }, f.input);
  expect(result).toMatchObject({ ok: false, code: 'unavailable', reason: 'unsupported_sandbox' });
  expect(JSON.stringify(result)).not.toContain('/private/host'); expect(complete).not.toHaveBeenCalled();
});

it('does not let progress or source observers break execution', async () => {
  const f = await fixture();
  const complete = vi.fn(async (request: ModelRequest) => {
    request.worker!.onWait?.(); request.worker!.onSource('kilo'); return completion('Done');
  });
  const throws = () => { throw new Error('observer failed'); };
  expect((await runWorkerAgent({ complete }, { ...f.input, onSource: throws, onWait: throws, onProgress: throws })).ok).toBe(true);
});
