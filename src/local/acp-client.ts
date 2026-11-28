import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { recordTransport } from './diagnostics.js';
import { SourceError } from './source.js';

export type AcpJson = Record<string, unknown>;

export interface AcpClient {
  request(method: string, params: AcpJson): Promise<unknown>;
  readonly notifications: AcpJson[];
  close(): Promise<void>;
}

export interface AcpClientOptions {
  source: string;
  label?: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  maxOutputBytes?: number;
  timeoutMs?: number;
  forbidToolCalls?: boolean;
  onNotify?(notification: AcpJson): void;
  spawnChild?: () => ChildProcess;
}

function killGroup(child: ChildProcess) {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') child.kill('SIGKILL');
    else process.kill(-child.pid, 'SIGKILL');
  } catch { /* Only our owned process group. */ }
}

/** Shared newline-delimited JSON-RPC 2.0 ACP client over stdio. Never exposes stderr or raw protocol text. */
export async function openAcpClient(program: string, args: string[], options: AcpClientOptions): Promise<AcpClient> {
  options.signal.throwIfAborted();
  const label = options.label ?? options.source;
  const started = performance.now();
  const child = options.spawnChild
    ? options.spawnChild()
    : spawn(program, args, { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  const notifications: AcpJson[] = [];
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void }>();
  const decoder = new StringDecoder('utf8');
  const limit = options.maxOutputBytes ?? 2 * 1024 * 1024;
  const timeout = Math.min(options.timeoutMs ?? 175000, 600000);
  const forbidTools = options.forbidToolCalls !== false;
  let nextId = 1, bytes = 0, partial = '', closed = false, expectedClose = false, failure: unknown;
  let exit!: () => void;
  const exited = new Promise<void>(resolveExit => { exit = resolveExit; });

  const fail = (error: unknown) => {
    failure ??= error;
    for (const operation of pending.values()) operation.reject(error);
    pending.clear();
    killGroup(child);
  };
  const abort = () => fail(options.signal.reason);
  const timer = setTimeout(() => fail(new SourceError('timeout', `${label} ACP timed out`)), timeout);
  const send = (value: unknown) => {
    if (closed || !child.stdin || child.stdin.destroyed) throw new SourceError('upstream', `${label} ACP is closed`);
    child.stdin.write(JSON.stringify(value) + '\n');
  };
  const receive = (line: string) => {
    if (!line.trim()) return;
    let value: AcpJson;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid frame');
      value = parsed as AcpJson;
    } catch { throw new SourceError('upstream', `${label} returned an invalid ACP message`); }
    if (value.jsonrpc !== '2.0') throw new SourceError('upstream', `${label} returned an invalid ACP version`);
    if (typeof value.method === 'string') {
      if (value.id !== undefined) {
        // Deny before executing anything. This client exposes no filesystem, terminals or permissions.
        if (value.method === 'session/request_permission') send({ jsonrpc: '2.0', id: value.id, result: { outcome: { outcome: 'cancelled' } } });
        else send({ jsonrpc: '2.0', id: value.id, error: { code: -32601, message: 'No client tools are available' } });
        if (forbidTools) throw new SourceError('refused', `${label} requested an unexpected native action`);
        return;
      }
      if (value.method !== 'session/update') throw new SourceError('refused', `${label} returned an unexpected ACP notification`);
      const update = (value.params as { update?: { sessionUpdate?: unknown } } | undefined)?.update;
      if (forbidTools && (update?.sessionUpdate === 'tool_call' || update?.sessionUpdate === 'tool_call_update')) {
        throw new SourceError('refused', `${label} attempted an unexpected native action`);
      }
      options.onNotify?.(value);
      notifications.push(value);
      return;
    }
    if (!Number.isSafeInteger(value.id) || !pending.has(value.id as number)) {
      throw new SourceError('upstream', `${label} returned an uncorrelated ACP reply`);
    }
    const operation = pending.get(value.id as number)!;
    pending.delete(value.id as number);
    if (value.error) {
      const error = value.error as { code?: unknown; message?: unknown };
      const text = typeof error.message === 'string' ? error.message : '';
      const code = /quota|usage.?limit|rate.?limit|allowance/i.test(text) ? 'quota'
        : error.code === -32000 || /auth|sign.?in|logged.?out/i.test(text) ? 'logged_out'
          : /plan|required.*(?:starter|pro)|forbidden|refus|denied/i.test(text) ? 'refused' : 'upstream';
      operation.reject(new SourceError(code, `${label} ACP did not complete the request`));
      return;
    }
    if (!Object.hasOwn(value, 'result')) throw new SourceError('upstream', `${label} ACP returned no result`);
    operation.resolve(value.result);
  };

  options.signal.addEventListener('abort', abort, { once: true });
  child.stdin?.on('error', () => {});
  child.stdout?.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > limit) { fail(new SourceError('upstream', `${label} output exceeded the supported size`)); return; }
    partial += decoder.write(chunk);
    let newline: number;
    try {
      while ((newline = partial.indexOf('\n')) !== -1) {
        const line = partial.slice(0, newline);
        partial = partial.slice(newline + 1);
        receive(line);
      }
    } catch (error) { fail(error); }
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    // Count but never retain native diagnostics, which can contain pairing URLs or tokens.
    bytes += chunk.length;
    if (bytes > limit) fail(new SourceError('upstream', `${label} output exceeded the supported size`));
  });
  child.once('error', () => fail(new SourceError('not_installed', `${label} CLI could not start; rerun usegrunt setup`)));
  child.once('close', code => {
    recordTransport({
      source: options.source,
      transport: 'cli',
      endpointLabel: 'cli',
      durationMs: Math.max(0, performance.now() - started),
      ...(options.signal.aborted ? { outcome: 'cancelled' as const } : failure || !expectedClose ? { outcome: 'failed' as const } : code === 0 ? { outcome: 'passed' as const } : {}),
      ...(Number.isInteger(code) ? { exitCode: code! } : {})
    });
    closed = true;
    clearTimeout(timer);
    options.signal.removeEventListener('abort', abort);
    fail(failure ?? new SourceError('upstream', `${label} ACP closed before completing the request`));
    exit();
  });
  if (options.signal.aborted) abort();

  return {
    notifications,
    request: async (method, params) => {
      options.signal.throwIfAborted();
      if (failure) throw failure;
      if (closed) throw new SourceError('upstream', `${label} ACP is closed`);
      return await new Promise((resolveResult, reject) => {
        const id = nextId++;
        pending.set(id, { resolve: resolveResult, reject });
        try { send({ jsonrpc: '2.0', id, method, params }); }
        catch (error) { pending.delete(id); reject(error); }
      });
    },
    close: async () => {
      if (!closed) {
        expectedClose = true;
        child.stdin?.end();
        killGroup(child);
      }
      await exited;
    }
  };
}
