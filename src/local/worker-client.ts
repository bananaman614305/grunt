import { randomUUID } from 'node:crypto';
import { addAbortSignal } from 'node:stream';
import type { Readable, Writable } from 'node:stream';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { gruntEnv } from '../brand.js';
import { installedPort } from './dashboard.js';
import { MAX_WORKER_ACTIVE, MAX_WORKER_CONTEXT_BYTES, MAX_WORKER_QUEUED, MAX_WORKER_RECENT, MAX_WORKER_TASK_BYTES, parseWorkerTask, workerActivities } from './worker-pool.js';
import type { WorkerFailureCode, WorkerResult, WorkerSnapshot, WorkerStatus, WorkerTask } from './worker-pool.js';

const usage = 'Usage: usegrunt workers <run | status | mcp> [--port <1-65535>]';
const taskUsage = 'Provide one or two tasks, for example {"tasks":[{"task":"Review the supplied code","context":"..."}]}.';
const runUsage = `Pass the batch as JSON on stdin. ${taskUsage}`;
// JSON escapes use at most six wire bytes for every byte of decoded input.
const maxRequestBytes = MAX_WORKER_ACTIVE * (MAX_WORKER_TASK_BYTES + MAX_WORKER_CONTEXT_BYTES) * 6 + 1024;
const maxResponseBytes = 512 * 1024;
const maxBatches = 8;
const batchLifetimeMs = 10 * 60 * 1000;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const providerId = /^[a-z][a-z0-9-]{0,63}$/;
const failureCodes = new Set<string>(['invalid_task', 'busy', 'cancelled', 'timeout', 'quota', 'unavailable'] satisfies WorkerFailureCode[]);
const workerStates = new Set<string>(['queued', 'running', 'completed', 'failed', 'cancelled'] satisfies WorkerStatus['state'][]);
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const timestamp = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const isFailureCode = (value: unknown): value is WorkerFailureCode => typeof value === 'string' && failureCodes.has(value);

function parseTasks(input: unknown) {
  const envelope = record(input), { tasks } = envelope;
  if (Object.keys(envelope).length !== 1 || !Array.isArray(tasks) || !tasks.length || tasks.length > MAX_WORKER_ACTIVE) throw new Error(taskUsage);
  return tasks.map((task: unknown) => {
    const parsed = parseWorkerTask(task);
    if (!parsed) throw new Error('Each worker needs a nonempty task of at most 8 KiB and optional context of at most 32 KiB.');
    return parsed;
  });
}

function parseResult(input: unknown): WorkerResult {
  const { ok, id, source, text, code, retryAfter } = record(input);
  const workerId = typeof id === 'string' && uuid.test(id) ? id : undefined;
  if (ok === true && workerId && typeof source === 'string' && providerId.test(source) && typeof text === 'string') return { ok, id: workerId, source, text };
  if (ok === false && isFailureCode(code)) {
    return { ok, code, ...(workerId ? { id: workerId } : {}), ...(timestamp(retryAfter) ? { retryAfter } : {}) };
  }
  throw new Error('Invalid Grunt worker response');
}

function parseWorkerStatus(input: unknown): WorkerStatus {
  const { id, state, createdAt, startedAt, finishedAt, source, code, activity } = record(input);
  if (typeof id !== 'string' || !uuid.test(id) || typeof state !== 'string' || !workerStates.has(state) || !timestamp(createdAt)) throw new Error('Invalid Grunt worker status');
  const workerActivity = workerActivities.find(value => value === activity);
  return { id, state: state as WorkerStatus['state'], createdAt, ...(timestamp(startedAt) ? { startedAt } : {}),
    ...(timestamp(finishedAt) ? { finishedAt } : {}), ...(typeof source === 'string' && providerId.test(source) ? { source } : {}),
    ...(isFailureCode(code) ? { code } : {}), ...(workerActivity ? { activity: workerActivity } : {}) };
}

function parseSnapshot(input: unknown): WorkerSnapshot {
  const { active, queued, recent } = record(input);
  const parseList = (list: unknown, limit: number) => {
    if (!Array.isArray(list) || list.length > limit) throw new Error('Invalid Grunt worker status');
    return list.map(parseWorkerStatus);
  };
  return { active: parseList(active, MAX_WORKER_ACTIVE), queued: parseList(queued, MAX_WORKER_QUEUED), recent: parseList(recent, MAX_WORKER_RECENT) };
}

async function daemonJson(port: number, run: WorkerTask | undefined, signal: AbortSignal, fetcher: typeof fetch) {
  const response = await fetcher(`http://127.0.0.1:${port}/v1/workers${run ? '/run' : ''}`, {
    redirect: 'error', signal, ...(run ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(run) } : {})
  });
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty Grunt worker response');
  let size = 0;
  const chunks: Buffer[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return { ok: response.ok, body: JSON.parse(Buffer.concat(chunks, size).toString('utf8')) as unknown };
      size += value.byteLength;
      if (size > maxResponseBytes) throw new Error('Grunt worker response too large');
      chunks.push(Buffer.from(value));
    }
  } finally {
    // On a size or network error there may still be a live response socket.
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function dispatchTasks(port: number, tasks: WorkerTask[], signal: AbortSignal, fetcher: typeof fetch) {
  return { results: await Promise.all(tasks.map(async (task): Promise<WorkerResult> => {
    if (signal.aborted) return { ok: false, code: 'cancelled' };
    const deadline = AbortSignal.timeout(330000);
    try {
      const { ok, body } = await daemonJson(port, task, AbortSignal.any([signal, deadline]), fetcher);
      const result = parseResult(body);
      return !ok && result.ok ? { ok: false, code: 'unavailable' } : result;
    } catch {
      return { ok: false, code: signal.aborted ? 'cancelled' : deadline.aborted ? 'timeout' : 'unavailable' };
    }
  })) };
}

export async function delegateWorkers(port: number, input: unknown, signal: AbortSignal, fetcher = fetch) {
  return dispatchTasks(port, parseTasks(input), signal, fetcher);
}

interface WorkerBatch {
  controller: AbortController;
  expiry: NodeJS.Timeout;
  results?: WorkerResult[];
}

function parseBatchId(input: unknown) {
  const args = record(input), { batchId } = args;
  if (Object.keys(args).length !== 1 || typeof batchId !== 'string' || !uuid.test(batchId)) throw new Error('Provide the batchId returned by grunt_delegate.');
  return batchId;
}

export class WorkerBatches {
  private batches = new Map<string, WorkerBatch>();

  constructor(private port: number, private fetcher = fetch) {}

  start(input: unknown) {
    const tasks = parseTasks(input);
    if (this.batches.size >= maxBatches) {
      const oldestCompleted = [...this.batches].find(([, batch]) => batch.results);
      if (!oldestCompleted) throw new Error('Too many active Grunt batches. Wait for a batch to finish or cancel one before dispatching more work.');
      this.remove(oldestCompleted[0]);
    }
    const batchId = randomUUID();
    const batch: WorkerBatch = { controller: new AbortController(), expiry: setTimeout(() => this.remove(batchId), batchLifetimeMs).unref() };
    this.batches.set(batchId, batch);
    void dispatchTasks(this.port, tasks, batch.controller.signal, this.fetcher).then(({ results }) => {
      if (!batch.controller.signal.aborted) batch.results = results;
    });
    return { batchId, state: 'running' as const };
  }

  result(input: unknown) {
    const batchId = parseBatchId(input);
    const batch = this.batches.get(batchId);
    if (!batch) throw new Error('This Grunt batch is no longer available in this session.');
    return batch.results ? { batchId, state: 'completed' as const, results: batch.results } : { batchId, state: 'running' as const };
  }

  cancel(input: unknown) {
    const batchId = parseBatchId(input);
    if (!this.remove(batchId)) throw new Error('This Grunt batch is no longer available in this session.');
    return { batchId, state: 'cancelled' as const };
  }

  close() {
    for (const batchId of this.batches.keys()) this.remove(batchId);
  }

  private remove(batchId: string) {
    const batch = this.batches.get(batchId);
    if (!batch) return false;
    this.batches.delete(batchId);
    clearTimeout(batch.expiry);
    if (!batch.results) batch.controller.abort();
    return true;
  }
}

export async function readWorkerStatus(port: number, signal: AbortSignal, fetcher = fetch) {
  try {
    const { ok, body } = await daemonJson(port, undefined, AbortSignal.any([signal, AbortSignal.timeout(3000)]), fetcher);
    if (ok) return parseSnapshot(body);
  } catch { /* Report a stable, useful error without copying daemon output. */ }
  throw new Error(`Grunt worker status is unavailable on 127.0.0.1:${port}. Start or update the Grunt daemon and try again.`);
}

export const gruntDelegateTool = {
  name: 'grunt_delegate', description: 'Start one or two independent Grunt subworker tasks. Keep working after this tool returns the batch ID, then check it with grunt_worker_result. Task and context text are sent to configured free model providers. Supply only approved excerpts. Workers can suggest edits for you to review and apply.',
  inputSchema: { type: 'object', required: ['tasks'], additionalProperties: false,
    properties: { tasks: { type: 'array', minItems: 1, maxItems: MAX_WORKER_ACTIVE, items: {
      type: 'object', required: ['task'], additionalProperties: false, properties: {
        task: { type: 'string', minLength: 1, maxLength: MAX_WORKER_TASK_BYTES },
        context: { type: 'string', maxLength: MAX_WORKER_CONTEXT_BYTES },
        activity: { type: 'string', enum: [...workerActivities], description: 'Optional activity label displayed in worker status.' }
      }
    } } } },
  annotations: { title: 'Delegate work to Grunt', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
} satisfies Tool;
const batchInputSchema = { type: 'object' as const, required: ['batchId'], additionalProperties: false,
  properties: { batchId: { type: 'string', pattern: uuid.source } } };
export const gruntWorkerResultTool = {
  name: 'grunt_worker_result', description: 'Check a Grunt batch from this session without waiting. Returns worker results once all tasks have finished.',
  inputSchema: batchInputSchema, annotations: { title: 'Get Grunt worker results', readOnlyHint: true, openWorldHint: false }
} satisfies Tool;
export const gruntWorkerCancelTool = {
  name: 'grunt_worker_cancel', description: 'Cancel a Grunt batch from this session and discard its results.',
  inputSchema: batchInputSchema, annotations: { title: 'Cancel a Grunt batch', readOnlyHint: false, destructiveHint: true, openWorldHint: false }
} satisfies Tool;
export const gruntWorkerStatusTool = {
  name: 'grunt_worker_status', description: 'Get status and provider metadata for local Grunt workers.',
  inputSchema: { type: 'object', additionalProperties: false }, annotations: { title: 'Grunt worker status', readOnlyHint: true, openWorldHint: false }
} satisfies Tool;

export function createWorkerMcpServer(port: number, fetcher = fetch) {
  const batches = new WorkerBatches(port, fetcher);
  const server = new Server({ name: 'grunt-workers', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.onclose = () => batches.close();
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [gruntDelegateTool, gruntWorkerResultTool, gruntWorkerCancelTool, gruntWorkerStatusTool] }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }, { signal }) => {
    try {
      signal.throwIfAborted();
      const args = params.arguments ?? {};
      let payload: WorkerSnapshot | ReturnType<WorkerBatches['result']> | ReturnType<WorkerBatches['cancel']>;
      if (params.name === gruntDelegateTool.name) payload = batches.start(args);
      else if (params.name === gruntWorkerResultTool.name) payload = batches.result(args);
      else if (params.name === gruntWorkerCancelTool.name) payload = batches.cancel(args);
      else if (params.name === gruntWorkerStatusTool.name && !Object.keys(args).length) payload = await readWorkerStatus(port, signal, fetcher);
      else throw new Error('Unknown Grunt worker tool or invalid arguments.');
      return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: { ...payload } };
    } catch (error) {
      return { content: [{ type: 'text', text: error instanceof Error ? error.message : 'Grunt worker request failed' }], isError: true };
    }
  });
  return server;
}

async function serveWorkers(port: number, input: Readable, output: Writable, signal: AbortSignal, fetcher: typeof fetch) {
  const server = createWorkerMcpServer(port, fetcher);
  const transport = new StdioServerTransport(input, output, { maxBufferSize: maxRequestBytes + 4096 });
  let closed!: () => void;
  const done = new Promise<void>(resolve => { closed = resolve; });
  const onClose = server.onclose;
  server.onclose = () => { onClose?.(); closed(); };
  const close = () => { void server.close().catch(closed); };
  try {
    input.once('end', close);
    input.once('close', close);
    input.once('error', close);
    output.once('error', close);
    signal.addEventListener('abort', close, { once: true });
    await server.connect(transport);
    if (input.readableEnded || input.destroyed || signal.aborted) close();
    await done;
  } finally {
    input.off('end', close);
    input.off('close', close);
    input.off('error', close);
    output.off('error', close);
    signal.removeEventListener('abort', close);
  }
}

interface WorkerCommandOptions {
  env?: NodeJS.ProcessEnv;
  input?: Readable & { isTTY?: boolean };
  output?: Writable;
  signal?: AbortSignal;
  fetcher?: typeof fetch;
}

export async function resolveWorkerPort(args: string[], env = process.env): Promise<number> {
  const [flag, override] = args;
  if (args.length && (args.length !== 2 || flag !== '--port')) throw new Error(usage);
  const portText = override ?? gruntEnv('PORT', env) ?? String(await installedPort(env));
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || port < 1 || port > 65535) throw new Error('Invalid Grunt port; use --port <1-65535>');
  return port;
}

export async function workerCommand(args: string[], options: WorkerCommandOptions = {}): Promise<void> {
  const [command, ...flags] = args;
  if (!['run', 'status', 'mcp'].includes(command ?? '')) throw new Error(usage);
  const { env = process.env, input = process.stdin, output = process.stdout, fetcher = fetch } = options;
  const port = await resolveWorkerPort(flags, env);
  const controller = new AbortController(), signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  const interrupt = () => { controller.abort(); process.exitCode = 130; };
  const terminate = () => { controller.abort(); process.exitCode = 143; };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', terminate);
  try {
    if (command === 'mcp') return await serveWorkers(port, input, output, signal, fetcher);
    if (command === 'status') {
      output.write(JSON.stringify(await readWorkerStatus(port, signal, fetcher), null, 2) + '\n');
      return;
    }
    if (input.isTTY) throw new Error(runUsage);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of addAbortSignal(signal, input)) {
      const bytes = Buffer.from(chunk as Uint8Array);
      size += bytes.length;
      if (size > maxRequestBytes) throw new Error('Worker task input is too large.');
      chunks.push(bytes);
    }
    let body: unknown;
    try { body = JSON.parse(Buffer.concat(chunks, size).toString('utf8')); }
    catch { throw new Error(runUsage); }
    output.write(JSON.stringify(await delegateWorkers(port, body, signal, fetcher), null, 2) + '\n');
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  }
}
