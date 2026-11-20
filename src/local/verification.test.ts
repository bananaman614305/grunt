import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { JobScheduler } from './jobs.js';
import type { JobRunner } from './jobs.js';
import { assertVerificationArtifactContents, authenticVerificationReceipt, captureVerificationState, readVerificationReceipt, sameVerificationState, signVerificationReceipt, verificationBinding, verificationCommandDigest, verificationPlanDigest, verifyReleaseReceipts, writeVerificationReceipt } from './verification.js';
import type { VerificationPlan, VerificationReceipt } from './verification.js';
const roots: string[] = [], stores: JobScheduler[] = [];
afterEach(async () => { await Promise.all(stores.splice(0).map(s => s.close())); await Promise.all(roots.splice(0).map(r => rm(r, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'grunt-verification-')); roots.push(root);
  const project = join(root, 'project'); await mkdir(project);
  const git = (...args: string[]) => { const r = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: project, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); };
  git('init', '-q'); git('config', 'user.name', 'synthetic'); git('config', 'user.email', 'synthetic@example.invalid');
  await writeFile(join(project, '.gitignore'), 'dist/\n'); await writeFile(join(project, 'source.txt'), 'version-one'); git('add', '.'); git('commit', '-qm', 'synthetic input');
  await mkdir(join(project, 'dist')); await writeFile(join(project, 'dist/index.html'), 'verified-page');
  const scheduler = async (runner: JobRunner, sessionId = 'fixture') => { const s = await JobScheduler.open({ stateDirectory: join(root, 'state'), sessionId, runner }); stores.push(s); return s; };
  return { root, project, git, scheduler };
}
const scoped = { checkId: 'unit', mode: 'scoped' as const, artifactPaths: ['dist'] };
it('fingerprints tracked/untracked contents, revision and ignored artifacts without treating identical rewrites as changes', async () => {
  const f = await fixture(), first = await captureVerificationState(f.project, ['dist']);
  expect(first.clean).toBe(true); expect(first.artifactFiles).toEqual([{ path: 'dist/index.html', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }]);
  await writeFile(join(f.project, 'source.txt'), 'version-one'); expect(sameVerificationState(first, await captureVerificationState(f.project, ['dist']))).toBe(true);
  await writeFile(join(f.project, 'new.txt'), 'untracked'); expect(sameVerificationState(first, await captureVerificationState(f.project, ['dist']))).toBe(false);
  await rm(join(f.project, 'new.txt')); await writeFile(join(f.project, 'dist/index.html'), 'changed-page'); expect((await captureVerificationState(f.project, ['dist'])).artifactDigest).not.toBe(first.artifactDigest);
  await writeFile(join(f.project, 'dist/index.html'), 'verified-page'); f.git('commit', '--allow-empty', '-qm', 'new revision'); expect((await captureVerificationState(f.project, ['dist'])).head).not.toBe(first.head);
});
it('rejects symlinks and artifact traversal rather than reading outside the project', async () => {
  const f = await fixture(); await symlink('/etc/passwd', join(f.project, 'leak')); await expect(captureVerificationState(f.project)).rejects.toThrow('regular file');
  await rm(join(f.project, 'leak')); await expect(captureVerificationState(f.project, ['../outside'])).rejects.toThrow('relative');
  await symlink('/tmp', join(f.project, 'dist/link')); await expect(captureVerificationState(f.project, ['dist'])).rejects.toThrow('symlinks');
});
it('deduplicates identical queued/running checks and reuses a completed unchanged scoped check without executing it again', async () => {
  const f = await fixture(); let release: (() => void) | undefined;
  const runner = vi.fn<JobRunner>(() => new Promise(resolve => { release = () => resolve({ stdout: 'synthetic pass', stderr: '', exitCode: 0 }); }));
  const s = await f.scheduler(runner), input = { command: 'synthetic-check', category: 'test', verification: scoped };
  const [first, second] = await Promise.all([s.start(input, f.project), s.start(input, f.project)]); expect(second).toMatchObject({ id: first.id, reused: true });
  await vi.waitFor(() => expect(release).toBeTypeOf('function')); release!(); const result = await s.wait(first.id);
  expect(result).toMatchObject({ state: 'completed', verification: { mode: 'scoped', unchanged: true, state: 'completed' } });
  expect(await s.start(input, f.project)).toMatchObject({ id: first.id, reused: true }); expect(runner).toHaveBeenCalledTimes(1);
});
it('invalidates reuse for changed tracked/untracked/artifact input, command and timeout', async () => {
  const f = await fixture(), runner = vi.fn<JobRunner>(async () => ({ stdout: 'pass', stderr: '', exitCode: 0 })), s = await f.scheduler(runner);
  const input = { command: 'synthetic-check', verification: scoped }; let last = await s.start(input, f.project); await s.wait(last.id);
  for (const [path, body] of [['source.txt', 'two'], ['new.txt', 'new'], ['dist/index.html', 'new artifact']] as const) {
    await writeFile(join(f.project, path), body); const next = await s.start(input, f.project); expect(next.id).not.toBe(last.id); await s.wait(next.id); last = next;
  }
  const next = await s.start({ ...input, command: 'other-check' }, f.project); expect(next.id).not.toBe(last.id); await s.wait(next.id);
  const timed = await s.start({ ...input, timeoutSeconds: 30 }, f.project); expect(timed.id).not.toBe(last.id); await s.wait(timed.id);
});
it('never reuses failed, cancelled, expired or source-mutating verification', async () => {
  const f = await fixture(); let now = Date.now(), count = 0;
  const s = await JobScheduler.open({ stateDirectory: join(f.root, 'state'), sessionId: 'fixture', now: () => now, runner: async () => { count++; if (count === 1) return { stdout: '', stderr: '', exitCode: 1 }; if (count === 2) await writeFile(join(f.project, 'source.txt'), 'changed during check'); return { stdout: '', stderr: '', exitCode: 0 }; } }); stores.push(s);
  const input = { command: 'synthetic', verification: scoped }; const a = await s.start(input, f.project); await s.wait(a.id); const b = await s.start(input, f.project); expect(b.id).not.toBe(a.id); expect((await s.wait(b.id)).verification?.unchanged).toBe(false);
  const d = await s.start(input, f.project); expect(d.id).not.toBe(b.id); await s.wait(d.id); now += 16 * 60_000;
  const expired = await s.start(input, f.project); expect(expired.id).not.toBe(d.id); await s.wait(expired.id);
});
it('recovers successful scoped proof across scheduler restart, without replaying an existing command', async () => {
  const f = await fixture(), runner = vi.fn<JobRunner>(async () => ({ stdout: 'pass', stderr: '', exitCode: 0 }));
  const s = await f.scheduler(runner), input = { command: 'synthetic', verification: scoped }, a = await s.start(input, f.project); await s.wait(a.id); await s.close();
  const reopened = await f.scheduler(runner); expect(await reopened.start(input, f.project)).toMatchObject({ id: a.id, reused: true }); expect(runner).toHaveBeenCalledTimes(1);
});
it('worker-owned jobs cannot claim a host-authenticated release plan', async () => {
  const f = await fixture(), runner = vi.fn<JobRunner>(), s = await f.scheduler(runner);
  await expect(s.start({ command: 'true', verification: { mode: 'release', checkId: 'unit', planId: 'release' } }, f.project)).rejects.toThrow('host authority'); expect(runner).not.toHaveBeenCalled();
});
it('requires every exact required command, authenticated success and unchanged current artifacts for release', async () => {
  const f = await fixture(), key = randomBytes(32), state = await captureVerificationState(f.project, ['dist']);
  const plan: VerificationPlan = { version: 1, id: 'publish', mode: 'release', checks: [{ id: 'unit', command: 'synthetic-unit', artifactPaths: ['dist'] }, { id: 'browser', command: 'synthetic-browser', artifactPaths: ['dist'] }] };
  const receipt = (i: number): VerificationReceipt => signVerificationReceipt({ version: 1, id: `synthetic-${i}`, mode: 'release', checkId: plan.checks[i]!.id, planDigest: verificationPlanDigest(plan), commandDigest: verificationCommandDigest(plan.checks[i]!.command), state: 'completed', exitCode: 0, completedAt: Date.now() - 100, unchanged: true, before: state, after: state, environmentDigest: 'a'.repeat(64) }, key);
  const receipts = [receipt(0), receipt(1)]; expect(await verifyReleaseReceipts(receipts, plan, f.project, key)).toMatchObject({ head: state.head, checkIds: ['unit', 'browser'] });
  await expect(verifyReleaseReceipts([receipts[0]!], plan, f.project, key)).rejects.toThrow('Every required');
  await expect(verifyReleaseReceipts([{ ...receipts[0]!, commandDigest: verificationCommandDigest('true') }, receipts[1]!], plan, f.project, key)).rejects.toThrow('unauthenticated');
  await expect(verifyReleaseReceipts([{ ...receipts[0]!, mode: 'scoped' }, receipts[1]!], plan, f.project, key)).rejects.toThrow('scoped');
  expect(authenticVerificationReceipt({ ...receipts[0]!, exitCode: 7 }, key)).toBe(false);
  await writeFile(join(f.project, 'dist/index.html'), 'changed'); await expect(verifyReleaseReceipts(receipts, plan, f.project, key)).rejects.toThrow('changed');
});
it('binds upload byte buffers to the signed artifact manifest, rejecting omissions, substitutions and duplicates', async () => {
  const f = await fixture(), state = await captureVerificationState(f.project, ['dist']);
  expect(() => assertVerificationArtifactContents(state, [{ path: 'dist/index.html', content: Buffer.from('verified-page') }])).not.toThrow();
  expect(() => assertVerificationArtifactContents(state, [{ path: 'dist/index.html', content: Buffer.from('unverified-page') }])).toThrow('bytes');
  expect(() => assertVerificationArtifactContents(state, [])).toThrow('bytes');
  expect(() => assertVerificationArtifactContents(state, [{ path: 'dist/index.html', content: Buffer.from('verified-page') }, { path: 'dist/index.html', content: Buffer.from('verified-page') }])).toThrow('bytes');
});
it('writes immutable private receipt files and refuses worker-selected release commands or changed artifact sets', async () => {
  const f = await fixture(), state = await captureVerificationState(f.project, ['dist']), key = randomBytes(32), plan: VerificationPlan = { version: 1, id: 'release', mode: 'release', checks: [{ id: 'unit', command: 'must-run', artifactPaths: ['dist'] }] };
  const spec = { mode: 'release' as const, planId: 'release', checkId: 'unit', artifactPaths: ['dist'] };
  expect(() => verificationBinding(spec, 'true', 900, [plan])).toThrow('exactly'); expect(() => verificationBinding({ ...spec, artifactPaths: [] }, 'must-run', 900, [plan])).toThrow('exactly');
  const r = signVerificationReceipt({ version: 1, id: 'synthetic', mode: 'release', checkId: 'unit', ...verificationBinding(spec, 'must-run', 900, [plan]), state: 'completed', exitCode: 0, completedAt: Date.now(), unchanged: true, before: state, after: state, environmentDigest: 'a'.repeat(64) }, key);
  await writeVerificationReceipt(f.root, r); expect(await readVerificationReceipt(f.root)).toEqual(r); await expect(writeVerificationReceipt(f.root, { ...r, exitCode: 1 })).rejects.toThrow();
});
