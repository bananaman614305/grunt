import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, lstat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

export const WORKER_MEMORY_BYTES = 512 * 1024 * 1024;
export const WORKER_TASKS_MAX = 64;
const systemdRun = '/usr/bin/systemd-run', systemctl = '/usr/bin/systemctl';
const unitPattern = /^grunt-worker-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.scope$/;
export interface WorkerResourceCommand {
  binary: string; args: string[]; env: NodeJS.ProcessEnv; unit: string;
  /** Await after stopping the owned process group, including on abort and timeout. */
  cleanup(): Promise<void>;
}
function bridgeEnvironment(): NodeJS.ProcessEnv {
  if (process.platform !== 'linux' || !process.getuid) throw new Error('Worker commands require enforceable Linux resource scopes.');
  const runtime = `/run/user/${process.getuid()}`;
  return { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', XDG_RUNTIME_DIR: runtime, DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtime}/bus` };
}
async function trustedBridge() {
  const env = bridgeEnvironment(), uid = process.getuid!();
  for (const binary of [systemdRun, systemctl]) {
    const info = await lstat(binary);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== 0 || info.mode & 0o022) throw new Error('Worker resource toolchain is not trusted.');
    await access(binary, constants.X_OK);
  }
  const directory = await lstat(env.XDG_RUNTIME_DIR!), bus = await lstat(`${env.XDG_RUNTIME_DIR}/bus`);
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== uid || directory.mode & 0o077 || !bus.isSocket() || bus.uid !== uid) throw new Error('The worker user resource manager is unavailable.');
}
/** Fixed bridge to this user's manager. No model arguments can select a unit, bus or limits. */
export function resourceCommand(binary: string, args: string[]): WorkerResourceCommand {
  if (!isAbsolute(binary) || binary.includes('\0') || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new Error('Worker resource wrapping requires a trusted executable and argument list.');
  const env = bridgeEnvironment(), unit = `grunt-worker-${randomUUID()}.scope`;
  let cleaning: Promise<void> | undefined;
  return {
    binary: systemdRun,
    args: ['--user', '--scope', '--quiet', '--collect', '--no-ask-password', '--expand-environment=no', `--unit=${unit}`,
      `--property=MemoryMax=${WORKER_MEMORY_BYTES}`, '--property=MemorySwapMax=0', `--property=TasksMax=${WORKER_TASKS_MAX}`, '--', binary, ...args],
    env, unit,
    cleanup() {
      // The name is generated here, never accepted from another session or model.
      if (!unitPattern.test(unit)) throw new Error('Invalid owned worker resource scope.');
      cleaning ??= boundedProcess(systemctl, ['--user', '--no-ask-password', 'kill', '--kill-whom=all', '--signal=KILL', unit], env, 2000).then(() => {}, () => {});
      return cleaning;
    }
  };
}
function boundedProcess(binary: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number, signal?: AbortSignal): Promise<{ code: number | null; stdout: string }> {
  signal?.throwIfAborted();
  return new Promise((resolveResult, reject) => {
    const child = spawn(binary, args, { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const chunks: Buffer[] = []; let bytes = 0, stopped = false, failed = false;
    const stop = () => { stopped = true; if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Only this owned process group is targeted. */ } } };
    const abort = () => stop(), timer = setTimeout(stop, timeoutMs);
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) stop();
    child.stdout.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 4096) stop(); else chunks.push(chunk); });
    child.stderr.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 4096) stop(); });
    child.once('error', () => { failed = true; });
    child.once('close', code => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort); const interrupted = stopped; stop();
      if (signal?.aborted) reject(signal.reason);
      else if (failed || interrupted || bytes > 4096) reject(new Error('Worker resource capability check failed.'));
      else resolveResult({ code, stdout: Buffer.concat(chunks).toString('utf8') });
    });
  });
}
const probeScript = `const fs=require('node:fs');const rows=fs.readFileSync('/proc/self/cgroup','utf8').trim().split('\\n');const row=rows.find(v=>v.startsWith('0::/'));if(!row)process.exit(1);const path=row.slice(3);if(path.includes('..')||!path.endsWith('/'+process.argv[1]))process.exit(1);const root='/sys/fs/cgroup'+path;const read=name=>fs.readFileSync(root+'/'+name,'utf8').trim();process.stdout.write(JSON.stringify({memory:read('memory.max'),swap:read('memory.swap.max'),tasks:read('pids.max')}));`;
/** Harmless real cgroup probe: property acceptance alone is not sufficient. No stress allocation or fork test. */
export async function probeWorkerResources(signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted();
  let wrapped: WorkerResourceCommand | undefined;
  try {
    await trustedBridge();
    wrapped = resourceCommand(process.execPath, ['-e', probeScript]);
    wrapped.args.push(wrapped.unit);
    const result = await boundedProcess(wrapped.binary, wrapped.args, wrapped.env, 5000, signal);
    if (result.code !== 0) return false;
    const measured: unknown = JSON.parse(result.stdout);
    return !!measured && typeof measured === 'object' && !Array.isArray(measured) &&
      (measured as Record<string, unknown>).memory === String(WORKER_MEMORY_BYTES) &&
      (measured as Record<string, unknown>).swap === '0' && (measured as Record<string, unknown>).tasks === String(WORKER_TASKS_MAX);
  } catch { signal?.throwIfAborted(); return false; }
  finally { await wrapped?.cleanup(); }
}
