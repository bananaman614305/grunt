import { randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { cp, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { authenticVerificationReceipt, captureVerificationState, readVerificationReceipt, sameVerificationState, signVerificationReceipt, verificationCommandDigest, verificationPlanDigest, verifyReleaseReceipts, writeVerificationReceipt } from './verification.js';
import type { VerificationPlan, VerificationReceipt, VerificationState } from './verification.js';

const execute = promisify(execFile);
const ids = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const names = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/;
const hash = /^[a-f0-9]{64}$/;
const head = /^[a-f0-9]{40}$/;
const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const inside = (root: string, path: string) => path === root || relative(root, path) !== '..' && !relative(root, path).startsWith('..' + sep) && !isAbsolute(relative(root, path));
const safeError = () => new Error('Invalid or unsafe verification broker request or authority state.');
export interface VerificationBrokerRequest { version: 1; id: string; planId: string; checkId: string; expectedHead: string; expectedTreeDigest: string }
export interface VerificationBrokerStatus { version: 1; id: string; state: 'queued' | 'running' | 'completed' | 'failed'; checkId: string; planId: string; code?: 'execution_failed' | 'inputs_changed' | 'interrupted' | 'capture_failed'; receipt?: VerificationReceipt; ownerPid?: number; ownerStartTicks?: string; completedAt?: number }
export interface VerificationBrokerRun { id: string; command: string; projectRoot: string; workspaceRoot: string; timeoutMs: number; signal: AbortSignal }
/** A trusted host supplies the sandbox executor. This function is never received from the model or read from its outbox. */
export type VerificationBrokerRunner = (request: VerificationBrokerRun) => Promise<{ exitCode: number }>;
export interface VerificationBrokerOptions { projectRoot: string; authorityDirectory: string; plans: readonly VerificationPlan[]; runner: VerificationBrokerRunner; environmentDigest: string; now?: () => number }

export function parseVerificationBrokerRequest(value: unknown): VerificationBrokerRequest {
  const v = object(value);
  if (Object.keys(v).length !== 6 || Object.keys(v).some(k => !['version', 'id', 'planId', 'checkId', 'expectedHead', 'expectedTreeDigest'].includes(k))
    || v.version !== 1 || typeof v.id !== 'string' || !ids.test(v.id) || typeof v.planId !== 'string' || !names.test(v.planId)
    || typeof v.checkId !== 'string' || !names.test(v.checkId) || typeof v.expectedHead !== 'string' || !head.test(v.expectedHead)
    || typeof v.expectedTreeDigest !== 'string' || !hash.test(v.expectedTreeDigest)) throw safeError();
  return v as unknown as VerificationBrokerRequest;
}
async function directory(path: string) {
  if (!isAbsolute(path) || resolve(path) !== path) throw safeError();
  await mkdir(path, { recursive: true, mode: 0o700 });
  const st = await lstat(path);
  if (!st.isDirectory() || st.isSymbolicLink() || process.getuid && st.uid !== process.getuid() || (st.mode & 0o077) !== 0 || await realpath(path) !== path) throw safeError();
}
async function readJSON(path: string, limit = 128 * 1024): Promise<unknown> {
  const f = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = await f.stat();
    if (!st.isFile() || process.getuid && st.uid !== process.getuid() || (st.mode & 0o077) !== 0 || st.size > limit) throw safeError();
    const bytes = Buffer.alloc(limit + 1); const read = await f.read(bytes, 0, bytes.length, 0); const after = await f.stat();
    if (read.bytesRead > limit || read.bytesRead !== st.size || after.size !== st.size || after.mtimeMs !== st.mtimeMs || after.ctimeMs !== st.ctimeMs) throw safeError();
    return JSON.parse(bytes.subarray(0, read.bytesRead).toString('utf8'));
  } finally { await f.close(); }
}
async function atomic(path: string, value: unknown) {
  const temporary = join(dirname(path), `.broker-${randomUUID()}.tmp`);
  try { await writeFile(temporary, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 }); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}
async function keyFile(path: string) {
  try { const f = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); try { await f.writeFile(randomBytes(32)); await f.sync(); } finally { await f.close(); } }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
  const f = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { const st = await f.stat(); if (!st.isFile() || st.nlink !== 1 || process.getuid && st.uid !== process.getuid() || (st.mode & 0o077) !== 0 || st.size !== 32) throw safeError(); return new Uint8Array(await f.readFile()); }
  finally { await f.close(); }
}
async function startTicks(pid: number) { try { return (await readFile(`/proc/${pid}/stat`, 'utf8')).split(') ').slice(1).join(') ').split(' ')[19]; } catch { return undefined; } }
async function ownerAlive(pid: number, ticks?: string) { try { process.kill(pid, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EPERM') return false; } return ticks === undefined || await startTicks(pid) === ticks; }
const gitEnv = () => ({ PATH: process.env.PATH, HOME: process.env.HOME, GIT_NO_REPLACE_OBJECTS: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' });
async function git(args: string[], cwd?: string) { await execute('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], { ...(cwd ? { cwd } : {}), env: gitEnv(), timeout: 60000, maxBuffer: 1024 * 1024 }); }
async function snapshot(project: string, destination: string, before: VerificationState, artifacts: readonly string[]) {
  await git(['clone', '--no-checkout', '--no-hardlinks', '--', project, destination]);
  await git(['checkout', '--detach', before.head], destination);
  for (const path of artifacts) {
    // captureVerificationState already rejects traversal and symlinks at every level.
    const source = join(project, path), target = join(destination, path);
    try { await lstat(source); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue; throw e; }
    await mkdir(dirname(target), { recursive: true });
    await cp(source, target, { recursive: true, dereference: false, preserveTimestamps: false });
  }
  const captured = await captureVerificationState(destination, artifacts);
  if (!sameVerificationState(before, { ...captured, projectRoot: project })) throw safeError();
}

/** Authority and snapshots stay outside project/worker mounts. The broker executes only policy-pinned checks, not supplied commands. */
export class VerificationBroker {
  private running: Promise<unknown> = Promise.resolve();
  private constructor(private options: VerificationBrokerOptions, private project: string, private key: Uint8Array, private plans: readonly VerificationPlan[]) {}
  static async open(options: VerificationBrokerOptions) {
    const project = await realpath(options.projectRoot);
    if (project !== options.projectRoot || !isAbsolute(project) || !hash.test(options.environmentDigest) || !options.plans.length || options.plans.length > 16) throw safeError();
    if (inside(project, options.authorityDirectory) || inside(options.authorityDirectory, project)) throw safeError();
    await directory(options.authorityDirectory);
    for (const name of ['requests', 'snapshots']) await directory(join(options.authorityDirectory, name));
    const plans = structuredClone(options.plans); const seen = new Set<string>();
    for (const plan of plans) { verificationPlanDigest(plan); if (seen.has(plan.id)) throw safeError(); seen.add(plan.id); }
    return new VerificationBroker(options, project, await keyFile(join(options.authorityDirectory, 'authority.key')), plans);
  }
  get authorityDirectory() { return this.options.authorityDirectory; }
  private plan(request: VerificationBrokerRequest) {
    const plan = this.plans.find(p => p.id === request.planId), check = plan?.checks.find(c => c.id === request.checkId);
    if (!plan || !check) throw safeError();
    return { plan, check };
  }
  private path(id: string) { if (!ids.test(id)) throw safeError(); return join(this.authorityDirectory, 'requests', id); }
  async status(id: string): Promise<VerificationBrokerStatus | undefined> {
    const path = this.path(id); await directory(join(this.authorityDirectory, 'requests'));
    try { const st = await lstat(path); if (!st.isDirectory() || st.isSymbolicLink()) throw safeError(); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
    let raw: Record<string, unknown>;
    try { raw = object(await readJSON(join(path, 'status.json'))); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
    if (raw.version !== 1 || raw.id !== id || !['queued', 'running', 'completed', 'failed'].includes(String(raw.state)) || typeof raw.checkId !== 'string' || !names.test(raw.checkId) || typeof raw.planId !== 'string' || !names.test(raw.planId)) throw safeError();
    let state = raw as unknown as VerificationBrokerStatus;
    if (state.state === 'running') {
      if (!Number.isSafeInteger(state.ownerPid) || Number(state.ownerPid) < 1 || state.ownerStartTicks !== undefined && (typeof state.ownerStartTicks !== 'string' || !/^\d+$/.test(state.ownerStartTicks))) throw safeError();
      if (!await ownerAlive(state.ownerPid!, state.ownerStartTicks)) {
        let receipt: VerificationReceipt | undefined;
        try { receipt = await readVerificationReceipt(path); if (!authenticVerificationReceipt(receipt, this.key) || receipt.id !== id) throw safeError(); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
        state = { version: 1, id, planId: state.planId, checkId: state.checkId, state: receipt?.state === 'completed' ? 'completed' : 'failed', ...(receipt?.state === 'completed' ? {} : { code: 'interrupted' as const }), completedAt: receipt?.completedAt ?? (this.options.now ?? Date.now)() };
        await atomic(join(path, 'status.json'), state);
      }
    }
    if (state.state === 'completed' || state.state === 'failed') {
      try { const receipt = await readVerificationReceipt(path); if (!authenticVerificationReceipt(receipt, this.key) || receipt.id !== id) throw safeError(); return { ...state, receipt }; }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    }
    return state;
  }
  /** Concurrent duplicate IDs are never executed twice, including across broker instances/processes. */
  run(value: unknown, signal = new AbortController().signal): Promise<VerificationBrokerStatus> {
    const request = parseVerificationBrokerRequest(value); this.plan(request);
    const result = this.running.then(() => this.execute(request, signal));
    this.running = result.then(() => {}, () => {}); return result;
  }
  private async execute(request: VerificationBrokerRequest, signal: AbortSignal): Promise<VerificationBrokerStatus> {
    signal.throwIfAborted(); const { plan, check } = this.plan(request), path = this.path(request.id);
    let exists = false;
    try { await lstat(path); exists = true; } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    if (!exists && (await readdir(join(this.authorityDirectory, 'requests'))).filter(name => ids.test(name)).length >= 4096) throw new Error('Verification authority retention limit reached; collect/prune old receipts before new checks.');
    try { await mkdir(path, { mode: 0o700 }); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      let previous: VerificationBrokerRequest;
      try { previous = parseVerificationBrokerRequest(await readJSON(join(path, 'request.json'), 8192)); }
      catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, id: request.id, planId: plan.id, checkId: check.id, state: 'queued' }; throw e; }
      if (Object.entries(request).some(([key, value]) => object(previous)[key] !== value)) throw safeError();
      return await this.status(request.id) ?? { version: 1, id: request.id, planId: plan.id, checkId: check.id, state: 'queued' };
    }
    await atomic(join(path, 'request.json'), request);
    const base = { version: 1 as const, id: request.id, checkId: check.id, planId: plan.id };
    const ticks = await startTicks(process.pid);
    await atomic(join(path, 'status.json'), { ...base, state: 'running', ownerPid: process.pid, ...(ticks ? { ownerStartTicks: ticks } : {}) });
    const workspace = join(this.authorityDirectory, 'snapshots', request.id), artifacts = check.artifactPaths ?? [];
    let before: VerificationState | undefined, after: VerificationState | undefined, exitCode: number | undefined;
    let code: VerificationBrokerStatus['code'] = 'capture_failed';
    try {
      before = await captureVerificationState(this.project, artifacts);
      code = 'inputs_changed';
      if (!before.clean || before.head !== request.expectedHead || before.treeDigest !== request.expectedTreeDigest) throw safeError();
      await snapshot(this.project, workspace, before, artifacts);
      code = 'execution_failed';
      const controller = new AbortController(), combined = AbortSignal.any([signal, controller.signal]);
      const timeout = setTimeout(() => controller.abort(new Error('Verification check exceeded its trusted deadline.')), (check.timeoutSeconds ?? 900) * 1000); timeout.unref();
      try {
        const result = await this.options.runner({ id: request.id, command: check.command, projectRoot: this.project, workspaceRoot: workspace, timeoutMs: (check.timeoutSeconds ?? 900) * 1000, signal: combined });
        combined.throwIfAborted();
        if (!Number.isInteger(result.exitCode) || result.exitCode < 0 || result.exitCode > 255) throw safeError();
        exitCode = result.exitCode;
      } finally { clearTimeout(timeout); }
      code = 'inputs_changed';
      const inSnapshot = await captureVerificationState(workspace, artifacts);
      after = await captureVerificationState(this.project, artifacts);
      const unchanged = sameVerificationState(before, after) && sameVerificationState(before, { ...inSnapshot, projectRoot: this.project });
      const passed = exitCode === 0 && unchanged && !before.missingArtifacts.length && !after.missingArtifacts.length && !inSnapshot.missingArtifacts.length;
      const receipt: VerificationReceipt = signVerificationReceipt({ version: 1, id: request.id, checkId: check.id, mode: 'release', planDigest: verificationPlanDigest(plan), commandDigest: verificationCommandDigest(check.command),
        state: passed ? 'completed' : 'failed', exitCode, completedAt: (this.options.now ?? Date.now)(), unchanged, before, after, environmentDigest: this.options.environmentDigest }, this.key);
      await writeVerificationReceipt(path, receipt);
      const result: VerificationBrokerStatus = { ...base, completedAt: receipt.completedAt, state: passed ? 'completed' : 'failed', ...(passed ? {} : { code: unchanged ? 'execution_failed' as const : code }), receipt };
      await atomic(join(path, 'status.json'), { ...result, receipt: undefined }); return result;
    } catch {
      const result: VerificationBrokerStatus = { ...base, completedAt: (this.options.now ?? Date.now)(), state: 'failed', code: signal.aborted ? 'interrupted' : code };
      await atomic(join(path, 'status.json'), result); return result;
    } finally { await rm(workspace, { recursive: true, force: true }); }
  }
  private async authenticatedReceipt(id: string) {
    const status = await this.status(id), receipt = status?.receipt;
    if (!receipt || status.state !== 'completed' || receipt.state !== 'completed' || receipt.exitCode !== 0 || !receipt.unchanged || !receipt.before.clean || !receipt.after.clean || receipt.before.missingArtifacts.length > 0 || receipt.after.missingArtifacts.length > 0 || !sameVerificationState(receipt.before, receipt.after) || receipt.environmentDigest !== this.options.environmentDigest || receipt.completedAt > (this.options.now ?? Date.now)()) throw safeError();
    const plan = this.plans.find(p => verificationPlanDigest(p) === receipt.planDigest), check = plan?.checks.find(c => c.id === receipt.checkId);
    if (!check || receipt.commandDigest !== verificationCommandDigest(check.command)) throw safeError();
    return { receipt, check };
  }
  /** Publication calls this on the host; a model-supplied `verified:true` is never accepted. */
  async verifiedReceipt(id: string) {
    const { receipt, check } = await this.authenticatedReceipt(id);
    if (!sameVerificationState(await captureVerificationState(this.project, check.artifactPaths ?? []), receipt.after)) throw safeError();
    return { id: receipt.id, projectRoot: this.project, head: receipt.after.head, treeDigest: receipt.after.treeDigest, artifactDigest: receipt.after.artifactDigest, checkId: receipt.checkId, mode: 'release' as const, state: 'completed' as const, exitCode: 0 as const, unchanged: true as const, verified: true as const, receipt };
  }
  /** Host housekeeping must supply IDs still referenced by pending publication. Recent and active evidence is preserved. */
  async prune(protectedIds: readonly string[], olderThan = (this.options.now ?? Date.now)() - 7 * 86400000) {
    if (protectedIds.length > 4096 || protectedIds.some(id => !ids.test(id)) || !Number.isSafeInteger(olderThan) || olderThan > (this.options.now ?? Date.now)() - 86400000) throw safeError();
    const keep = new Set(protectedIds); let removed = 0;
    for (const id of await readdir(join(this.authorityDirectory, 'requests'))) {
      if (!ids.test(id) || keep.has(id)) continue;
      const status = await this.status(id);
      if (status && ['completed', 'failed'].includes(status.state) && status.completedAt !== undefined && status.completedAt < olderThan) {
        await rm(this.path(id), { recursive: true });
        await rm(join(this.authorityDirectory, 'snapshots', id), { recursive: true, force: true }); removed++;
      }
    }
    return { removed };
  }
  async verifyPlan(planId: string, receiptIds: readonly string[]) {
    const plan = this.plans.find(p => p.id === planId); if (!plan) throw safeError();
    // The plan validator captures each distinct artifact set once after checking
    // all signatures. Avoid an additional full capture for every receipt here.
    const receipts = await Promise.all(receiptIds.map(async id => (await this.authenticatedReceipt(id)).receipt));
    return verifyReleaseReceipts(receipts, plan, this.project, this.key, (this.options.now ?? Date.now)());
  }
}
