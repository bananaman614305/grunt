import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, lstat, open, realpath } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { executeWorkerTool, inspectWorkerFiles } from './worker-tool-helper.js';
import type { WorkerInspection, WorkerToolPolicy, WorkerToolResult, WorkerSnapshotManifest } from './worker-tool-helper.js';

export interface WorkerCapabilities { filesystem: true; commands: boolean; sandbox: 'bubblewrap' | 'filesystem' }
export interface WorkerSandboxOptions {
  /** Trusted operator/test settings, never accepted in model tool arguments. */
  mode?: 'auto' | 'filesystem' | 'bubblewrap';
  bwrapPath?: string;
  nodePath?: string;
  helperPath?: string;
  dependencies?: string;
  /** Trusted capture-only read-only binding. Never expose this instance to a model. */
  sourceRoot?: string;
}
interface RunResult { code: number | null; stdout: string }
const existing = async (path: string) => { try { await lstat(path); return true; } catch { return false; } };
async function trustedFile(path: string, executable = false) {
  const file = await realpath(path), stat = await lstat(file);
  if (!stat.isFile() || (stat.mode & 0o022) || process.getuid && stat.uid !== 0 && stat.uid !== process.getuid()) throw new Error('Worker toolchain is not a trusted regular file');
  if (executable) await access(file, constants.X_OK);
  return file;
}
async function bindings() {
  const args: string[] = [];
  for (const path of ['/usr', '/bin', '/lib', '/lib64']) if (await existing(path)) args.push('--ro-bind', path, path);
  args.push('--dir', '/etc');
  for (const path of ['/etc/ld.so.cache', '/etc/passwd', '/etc/group', '/etc/hosts', '/etc/nsswitch.conf', '/etc/localtime', '/etc/ssl/certs']) {
    if (await existing(path)) args.push('--ro-bind', await realpath(path), path);
  }
  return args;
}
async function run(binary: string, args: string[], input: string, signal: AbortSignal, maxBytes: number, timeoutMs: number, sourceFd?: number): Promise<RunResult> {
  signal.throwIfAborted();
  return new Promise((resolveResult, reject) => {
    const child = spawn(binary, args, { env: { PATH: '/usr/bin:/bin' }, stdio: sourceFd === undefined ? ['pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe', sourceFd], detached: true });
    const chunks: Buffer[] = []; let bytes = 0, failed = false, stopped = false;
    const stop = () => {
      stopped = true;
      if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Our owned process group has exited. */ } }
    };
    const abort = () => stop(), timer = setTimeout(stop, timeoutMs);
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
    child.stdout!.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > maxBytes) stop(); else chunks.push(chunk); });
    child.stderr!.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > maxBytes) stop(); });
    child.stdin!.on('error', () => {}); child.stdin!.end(input);
    child.on('error', () => { failed = true; });
    child.once('close', code => {
      clearTimeout(timer); signal.removeEventListener('abort', abort);
      const interrupted = stopped; stop();
      if (signal.aborted) reject(signal.reason);
      else if (failed || interrupted || code !== 0 || bytes > maxBytes) reject(new Error('Worker sandbox operation did not complete within its limits'));
      else resolveResult({ code, stdout: Buffer.concat(chunks).toString('utf8') });
    });
  });
}
export class WorkerSandbox {
  readonly capabilities: WorkerCapabilities;
  private constructor(private policy: WorkerToolPolicy, private args: string[] | undefined, private binary: string | undefined, private helper: string | undefined, private sourceHandle: FileHandle | undefined = undefined) {
    this.capabilities = { filesystem: true, commands: !!args, sandbox: args ? 'bubblewrap' : 'filesystem' };
  }
  static async create(policy: WorkerToolPolicy, options: WorkerSandboxOptions = {}, signal = new AbortController().signal) {
    signal.throwIfAborted();
    if (options.mode === 'filesystem' || process.platform !== 'linux') {
      if (options.mode === 'bubblewrap') throw new Error('The required worker sandbox is unavailable');
      return new WorkerSandbox(policy, undefined, undefined, undefined);
    }
    let sourceHandle: FileHandle | undefined;
    try {
      const binary = await trustedFile(options.bwrapPath ?? '/usr/bin/bwrap', true);
      const node = await trustedFile(options.nodePath ?? process.execPath, true);
      const helper = await trustedFile(options.helperPath ?? fileURLToPath(new URL('./worker-tool-helper.js', import.meta.url)));
      await trustedFile('/usr/bin/prlimit', true); await trustedFile('/usr/bin/nice', true);
      const base = ['--die-with-parent', '--new-session', '--unshare-all', '--unshare-user', '--cap-drop', 'ALL', '--disable-userns', '--tmpfs', '/',
        ...await bindings(), '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--tmpfs', '/run', '--dir', '/home', '--dir', '/home/worker',
        '--dir', '/opt', '--dir', '/opt/grunt', '--ro-bind', node, '/opt/grunt/node', '--ro-bind', helper, '/opt/grunt/worker-tool-helper.mjs',
        policy.readOnly ? '--ro-bind' : '--bind', policy.root, '/workspace'];
      if (options.sourceRoot) {
        sourceHandle = await open(options.sourceRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        if (!(await sourceHandle.stat()).isDirectory()) throw new Error('The capture root is not a directory');
        base.push('--ro-bind', '/proc/self/fd/3', '/source');
      }
      if (options.dependencies) {
        const info = await lstat(options.dependencies);
        // Symlinked roots could point at a vault or another private project.
        if (info.isDirectory() && !info.isSymbolicLink()) base.push('--ro-bind', options.dependencies, '/workspace/node_modules');
      }
      base.push('--chdir', '/workspace', '--clearenv', '--setenv', 'PATH', '/opt/grunt:/usr/bin:/bin', '--setenv', 'HOME', '/home/worker',
        '--setenv', 'TMPDIR', '/tmp', '--setenv', 'LANG', 'C.UTF-8', '--setenv', 'LC_ALL', 'C.UTF-8', '--setenv', 'TERM', 'dumb',
        '--setenv', 'XDG_CACHE_HOME', '/tmp/cache', '--setenv', 'npm_config_cache', '/tmp/npm-cache',
        '--setenv', 'GIT_CONFIG_NOSYSTEM', '1', '--setenv', 'GIT_CONFIG_GLOBAL', '/dev/null', '--setenv', 'GIT_TERMINAL_PROMPT', '0',
        '--remount-ro', '/');
      const probe = await run(binary, [...base, '/opt/grunt/node', '-e', 'process.exit(0)'], '', signal, 4096, 5000, sourceHandle?.fd);
      if (probe.code !== 0) throw new Error('Worker namespace probe failed');
      return new WorkerSandbox(policy, base, binary, helper, sourceHandle);
    } catch (error) {
      await sourceHandle?.close();
      signal.throwIfAborted();
      if (options.mode === 'bubblewrap') throw error;
      // Explicit filesystem-only mode never launches a model-supplied command.
      return new WorkerSandbox(policy, undefined, undefined, undefined);
    }
  }
  async execute(name: string, args: unknown, signal: AbortSignal): Promise<WorkerToolResult> {
    signal.throwIfAborted();
    if (!this.args || !this.binary || !this.helper) {
      if (name === 'worker_command') return { ok: false, code: 'unsupported_sandbox', message: 'Command execution needs the verified Linux worker sandbox. Filesystem tools remain available.' };
      const result = await executeWorkerTool(this.policy, name, args); signal.throwIfAborted(); return result;
    }
    return await this.operation(name, args, signal) as WorkerToolResult;
  }
  async inspect(maxBytes: number, signal: AbortSignal, baseline: Record<string, string> = {}): Promise<WorkerInspection> {
    signal.throwIfAborted();
    if (!this.args) return inspectWorkerFiles(this.policy, maxBytes, baseline);
    return await this.operation('inspect', undefined, signal, maxBytes, { baseline }) as WorkerInspection;
  }
  async snapshot(paths: string[], maxBytes: number, signal: AbortSignal): Promise<WorkerSnapshotManifest> {
    if (!this.args) throw new Error('Unconfined source capture is not supported');
    try { return await this.operation('snapshot', undefined, signal, maxBytes, { paths }) as WorkerSnapshotManifest; }
    finally { await this.sourceHandle?.close(); this.sourceHandle = undefined; }
  }
  private async operation(operation: string, args: unknown, signal: AbortSignal, maxBytes?: number, extra: Record<string, unknown> = {}) {
    const command = args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : {};
    const seconds = Number.isSafeInteger(command.timeoutSeconds) ? Math.min(120, Math.max(1, Number(command.timeoutSeconds))) : 30;
    const input = JSON.stringify({ policy: { ...this.policy, root: '/workspace' }, operation, args, maxBytes, ...extra });
    const result = await run(this.binary!, [...this.args!, '/opt/grunt/node', '/opt/grunt/worker-tool-helper.mjs'], input, signal,
      operation === 'inspect' || operation === 'snapshot' ? 8 * 1024 * 1024 : 512 * 1024, operation === 'worker_command' ? (seconds + 3) * 1000 : 15000, this.sourceHandle?.fd);
    if (result.code !== 0) throw new Error('Worker sandbox helper did not complete');
    try { return JSON.parse(result.stdout) as unknown; } catch { throw new Error('Worker sandbox helper returned an invalid result'); }
  }
}
