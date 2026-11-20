import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, parse, relative, sep } from 'node:path';

const forbidden = new Set(['.ssh', '.gnupg', '.aws', '.azure', '.kube', '.config', '.codex', '.trusty-squire']);
const idPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const tokenPattern = /^[a-f0-9]{64}$/;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export interface WorkerProjectScope { projectRoot: string; projectIdentity: string }
interface Challenge extends WorkerProjectScope { fileName: string; nonce: string; expiresAt: number; device: number; inode: number }
interface Lease extends WorkerProjectScope { expiresAt: number; device: number; inode: number }

export class WorkerScopeError extends Error {
  constructor(readonly code: 'invalid_workspace' | 'permission_denied' | 'expired_scope' | 'busy') {
    super({ invalid_workspace: 'Choose an owned project directory, not a home or credential directory.',
      permission_denied: 'Project access was not proved by the current coding interface.',
      expired_scope: 'The worker project registration expired; reconnect the current project.',
      busy: 'Too many worker project registrations are active.' }[code]);
  }
}

/** A caller must prove it can write inside the project before the daemon reads it.
 * A model-supplied path alone must never grant the daemon's broader host access. */
export class WorkerScopes {
  private challenges = new Map<string, Challenge>();
  private leases = new Map<string, Lease>();
  constructor(private options: { now?: () => number; challengeMs?: number; leaseMs?: number; maximum?: number } = {}) {}
  private now() { return (this.options.now ?? Date.now)(); }
  private prune() {
    const now = this.now();
    for (const [id, value] of this.challenges) if (value.expiresAt <= now) this.challenges.delete(id);
    for (const [id, value] of this.leases) if (value.expiresAt <= now) this.leases.delete(id);
  }
  async challenge(input: unknown) {
    this.prune();
    if (this.challenges.size + this.leases.size >= (this.options.maximum ?? 64)) throw new WorkerScopeError('busy');
    if (typeof input !== 'string' || input.length > 4096 || /[\0\r\n]/.test(input) || !isAbsolute(input)) throw new WorkerScopeError('invalid_workspace');
    let projectRoot: string, device: number, inode: number;
    try {
      projectRoot = await realpath(input);
      const info = await lstat(projectRoot);
      const components = projectRoot.split(sep);
      if (!info.isDirectory() || (process.getuid && info.uid !== process.getuid()) || projectRoot === parse(projectRoot).root
        || projectRoot === await realpath(homedir()) || components.some(part => forbidden.has(part))) throw new Error();
      device = info.dev; inode = info.ino;
    } catch { throw new WorkerScopeError('invalid_workspace'); }
    const challengeId = randomUUID(), fileName = `.grunt-workspace-${challengeId}.proof`, nonce = randomBytes(32).toString('hex');
    const projectIdentity = hash(`${device}:${inode}`);
    this.challenges.set(challengeId, { projectRoot, projectIdentity, fileName, nonce, device, inode, expiresAt: this.now() + (this.options.challengeMs ?? 60000) });
    return { challengeId, fileName, nonce };
  }
  async register(id: unknown) {
    this.prune();
    if (typeof id !== 'string' || !idPattern.test(id)) throw new WorkerScopeError('permission_denied');
    const challenge = this.challenges.get(id);
    this.challenges.delete(id);
    if (!challenge) throw new WorkerScopeError('expired_scope');
    const fileName = join(challenge.projectRoot, challenge.fileName);
    let handle;
    try {
      // The directory itself must still be the same real project, not a swapped symlink.
      if (await realpath(challenge.projectRoot) !== challenge.projectRoot) throw new Error();
      const rootInfo = await lstat(challenge.projectRoot);
      if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || rootInfo.dev !== challenge.device || rootInfo.ino !== challenge.inode) throw new Error();
      const before = await lstat(fileName);
      if (!before.isFile() || before.isSymbolicLink()) throw new Error();
      handle = await open(fileName, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const info = await handle.stat();
      if (!info.isFile() || info.ino !== before.ino || info.dev !== before.dev || info.size !== 64
        || process.getuid && (info.uid !== process.getuid() || (info.mode & 0o777) !== 0o600)) throw new Error();
      const proof = await handle.readFile();
      if (proof.length !== 64 || !timingSafeEqual(proof, Buffer.from(challenge.nonce))) throw new Error();
      await handle.close(); handle = undefined;
      await unlink(fileName);
    } catch { throw new WorkerScopeError('permission_denied'); }
    finally { await handle?.close(); }
    const token = randomBytes(32).toString('hex'), expiresAt = this.now() + (this.options.leaseMs ?? 24 * 60 * 60 * 1000);
    this.leases.set(hash(token), { projectRoot: challenge.projectRoot, projectIdentity: challenge.projectIdentity, device: challenge.device, inode: challenge.inode, expiresAt });
    return { token, expiresAt };
  }
  async resolve(token: unknown): Promise<WorkerProjectScope | undefined> {
    this.prune();
    if (typeof token !== 'string' || !tokenPattern.test(token)) return;
    const lease = this.leases.get(hash(token));
    if (!lease) return;
    try {
      const info = await lstat(lease.projectRoot);
      if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== lease.device || info.ino !== lease.inode
        || await realpath(lease.projectRoot) !== lease.projectRoot) return;
      return { projectRoot: lease.projectRoot, projectIdentity: lease.projectIdentity };
    } catch { return; }
  }
  revoke(token: unknown) {
    return typeof token === 'string' && tokenPattern.test(token) ? this.leases.delete(hash(token)) : false;
  }
  close() { this.challenges.clear(); this.leases.clear(); }
}

export function scopeContains(scope: WorkerProjectScope, other: WorkerProjectScope) {
  return relative(scope.projectRoot, other.projectRoot) === '' && scope.projectIdentity === other.projectIdentity;
}
