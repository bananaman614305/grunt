import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { workerRelativePath, ownsWorkerPath } from './worker-tool-helper.js';

/** Apply only a retained, reviewed artifact in the caller's own filesystem sandbox. */
export interface ApplicableWorkerArtifact {
  files: { path: string; beforeSha256: string | null; afterSha256: string | null;
    content?: string; deleted?: boolean; binary?: boolean; encoding?: 'utf8' | 'base64' }[];
  complete: boolean;
  truncated: boolean;
}
export interface WorkerIntegrationOptions {
  ownedPaths: readonly string[];
  /** A complete artifact from a partially completed job is allowed; truncated artifacts never are. */
  allowPartial?: boolean;
  /** Trusted caller-resolved private journal directory, on the project's filesystem. */
  journalRoot?: string;
}
type Code = 'invalid_artifact' | 'invalid_path' | 'outside_ownership' | 'invalid_project' |
  'invalid_journal' | 'unsupported_filesystem' | 'conflict' | 'busy' | 'cancelled' | 'io_error';
export type WorkerIntegrationResult = {
  ok: boolean; appliedFiles: string[]; code?: Code; conflicts?: string[];
  journalPath?: string; warning?: 'journal_in_project'; rollback?: 'not_needed' | 'complete' | 'partial';
};
class Fault extends Error {
  constructor(readonly code: Code, readonly path?: string) { super(code); }
}
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const MAX_BYTES = 1024 * 1024;
const MAX_FILES = 256;
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const fileFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
const exists = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'EEXIST';
const cancelled = (signal?: AbortSignal) => { if (signal?.aborted) throw new Fault('cancelled'); };
interface Entry { path: string; before: string | null; after: string | null; bytes: Buffer | null;
  parent?: FileHandle; leaf: string; mode: number; backup?: string; installed?: { dev: number; ino: number }; }
interface Sample { digest: string; dev: number; ino: number; mode: number }

function entriesFor(artifact: ApplicableWorkerArtifact, options: WorkerIntegrationOptions): Entry[] {
  if (!artifact || artifact.complete !== true || artifact.truncated !== false || !Array.isArray(artifact.files) ||
      artifact.files.length > MAX_FILES || !options || !Array.isArray(options.ownedPaths) ||
      options.ownedPaths.length < 1 || options.ownedPaths.length > 32) throw new Fault('invalid_artifact');
  let owned: string[];
  try { owned = options.ownedPaths.map(path => workerRelativePath(path)); }
  catch { throw new Fault('invalid_path'); }
  let total = 0;
  const entries = artifact.files.map(file => {
    let path: string;
    try { path = workerRelativePath(file?.path); } catch { throw new Fault('invalid_path'); }
    if (path.split('/').length > 32) throw new Fault('invalid_path');
    if (!ownsWorkerPath(path, owned)) throw new Fault('outside_ownership', path);
    const validHash = (v: unknown) => v === null || (typeof v === 'string' && /^[a-f0-9]{64}$/.test(v));
    if ((file.binary !== undefined && typeof file.binary !== 'boolean') ||
        (file.deleted !== undefined && typeof file.deleted !== 'boolean')) throw new Fault('invalid_artifact', path);
    if (!validHash(file.beforeSha256) || !validHash(file.afterSha256) ||
        (file.beforeSha256 === null && file.afterSha256 === null)) throw new Fault('invalid_artifact', path);
    let bytes: Buffer | null = null;
    if (file.afterSha256 === null) {
      if (file.deleted !== true || file.content !== undefined) throw new Fault('invalid_artifact', path);
    } else {
      if (file.deleted || typeof file.content !== 'string' || file.content.length > MAX_BYTES * 2 ||
          (file.encoding !== undefined && file.encoding !== 'utf8' && file.encoding !== 'base64')) {
        throw new Fault('invalid_artifact', path);
      }
      const base64 = file.binary === true || file.encoding === 'base64';
      bytes = Buffer.from(file.content, base64 ? 'base64' : 'utf8');
      if ((base64 && bytes.toString('base64') !== file.content) || hash(bytes) !== file.afterSha256) {
        throw new Fault('invalid_artifact', path);
      }
      total += bytes.length;
      if (total > MAX_BYTES) throw new Fault('invalid_artifact', path);
    }
    return { path, before: file.beforeSha256, after: file.afterSha256, bytes,
      leaf: path.split('/').at(-1)!, mode: 0o600 };
  });
  const sorted = entries.map(entry => entry.path).sort();
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === sorted[i - 1] || sorted[i]!.startsWith(sorted[i - 1] + '/')) throw new Fault('invalid_artifact');
  }
  return entries;
}

/** Fd-relative directory traversal keeps replaced symlinks outside the write path. */
class Tree {
  readonly handles = new Map<string, FileHandle>();
  readonly created = new Map<string, { dev: number; ino: number }>();
  private prefix = '';
  constructor(readonly rootPath: string) {}
  async open() {
    const stat = await fs.lstat(this.rootPath);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) {
      throw new Fault('invalid_project');
    }
    const root = await fs.open(this.rootPath, directoryFlags);
    this.handles.set('', root);
    const opened = await root.stat();
    if (opened.dev !== stat.dev || opened.ino !== stat.ino) throw new Fault('invalid_project');
    for (const prefix of ['/proc/self/fd', '/dev/fd']) {
      try {
        const anchored = await fs.stat(`${prefix}/${root.fd}/.`);
        if (anchored.dev === stat.dev && anchored.ino === stat.ino) { this.prefix = prefix; break; }
      } catch { /* Try the platform's other descriptor filesystem. */ }
    }
    if (!this.prefix) throw new Fault('unsupported_filesystem');
  }
  at(handle: FileHandle, leaf = '') { return `${this.prefix}/${handle.fd}/${leaf || '.'}`; }
  async parent(path: string, create = false): Promise<FileHandle | undefined> {
    const parts = path.split('/').slice(0, -1);
    let key = '';
    let parent = this.handles.get('')!;
    for (const part of parts) {
      key = key ? `${key}/${part}` : part;
      let child = this.handles.get(key);
      if (!child) {
        try { child = await fs.open(this.at(parent, part), directoryFlags); }
        catch (error) {
          if (!missing(error)) throw new Fault('invalid_path', path);
          if (!create) return undefined;
          let created = false;
          try { await fs.mkdir(this.at(parent, part), { mode: 0o700 }); created = true; }
          catch (error) { if (!exists(error)) throw error; }
          child = await fs.open(this.at(parent, part), directoryFlags);
          if (created) { const stat = await child.stat(); this.created.set(key, { dev: stat.dev, ino: stat.ino }); }
        }
        this.handles.set(key, child);
      }
      // Recheck the visible directory instead of trusting a cached descriptor after a rename.
      const visible = await fs.lstat(this.at(parent, part));
      const held = await child.stat();
      if (!visible.isDirectory() || visible.dev !== held.dev || visible.ino !== held.ino) throw new Fault('conflict', path);
      parent = child;
    }
    return parent;
  }
  async validateRoot() {
    const visible = await fs.lstat(this.rootPath);
    const held = await this.handles.get('')!.stat();
    if (!visible.isDirectory() || visible.dev !== held.dev || visible.ino !== held.ino) throw new Fault('conflict');
  }
  async close() { await Promise.allSettled([...this.handles.values()].map(handle => handle.close())); }
}

async function sample(path: string): Promise<Sample | null> {
  let handle: FileHandle;
  try { handle = await fs.open(path, fileFlags); }
  catch (error) { if (missing(error)) return null; throw new Fault('conflict'); }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Fault('conflict');
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await handle.stat();
    if (length > MAX_BYTES || after.size !== length || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs) {
      throw new Fault('conflict');
    }
    return { digest: hash(bytes.subarray(0, length)), dev: stat.dev, ino: stat.ino, mode: stat.mode & 0o777 };
  } finally { await handle.close(); }
}

async function verify(tree: Tree, entry: Entry) {
  const parent = await tree.parent(entry.path);
  const current = parent ? await sample(tree.at(parent, entry.leaf)) : null;
  if ((current?.digest ?? null) !== entry.before) throw new Fault('conflict', entry.path);
  if (current) entry.mode = current.mode;
}

async function privateJournal(project: string, tree: Tree, requested?: string) {
  let base: string;
  let warning: 'journal_in_project' | undefined;
  const rootStat = await tree.handles.get('')!.stat();
  if (requested !== undefined) {
    if (!isAbsolute(requested)) throw new Fault('invalid_journal');
    base = resolve(requested);
  } else {
    try {
      const git = await fs.lstat(join(project, '.git'));
      if (!git.isDirectory() || git.isSymbolicLink() || (process.getuid && git.uid !== process.getuid())) throw new Error('gitdir');
      base = join(project, '.git', 'grunt-worker-integrations');
    } catch {
      base = join(project, '.grunt-workspace-integrations');
      warning = 'journal_in_project';
    }
  }
  try {
    // Resolve the trusted parent once; an explicit journal may live in a worktree's real gitdir.
    const parentPath = dirname(base);
    const parentStat = await fs.lstat(parentPath);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || parentStat.dev !== rootStat.dev ||
        (process.getuid && parentStat.uid !== process.getuid())) throw new Fault('invalid_journal');
    const parent = await fs.open(parentPath, directoryFlags);
    try {
      const openedParent = await parent.stat();
      if (openedParent.ino !== parentStat.ino || openedParent.dev !== parentStat.dev) throw new Fault('invalid_journal');
      const leaf = base.slice(parentPath.length + 1);
      try { await fs.mkdir(tree.at(parent, leaf), { mode: 0o700 }); } catch (error) { if (!exists(error)) throw error; }
      const handle = await fs.open(tree.at(parent, leaf), directoryFlags);
      const stat = await handle.stat();
      if (stat.dev !== rootStat.dev || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) {
        await handle.close(); throw new Fault('invalid_journal');
      }
      return { base, handle, warning };
    } finally { await parent.close(); }
  } catch { throw new Fault('invalid_journal'); }
}

const queues = new Map<string, Promise<void>>();
export async function applyWorkerArtifact(projectRoot: string, artifact: ApplicableWorkerArtifact,
  options: WorkerIntegrationOptions, signal?: AbortSignal): Promise<WorkerIntegrationResult> {
  let entries: Entry[];
  try { cancelled(signal); entries = entriesFor(artifact, options); }
  catch (error) { return failure(error, 'not_needed'); }
  let project: string;
  try {
    if (!isAbsolute(projectRoot) || (await fs.lstat(projectRoot)).isSymbolicLink()) throw new Fault('invalid_project');
    project = await fs.realpath(projectRoot);
  } catch { return failure(new Fault('invalid_project'), 'not_needed'); }
  const previous = queues.get(project) ?? Promise.resolve();
  let release!: () => void;
  const queued = new Promise<void>(done => { release = done; });
  queues.set(project, queued);
  try { await previous; cancelled(signal); return await applyLocked(project, entries, options, signal); }
  catch (error) { return failure(error, 'not_needed'); }
  finally { release(); if (queues.get(project) === queued) queues.delete(project); }
}

function failure(error: unknown, rollback: 'not_needed' | 'complete' | 'partial', journalPath?: string,
  warning?: 'journal_in_project'): WorkerIntegrationResult {
  const fault = error instanceof Fault ? error : new Fault('io_error');
  return { ok: false, code: fault.code, appliedFiles: [], rollback,
    ...(fault.path ? { conflicts: [fault.path] } : {}), ...(journalPath ? { journalPath } : {}), ...(warning ? { warning } : {}) };
}

async function applyLocked(project: string, entries: Entry[], options: WorkerIntegrationOptions, signal?: AbortSignal): Promise<WorkerIntegrationResult> {
  const tree = new Tree(project);
  let baseHandle: FileHandle | undefined;
  let journal: FileHandle | undefined;
  let lock: FileHandle | undefined;
  let lockPath: string | undefined;
  let journalPath: string | undefined;
  let warning: 'journal_in_project' | undefined;
  let recordState: ((state: string) => Promise<void>) | undefined;
  const touched: Entry[] = [];
  const token = randomUUID();
  try {
    await tree.open();
    for (const entry of entries) { cancelled(signal); await verify(tree, entry); }
    cancelled(signal);
    if (!entries.length) return { ok: true, appliedFiles: [] };
    const base = await privateJournal(project, tree, options.journalRoot);
    baseHandle = base.handle; warning = base.warning;
    lockPath = tree.at(baseHandle, `lock-${hash(Buffer.from(project))}`);
    try { lock = await fs.open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (error) { if (exists(error)) throw new Fault('busy'); throw error; }
    await lock.writeFile(JSON.stringify({ token, pid: process.pid }));
    await lock.sync();
    for (const entry of entries) { cancelled(signal); await verify(tree, entry); }
    await tree.validateRoot();
    const journalName = `transaction-${token}`;
    await fs.mkdir(tree.at(baseHandle, journalName), { mode: 0o700 });
    journal = await fs.open(tree.at(baseHandle, journalName), directoryFlags);
    journalPath = join(base.base, journalName);
    const writeJournal = recordState = async (state: string) => {
      const data = JSON.stringify({ schema: 'grunt-worker-integration/v1', state, project,
        files: entries.map((entry, index) => ({ path: entry.path, beforeSha256: entry.before, afterSha256: entry.after,
          before: entry.before !== null ? `before-${index}` : undefined, after: entry.bytes ? `after-${index}` : undefined })) });
      const handle = await fs.open(tree.at(journal!, `journal-${randomUUID()}.json`), 'wx', 0o600);
      try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
      await journal!.sync();
    };
    for (const [index, entry] of entries.entries()) {
      cancelled(signal);
      if (entry.bytes) {
        const handle = await fs.open(tree.at(journal, `after-${index}`), 'wx', entry.mode);
        try { await handle.chmod(entry.mode); await handle.writeFile(entry.bytes); await handle.sync(); } finally { await handle.close(); }
      }
    }
    await writeJournal('prepared');
    // No project content changes until every baseline and staged content has been checked.
    for (const entry of entries) { cancelled(signal); await verify(tree, entry); }
    for (const [index, entry] of entries.entries()) {
      cancelled(signal); await tree.validateRoot();
      await verify(tree, entry);
      entry.parent = (await tree.parent(entry.path, true))!;
      const target = tree.at(entry.parent!, entry.leaf);
      touched.push(entry);
      if (entry.before !== null) {
        entry.backup = `before-${index}`;
        await fs.rename(target, tree.at(journal, entry.backup));
        const captured = await sample(tree.at(journal, entry.backup));
        if (captured?.digest !== entry.before) throw new Fault('conflict', entry.path);
      }
      if (entry.bytes) {
        entry.installed = (await sample(tree.at(journal, `after-${index}`)))!;
        try { await fs.link(tree.at(journal, `after-${index}`), target); }
        catch (error) { if (exists(error)) throw new Fault('conflict', entry.path); throw error; }
        const installed = await sample(target);
        if (!installed || installed.digest !== entry.after) throw new Fault('conflict', entry.path);
        entry.installed = installed;
      }
    }
    cancelled(signal);
    await tree.validateRoot();
    for (const entry of entries) {
      await tree.parent(entry.path);
      const current = await sample(tree.at(entry.parent!, entry.leaf));
      if ((current?.digest ?? null) !== entry.after || (entry.installed &&
          (current?.ino !== entry.installed.ino || current.dev !== entry.installed.dev))) throw new Fault('conflict', entry.path);
    }
    await writeJournal('applied');
    return { ok: true, appliedFiles: entries.map(entry => entry.path), journalPath, ...(warning ? { warning } : {}) };
  } catch (error) {
    let rollback: 'not_needed' | 'complete' | 'partial' = touched.length ? 'complete' : 'not_needed';
    // Never overwrite a concurrently edited/replaced target. Every captured original remains in the private journal.
    for (const [index, entry] of [...touched].reverse().entries()) {
      if (!entry.parent || !journal) continue;
      const target = tree.at(entry.parent, entry.leaf);
      try {
        if (entry.installed) {
          const current = await sample(target);
          if (current && current.ino === entry.installed.ino && current.dev === entry.installed.dev && current.digest === entry.after) {
            const displaced = tree.at(journal, `rollback-${index}`);
            await fs.rename(target, displaced);
            const moved = await sample(displaced);
            if (!moved || moved.ino !== entry.installed.ino || moved.dev !== entry.installed.dev || moved.digest !== entry.after) {
              // The rename captured a racing user replacement: restore exclusively, keep its backup either way.
              try { await fs.link(displaced, target); } catch { /* Preserve the new visible target and the captured data. */ }
              rollback = 'partial'; continue;
            }
          } else if (current) { rollback = 'partial'; continue; }
        }
        if (entry.backup) {
          try { await fs.link(tree.at(journal, entry.backup), target); }
          catch { rollback = 'partial'; }
        }
      } catch { rollback = 'partial'; }
    }
    for (const [path, created] of [...tree.created].reverse()) {
      try {
        const parent = await tree.parent(path);
        if (parent) {
          const target = tree.at(parent, path.split('/').at(-1)!);
          const current = await fs.lstat(target);
          if (current.isDirectory() && current.dev === created.dev && current.ino === created.ino) await fs.rmdir(target);
        }
      } catch { /* Only empty directories are eligible for removal. */ }
    }
    try { await recordState?.(rollback === 'partial' ? 'recovery_required' : 'rolled_back'); } catch { /* Keep the prepared journal if the disk refuses further writes. */ }
    return failure(error, rollback, journalPath, warning);
  } finally {
    if (lock && lockPath) {
      try {
        const visible = await fs.lstat(lockPath);
        const held = await lock.stat();
        if (visible.ino === held.ino && visible.dev === held.dev) await fs.unlink(lockPath);
      } catch { /* A changed lock is never force-removed. */ }
      await lock.close();
    }
    await journal?.close(); await baseHandle?.close(); await tree.close();
  }
}
