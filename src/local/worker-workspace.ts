import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir, tmpdir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { WorkerSandbox } from './worker-sandbox.js';
import type { WorkerCapabilities, WorkerSandboxOptions } from './worker-sandbox.js';
import { ownsWorkerPath, privateWorkerPath, workerRelativePath } from './worker-tool-helper.js';
import type { WorkerToolPolicy, WorkerToolResult, SnapshotWorkerFile, WorkerSnapshotManifest } from './worker-tool-helper.js';
import type { ModelRequest } from './source.js';
export type { WorkerCapabilities, WorkerToolResult };

export interface WorkerInitialFile { path: string; content: string; binary?: boolean; sha256?: string }
export interface WorkerArtifactFile { path: string; beforeSha256: string | null; afterSha256: string | null; content?: string; deleted?: boolean; binary?: boolean }
export interface WorkerArtifact { id: string; files: WorkerArtifactFile[]; complete: boolean; truncated: boolean; summary?: string }
export interface WorkerWorkspaceLimits { maxFiles?: number; maxSnapshotBytes?: number; maxFileBytes?: number; maxArtifactBytes?: number; maxOutputBytes?: number; maxWorkspaceBytes?: number }
export interface WorkerWorkspaceOptions {
  projectRoot: string;
  ownedPaths: string[];
  readOnly?: boolean;
  stateDirectory?: string;
  limits?: WorkerWorkspaceLimits;
  initialSnapshot?: WorkerInitialFile[];
  /** Trusted host configuration/test injection, never model arguments. */
  sandbox?: WorkerSandboxOptions;
}
export class WorkerWorkspaceError extends Error {
  constructor(readonly code: 'invalid_workspace' | 'snapshot_required' | 'snapshot_too_large' | 'unsupported_sandbox' | 'workspace_failed', message: string) { super(message); }
}
const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const gitEnv = { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
const gitArgs = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false'];
const generated = new Set(['dist', 'build', 'coverage', '.vite', '.next', 'test-results', 'playwright-report', '.grunt-output']);
const clamp = (value: number | undefined, fallback: number, max: number) => value === undefined ? fallback : Number.isSafeInteger(value) && value > 0 && value <= max ? value : (() => { throw new WorkerWorkspaceError('invalid_workspace', 'Invalid worker workspace limit'); })();
function limits(value: WorkerWorkspaceLimits = {}) {
  return { maxFiles: clamp(value.maxFiles, 5000, 20000), maxSnapshotBytes: clamp(value.maxSnapshotBytes, 64 * 1024 * 1024, 256 * 1024 * 1024),
    maxFileBytes: clamp(value.maxFileBytes, 16 * 1024 * 1024, 64 * 1024 * 1024), maxArtifactBytes: clamp(value.maxArtifactBytes, 1024 * 1024, 1024 * 1024),
    maxOutputBytes: clamp(value.maxOutputBytes, 65536, 131072), maxWorkspaceBytes: clamp(value.maxWorkspaceBytes, 256 * 1024 * 1024, 1024 * 1024 * 1024) };
}
async function privateDirectory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || process.getuid && info.uid !== process.getuid() || (info.mode & 0o077)) throw new WorkerWorkspaceError('invalid_workspace', 'Worker state must be an owned private directory');
}
function projectPath(path: string) {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) === '/' || resolve(path) === homedir() || /[\x00-\x1f]/.test(path)) throw new WorkerWorkspaceError('invalid_workspace', 'Choose an explicit project directory');
  return resolve(path);
}
async function localProject(path: string) {
  const root = projectPath(path), actual = await realpath(root), info = await lstat(root);
  if (actual !== root || !info.isDirectory() || info.isSymbolicLink() || process.getuid && info.uid !== process.getuid()) throw new WorkerWorkspaceError('invalid_workspace', 'The project root must be an owned real directory');
  return root;
}
async function gitFiles(root: string, maxFiles: number, signal: AbortSignal): Promise<string[] | undefined> {
  try {
    const result = await promisify(execFile)('git', [...gitArgs, '-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], { env: gitEnv, signal, timeout: 10000, maxBuffer: 8 * 1024 * 1024 });
    const files = [...new Set(result.stdout.split('\0').filter(Boolean))];
    if (files.length > maxFiles) throw new WorkerWorkspaceError('snapshot_too_large', 'Project file count exceeds the worker snapshot limit');
    return files.filter(path => !privateWorkerPath(path));
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof WorkerWorkspaceError) throw error;
    if ((error as { code?: unknown }).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw new WorkerWorkspaceError('snapshot_too_large', 'Project file list exceeds the snapshot limit');
    return undefined;
  }
}
async function walk(root: string, maxFiles: number, signal: AbortSignal, prefix = '', result: string[] = []) {
  signal.throwIfAborted();
  for (const item of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? prefix + '/' + item.name : item.name;
    if (privateWorkerPath(path) || item.isSymbolicLink()) continue;
    if (item.isDirectory()) {
      if (!prefix && generated.has(item.name)) continue;
      await walk(root, maxFiles, signal, path, result);
    } else if (item.isFile()) {
      result.push(path); if (result.length > maxFiles) throw new WorkerWorkspaceError('snapshot_too_large', 'Project file count exceeds the worker snapshot limit');
    }
  }
  return result;
}
async function sourcePaths(root: string, maxFiles: number, signal: AbortSignal) {
  const selected = await gitFiles(root, maxFiles, signal) ?? await walk(root, maxFiles, signal);
  if (Buffer.byteLength(JSON.stringify(selected)) > 1024 * 1024) throw new WorkerWorkspaceError('snapshot_too_large', 'Project paths exceed the snapshot metadata limit');
  return selected;
}

/** Run only in the authorized caller's own filesystem permissions, not as a daemon fallback. */
export async function captureWorkerInitialSnapshot(projectRoot: string, options: WorkerWorkspaceLimits = {}, signal = new AbortController().signal): Promise<WorkerInitialFile[]> {
  const root = await localProject(projectRoot), cap = limits(options), files: WorkerInitialFile[] = [];
  let bytes = 0;
  for (const input of await sourcePaths(root, cap.maxFiles, signal)) {
    signal.throwIfAborted();
    const path = workerRelativePath(input); let current = root, skip = false;
    for (const part of path.split('/')) {
      current = join(current, part);
      try { if ((await lstat(current)).isSymbolicLink()) { skip = true; break; } }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { skip = true; break; } throw error; }
    }
    if (skip) continue;
    const file = await open(current, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await file.stat(); if (!info.isFile()) continue;
      if (info.size > cap.maxFileBytes) throw new WorkerWorkspaceError('snapshot_too_large', 'A project file exceeds the snapshot limit');
      const data = await file.readFile(), after = await file.stat();
      if (info.size !== after.size || info.mtimeMs !== after.mtimeMs || info.ctimeMs !== after.ctimeMs) throw new WorkerWorkspaceError('workspace_failed', 'Project changed during snapshot capture; retry');
      bytes += data.length; if (bytes > cap.maxSnapshotBytes) throw new WorkerWorkspaceError('snapshot_too_large', 'Project content exceeds the snapshot limit');
      const text = data.toString('utf8'), binary = data.includes(0) || !Buffer.from(text).equals(data);
      files.push({ path, content: binary ? data.toString('base64') : text, ...(binary ? { binary: true } : {}), sha256: sha256(data) });
    } finally { await file.close(); }
  }
  return files;
}

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[] = []): ModelRequest['tools'][number] {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } };
}
function definitions(readOnly: boolean, commands: boolean): ModelRequest['tools'] {
  const path = { type: 'string', description: 'Relative project path, without traversal, private files or symlinks.' };
  return [
    tool('worker_list', 'List scoped project files. Private files and dependencies are excluded.', { path }),
    tool('worker_read', 'Read a bounded UTF-8 file excerpt.', { path, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 65536 } }, ['path']),
    tool('worker_search', 'Find literal text in scoped project files.', { query: { type: 'string', minLength: 1, maxLength: 512 }, path }, ['query']),
    ...readOnly ? [] : [
      tool('worker_write', 'Write an assigned file in this private working copy. Original project files are never changed.', { path, content: { type: 'string' } }, ['path', 'content']),
      tool('worker_edit', 'Replace exactly one matching text span in an assigned file.', { path, oldText: { type: 'string', minLength: 1 }, newText: { type: 'string' } }, ['path', 'oldText', 'newText']),
      tool('worker_delete', 'Delete one assigned regular file in this private working copy.', { path }, ['path']),
    ],
    ...commands ? [tool('worker_command', 'Run a bounded command in the private Linux sandbox. No host home, credentials, original Git metadata or network are available. Write generated output to /tmp where possible.', { command: { type: 'string', minLength: 1, maxLength: 8192 }, timeoutSeconds: { type: 'integer', minimum: 1, maximum: 120 } }, ['command'])] : [],
  ];
}
async function suppliedSnapshot(root: string, initial: WorkerInitialFile[], cap: ReturnType<typeof limits>, signal: AbortSignal): Promise<WorkerSnapshotManifest> {
  if (!Array.isArray(initial) || initial.length > cap.maxFiles) throw new WorkerWorkspaceError('snapshot_too_large', 'Caller snapshot exceeds the file count limit');
  const files: SnapshotWorkerFile[] = [], seen = new Set<string>(); let bytes = 0;
  for (const input of initial) {
    signal.throwIfAborted();
    if (!input || typeof input !== 'object' || Object.keys(input).some(key => !['path', 'content', 'binary', 'sha256'].includes(key)) || typeof input.content !== 'string' || input.binary !== undefined && typeof input.binary !== 'boolean') throw new WorkerWorkspaceError('invalid_workspace', 'Invalid caller snapshot');
    const path = workerRelativePath(input.path);
    if (seen.has(path)) throw new WorkerWorkspaceError('invalid_workspace', 'Duplicate caller snapshot path'); seen.add(path);
    const data = Buffer.from(input.content, input.binary ? 'base64' : 'utf8');
    if (input.binary && data.toString('base64') !== input.content || input.sha256 !== undefined && sha256(data) !== input.sha256) throw new WorkerWorkspaceError('invalid_workspace', 'Caller snapshot hash or encoding is invalid');
    bytes += data.length;
    if (data.length > cap.maxFileBytes || bytes > cap.maxSnapshotBytes) throw new WorkerWorkspaceError('snapshot_too_large', 'Caller snapshot exceeds the content limit');
    const destination = join(root, path), parent = resolve(destination, '..');
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const file = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(data); } finally { await file.close(); }
    files.push({ path, sha256: sha256(data), size: data.length, binary: !!input.binary, executable: false });
  }
  return { files, omittedPaths: [] };
}

export class WorkerWorkspace {
  readonly tools: ModelRequest['tools'];
  readonly recoveryId: string;
  readonly capabilities: WorkerCapabilities;
  private closed = false;
  private serial: Promise<unknown> = Promise.resolve();
  constructor(readonly id: string, readonly path: string, readonly projectRoot: string, private sandbox: WorkerSandbox,
    private baseline: WorkerSnapshotManifest, private ownedPaths: string[], private readOnly: boolean, private cap: ReturnType<typeof limits>, private localSource: boolean, private manifestPath?: string, recoveryOnly = false) {
    this.recoveryId = basename(path);
    this.capabilities = sandbox.capabilities; this.tools = recoveryOnly ? [] : definitions(readOnly, sandbox.capabilities.commands);
  }
  async executeTool(name: string, args: unknown, signal: AbortSignal): Promise<WorkerToolResult> {
    const result = this.serial.then(async () => {
      signal.throwIfAborted();
      if (this.closed) return { ok: false, code: 'closed', message: 'This worker workspace has closed.' };
      if (!this.tools.some(tool => (tool.function as { name?: unknown } | undefined)?.name === name)) return { ok: false, code: name === 'worker_command' ? 'unsupported_sandbox' : 'unsupported_tool', message: 'This tool is unavailable for this worker.' };
      const result = await this.sandbox.execute(name, args, signal);
      if (name === 'worker_command') {
        const artifact = await this.inspect(signal);
        if (artifact.outside.length) return { ...result, ok: false, code: 'ownership_violation', message: 'Command changed files outside assigned ownership; those changes cannot be integrated.', paths: artifact.outside.slice(0, 30) };
      }
      return result;
    });
    this.serial = result.catch(() => {}); return result;
  }
  private async ignored(paths: string[], signal: AbortSignal) {
    const result = new Set<string>();
    if (!paths.length) return result;
    if (this.localSource) try {
      const pending = promisify(execFile)('git', [...gitArgs, '-C', this.projectRoot, 'check-ignore', '--no-index', '-z', '--stdin'],
        { env: gitEnv, signal, timeout: 5000, maxBuffer: 2 * 1024 * 1024 });
      pending.child.stdin?.end(paths.join('\0') + '\0');
      const child = await pending;
      for (const path of child.stdout.toString().split('\0').filter(Boolean)) result.add(path);
    } catch { /* Unknown ignore state never hides changes. */ }
    // Fixed, documented generated directories are ignored only for new,
    // unowned files. Existing baseline files are always compared below.
    for (const path of paths) if (generated.has(path.split('/')[0]!)) result.add(path);
    return result;
  }
  private async inspect(signal: AbortSignal) {
    const baseline = new Map(this.baseline.files.map(file => [file.path, file]));
    const hashes = Object.fromEntries(this.baseline.files.map(file => [file.path, file.sha256]));
    const current = await this.sandbox.inspect(this.cap.maxArtifactBytes, signal, hashes), currentMap = new Map(current.files.map(file => [file.path, file]));
    const newUnowned = [...current.files.map(file => file.path), ...current.unsafe].filter(path => !baseline.has(path) && !ownsWorkerPath(path, this.ownedPaths));
    const ignored = await this.ignored(newUnowned, signal), files: WorkerArtifactFile[] = [], outside: string[] = [];
    let incomplete = false, truncated = false;
    for (const path of [...new Set([...baseline.keys(), ...currentMap.keys()])].sort()) {
      const before = baseline.get(path), after = currentMap.get(path);
      if (before?.sha256 === after?.sha256 && before?.executable === after?.executable) continue;
      if (!before && ignored.has(path)) continue;
      if (!ownsWorkerPath(path, this.ownedPaths) || this.readOnly) { outside.push(path); continue; }
      if (files.length >= 256) { incomplete = true; truncated = true; continue; }
      const file: WorkerArtifactFile = { path, beforeSha256: before?.sha256 ?? null, afterSha256: after?.sha256 ?? null };
      if (!after) file.deleted = true;
      else {
        file.binary = after.binary;
        if (after.content !== undefined) file.content = after.content;
        else { incomplete = true; truncated = true; }
        if (before && before.executable !== after.executable) incomplete = true;
      }
      files.push(file);
    }
    for (const path of current.unsafe) if (baseline.has(path) || !ignored.has(path)) outside.push(path);
    return { files, outside: [...new Set(outside)], incomplete, truncated };
  }
  async artifact(signal = AbortSignal.timeout(15000)): Promise<WorkerArtifact> {
    await this.serial; signal.throwIfAborted();
    const inspected = await this.inspect(signal), complete = !inspected.incomplete && inspected.outside.length === 0;
    const artifact: WorkerArtifact = { id: this.id, files: inspected.files, complete, truncated: inspected.truncated,
      ...(inspected.outside.length ? { summary: `${inspected.outside.length} changes outside assigned ownership or unsafe paths prevent integration.` }
        : !complete ? { summary: 'Artifact exceeds export bounds or contains unsupported permission changes. The private working copy is retained.' } : {}) };
    while (Buffer.byteLength(JSON.stringify(artifact)) > this.cap.maxArtifactBytes && artifact.files.length) {
      const last = [...artifact.files].reverse().find(file => file.content !== undefined);
      if (last) delete last.content; else artifact.files.pop();
      artifact.complete = false; artifact.truncated = true;
      artifact.summary = 'Artifact exceeds export bounds. The private working copy is retained.';
    }
    if (Buffer.byteLength(JSON.stringify(artifact)) > this.cap.maxArtifactBytes) delete artifact.summary;
    return artifact;
  }
  /** Explicit cleanup only; callers must retain this object on quota/cancel/timeout. */
  async cleanup() { await this.serial; this.closed = true; await rm(this.path, { recursive: true, force: true }); if (this.manifestPath) await rm(this.manifestPath, { force: true }); }
}

export async function createWorkerWorkspace(options: WorkerWorkspaceOptions, signal: AbortSignal): Promise<WorkerWorkspace> {
  signal.throwIfAborted();
  const projectRoot = projectPath(options.projectRoot), cap = limits(options.limits), readOnly = options.readOnly === true;
  if (cap.maxArtifactBytes < 128) throw new WorkerWorkspaceError('invalid_workspace', 'Worker artifact limit must allow its envelope');
  if (!Array.isArray(options.ownedPaths) || options.ownedPaths.length > 32 || !readOnly && !options.ownedPaths.length) throw new WorkerWorkspaceError('invalid_workspace', 'Implementation workers require one to 32 assigned relative paths');
  const ownedPaths = [...new Set(options.ownedPaths.map(path => workerRelativePath(path)))];
  let directory: string;
  if (options.stateDirectory) { await privateDirectory(options.stateDirectory); directory = await mkdtemp(join(options.stateDirectory, 'worker-')); }
  else directory = await mkdtemp(join(tmpdir(), 'grunt-agent-'));
  const policy: WorkerToolPolicy = { root: directory, ownedPaths, readOnly, maxFileBytes: cap.maxFileBytes, maxOutputBytes: cap.maxOutputBytes, maxFiles: cap.maxFiles, maxWorkspaceBytes: cap.maxWorkspaceBytes };
  try {
    // Probe before touching source contents. A portable daemon accepts only a
    // snapshot captured within the authorized caller's own permissions.
    let candidate: WorkerSandbox;
    try { candidate = await WorkerSandbox.create(policy, options.sandbox, signal); }
    catch { signal.throwIfAborted(); throw new WorkerWorkspaceError('unsupported_sandbox', 'The required worker command sandbox is unavailable'); }
    let baseline: WorkerSnapshotManifest, localSource = false;
    if (options.initialSnapshot) baseline = await suppliedSnapshot(directory, options.initialSnapshot, cap, signal);
    else {
      if (!candidate.capabilities.commands) throw new WorkerWorkspaceError('snapshot_required', 'This platform requires a caller-provided project snapshot; no project files were read');
      const source = await localProject(projectRoot), selected = await sourcePaths(source, cap.maxFiles, signal);
      const capture = await WorkerSandbox.create({ ...policy, readOnly: false }, { ...options.sandbox, sourceRoot: source, mode: 'bubblewrap' }, signal);
      baseline = await capture.snapshot(selected, cap.maxSnapshotBytes, signal); localSource = true;
    }
    let dependencies: string | undefined;
    if (localSource) { try { const path = join(projectRoot, 'node_modules'), info = await lstat(path); if (info.isDirectory() && !info.isSymbolicLink()) dependencies = path; } catch { /* Dependencies are optional. */ } }
    if (dependencies) await mkdir(join(directory, 'node_modules'), { mode: 0o700 });
    const { sourceRoot: _sourceRoot, ...toolOptions } = options.sandbox ?? {};
    const sandbox = await WorkerSandbox.create(policy, { ...toolOptions, ...(dependencies ? { dependencies } : {}) }, signal);
    const id = randomUUID();
    const manifestPath = options.stateDirectory ? join(options.stateDirectory, basename(directory) + '.json') : undefined;
    if (manifestPath) {
      const serialized = JSON.stringify({ schema: 1, id, directory: basename(directory), projectRoot, baseline, ownedPaths, readOnly, cap });
      if (Buffer.byteLength(serialized) > 8 * 1024 * 1024) throw new WorkerWorkspaceError('snapshot_too_large', 'Worker recovery metadata exceeds its limit');
      const manifest = await open(manifestPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await manifest.writeFile(serialized); await manifest.sync(); } finally { await manifest.close(); }
    }
    return new WorkerWorkspace(id, directory, projectRoot, sandbox, baseline, ownedPaths, readOnly, cap, localSource, manifestPath);
  } catch (error) {
    await rm(directory, { recursive: true, force: true }); signal.throwIfAborted();
    if (error instanceof WorkerWorkspaceError) throw error;
    throw new WorkerWorkspaceError('workspace_failed', 'The isolated worker snapshot could not be created');
  }
}

let capabilities: Promise<WorkerCapabilities & { initialSnapshotRequired: boolean }> | undefined;
export function getWorkerCapabilities() {
  return capabilities ??= (async () => {
    const root = await mkdtemp(join(tmpdir(), 'grunt-sandbox-probe-'));
    try {
      const sandbox = await WorkerSandbox.create({ root, ownedPaths: [], readOnly: true, maxFiles: 1, maxFileBytes: 1024, maxOutputBytes: 1024 }, {}, AbortSignal.timeout(7000));
      return { ...sandbox.capabilities, initialSnapshotRequired: !sandbox.capabilities.commands };
    } finally { await rm(root, { recursive: true, force: true }); }
  })();
}

export interface RestoreWorkerWorkspaceOptions {
  recoveryId: string;
  workspaceId: string;
  stateDirectory: string;
  /** Trusted toolchain injection; never restored from model-controlled metadata. */
  sandbox?: WorkerSandboxOptions;
}
/** Recover artifacts/discard only. No original project reads or automatic execution resume. */
export async function restoreWorkerWorkspace(options: RestoreWorkerWorkspaceOptions, signal: AbortSignal): Promise<WorkerWorkspace> {
  signal.throwIfAborted();
  if (!/^worker-[A-Za-z0-9_-]{6,64}$/.test(options.recoveryId) || !/^[a-f0-9-]{36}$/.test(options.workspaceId)) throw new WorkerWorkspaceError('invalid_workspace', 'Invalid retained workspace identity');
  await privateDirectory(options.stateDirectory);
  const directory = join(options.stateDirectory, options.recoveryId), manifestPath = directory + '.json';
  const rootInfo = await lstat(directory);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || process.getuid && rootInfo.uid !== process.getuid() || (rootInfo.mode & 0o077)) throw new WorkerWorkspaceError('invalid_workspace', 'Retained workspace ownership is invalid');
  const manifest = await open(manifestPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let value: Record<string, unknown>;
  try {
    const info = await manifest.stat();
    if (!info.isFile() || process.getuid && info.uid !== process.getuid() || (info.mode & 0o077) || info.size > 8 * 1024 * 1024) throw new WorkerWorkspaceError('invalid_workspace', 'Retained manifest ownership or size is invalid');
    value = JSON.parse(await manifest.readFile('utf8')) as Record<string, unknown>;
  } finally { await manifest.close(); }
  if (!value || value.schema !== 1 || value.id !== options.workspaceId || value.directory !== options.recoveryId || !Array.isArray(value.ownedPaths) || value.ownedPaths.length > 32 || typeof value.readOnly !== 'boolean' || !value.readOnly && !value.ownedPaths.length) throw new WorkerWorkspaceError('invalid_workspace', 'Retained workspace manifest is invalid');
  const projectRoot = projectPath(value.projectRoot as string), ownedPaths = value.ownedPaths.map(path => workerRelativePath(path));
  const cap = limits(value.cap as WorkerWorkspaceLimits), baseline = value.baseline as WorkerSnapshotManifest;
  if (!baseline || !Array.isArray(baseline.files) || baseline.files.length > cap.maxFiles || !Array.isArray(baseline.omittedPaths)) throw new WorkerWorkspaceError('invalid_workspace', 'Retained baseline is invalid');
  const seen = new Set<string>();
  for (const file of baseline.files) {
    const path = workerRelativePath(file.path);
    if (seen.has(path) || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size < 0 || typeof file.binary !== 'boolean' || typeof file.executable !== 'boolean') throw new WorkerWorkspaceError('invalid_workspace', 'Retained baseline file is invalid');
    seen.add(path);
  }
  const policy: WorkerToolPolicy = { root: directory, ownedPaths, readOnly: value.readOnly, maxFileBytes: cap.maxFileBytes, maxOutputBytes: cap.maxOutputBytes, maxFiles: cap.maxFiles, maxWorkspaceBytes: cap.maxWorkspaceBytes };
  const { sourceRoot: _sourceRoot, dependencies: _dependencies, ...sandboxOptions } = options.sandbox ?? {};
  const sandbox = await WorkerSandbox.create(policy, sandboxOptions, signal);
  return new WorkerWorkspace(options.workspaceId, directory, projectRoot, sandbox, baseline, ownedPaths, value.readOnly, cap, false, manifestPath, true);
}
