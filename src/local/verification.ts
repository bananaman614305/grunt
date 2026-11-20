import { createHash, createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath, link, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';

const hashPattern = /^[a-f0-9]{64}$/;
const headPattern = /^[a-f0-9]{40}$/;
const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/;
const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const digest = (v: unknown) => createHash('sha256').update(canonical(v)).digest('hex');
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, v]) => JSON.stringify(key) + ':' + canonical(v)).join(',') + '}';
  return JSON.stringify(value);
}
export interface VerificationInput { checkId: string; mode: 'scoped' | 'release'; planId?: string; artifactPaths: string[] }
export interface VerificationCheck { id: string; command: string; timeoutSeconds?: number; artifactPaths?: string[] }
/** Register release plans from the trusted launch policy, never from a model-supplied success claim. */
export interface VerificationPlan { version: 1; id: string; mode: 'release'; checks: VerificationCheck[] }
export interface VerificationArtifact { path: string; sha256: string }
export interface VerificationState { projectRoot: string; head: string; treeDigest: string; artifactDigest: string; artifactRoots: string[]; artifactFiles: VerificationArtifact[]; missingArtifacts: string[]; clean: boolean; files: number }
export interface VerificationReceipt {
  version: 1; id: string; checkId: string; mode: 'scoped' | 'release'; planDigest: string; commandDigest: string;
  state: 'completed' | 'failed'; exitCode?: number; completedAt: number; unchanged: boolean;
  before: VerificationState; after: VerificationState; environmentDigest: string; signature?: string;
}
export const VERIFICATION_MAX_CACHE_AGE_MS = 15 * 60_000;
export function parseVerificationInput(value: unknown): VerificationInput {
  const v = object(value);
  if (Object.keys(v).some(k => !['checkId', 'mode', 'planId', 'artifactPaths'].includes(k)) || typeof v.checkId !== 'string' || !idPattern.test(v.checkId)
    || !['scoped', 'release'].includes(String(v.mode)) || v.planId !== undefined && (typeof v.planId !== 'string' || !idPattern.test(v.planId))) throw new Error('Verification needs a bounded check id, mode and optional trusted plan id.');
  const paths = v.artifactPaths ?? [];
  if (!Array.isArray(paths) || paths.length > 32 || paths.some(p => typeof p !== 'string' || !p || p.length > 1024 || isAbsolute(p) || p.includes('\\') || p.includes('\0') || p.split('/').some(s => !s || s === '.' || s === '..' || s === '.git'))) throw new Error('Verification artifacts must be bounded project-relative paths without symlinks or traversal.');
  return { checkId: v.checkId, mode: v.mode as VerificationInput['mode'], ...(v.planId ? { planId: v.planId as string } : {}), artifactPaths: [...new Set(paths as string[])].sort() };
}
export function verificationPlanDigest(plan: VerificationPlan): string {
  if (plan.version !== 1 || !idPattern.test(plan.id) || plan.mode !== 'release' || !Array.isArray(plan.checks) || !plan.checks.length || plan.checks.length > 32) throw new Error('Invalid trusted release verification plan.');
  const ids = new Set<string>();
  for (const check of plan.checks) {
    parseVerificationInput({ checkId: check.id, mode: 'release', artifactPaths: check.artifactPaths });
    if (ids.has(check.id) || typeof check.command !== 'string' || !check.command.trim() || Buffer.byteLength(check.command) > 8192 || check.command.includes('\0')
      || check.timeoutSeconds !== undefined && (!Number.isSafeInteger(check.timeoutSeconds) || check.timeoutSeconds < 1 || check.timeoutSeconds > 1800)) throw new Error('Invalid or duplicate trusted release check.');
    ids.add(check.id);
  }
  return digest(plan);
}
export function verificationBinding(input: VerificationInput, command: string, timeoutSeconds: number, plans: readonly VerificationPlan[] = []) {
  if (input.mode === 'scoped') {
    if (input.planId) throw new Error('Scoped verification cannot claim a release plan.');
    return { planDigest: digest({ mode: 'scoped', checkId: input.checkId, command, timeoutSeconds, artifactPaths: input.artifactPaths }), commandDigest: digest(command) };
  }
  const matches = plans.filter(p => p.id === input.planId);
  if (matches.length !== 1) throw new Error('Release verification requires one trusted launch-policy plan.');
  const plan = matches[0]!, planDigest = verificationPlanDigest(plan), check = plan.checks.find(c => c.id === input.checkId);
  if (!check || check.command !== command || (check.timeoutSeconds ?? 900) !== timeoutSeconds || canonical([...(check.artifactPaths ?? [])].sort()) !== canonical(input.artifactPaths)) throw new Error('Command, timeout and artifact set must match the trusted release check exactly.');
  return { planDigest, commandDigest: digest(command) };
}
export const verificationCommandDigest = (command: string) => digest(command);
export function verificationEnvironmentDigest(env: NodeJS.ProcessEnv) { return digest({ env, node: process.version, executable: process.execPath, platform: process.platform, arch: process.arch }); }
function git(cwd: string, args: string[]) {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1' };
  const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], { cwd, env, timeout: 5000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) throw new Error('Verification needs bounded readable Git metadata.');
  return result.stdout;
}
/** Hash full tracked and nonignored untracked input; explicit artifacts also cover ignored generated output. */
export async function captureVerificationState(cwd: string, artifactPaths: readonly string[] = []): Promise<VerificationState> {
  const normalizedArtifacts = parseVerificationInput({ checkId: 'capture', mode: 'scoped', artifactPaths: [...artifactPaths] }).artifactPaths;
  const root = await realpath(git(cwd, ['rev-parse', '--show-toplevel']).trim());
  if (!isAbsolute(root)) throw new Error('Invalid verification project.');
  const head = git(root, ['rev-parse', '--verify', 'HEAD']).trim();
  if (!headPattern.test(head)) throw new Error('Verification requires a committed Git HEAD.');
  const names = [...new Set(git(root, ['ls-files', '-c', '-o', '--exclude-standard', '-z']).split('\0').filter(Boolean))].sort();
  if (names.length > 20000) throw new Error('Verification input exceeds 20000 files.');
  let bytes = 0, files = 0;
  const witnesses: { name: string; stamp?: string; children?: string[] }[] = [];
  const stamp = (st: { ino: bigint; dev: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint }) => [st.ino, st.dev, st.size, st.mtimeNs, st.ctimeNs].join(':');
  const read = async (name: string) => {
    if (isAbsolute(name) || name.includes('\0') || name.split('/').some(p => p === '..' || p === '.git')) throw new Error('Unsafe verification input path.');
    const path = join(root, name);
    // Reject symlinked ancestors as well as symlinked leaf files.
    let parent = dirname(path);
    while (parent !== root) { if ((await lstat(parent)).isSymbolicLink()) throw new Error('Verification inputs cannot traverse symlinks.'); const next = dirname(parent); if (next === parent) throw new Error('Verification input escaped project.'); parent = next; }
    let st;
    try { st = await lstat(path, { bigint: true }); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') { witnesses.push({ name }); return [name, 'missing']; } throw e; }
    if (!st.isFile() || st.isSymbolicLink()) throw new Error('Verification input must be a regular file; submodules and symlinks require separate verification.');
    if (++files > 40000 || st.size > 32n * 1024n * 1024n) throw new Error('Verification input exceeds its bounded content budget.');
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await file.stat({ bigint: true });
      const contentHash = createHash('sha256'), buffer = Buffer.allocUnsafe(64 * 1024); let size = 0;
      for (;;) { const part = await file.read(buffer, 0, buffer.length, null); if (!part.bytesRead) break; size += part.bytesRead; bytes += part.bytesRead; if (size > 32 * 1024 * 1024 || bytes > 256 * 1024 * 1024) throw new Error('Verification input exceeds its bounded content budget.'); contentHash.update(buffer.subarray(0, part.bytesRead)); }
      const after = await file.stat({ bigint: true }); const current = await lstat(path, { bigint: true });
      if (before.ino !== st.ino || before.dev !== st.dev || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
        || current.ino !== after.ino || current.ctimeNs !== after.ctimeNs) throw new Error('Verification input changed while hashing.');
      witnesses.push({ name, stamp: stamp(after) });
      return [name, contentHash.digest('hex'), String(after.mode & 0o111n)];
    } finally { await file.close(); }
  };
  const source = [];
  for (const name of names) source.push(await read(name));
  const artifactFiles: VerificationArtifact[] = [], missingArtifacts: string[] = []; let artifactNodes = 0;
  const walk = async (name: string, depth: number) => {
    if (++artifactNodes > 10000 || depth > 32) throw new Error('Verification artifact nesting exceeds its limit.');
    let ancestor = dirname(join(root, name));
    while (ancestor !== root) { if ((await lstat(ancestor)).isSymbolicLink()) throw new Error('Verification artifacts cannot traverse symlinks.'); const next = dirname(ancestor); if (next === ancestor) throw new Error('Verification artifact escaped project.'); ancestor = next; }
    let st; try { st = await lstat(join(root, name)); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') { missingArtifacts.push(name); return; } throw e; }
    if (st.isSymbolicLink()) throw new Error('Verification artifacts cannot be symlinks.');
    if (st.isDirectory()) { const children = (await readdir(join(root, name))).sort(); witnesses.push({ name, children }); for (const child of children) await walk(name + '/' + child, depth + 1); }
    else { const row = await read(name); if (row[1] === 'missing') throw new Error('Artifact disappeared while hashing.'); artifactFiles.push({ path: name, sha256: String(row[1]) }); if (artifactFiles.length > 4096) throw new Error('Verification artifact manifest exceeds4096 files.'); }
  };
  for (const path of normalizedArtifacts) { parseVerificationInput({ checkId: 'artifact', mode: 'scoped', artifactPaths: [path] }); await walk(path, 0); }
  for (const witness of witnesses) {
    let current; try { current = await lstat(join(root, witness.name), { bigint: true }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT' || witness.stamp || witness.children) throw new Error('Verification input changed while hashing.'); continue; }
    if (current.isSymbolicLink() || (witness.children ? !current.isDirectory() || canonical((await readdir(join(root, witness.name))).sort()) !== canonical(witness.children) : !witness.stamp || stamp(current) !== witness.stamp)) throw new Error('Verification input changed while hashing.');
  }
  const status = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  // Check index/list membership and HEAD again after reads to fail closed on concurrent Git work.
  if (git(root, ['rev-parse', '--verify', 'HEAD']).trim() !== head || canonical([...new Set(git(root, ['ls-files', '-c', '-o', '--exclude-standard', '-z']).split('\0').filter(Boolean))].sort()) !== canonical(names)) throw new Error('Verification revision changed while hashing.');
  if (Buffer.byteLength(canonical(artifactFiles)) > 400 * 1024) throw new Error('Verification artifact manifest exceeds its metadata budget.');
  const artifactRoots = normalizedArtifacts; missingArtifacts.sort(); artifactFiles.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { projectRoot: root, head, treeDigest: digest(source), artifactDigest: digest({ artifactRoots, artifactFiles, missingArtifacts }), artifactRoots, artifactFiles, missingArtifacts, clean: status.length === 0, files: names.length };
}
export function assertVerificationArtifactContents(state: VerificationState, files: readonly { path: string; content: Uint8Array }[]) {
  if (state.missingArtifacts.length || state.artifactDigest !== digest({ artifactRoots: state.artifactRoots, artifactFiles: state.artifactFiles, missingArtifacts: state.missingArtifacts })) throw new Error('Invalid or missing signed artifact manifest.');
  const manifest = files.map(file => ({ path: file.path, sha256: createHash('sha256').update(file.content).digest('hex') })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (new Set(manifest.map(f => f.path)).size !== manifest.length || canonical(manifest) !== canonical(state.artifactFiles)) throw new Error('Uploaded artifact bytes do not match verified artifacts.');
}
export function sameVerificationState(a: VerificationState, b: VerificationState) { return canonical(a) === canonical(b); }
export function verificationKey(input: VerificationInput, binding: { planDigest: string; commandDigest: string }, state: VerificationState, environmentDigest: string) { return digest({ input, binding, state, environmentDigest }); }
function signingBody(receipt: VerificationReceipt) { const { signature: _signature, ...body } = receipt; return canonical(body); }
/** Signing key belongs to a trusted host authority outside worker mounts; never store it with worker receipts. */
export function signVerificationReceipt(receipt: VerificationReceipt, key: Uint8Array) {
  if (key.byteLength < 32) throw new Error('Verification authority key needs at least256 bits.');
  return { ...receipt, signature: createHmac('sha256', key).update(signingBody(receipt)).digest('hex') };
}
export function authenticVerificationReceipt(receipt: VerificationReceipt, key: Uint8Array) {
  if (typeof receipt.signature !== 'string' || !hashPattern.test(receipt.signature) || key.byteLength < 32) return false;
  return timingSafeEqual(Buffer.from(receipt.signature, 'hex'), Buffer.from(createHmac('sha256', key).update(signingBody(receipt)).digest('hex'), 'hex'));
}
export async function writeVerificationReceipt(directory: string, receipt: VerificationReceipt) {
  const target = join(directory, 'verification.json'), temporary = join(directory, `.verification-${randomUUID()}.tmp`);
  try { await writeFile(temporary, JSON.stringify(receipt) + '\n', { flag: 'wx', mode: 0o600 }); await link(temporary, target); }
  finally { await rm(temporary, { force: true }); }
}
export async function readVerificationReceipt(directory: string): Promise<VerificationReceipt> {
  const file = await open(join(directory, 'verification.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = await file.stat();
    if (!st.isFile() || process.getuid && st.uid !== process.getuid() || (st.mode & 0o077) || st.size > 1024 * 1024) throw new Error('Unsafe verification receipt.');
    const v = object(JSON.parse(await file.readFile('utf8')));
    if (Object.keys(v).some(k => !['version', 'id', 'checkId', 'mode', 'planDigest', 'commandDigest', 'state', 'exitCode', 'completedAt', 'unchanged', 'before', 'after', 'environmentDigest', 'signature'].includes(k)) || v.version !== 1 || typeof v.id !== 'string' || v.id.length > 128 || typeof v.checkId !== 'string' || !idPattern.test(v.checkId) || !['scoped', 'release'].includes(String(v.mode)) || !['completed', 'failed'].includes(String(v.state))
      || typeof v.planDigest !== 'string' || !hashPattern.test(v.planDigest) || typeof v.commandDigest !== 'string' || !hashPattern.test(v.commandDigest) || typeof v.environmentDigest !== 'string' || !hashPattern.test(v.environmentDigest)
      || !Number.isSafeInteger(v.completedAt) || Number(v.completedAt) < 0 || typeof v.unchanged !== 'boolean' || v.exitCode !== undefined && (!Number.isSafeInteger(v.exitCode) || Number(v.exitCode) < 0 || Number(v.exitCode) > 255) || v.signature !== undefined && (typeof v.signature !== 'string' || !hashPattern.test(v.signature))) throw new Error('Invalid verification receipt.');
    for (const name of ['before', 'after']) {
      const s = object(v[name]);
      if (Object.keys(s).some(k => !['projectRoot', 'head', 'treeDigest', 'artifactDigest', 'artifactRoots', 'artifactFiles', 'missingArtifacts', 'clean', 'files'].includes(k)) || typeof s.projectRoot !== 'string' || !isAbsolute(s.projectRoot) || typeof s.head !== 'string' || !headPattern.test(s.head) || typeof s.treeDigest !== 'string' || !hashPattern.test(s.treeDigest) || typeof s.artifactDigest !== 'string' || !hashPattern.test(s.artifactDigest) || typeof s.clean !== 'boolean' || !Number.isSafeInteger(s.files) || Number(s.files) < 0 || Number(s.files) > 20000 || !Array.isArray(s.artifactRoots) || !Array.isArray(s.artifactFiles) || s.artifactFiles.length > 4096 || !Array.isArray(s.missingArtifacts)) throw new Error('Invalid verification state.');
      const roots = parseVerificationInput({ checkId: 'receipt', mode: 'scoped', artifactPaths: s.artifactRoots }).artifactPaths;
      if (canonical(roots) !== canonical(s.artifactRoots) || s.missingArtifacts.some(p => !roots.includes(p as string))) throw new Error('Invalid verification artifact roots.');
      const seen = new Set<string>();
      for (const file of s.artifactFiles) { const row = object(file); if (Object.keys(row).length !== 2 || typeof row.path !== 'string' || !roots.some(p => row.path === p || String(row.path).startsWith(p + '/')) || seen.has(row.path) || typeof row.sha256 !== 'string' || !hashPattern.test(row.sha256)) throw new Error('Invalid verification artifact manifest.'); parseVerificationInput({ checkId: 'receipt', mode: 'scoped', artifactPaths: [row.path] }); seen.add(row.path); }
      if (s.artifactDigest !== digest({ artifactRoots: s.artifactRoots, artifactFiles: s.artifactFiles, missingArtifacts: s.missingArtifacts })) throw new Error('Invalid verification artifact digest.');
    }
    return v as unknown as VerificationReceipt;
  } finally { await file.close(); }
}
export async function verifyReleaseReceipts(receipts: readonly VerificationReceipt[], plan: VerificationPlan, cwd: string, key: Uint8Array, now = Date.now()) {
  const planDigest = verificationPlanDigest(plan);
  if (receipts.length !== plan.checks.length) throw new Error('Every required release check needs its own authenticated receipt.');
  const ids = new Set<string>();
  for (const check of plan.checks) {
    const matches = receipts.filter(r => r.checkId === check.id); if (matches.length !== 1) throw new Error('Missing or duplicate release check receipt.');
    const r = matches[0]!;
    if (ids.has(r.id) || r.mode !== 'release' || r.planDigest !== planDigest || r.commandDigest !== digest(check.command) || r.state !== 'completed' || r.exitCode !== 0 || !r.unchanged
      || !r.before.clean || !r.after.clean || r.after.missingArtifacts.length > 0 || !sameVerificationState(r.before, r.after) || r.completedAt > now || !authenticVerificationReceipt(r, key)) throw new Error('Release verification is stale, failed, scoped or unauthenticated.');
    ids.add(r.id);
    const current = await captureVerificationState(cwd, check.artifactPaths ?? []);
    if (!sameVerificationState(current, r.after)) throw new Error('Release inputs or artifacts changed after verification.');
  }
  return { planDigest, head: receipts[0]!.after.head, checkIds: plan.checks.map(c => c.id), verifiedAt: now };
}
