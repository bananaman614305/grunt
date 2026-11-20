/** Fixed filesystem operations shared by the portable worker and its sandbox helper. */
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

export interface WorkerToolResult { ok: boolean; [key: string]: unknown }
export interface WorkerToolPolicy {
  root: string;
  ownedPaths: string[];
  readOnly: boolean;
  maxFileBytes: number;
  maxOutputBytes: number;
  maxFiles: number;
  maxWorkspaceBytes?: number;
}
export interface InspectedWorkerFile { path: string; sha256: string; size: number; binary: boolean; executable: boolean; content?: string }
export interface WorkerInspection { files: InspectedWorkerFile[]; unsafe: string[]; truncated: boolean }
export interface SnapshotWorkerFile { path: string; sha256: string; size: number; binary: boolean; executable: boolean }
export interface WorkerSnapshotManifest { files: SnapshotWorkerFile[]; omittedPaths: string[] }
const folders = new Set(['.git', '.hg', '.svn', '.ssh', '.aws', '.config', '.cache', '.local', '.codex', '.trusty-squire', '.npm', '.pnpm-store', '.kube', '.azure', '.gcloud', '.docker', '.gnupg', '.squire', 'node_modules']);
const secretNames = new Set(['.npmrc', '.netrc', '.pypirc', 'auth.json', 'models.json', 'credentials', 'credentials.json', 'credentials.yml', 'credentials.yaml', 'id_rsa', 'id_ed25519']);
export function privateWorkerPath(path: string) {
  return path.split('/').some(value => {
    const part = value.toLowerCase();
    return folders.has(part) || secretNames.has(part) || part === '.env' || part === '.envrc' || part.startsWith('.env.') || part.startsWith('.grunt-workspace-') || /^credentials/.test(part) || /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)/.test(part) || /\.(?:pem|key|p12|pfx)$/.test(part) || /^service-account.*\.json$/.test(part);
  });
}
export function workerRelativePath(value: unknown, allowRoot = false): string {
  if (allowRoot && (value === undefined || value === '' || value === '.')) return '';
  if (typeof value !== 'string' || !value || value.length > 1024 || /[\\:\x00-\x1f\x7f]/.test(value) || value.startsWith('/')) throw new ToolFailure('invalid_path');
  const parts = value.replace(/\/$/, '').split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) || privateWorkerPath(parts.join('/'))) throw new ToolFailure('invalid_path');
  return parts.join('/');
}
export const ownsWorkerPath = (path: string, ownedPaths: readonly string[]) => ownedPaths.some(prefix => path === prefix || path.startsWith(prefix + '/'));
const hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
class ToolFailure extends Error { constructor(readonly code: string) { super(code); } }
const messages: Record<string, string> = {
  invalid_path: 'Use a relative project path without private files or symlinks.', invalid_arguments: 'Tool arguments are invalid.',
  ownership: 'This path is outside the assigned file ownership.', read_only: 'This worker is read-only.', not_found: 'The requested file does not exist.',
  too_large: 'The requested operation exceeds the worker size limit.', ambiguous_edit: 'The old text must occur exactly once.',
  unsupported_tool: 'This tool is unavailable.', tool_failed: 'The scoped operation failed.',
};
function exactArgs(value: unknown, allowed: string[], required: string[] = []) {
  const args = object(value);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(args).some(key => !allowed.includes(key)) || required.some(key => !(key in args))) throw new ToolFailure('invalid_arguments');
  return args;
}
async function checkedPath(policy: WorkerToolPolicy, relative: string, createParents = false) {
  let current = resolve(policy.root);
  const root = await lstat(current);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new ToolFailure('invalid_path');
  const parts = relative.split('/').filter(Boolean);
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || (index < parts.length - 1 && !info.isDirectory())) throw new ToolFailure('invalid_path');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (index < parts.length - 1) {
        if (!createParents) throw new ToolFailure('not_found');
        await mkdir(current, { mode: 0o700 });
      }
    }
  }
  return current;
}
async function readBytes(policy: WorkerToolPolicy, path: string, limit = policy.maxFileBytes) {
  const full = await checkedPath(policy, path);
  const file = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new ToolFailure('invalid_path');
    if (info.size > limit) throw new ToolFailure('too_large');
    const data = await file.readFile(), after = await file.stat();
    if (info.size !== after.size || info.mtimeMs !== after.mtimeMs || info.ctimeMs !== after.ctimeMs || data.length !== info.size) throw new ToolFailure('tool_failed');
    return data;
  } finally { await file.close(); }
}
async function writeBytes(policy: WorkerToolPolicy, path: string, data: string) {
  if (policy.readOnly) throw new ToolFailure('read_only');
  if (!ownsWorkerPath(path, policy.ownedPaths)) throw new ToolFailure('ownership');
  if (Buffer.byteLength(data) > policy.maxFileBytes) throw new ToolFailure('too_large');
  const full = await checkedPath(policy, path, true);
  const usage = await boundedUsage(policy);
  let previousSize = 0;
  try { const info = await lstat(full); if (!info.isFile()) throw new ToolFailure('invalid_path'); previousSize = info.size; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (usage.bytes - previousSize + Buffer.byteLength(data) > (policy.maxWorkspaceBytes ?? 256 * 1024 * 1024)) throw new ToolFailure('too_large');
  const file = await open(full, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try { if (!(await file.stat()).isFile()) throw new ToolFailure('invalid_path'); await file.writeFile(data); }
  finally { await file.close(); }
  return { ok: true, path, bytes: Buffer.byteLength(data), sha256: hash(Buffer.from(data)) };
}
async function paths(policy: WorkerToolPolicy, parent = '', unsafe: string[] = [], all: string[] = [], reportPrivate = false) {
  const full = await checkedPath(policy, parent);
  for (const item of await readdir(full, { withFileTypes: true })) {
    const path = parent ? parent + '/' + item.name : item.name;
    if (privateWorkerPath(path)) {
      if (reportPrivate && !['node_modules', '.cache', '.npm', '.pnpm-store'].includes(item.name)) unsafe.push(path);
      continue;
    }
    if (all.length + unsafe.length >= policy.maxFiles) throw new ToolFailure('too_large');
    if (item.isSymbolicLink()) unsafe.push(path);
    else if (item.isDirectory()) await paths(policy, path, unsafe, all, reportPrivate);
    else if (item.isFile()) all.push(path);
    else unsafe.push(path);
  }
  return { all, unsafe };
}
export async function inspectWorkerFiles(policy: WorkerToolPolicy, maxBytes: number, baseline: Record<string, string> = {}): Promise<WorkerInspection> {
  const found = await paths(policy, '', [], [], true), files: InspectedWorkerFile[] = [];
  let bytes = 0, truncated = false;
  for (const path of found.all.sort()) {
    try {
      const data = await readBytes(policy, path), text = data.toString('utf8'), binary = data.includes(0) || !Buffer.from(text).equals(data);
      const content = binary ? data.toString('base64') : text, size = Buffer.byteLength(content);
      const info = await lstat(await checkedPath(policy, path));
      const row: InspectedWorkerFile = { path, sha256: hash(data), size: data.length, binary, executable: !!(info.mode & 0o111) };
      if (baseline[path] !== row.sha256 && ownsWorkerPath(path, policy.ownedPaths)) {
        if (bytes + size <= maxBytes) { row.content = content; bytes += size; } else truncated = true;
      }
      files.push(row);
    } catch (error) {
      if (error instanceof ToolFailure && error.code === 'too_large') { truncated = true; found.unsafe.push(path); }
      else throw error;
    }
  }
  return { files, unsafe: found.unsafe, truncated };
}
/** Trusted capture phase; it is never offered as a model tool. */
export async function snapshotWorkerFiles(sourceRoot: string, policy: WorkerToolPolicy, selected: string[], maxBytes: number): Promise<WorkerSnapshotManifest> {
  const source = { ...policy, root: sourceRoot, readOnly: true }, files: SnapshotWorkerFile[] = [], omittedPaths: string[] = [];
  let bytes = 0;
  if (selected.length > policy.maxFiles) throw new ToolFailure('too_large');
  for (const input of [...new Set(selected)].sort()) {
    if (privateWorkerPath(input)) continue;
    const path = workerRelativePath(input);
    let data: Buffer, info;
    try {
      const full = await checkedPath(source, path); info = await lstat(full);
      if (!info.isFile() || info.isSymbolicLink()) { omittedPaths.push(path); continue; }
      data = await readBytes(source, path);
    } catch (error) {
      if (error instanceof ToolFailure && ['invalid_path', 'not_found'].includes(error.code) || (error as NodeJS.ErrnoException).code === 'ENOENT') { omittedPaths.push(path); continue; }
      throw error;
    }
    bytes += data.length; if (bytes > maxBytes) throw new ToolFailure('too_large');
    const destination = await checkedPath(policy, path, true), output = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, info.mode & 0o111 ? 0o700 : 0o600);
    try { await output.writeFile(data); } finally { await output.close(); }
    files.push({ path, sha256: hash(data), size: data.length, binary: data.includes(0) || !Buffer.from(data.toString('utf8')).equals(data), executable: !!(info.mode & 0o111) });
  }
  return { files, omittedPaths };
}
export async function executeWorkerTool(policy: WorkerToolPolicy, name: string, input: unknown): Promise<WorkerToolResult> {
  try {
    if (name === 'worker_list') {
      const args = exactArgs(input, ['path']), path = workerRelativePath(args.path, true), found = await paths(policy, path);
      return { ok: true, paths: found.all.slice(0, 200), truncated: found.all.length > 200, unsafePaths: found.unsafe.slice(0, 20) };
    }
    if (name === 'worker_read') {
      const args = exactArgs(input, ['path', 'offset', 'limit'], ['path']), path = workerRelativePath(args.path);
      const offset = args.offset ?? 0, limit = args.limit ?? Math.min(65536, policy.maxOutputBytes);
      if (!Number.isSafeInteger(offset) || Number(offset) < 0 || !Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > policy.maxOutputBytes) throw new ToolFailure('invalid_arguments');
      const data = await readBytes(policy, path), selected = data.subarray(Number(offset), Number(offset) + Number(limit));
      const binary = data.includes(0) || !Buffer.from(data.toString('utf8')).equals(data);
      return { ok: true, path, bytes: data.length, binary, ...(binary ? {} : { content: selected.toString('utf8'), nextOffset: Number(offset) + selected.length, truncated: Number(offset) + selected.length < data.length }) };
    }
    if (name === 'worker_search') {
      const args = exactArgs(input, ['query', 'path'], ['query']);
      if (typeof args.query !== 'string' || !args.query || args.query.length > 512) throw new ToolFailure('invalid_arguments');
      const found = await paths(policy, workerRelativePath(args.path, true)), matches: { path: string; line: number; text: string }[] = [];
      let bytes = 0;
      for (const path of found.all) {
        let data: Buffer; try { data = await readBytes(policy, path); } catch (error) { if (error instanceof ToolFailure && error.code === 'too_large') continue; throw error; }
        if (data.includes(0)) continue;
        for (const [index, text] of data.toString('utf8').split('\n').entries()) {
          if (!text.includes(args.query)) continue;
          const excerpt = text.slice(0, 500); bytes += Buffer.byteLength(excerpt);
          if (matches.length >= 100 || bytes > policy.maxOutputBytes) return { ok: true, matches, truncated: true };
          matches.push({ path, line: index + 1, text: excerpt });
        }
      }
      return { ok: true, matches, truncated: false };
    }
    if (name === 'worker_write') {
      const args = exactArgs(input, ['path', 'content'], ['path', 'content']);
      if (typeof args.content !== 'string') throw new ToolFailure('invalid_arguments');
      return await writeBytes(policy, workerRelativePath(args.path), args.content);
    }
    if (name === 'worker_edit') {
      const args = exactArgs(input, ['path', 'oldText', 'newText'], ['path', 'oldText', 'newText']);
      if (typeof args.oldText !== 'string' || !args.oldText || typeof args.newText !== 'string') throw new ToolFailure('invalid_arguments');
      const path = workerRelativePath(args.path), data = await readBytes(policy, path), text = data.toString('utf8');
      if (data.includes(0) || !Buffer.from(text).equals(data)) throw new ToolFailure('invalid_arguments');
      const index = text.indexOf(args.oldText);
      if (index < 0 || text.indexOf(args.oldText, index + args.oldText.length) >= 0) throw new ToolFailure('ambiguous_edit');
      return await writeBytes(policy, path, text.slice(0, index) + args.newText + text.slice(index + args.oldText.length));
    }
    if (name === 'worker_delete') {
      const args = exactArgs(input, ['path'], ['path']), path = workerRelativePath(args.path);
      if (policy.readOnly) throw new ToolFailure('read_only');
      if (!ownsWorkerPath(path, policy.ownedPaths)) throw new ToolFailure('ownership');
      const full = await checkedPath(policy, path);
      if (!(await lstat(full)).isFile()) throw new ToolFailure('invalid_path');
      await unlink(full); return { ok: true, path, deleted: true };
    }
    throw new ToolFailure('unsupported_tool');
  } catch (error) {
    const code = error instanceof ToolFailure ? error.code : (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'not_found' : 'tool_failed';
    return { ok: false, code, message: messages[code] ?? messages.tool_failed };
  }
}

/** Fixed metadata-only growth guard, inside the same namespace as the command. */
async function boundedUsage(policy: WorkerToolPolicy) {
  let entries = 0, bytes = 0;
  const visit = async (root: string) => {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      // Read-only dependencies cannot grow and can contain arbitrarily many files.
      if (root === policy.root && entry.name === 'node_modules') continue;
      if (++entries > policy.maxFiles * 2) throw new ToolFailure('workspace_limit');
      const path = join(root, entry.name), info = await lstat(path);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) await visit(path);
      else { bytes += info.size; if (bytes > (policy.maxWorkspaceBytes ?? 256 * 1024 * 1024)) throw new ToolFailure('workspace_limit'); }
    }
  };
  await visit(policy.root);
  return { bytes, entries };
}
async function command(policy: WorkerToolPolicy, input: unknown): Promise<WorkerToolResult> {
  const args = exactArgs(input, ['command', 'timeoutSeconds'], ['command']);
  if (typeof args.command !== 'string' || !args.command.trim() || args.command.length > 8192) throw new ToolFailure('invalid_arguments');
  const seconds = args.timeoutSeconds ?? 30;
  if (!Number.isSafeInteger(seconds) || Number(seconds) < 1 || Number(seconds) > 120) throw new ToolFailure('invalid_arguments');
  return new Promise(resolveResult => {
    const child = spawn('/usr/bin/prlimit', [`--fsize=${policy.maxFileBytes}`, '--nofile=256', '--core=0', '--', '/usr/bin/nice', '-n', '5', '/bin/sh', '-c', args.command as string], { cwd: policy.root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), bytes = 0, timedOut = false, limited = false, workspaceLimited = false, sampling = false;
    const stop = () => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Owned process group is gone. */ } } };
    const timer = setTimeout(() => { timedOut = true; stop(); }, Number(seconds) * 1000);
    const growth = setInterval(() => {
      if (sampling) return; sampling = true;
      void boundedUsage(policy).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { workspaceLimited = true; stop(); } }).finally(() => { sampling = false; });
    }, 250);
    growth.unref();
    const collect = (value: Buffer, target: 'stdout' | 'stderr') => {
      bytes += value.length;
      const current = target === 'stdout' ? stdout : stderr;
      const next = Buffer.concat([current, value.subarray(0, Math.max(0, policy.maxOutputBytes - current.length))]);
      if (target === 'stdout') stdout = next; else stderr = next;
      if (bytes > 1024 * 1024) { limited = true; stop(); }
    };
    child.stdout.on('data', value => collect(value, 'stdout')); child.stderr.on('data', value => collect(value, 'stderr'));
    child.on('error', () => {});
    child.once('close', async code => {
      clearTimeout(timer); clearInterval(growth); stop();
      try { await boundedUsage(policy); } catch { workspaceLimited = true; }
      resolveResult({ ok: code === 0 && !timedOut && !limited && !workspaceLimited, exitCode: code, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'),
        truncated: bytes > stdout.length + stderr.length, ...(timedOut ? { code: 'timeout' } : limited ? { code: 'output_limit' } : workspaceLimited ? { code: 'workspace_limit' } : {}) });
    });
  });
}
async function main() {
  let bytes = 0; const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) { bytes += chunk.length; if (bytes > 2 * 1024 * 1024) throw new ToolFailure('too_large'); chunks.push(chunk); }
  const request = object(JSON.parse(Buffer.concat(chunks).toString('utf8'))), policy = request.policy as WorkerToolPolicy;
  // The parent owns this policy and transport. Model input occupies args only.
  const result = request.operation === 'snapshot' ? await snapshotWorkerFiles('/source', policy, request.paths as string[], Number(request.maxBytes))
    : request.operation === 'inspect' ? await inspectWorkerFiles(policy, Number(request.maxBytes), request.baseline as Record<string, string> | undefined)
    : request.operation === 'worker_command' ? await command(policy, request.args) : await executeWorkerTool(policy, String(request.operation), request.args);
  process.stdout.write(JSON.stringify(result));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch(() => { process.stdout.write(JSON.stringify({ ok: false, code: 'tool_failed', message: messages.tool_failed })); process.exitCode = 1; });
}
