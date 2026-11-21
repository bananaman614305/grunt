import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readdir, realpath, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const MAX_BYTES = 512 * 1024, KEEP_REVISIONS = 8;
const revisionName = /^[0-9]{16}\.json$/;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const invalid = () => new Error('Invalid or unsafe Grunt coordination state.');
const conflict = () => new Error('Coordination revision conflict; read status and reconcile before dispatching.');
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
async function safeParents(path: string) {
  for (let current = path; ; current = dirname(current)) {
    try { if ((await lstat(current)).isSymbolicLink()) throw invalid(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (dirname(current) === current) break;
  }
}
async function privateDirectory(path: string) {
  await safeParents(path); await mkdir(path, { recursive: true, mode: 0o700 }); await safeParents(path);
  const st = await lstat(path);
  if (!st.isDirectory() || process.getuid && st.uid !== process.getuid() || process.platform !== 'win32' && (st.mode & 0o077)) throw invalid();
}
export interface CoordinationRecord { revision: number; plan: unknown }
/** Private advisory coordination memory. Exclusive immutable revisions arbitrate admission intent. */
export class CoordinationStore {
  private constructor(private options: { root: string; device: number; inode: number; identity: string; session: string; directory: string }) {}
  static async open(options: { projectRoot: string; sessionId: string; stateDirectory?: string }) {
    if (!isAbsolute(options.projectRoot) || typeof options.sessionId !== 'string' || !options.sessionId.trim() || options.sessionId.includes('\0') || Buffer.byteLength(options.sessionId) > 256) throw invalid();
    const root = await realpath(options.projectRoot), st = await lstat(root);
    if (!st.isDirectory() || process.getuid && st.uid !== process.getuid()) throw invalid();
    const state = options.stateDirectory ?? process.env.GRUNT_COORDINATION_STATE_DIR ?? join(homedir(), '.cache', 'grunt', 'coordination');
    if (!isAbsolute(state)) throw invalid();
    const placement = relative(root, resolve(state));
    if (!placement || placement !== '..' && !placement.startsWith('..' + sep) && !isAbsolute(placement)) throw invalid();
    const identity = hash(`${root}:${st.dev}:${st.ino}`), session = hash(options.sessionId), base = resolve(state);
    await privateDirectory(base); const project = join(base, identity); await privateDirectory(project);
    const directory = join(project, session); await privateDirectory(directory);
    return new CoordinationStore({ root, device: st.dev, inode: st.ino, identity, session, directory });
  }
  private async scope() {
    const st = await lstat(this.options.root);
    if (!st.isDirectory() || st.isSymbolicLink() || st.dev !== this.options.device || st.ino !== this.options.inode || await realpath(this.options.root) !== this.options.root) throw invalid();
    await privateDirectory(this.options.directory);
  }
  private async revisions() {
    const names = await readdir(this.options.directory);
    if (names.length > 128) throw invalid();
    return names.filter(name => revisionName.test(name)).sort();
  }
  async read(): Promise<CoordinationRecord | undefined> {
    await this.scope();
    for (let attempt = 0; attempt < 3; attempt++) {
      const name = (await this.revisions()).at(-1); if (!name) return;
      let file;
      try { file = await open(join(this.options.directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw invalid(); }
      try {
        let before = await file.stat({ bigint: true });
        if (before.nlink === 2n) {
          // A crash may leave the fully synced publisher's private temporary link.
          // Only unlink that exact inode inside this private session directory;
          // arbitrary external hardlinks still fail the nlink check below.
          for (const pending of await readdir(this.options.directory)) {
            if (!/^\.pending-[a-f0-9-]{36}$/.test(pending)) continue;
            const path = join(this.options.directory, pending);
            const candidate = await lstat(path, { bigint: true }).catch(() => undefined);
            if (candidate?.isFile() && candidate.ino === before.ino && candidate.dev === before.dev && candidate.uid === before.uid && !(candidate.mode & 0o077n)) await unlink(path).catch(() => {});
          }
          before = await file.stat({ bigint: true });
        }
        if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(MAX_BYTES) || process.getuid && Number(before.uid) !== process.getuid() || process.platform !== 'win32' && (before.mode & 0o077n)) throw invalid();
        const bytes = await file.readFile(), after = await file.stat({ bigint: true });
        if (bytes.length > MAX_BYTES || before.size !== after.size || before.ctimeNs !== after.ctimeNs || before.mtimeNs !== after.mtimeNs) throw invalid();
        const record = object(JSON.parse(bytes.toString('utf8')));
        if (Object.keys(record).some(key => !['version', 'revision', 'identity', 'session', 'plan'].includes(key)) || record.version !== 1 || record.identity !== this.options.identity || record.session !== this.options.session
          || record.revision !== Number(name.slice(0, 16)) || !Number.isSafeInteger(record.revision) || Number(record.revision) < 1) throw invalid();
        await this.scope(); return { revision: Number(record.revision), plan: record.plan };
      } catch (error) { if (error instanceof SyntaxError) throw invalid(); throw error; }
      finally { await file.close(); }
    }
    throw conflict();
  }
  async write(plan: unknown, expectedRevision: number) {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision >= 999999999999999) throw invalid();
    await this.scope(); const current = await this.read();
    if ((current?.revision ?? 0) !== expectedRevision) throw conflict();
    const revision = expectedRevision + 1, bytes = JSON.stringify({ version: 1, revision, identity: this.options.identity, session: this.options.session, plan });
    if (Buffer.byteLength(bytes) > MAX_BYTES) throw invalid();
    const temporary = join(this.options.directory, `.pending-${randomUUID()}`), target = join(this.options.directory, String(revision).padStart(16, '0') + '.json');
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await file.writeFile(bytes); await file.sync(); await this.scope();
      try { await link(temporary, target); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw conflict(); throw error; }
    } finally { await file.close(); await unlink(temporary).catch(() => {}); }
    if (process.platform !== 'win32') {
      const directory = await open(this.options.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { await directory.sync(); } finally { await directory.close(); }
    }
    // Retention can free an old exclusive name while a suspended writer still
    // holds the previous head. Publishing that name is not admission: the head
    // must still be our revision after the directory entry is durable. Normal
    // pruning never removes the highest revision, so an ABA cannot pass here.
    if (Number((await this.revisions()).at(-1)?.slice(0, 16)) !== revision) throw conflict();
    // Bound disk use. Never delete the current revision or another writer's newer entry.
    const old = (await this.revisions()).filter(name => Number(name.slice(0, 16)) <= revision - KEEP_REVISIONS);
    await Promise.all(old.map(name => unlink(join(this.options.directory, name)).catch(() => {})));
    return revision;
  }
}
