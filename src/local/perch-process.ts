import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { SourceError } from './source.js';

type Json = Record<string, unknown>;
export interface PerchProcessOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  maxOutputBytes?: number;
  timeoutMs?: number;
  onLine?(line: string, stream: 'stdout' | 'stderr'): void;
}
export interface PerchCommandResult { stdout: string; code: number | null }
export interface PerchACP {
  request(method: string, params: Json): Promise<unknown>;
  readonly notifications: Json[];
  close(): Promise<void>;
}
export interface PerchACPOptions extends PerchProcessOptions { onNotify?(notification: Json): void }
export interface PerchProcesses {
  command: typeof runPerchCommand;
  acp: typeof openPerchACP;
  memory?: typeof runPerchMemorySettings;
}
function kill(child: ReturnType<typeof spawn>) {
  if (!child.pid) return;
  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Only our owned process group. */ }
}
function unsupported() {
  if (!['linux', 'darwin'].includes(process.platform)) throw new SourceError('not_installed', 'Perch requires the vetted Linux or macOS CLI');
}

/** program and args are executed exactly as supplied, without a shell. Login may use 600s; inference uses 175s. */
export async function runPerchCommand(program: string, args: string[], options: PerchProcessOptions): Promise<PerchCommandResult> {
  unsupported(); options.signal.throwIfAborted();
  return await new Promise((resolveResult, reject) => {
    const child = spawn(program, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let stdout = '', bytes = 0, failure: unknown;
    const decoder = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') }, partial = { stdout: '', stderr: '' };
    const fail = (error: unknown) => { failure ??= error; kill(child); };
    const abort = () => fail(options.signal.reason);
    const timer = setTimeout(() => fail(new SourceError('timeout', 'Perch command timed out')), Math.min(options.timeoutMs ?? 175000, 600000));
    const consume = (chunk: Buffer, stream: 'stdout' | 'stderr') => {
      bytes += chunk.length;
      if (bytes > (options.maxOutputBytes ?? 65536)) { fail(new SourceError('upstream', 'Perch output exceeded the supported size')); return; }
      const text = decoder[stream].write(chunk);
      if (stream === 'stdout') stdout += text;
      if (!options.onLine) return;
      partial[stream] += text;
      let newline: number;
      while ((newline = partial[stream].indexOf('\n')) !== -1) {
        const line = partial[stream].slice(0, newline).replace(/\r$/, ''); partial[stream] = partial[stream].slice(newline + 1);
        try { options.onLine(line, stream); } catch (error) { fail(error); return; }
      }
    };
    options.signal.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', chunk => consume(chunk as Buffer, 'stdout'));
    child.stderr.on('data', chunk => consume(chunk as Buffer, 'stderr'));
    child.once('error', () => fail(new SourceError('not_installed', 'Perch CLI could not start; rerun usegrunt setup')));
    child.once('close', code => {
      clearTimeout(timer); options.signal.removeEventListener('abort', abort); kill(child);
      if (!failure && !options.signal.aborted && options.onLine) {
        for (const stream of ['stdout', 'stderr'] as const) {
          const last = partial[stream] + decoder[stream].end();
          try { if (last.trim()) options.onLine(last, stream); } catch (error) { failure = error; }
        }
      }
      if (options.signal.aborted) reject(options.signal.reason);
      else if (failure) reject(failure);
      else resolveResult({ stdout, code });
    });
    if (options.signal.aborted) abort();
  });
}

/** Supported native plain-terminal settings; fixed slashcommands never invoke a model. */
export async function runPerchMemorySettings(binary: string, options: PerchProcessOptions, configure = false): Promise<{ email: string }> {
  unsupported(); options.signal.throwIfAborted();
  const native = [process.execPath, binary, '--no-local-tools', '--mode', 'ask', '--permission', 'plan', '--cwd', options.cwd];
  // Linux script invokes a shell. Every argument is fixed or an owned path, and
  // receives POSIX quoting; caller prompts never enter this command or stdin.
  const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
  const nonce = randomUUID().replaceAll('-', '');
  // forkpty gives this shell its own process group. Its first exact nonce frame
  // identifies that owned group before exec, before the CLI can produce output.
  const command = `printf '\\036grunt-perch-${nonce}:%s\\037\\n' "$$"; exec ` + native.map(quote).join(' ');
  const args = process.platform === 'darwin' ? ['-q', '/dev/null', '/bin/sh', '-c', command] : ['-q', '-e', '-c', command, '/dev/null'];
  return await new Promise((resolveResult, reject) => {
    const env = Object.fromEntries(Object.entries(options.env).filter(([key]) => !/^(?:SHELL|BASH_ENV|ENV|ZDOTDIR|LD_PRELOAD|DYLD_INSERT_LIBRARIES)$/i.test(key)));
    const child = spawn('/usr/bin/script', args, { cwd: options.cwd, env: { ...env, SHELL: '/bin/sh', PERCH_CLI_PLAIN: '1', TERM: 'dumb' }, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    const commands = configure ? ['/settings memory off', '/settings learn-memories off', '/settings memory', '/exit'] : ['/settings memory', '/exit'];
    const decoder = new StringDecoder('utf8');
    let output = '', bytes = 0, stage = 0, scan = 0, failure: unknown, identity: { email: string } | undefined, verified = false, nativeGroup: number | undefined;
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      if (nativeGroup) try { process.kill(-nativeGroup, 'SIGKILL'); } catch { /* Only the nonce-bound forkpty child group. */ }
      kill(child);
    };
    const fail = (error: unknown) => {
      failure ??= error;
      if (nativeGroup) { stop(); return; }
      // Let script forward termination while an early startup frame is pending;
      // keep draining that frame so we can kill its separate native group too.
      try { if (child.pid) process.kill(-child.pid, 'SIGTERM'); } catch { /* Already closed. */ }
      cleanupTimer ??= setTimeout(stop, 250);
    };
    const abort = () => fail(options.signal.reason);
    const timer = setTimeout(() => fail(new SourceError('timeout', 'Perch memory settings timed out')), Math.min(options.timeoutMs ?? 30000, 30000));
    options.signal.addEventListener('abort', abort, { once: true });
    child.stdin.on('error', () => {});
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > Math.min(options.maxOutputBytes ?? 65536, 65536)) { fail(new SourceError('upstream', 'Perch memory settings exceeded the supported size')); return; }
      output += decoder.write(chunk);
      if (!nativeGroup) {
        const frame = output.match(new RegExp(`^\x1egrunt-perch-${nonce}:(\\d+)\x1f\\r?\\n`));
        if (!frame) { if (output.includes('\n')) fail(new SourceError('refused', 'Perch terminal ownership could not be verified')); return; }
        const group = Number(frame[1]);
        if (!Number.isSafeInteger(group) || group <= 1 || group === process.pid || group === child.pid) { fail(new SourceError('refused', 'Perch terminal ownership could not be verified')); return; }
        nativeGroup = group; output = output.slice(frame[0].length);
        if (failure || options.signal.aborted) { stop(); return; }
      }
      let marker: number;
      while ((marker = output.indexOf('you› ', scan)) !== -1) {
        const response = output.slice(scan, marker).replaceAll('\r', ''); scan = marker + 'you› '.length;
        if (!stage) {
          const clean = output.replaceAll('\r', ''), matches = [...clean.matchAll(/^\s*signed in as ([^\s@]+@[^\s@]+\.[^\s@]+) · saffron · ask · plan\s*$/gm)];
          const versions = [...clean.matchAll(/^perch · field terminal\s+v([^\s]+)\s*$/gm)];
          if (matches.length !== 1 || versions.length !== 1 || versions[0]![1] !== '2.4.132') { fail(new SourceError('logged_out', 'Perch memory settings identity is unavailable')); return; }
          identity = { email: matches[0]![1]!.toLowerCase() };
        } else if (commands[stage - 1] === '/settings memory') {
          const use = response.split('\n').filter(line => /^\s*Use memory\s+/.test(line)), learn = response.split('\n').filter(line => /^\s*Learn new memories\s+/.test(line));
          if (use.length !== 1 || learn.length !== 1 || !/^\s*Use memory\s+Off\s+memory\s*$/.test(use[0]!) || !/^\s*Learn new memories\s+Off\s+learn-memories\s*$/.test(learn[0]!)) {
            fail(new SourceError('refused', 'Perch account memory must be switched off; rerun usegrunt setup')); return;
          }
          verified = true;
        }
        const command = commands[stage++];
        if (!command) { fail(new SourceError('upstream', 'Perch memory settings returned an unexpected prompt')); return; }
        child.stdin.write(command + '\n');
      }
    });
    child.stderr.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > Math.min(options.maxOutputBytes ?? 65536, 65536)) fail(new SourceError('upstream', 'Perch memory settings exceeded the supported size')); });
    child.once('error', () => fail(new SourceError('not_installed', 'Perch requires the native script terminal utility for isolated settings')));
    child.once('close', code => {
      clearTimeout(timer); clearTimeout(cleanupTimer); options.signal.removeEventListener('abort', abort); stop();
      if (options.signal.aborted) reject(options.signal.reason);
      else if (failure) reject(failure);
      else if (code !== 0 || !identity || !verified || stage !== commands.length) reject(new SourceError('refused', 'Perch memory settings could not be verified'));
      else resolveResult(identity);
    });
    if (options.signal.aborted) abort();
  });
}

/** The official CLI implements newline-delimited ACP. Never expose its stderr or raw protocol errors. */
export async function openPerchACP(binary: string, options: PerchACPOptions): Promise<PerchACP> {
  unsupported(); options.signal.throwIfAborted();
  const child = spawn(process.execPath, [binary, 'acp'], { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  const notifications: Json[] = [], pending = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void }>();
  const decoder = new StringDecoder('utf8');
  let nextId = 1, bytes = 0, partial = '', closed = false, failure: unknown;
  let exit!: () => void;
  const exited = new Promise<void>(resolveExit => { exit = resolveExit; });
  const fail = (error: unknown) => {
    failure ??= error;
    for (const operation of pending.values()) operation.reject(error);
    pending.clear(); kill(child);
  };
  const abort = () => fail(options.signal.reason);
  const timer = setTimeout(() => fail(new SourceError('timeout', 'Perch ACP timed out')), Math.min(options.timeoutMs ?? 175000, 175000));
  const send = (value: unknown) => {
    if (closed || child.stdin.destroyed) throw new SourceError('upstream', 'Perch ACP is closed');
    child.stdin.write(JSON.stringify(value) + '\n');
  };
  const receive = (line: string) => {
    if (!line.trim()) return;
    let value: Json;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid frame');
      value = parsed as Json;
    } catch { throw new SourceError('upstream', 'Perch returned an invalid ACP message'); }
    if (value.jsonrpc !== '2.0') throw new SourceError('upstream', 'Perch returned an invalid ACP version');
    if (typeof value.method === 'string') {
      if (value.id !== undefined) {
        // Deny before executing anything. This client exposes no filesystem, terminals or permissions.
        if (value.method === 'session/request_permission') send({ jsonrpc: '2.0', id: value.id, result: { outcome: { outcome: 'cancelled' } } });
        else send({ jsonrpc: '2.0', id: value.id, error: { code: -32601, message: 'No client tools are available' } });
        throw new SourceError('refused', 'Perch requested an unexpected native action');
      }
      if (value.method !== 'session/update') throw new SourceError('refused', 'Perch returned an unexpected ACP notification');
      const update = (value.params as { update?: { sessionUpdate?: unknown } } | undefined)?.update;
      if (update?.sessionUpdate === 'tool_call' || update?.sessionUpdate === 'tool_call_update') throw new SourceError('refused', 'Perch attempted an unexpected native action');
      options.onNotify?.(value); notifications.push(value); return;
    }
    if (!Number.isSafeInteger(value.id) || !pending.has(value.id as number)) throw new SourceError('upstream', 'Perch returned an uncorrelated ACP reply');
    const operation = pending.get(value.id as number)!; pending.delete(value.id as number);
    if (value.error) {
      const error = value.error as { code?: unknown; message?: unknown };
      const text = typeof error.message === 'string' ? error.message : '';
      const code = /quota|usage.?limit|rate.?limit|allowance/i.test(text) ? 'quota'
        : error.code === -32000 || /auth|sign.?in|logged.?out/i.test(text) ? 'logged_out'
          : /plan|required.*(?:starter|pro)|forbidden|refus|denied/i.test(text) ? 'refused' : 'upstream';
      operation.reject(new SourceError(code, 'Perch ACP did not complete the request')); return;
    }
    if (!Object.hasOwn(value, 'result')) throw new SourceError('upstream', 'Perch ACP returned no result');
    operation.resolve(value.result);
  };
  options.signal.addEventListener('abort', abort, { once: true });
  child.stdin.on('error', () => {});
  child.stdout.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > (options.maxOutputBytes ?? 2 * 1024 * 1024)) { fail(new SourceError('upstream', 'Perch output exceeded the supported size')); return; }
    partial += decoder.write(chunk);
    let newline: number;
    try {
      while ((newline = partial.indexOf('\n')) !== -1) { const line = partial.slice(0, newline); partial = partial.slice(newline + 1); receive(line); }
    } catch (error) { fail(error); }
  });
  child.stderr.on('data', (chunk: Buffer) => {
    // Count but never retain native diagnostics, which can contain pairing URLs or tokens.
    bytes += chunk.length;
    if (bytes > (options.maxOutputBytes ?? 2 * 1024 * 1024)) fail(new SourceError('upstream', 'Perch output exceeded the supported size'));
  });
  child.once('error', () => fail(new SourceError('not_installed', 'Perch CLI could not start; rerun usegrunt setup')));
  child.once('close', () => {
    closed = true; clearTimeout(timer); options.signal.removeEventListener('abort', abort);
    fail(failure ?? new SourceError('upstream', 'Perch ACP closed before completing the request')); exit();
  });
  if (options.signal.aborted) abort();
  return {
    notifications,
    request: async (method, params) => {
      options.signal.throwIfAborted();
      if (failure) throw failure;
      if (closed) throw new SourceError('upstream', 'Perch ACP is closed');
      return await new Promise((resolveResult, reject) => {
        const id = nextId++; pending.set(id, { resolve: resolveResult, reject });
        try { send({ jsonrpc: '2.0', id, method, params }); }
        catch (error) { pending.delete(id); reject(error); }
      });
    },
    close: async () => { if (!closed) { child.stdin.end(); kill(child); } await exited; }
  };
}

/** Hash only public executable artifacts, never native authentication. */
export async function verifyPerchCoreFiles(packageDirectory: string, expected: Record<string, string>, signal: AbortSignal) {
  for (const [relative, wanted] of Object.entries(expected)) {
    signal.throwIfAborted();
    let directory = dirname(join(packageDirectory, relative));
    while (directory.startsWith(packageDirectory)) {
      const st = await lstat(directory);
      if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid?.() || (st.mode & 0o022)) throw new SourceError('not_installed', 'Perch public installation directory is unsafe');
      if (directory === packageDirectory) break;
      directory = dirname(directory);
    }
    const file = await open(join(packageDirectory, relative), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const st = await file.stat();
      if (!st.isFile() || st.uid !== process.getuid?.() || (st.mode & 0o022) || st.size > 20 * 1024 * 1024) throw new SourceError('not_installed', 'Perch public installation is unsafe');
      const hash = createHash('sha256');
      for await (const chunk of file.createReadStream({ autoClose: false })) { signal.throwIfAborted(); hash.update(chunk as Buffer); }
      if (hash.digest('hex') !== wanted) throw new SourceError('not_installed', 'Perch installation does not match the pinned release');
    } finally { await file.close(); }
  }
}
