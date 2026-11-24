import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { bindReview, parseReviewRecord } from './publication-review.js';

const sha = /^[a-f0-9]{40}$/, digest = /^[a-f0-9]{64}$/, id = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const branch = /^(?!\/)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[a-zA-Z0-9][a-zA-Z0-9._/-]{0,120}(?<!\/)(?<!\.lock)$/;
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
export interface PublicationPolicy {
  version: 1; projectRoot: string; repository: string; base: string; headPrefix: string;
  requiredChecks: string[]; reviewPaths: string[]; artifactDirectory: string; pagesBranch: string;
  /** Operator-owned permission, never supplied in a model tool call. */
  allowMerge: boolean; allowDeploy: boolean;
}
export interface PublicationSnapshot {
  projectRoot: string; head: string; treeDigest: string; artifactDigest: string; clean: boolean;
  branch: string; baseHead: string; baseIsAncestor: boolean; gitTree: string;
}
/** A host verifier returns this projection only after authenticating its execution receipt. */
export interface PublicationVerification {
  verified: true; id: string; projectRoot: string; head: string; treeDigest: string; artifactDigest: string;
  checkId: string; mode: 'release'; state: 'completed'; exitCode: 0; unchanged: true;
}
/** Review evidence recorded by the builder over the channel (the host runs no reviewer). Records written before that
 * carry extra reviewer fields; only `verdict` is read from them. */
export interface PublicationReview {
  source: 'builder'; verdict: 'approve' | 'changes_requested'; head: string; gitTree: string;
  treeDigest: string; artifactDigest: string; summary: string; recordedAt: number;
}
export interface PublicationRequest { head: string; branch: string; title: string; body: string; verificationIds: string[] }
export type PublicationPhase = 'awaiting_review' | 'reviewing' | 'ready' | 'publishing' | 'pull_request' | 'merging' | 'deploying' | 'deployed' | 'blocked';
export interface PublicationRecord {
  version: 1; id: string; createdAt: number; updatedAt: number; phase: PublicationPhase;
  policyDigest?: string;
  request: PublicationRequest; snapshot: PublicationSnapshot; verificationIds: string[];
  review?: PublicationReview; pullRequest?: { number: number; url: string }; mergeCommit?: string; pagesCommit?: string; deploymentUrl?: string;
  reason?: 'stale_evidence' | 'verification_required' | 'review_required' | 'changes_requested' | 'operation_interrupted' | 'policy_denied';
}
export interface PublicationTransport {
  ensurePullRequest(record: PublicationRecord, policy: PublicationPolicy, signal?: AbortSignal): Promise<{ number: number; url: string }>;
  merge(record: PublicationRecord, policy: PublicationPolicy, signal?: AbortSignal): Promise<string>;
  deploy(record: PublicationRecord, policy: PublicationPolicy, signal?: AbortSignal): Promise<{ commit: string; url?: string }>;
}
export interface PublicationOptions {
  directory: string; policy: PublicationPolicy;
  capture(): Promise<PublicationSnapshot>;
  /** IDs resolve against host-owned signed receipt storage; callers cannot supply attestation JSON. */
  verification(id: string): Promise<PublicationVerification | undefined>;
  /** Host-side screening of the exact candidate (private-looking paths) before a builder review may be recorded. */
  screen?(record: PublicationRecord): Promise<void>;
  transport: PublicationTransport; now?: () => number;
}

export function publicationPolicy(value: PublicationPolicy): PublicationPolicy {
  if (value.version !== 1 || !isAbsolute(value.projectRoot) || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}\/[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(value.repository)
    || !branch.test(value.base) || !branch.test(value.pagesBranch) || value.base === value.pagesBranch
    || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,80}\/$/.test(value.headPrefix) || value.headPrefix.includes('..')
    || !Array.isArray(value.requiredChecks) || !value.requiredChecks.length || value.requiredChecks.length > 32
    || new Set(value.requiredChecks).size !== value.requiredChecks.length || value.requiredChecks.some(x => !/^[a-zA-Z0-9_-]{1,80}$/.test(x))
    || !Array.isArray(value.reviewPaths) || !value.reviewPaths.length || value.reviewPaths.length > 32
    || [...value.reviewPaths, value.artifactDirectory].some(x => !safeRelative(x))
    || typeof value.allowMerge !== 'boolean' || typeof value.allowDeploy !== 'boolean') throw new Error('Invalid trusted publication policy.');
  return structuredClone(value);
}
export function safeRelative(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length < 4096 && !isAbsolute(value)
    && !value.includes('\\') && !value.includes('\0') && value.split('/').every(x => x !== '.' && x !== '..' && x !== '' && x !== '.git');
}
function request(value: unknown, policy: PublicationPolicy): PublicationRequest {
  const v = record(value);
  if (Object.keys(v).some(x => !['head', 'branch', 'title', 'body', 'verificationIds'].includes(x))
    || typeof v.head !== 'string' || !sha.test(v.head) || typeof v.branch !== 'string' || !branch.test(v.branch)
    || !v.branch.startsWith(policy.headPrefix) || v.branch === policy.base || v.branch === policy.pagesBranch
    || typeof v.title !== 'string' || !v.title.trim() || v.title.length > 160 || /[\r\n\0]/.test(v.title)
    || typeof v.body !== 'string' || !v.body.trim() || v.body.length > 45000 || v.body.includes('\0')
    || !Array.isArray(v.verificationIds) || v.verificationIds.length > 32 || !v.verificationIds.length
    || v.verificationIds.some(x => typeof x !== 'string' || !id.test(x)) || new Set(v.verificationIds).size !== v.verificationIds.length) throw new Error('Invalid release request; policy and evidence are supplied by the trusted interface.');
  return { head: v.head, branch: v.branch, title: v.title, body: v.body, verificationIds: v.verificationIds as string[] };
}
function snapshot(value: PublicationSnapshot, policy: PublicationPolicy, merged = false) {
  if (value.projectRoot !== policy.projectRoot || !sha.test(value.head) || !sha.test(value.baseHead) || !sha.test(value.gitTree)
    || !digest.test(value.treeDigest) || !digest.test(value.artifactDigest) || value.clean !== true || !merged && value.baseIsAncestor !== true
    || !branch.test(value.branch) || !value.branch.startsWith(policy.headPrefix)) throw new Error('Publication requires a clean, fully committed project containing the current base.');
  return { projectRoot: value.projectRoot, head: value.head, treeDigest: value.treeDigest, artifactDigest: value.artifactDigest,
    clean: value.clean, branch: value.branch, baseHead: value.baseHead, baseIsAncestor: value.baseIsAncestor, gitTree: value.gitTree };
}
function equal(a: PublicationSnapshot, b: PublicationSnapshot) { return JSON.stringify(a) === JSON.stringify(b); }
async function privateDirectory(path: string) {
  await mkdir(path, { mode: 0o700, recursive: true });
  const st = await lstat(path);
  if (!st.isDirectory() || st.isSymbolicLink() || process.getuid && st.uid !== process.getuid() || (st.mode & 0o077) !== 0) throw new Error('Publication state requires a private owned directory.');
}
async function read(path: string): Promise<PublicationRecord> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const st = await file.stat(); if (!st.isFile() || st.size > 128 * 1024 || process.getuid && st.uid !== process.getuid() || (st.mode & 0o077) !== 0) throw new Error('Unsafe publication record.'); return JSON.parse(await file.readFile('utf8')) as PublicationRecord; }
  finally { await file.close(); }
}
interface Lease { ownerPid: number; token: string; startTicks?: string }
function lease(value: unknown): Lease {
  const v = record(value);
  if (!Number.isSafeInteger(v.ownerPid) || Number(v.ownerPid) <= 0 || typeof v.token !== 'string' || !id.test(v.token)
    || v.startTicks !== undefined && (typeof v.startTicks !== 'string' || !/^\d+$/.test(v.startTicks))) throw new Error('Invalid publication owner lease; inspect it before recovery.');
  return { ownerPid: Number(v.ownerPid), token: v.token, ...(typeof v.startTicks === 'string' ? { startTicks: v.startTicks } : {}) };
}
async function startTicks(pid: number) { try { return (await readFile(`/proc/${pid}/stat`, 'utf8')).split(') ').at(-1)?.split(' ')[19]; } catch { return undefined; } }
async function alive(owner: Lease) {
  try { process.kill(owner.ownerPid, 0); } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
  const ticks = owner.startTicks ? await startTicks(owner.ownerPid) : undefined;
  return !owner.startTicks || ticks === undefined || ticks === owner.startTicks;
}
async function exclusive(path: string, value: unknown) {
  const staged = join(dirname(path), '.owner-' + randomUUID());
  try { await writeFile(staged, JSON.stringify(value), { mode: 0o600, flag: 'wx' }); await link(staged, path); }
  finally { await unlink(staged).catch(() => {}); }
}
async function recoverLock(directory: string, path: string, previous: Lease, next: Lease) {
  if (await alive(previous)) throw new Error('Publication already has a live advancement owner.');
  const claims = join(directory, 'lock-claims'); await privateDirectory(claims);
  let observed = previous;
  for (let depth = 0; depth < 128; depth++) {
    const claim = join(claims, createHash('sha256').update(JSON.stringify(observed)).digest('hex') + '.json');
    try { await exclusive(claim, next); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      observed = lease(await read(claim));
      if (await alive(observed)) throw new Error('Another publication process is recovering this owner.');
      if (depth === 127) throw new Error('Publication owner recovery limit exceeded.');
    }
  }
  const current = lease(await read(path));
  if (current.token !== previous.token || await alive(current)) throw new Error('Publication owner changed during recovery.');
  await unlink(path); await exclusive(path, next);
}
export function publicationView(value: PublicationRecord) {
  return { id: value.id, head: value.snapshot.head, phase: value.phase, updatedAt: value.updatedAt,
    ...(value.reason ? { reason: value.reason } : {}), ...(value.pullRequest ? { pullRequest: value.pullRequest } : {}),
    ...(value.mergeCommit ? { mergeCommit: value.mergeCommit } : {}), ...(value.pagesCommit ? { pagesCommit: value.pagesCommit } : {}),
    ...(value.deploymentUrl ? { deploymentUrl: value.deploymentUrl } : {}) };
}

/** Host-owned queue. Model tools submit intent/receipt IDs; they cannot mint review or test authority. */
export class PublicationQueue {
  readonly policy: PublicationPolicy;
  private constructor(private options: PublicationOptions) { this.policy = publicationPolicy(options.policy); }
  static async open(options: PublicationOptions) {
    const policy = publicationPolicy(options.policy), project = await realpath(policy.projectRoot);
    if (project !== policy.projectRoot || !isAbsolute(options.directory)) throw new Error('Publication paths must be canonical and host supplied.');
    const relativeState = relative(project, options.directory);
    if (!relativeState || !(relativeState === '..' || relativeState.startsWith('../') || isAbsolute(relativeState))) throw new Error('Keep publication authority outside the project.');
    await privateDirectory(options.directory);
    if (await realpath(options.directory) !== options.directory) throw new Error('Publication authority must not traverse symlinks.');
    return new PublicationQueue({ ...options, policy });
  }
  private path(value: string) { if (!id.test(value)) throw new Error('Provide a release UUID.'); return join(this.options.directory, value + '.json'); }
  private async save(value: PublicationRecord) {
    value.updatedAt = (this.options.now ?? Date.now)();
    const target = this.path(value.id), temp = join(dirname(target), '.release-' + randomUUID());
    try { await writeFile(temp, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx' }); await rename(temp, target); }
    finally { await unlink(temp).catch(() => {}); }
  }
  private async locked<T>(action: () => Promise<T>) {
    const path = join(this.options.directory, 'queue.lock'), ticks = await startTicks(process.pid), owner: Lease = { ownerPid: process.pid, token: randomUUID(), ...(ticks ? { startTicks: ticks } : {}) };
    try { await exclusive(path, owner); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; await recoverLock(this.options.directory, path, lease(await read(path)), owner); }
    try { return await action(); }
    finally { const current = lease(await read(path)); if (current.token === owner.token) await unlink(path); }
  }
  private async verified(value: PublicationRecord) {
    const expected = value.snapshot, found = new Set<string>();
    for (const evidenceId of value.verificationIds) {
      const evidence = await this.options.verification(evidenceId);
      if (!evidence || evidence.verified !== true || evidence.id !== evidenceId || evidence.mode !== 'release' || evidence.state !== 'completed'
        || evidence.exitCode !== 0 || evidence.unchanged !== true || evidence.projectRoot !== expected.projectRoot || evidence.head !== expected.head
        || evidence.treeDigest !== expected.treeDigest || evidence.artifactDigest !== expected.artifactDigest || !this.policy.requiredChecks.includes(evidence.checkId)) return false;
      if (found.has(evidence.checkId)) return false;
      found.add(evidence.checkId);
    }
    return this.policy.requiredChecks.every(check => found.has(check));
  }
  private policyDigest() { return createHash('sha256').update(JSON.stringify(this.policy)).digest('hex'); }
  async prepare(input: unknown, requestId?: string) {
    return this.locked(async () => {
      const parsed = request(input, this.policy), releaseId = requestId ?? randomUUID();
      const target = this.path(releaseId);
      try {
        const previous = await read(target);
        if (previous.id !== releaseId || previous.policyDigest !== this.policyDigest() || JSON.stringify(previous.request) !== JSON.stringify(parsed)) throw new Error('Release request ID was already used for different intent or policy.');
        return publicationView(previous);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const captured = snapshot(await this.options.capture(), this.policy);
      if (parsed.head !== captured.head || parsed.branch !== captured.branch) throw new Error('Release request does not match the current committed head.');
      const now = (this.options.now ?? Date.now)(), value: PublicationRecord = { version: 1, id: releaseId, policyDigest: this.policyDigest(), createdAt: now, updatedAt: now,
        phase: 'awaiting_review', request: parsed, snapshot: captured, verificationIds: parsed.verificationIds };
      if (!await this.verified(value)) { value.phase = 'blocked'; value.reason = 'verification_required'; }
      await this.save(value); return publicationView(value);
    });
  }
  /** Records the builder's own review of the exact verified candidate. Recording is once per release; a repeat of the identical record is a no-op. */
  async recordReview(releaseId: string, input: unknown) {
    return this.locked(async () => {
      const review = parseReviewRecord(input);
      if (review.id !== releaseId) throw new Error('Invalid review record.');
      const value = await read(this.path(releaseId));
      if (value.version !== 1 || value.id !== releaseId || value.policyDigest !== this.policyDigest()) throw new Error('Invalid retained publication record or changed publication policy.');
      if (value.review && value.review.source === 'builder' && value.review.verdict === review.verdict && value.review.head === review.head
        && value.review.gitTree === review.gitTree && value.review.summary === review.summary) return publicationView(value);
      if (value.phase !== 'awaiting_review' || value.review) throw new Error('A review can be recorded once, while the verified release awaits review.');
      const bound = bindReview(value, review, (this.options.now ?? Date.now)());
      const current = snapshot(await this.options.capture(), this.policy);
      if (!equal(current, value.snapshot)) { value.phase = 'blocked'; value.reason = 'stale_evidence'; await this.save(value); return publicationView(value); }
      if (!await this.verified(value)) { value.phase = 'blocked'; value.reason = 'verification_required'; await this.save(value); return publicationView(value); }
      await this.options.screen?.(structuredClone(value));
      value.review = bound;
      if (bound.verdict === 'approve') value.phase = 'ready'; else { value.phase = 'blocked'; value.reason = 'changes_requested'; }
      await this.save(value); return publicationView(value);
    });
  }
  async status(releaseId: string) { return publicationView(await read(this.path(releaseId))); }
  async advance(releaseId: string, signal?: AbortSignal) {
    return this.locked(async () => {
      const value = await read(this.path(releaseId));
      if (value.version !== 1 || value.id !== releaseId || value.policyDigest !== this.policyDigest()) throw new Error('Invalid retained publication record or changed publication policy.');
      if (value.phase === 'deployed' || value.phase === 'blocked') return publicationView(value);
      signal?.throwIfAborted();
      // After merging the original local checkout must still be the reviewed head; only the remote base advances.
      const current = snapshot(await this.options.capture(), this.policy, !!value.mergeCommit || value.phase === 'merging');
      const expected = value.mergeCommit ? { ...value.snapshot, baseHead: value.mergeCommit, baseIsAncestor: current.baseIsAncestor }
        : value.phase === 'merging' ? { ...value.snapshot, baseHead: current.baseHead, baseIsAncestor: current.baseIsAncestor } : value.snapshot;
      if (!equal(current, expected)) { value.phase = 'blocked'; value.reason = 'stale_evidence'; await this.save(value); return publicationView(value); }
      if (!await this.verified(value)) { value.phase = 'blocked'; value.reason = 'verification_required'; await this.save(value); return publicationView(value); }
      if (value.phase === 'reviewing') { value.phase = 'blocked'; value.reason = 'operation_interrupted'; await this.save(value); return publicationView(value); }
      // Nothing runs here: the builder records its review with `recordReview`, then the release is ready or blocked.
      if (value.phase === 'awaiting_review') return publicationView(value);
      if (value.review?.verdict !== 'approve') { value.phase = 'blocked'; value.reason = 'review_required'; await this.save(value); return publicationView(value); }
      if (value.phase === 'ready' || value.phase === 'publishing') {
        value.phase = 'publishing'; await this.save(value);
        const pr = await this.options.transport.ensurePullRequest(value, this.policy, signal);
        if (!Number.isSafeInteger(pr.number) || pr.number < 1 || pr.url !== `https://github.com/${this.policy.repository}/pull/${pr.number}`) throw new Error('Publication returned an unexpected pull request.');
        value.pullRequest = pr; value.phase = 'pull_request'; await this.save(value); return publicationView(value);
      }
      if (value.phase === 'pull_request' || value.phase === 'merging') {
        if (!this.policy.allowMerge) { value.phase = 'blocked'; value.reason = 'policy_denied'; await this.save(value); return publicationView(value); }
        value.phase = 'merging'; await this.save(value);
        const commit = await this.options.transport.merge(value, this.policy, signal);
        if (!sha.test(commit)) throw new Error('Invalid merge receipt.');
        value.mergeCommit = commit; value.phase = 'deploying'; await this.save(value); return publicationView(value);
      }
      if (value.phase === 'deploying') {
        if (!this.policy.allowDeploy) { value.phase = 'blocked'; value.reason = 'policy_denied'; await this.save(value); return publicationView(value); }
        const deployed = await this.options.transport.deploy(value, this.policy, signal);
        if (!sha.test(deployed.commit) || deployed.url !== undefined && !/^https:\/\/[a-zA-Z0-9.-]+\.github\.io\/[a-zA-Z0-9._/-]*$/.test(deployed.url)) throw new Error('Invalid deployment receipt.');
        value.pagesCommit = deployed.commit;
        if (deployed.url) { value.deploymentUrl = deployed.url; value.phase = 'deployed'; }
        await this.save(value); return publicationView(value);
      }
      throw new Error('Unknown publication phase.');
    });
  }
}

/** Stable marker permits reconciliation after a network reply is lost, without replaying a different release. */
export const publicationMarker = (value: PublicationRecord, kind: 'merge' | 'pages') => `Grunt ${kind} ${value.id}\n\nsource=${value.snapshot.head}\nartifact=${value.snapshot.artifactDigest}`;
export const publicationBodyDigest = (value: PublicationRequest) => createHash('sha256').update(value.body).digest('hex');
