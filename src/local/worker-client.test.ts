import { PassThrough, Readable } from 'node:stream';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expect, it, vi } from 'vitest';
import { createWorkerMcpServer, delegateWorkers, resolveWorkerPort, WorkerBatches, workerCommand } from './worker-client.js';

const workerId = 'd4f905d0-6f47-43f5-94e7-e678eb1172d4';
const success = { ok: true, id: workerId, source: 'kilo', text: 'Checked.' };
const signal = () => new AbortController().signal;

it('runs both CLI tasks concurrently with stable output order and loopback-only requests', async () => {
  const pending: ((response: Response) => void)[] = [];
  const fetcher = vi.fn<typeof fetch>(() => new Promise(resolve => pending.push(resolve)));
  const tasks = [{ task: 'Review caching', context: 'Relevant excerpt', activity: 'review' }, { task: 'Draft tests' }];
  const output = new PassThrough();
  let stdout = '';
  output.on('data', chunk => { stdout += String(chunk); });
  const run = workerCommand(['run', '--port', '8792'], { input: Readable.from([JSON.stringify({ tasks })]), output, fetcher });
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  for (let index = 0; index < tasks.length; index++) {
    expect(fetcher).toHaveBeenNthCalledWith(index + 1, 'http://127.0.0.1:8792/v1/workers/run', expect.objectContaining({
      method: 'POST', redirect: 'error', body: JSON.stringify(tasks[index])
    }));
  }
  const limited = { ok: false, code: 'quota', retryAfter: 42 };
  pending[1]!(Response.json(limited, { status: 429 }));
  pending[0]!(Response.json(success));
  await run;
  expect(JSON.parse(stdout)).toEqual({ results: [success, limited] });
});

it('validates the full batch before submitting any task', async () => {
  const fetcher = vi.fn<typeof fetch>();
  await expect(delegateWorkers(8788, { tasks: [{ task: 'Review' }, { task: 'é'.repeat(4097) }] }, signal(), fetcher)).rejects.toThrow('8 KiB');
  await expect(delegateWorkers(8788, { tasks: [{ task: 'Review', cwd: '/private' }] }, signal(), fetcher)).rejects.toThrow('8 KiB');
  await expect(delegateWorkers(8788, { tasks: Array(3).fill({ task: 'Review' }) }, signal(), fetcher)).rejects.toThrow('one or two');
  expect(fetcher).not.toHaveBeenCalled();
});

it('uses the secured setup port unless the caller selects a local port', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'grunt-worker-client-'));
  const env = { GRUNT_CONFIG_DIR: dir };
  try {
    await writeFile(join(dir, 'installed-port.json'), '8792', { mode: 0o600 });
    await expect(resolveWorkerPort([], env)).resolves.toBe(8792);
    await expect(resolveWorkerPort([], { ...env, GRUNT_PORT: '8793' })).resolves.toBe(8793);
    await expect(resolveWorkerPort(['--port', '8794'], { ...env, GRUNT_PORT: '8793' })).resolves.toBe(8794);
    await expect(resolveWorkerPort(['--port', 'https://example.com'], env)).rejects.toThrow('Invalid Grunt port');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it('returns an MCP batch ID before work is complete and exposes metadata-only status', async () => {
  const active = [{ id: workerId, state: 'running', createdAt: 42, source: 'kilo', activity: 'review' }];
  const pending: ((response: Response) => void)[] = [];
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => init?.method === 'POST' ? new Promise(resolve => pending.push(resolve)) :
    Response.json({ active: [{ ...active[0], task: 'private', context: 'private' }], queued: [], recent: [], private: 'private' }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createWorkerMcpServer(8788, fetcher), client = new Client({ name: 'test', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['grunt_delegate', 'grunt_worker_result', 'grunt_worker_cancel', 'grunt_worker_status']);
    const result = await client.callTool({ name: 'grunt_delegate', arguments: { tasks: [{ task: 'Review tools' }, { task: 'Draft tests' }] } });
    const batchId = result.structuredContent?.batchId;
    expect(result.structuredContent).toEqual({ batchId: expect.any(String), state: 'running' });
    expect(pending).toHaveLength(2);
    const read = () => client.callTool({ name: 'grunt_worker_result', arguments: { batchId } });
    expect((await read()).structuredContent).toEqual({ batchId, state: 'running' });
    const status = await client.callTool({ name: 'grunt_worker_status' });
    expect(status.structuredContent).toEqual({ active, queued: [], recent: [] });
    const limited = { ok: false, code: 'quota' };
    pending[1]!(Response.json(limited, { status: 429 }));
    pending[0]!(Response.json(success));
    await vi.waitFor(async () => expect((await read()).structuredContent).toEqual({ batchId, state: 'completed', results: [success, limited] }));
  } finally { await client.close(); }
});

it('cancels both active calls when the MCP client cancels the batch', async () => {
  const aborted: AbortSignal[] = [];
  const fetcher = vi.fn<typeof fetch>((_url, init) => new Promise((_resolve, reject) => {
    const fetchSignal = init!.signal!;
    fetchSignal.addEventListener('abort', () => {
      aborted.push(fetchSignal);
      reject(fetchSignal.reason);
    }, { once: true });
  }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createWorkerMcpServer(8788, fetcher), client = new Client({ name: 'test', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({ name: 'grunt_delegate', arguments: { tasks: [{ task: 'One' }, { task: 'Two' }] } });
    const batchId = result.structuredContent?.batchId;
    expect(fetcher).toHaveBeenCalledTimes(2);
    const cancelled = await client.callTool({ name: 'grunt_worker_cancel', arguments: { batchId } });
    expect(cancelled.structuredContent).toEqual({ batchId, state: 'cancelled' });
    expect(aborted).toHaveLength(2);
    expect((await client.callTool({ name: 'grunt_worker_result', arguments: { batchId } })).isError).toEqual(true);
  } finally { await client.close(); }
});

it('bounds batches, scopes IDs to the session, and expires retained work automatically', async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn<typeof fetch>(async () => Response.json(success));
  const batches = new WorkerBatches(8788, fetcher), anotherSession = new WorkerBatches(8788, fetcher);
  try {
    const input = { tasks: [{ task: 'One' }] };
    const jobs = Array.from({ length: 8 }, () => batches.start(input));
    const first = { batchId: jobs[0]!.batchId };
    expect(() => batches.start(input)).toThrow('Too many active Grunt batches');
    expect(() => anotherSession.result(first)).toThrow('this session');
    await vi.advanceTimersByTimeAsync(1000);
    expect(batches.result(first)).toEqual({ ...first, state: 'completed', results: [success] });
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(() => batches.result(first)).toThrow('no longer available');
    expect(batches.start(input).state).toEqual('running');
  } finally {
    batches.close();
    anotherSession.close();
    vi.useRealTimers();
  }
});

it('cancels an in-flight daemon call when the harness closes its stdio pipe', async () => {
  const input = new PassThrough(), output = new PassThrough();
  const fetcher = vi.fn<typeof fetch>((_url, init) => new Promise((_resolve, reject) => {
    const fetchSignal = init!.signal!;
    fetchSignal.addEventListener('abort', () => reject(fetchSignal.reason), { once: true });
  }));
  let stdout = '';
  output.on('data', chunk => { stdout += String(chunk); });
  const server = workerCommand(['mcp', '--port', '8792'], { input, output, fetcher });
  const write = (message: object) => input.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  write({ id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } } });
  await vi.waitFor(() => expect(stdout).toContain('grunt-workers'));
  write({ method: 'notifications/initialized' });
  write({ id: 2, method: 'tools/call', params: { name: 'grunt_delegate', arguments: { tasks: [{ task: 'Review' }] } } });
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  input.end();
  await server;
  expect(fetcher.mock.calls[0]![1]!.signal?.aborted).toBe(true);
});

it('requires an explicit trusted project for agent MCP and recovery commands', async () => {
  const fetcher = vi.fn<typeof fetch>();
  for (const args of [['mcp', '--agentic'], ['mcp', '--project', '/tmp/example'], ['apply', workerId], ['artifact', workerId, '--project', 'relative'], ['retained', '--project', '/tmp/example', '--unknown']]) {
    await expect(workerCommand(args, { fetcher })).rejects.toThrow('Usage');
  }
  expect(fetcher).not.toHaveBeenCalled();
});

it('keeps the tool-using worker absent from unscoped MCP and exposes it only for explicit scope', async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createWorkerMcpServer(8788, vi.fn<typeof fetch>(), { projectRoot: '/tmp/synthetic-project' });
  const client = new Client({ name: 'test', version: '1.0.0' });
  await server.connect(serverTransport); await client.connect(clientTransport);
  try { expect((await client.listTools()).tools.map(tool => tool.name)).toContain('grunt_spawn'); }
  finally { await client.close(); }
});

it('does not let the legacy proposal tool opt into agent mode', async () => {
  const fetcher = vi.fn<typeof fetch>();
  await expect(delegateWorkers(8788, { tasks: [{ task: 'Edit', mode: 'agent', ownedPaths: ['src'] }] }, signal(), fetcher)).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});
