import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { assertVerificationArtifactContents, authenticVerificationReceipt, captureVerificationState, readVerificationReceipt, sameVerificationState, signVerificationReceipt, verificationCommandDigest, verificationPlanDigest, verifyReleaseReceipts, writeVerificationReceipt } from './verification.js';
import type { VerificationPlan, VerificationReceipt } from './verification.js';
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, open: vi.fn(actual.open) };
});
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(r => rm(r, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'grunt-verification-')); roots.push(root);
  const project = join(root, 'project'); await mkdir(project);
  const git = (...args: string[]) => { const r = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: project, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); };
  git('init', '-q'); git('config', 'user.name', 'synthetic'); git('config', 'user.email', 'synthetic@example.invalid');
  await writeFile(join(project, '.gitignore'), 'dist/\n'); await writeFile(join(project, 'source.txt'), 'version-one'); git('add', '.'); git('commit', '-qm', 'synthetic input');
  await mkdir(join(project, 'dist')); await writeFile(join(project, 'dist/index.html'), 'verified-page');
  return { root, project, git };
}
it('hashes a tracked artifact once per capture and reads its bytes again on the next capture', async () => {
  const f = await fixture();
  const observed = vi.spyOn(fs, 'open');
  const count = () => observed.mock.calls.filter(([path]) => path === join(f.project, 'source.txt')).length;
  const first = await captureVerificationState(f.project, ['source.txt']);
  expect(count()).toBe(1);
  await writeFile(join(f.project, 'source.txt'), 'new bytes');
  const second = await captureVerificationState(f.project, ['source.txt']);
  expect(count()).toBe(2); expect(second.treeDigest).not.toBe(first.treeDigest); expect(second.artifactDigest).not.toBe(first.artifactDigest);
});
it('bounds concurrent input reads and closes every started file before a capture failure returns', async () => {
  const f = await fixture();
  for (let i = 0; i < 8; i++) await writeFile(join(f.project, `parallel-${i}.txt`), 'synthetic');
  const actual = await vi.importActual<typeof fs>('node:fs/promises');
  let active = 0, maximum = 0, started = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const timer = setTimeout(release, 100);
  vi.spyOn(fs, 'open').mockImplementation(async (path, flags, mode) => {
    const file = await actual.open(path, flags, mode);
    active++; maximum = Math.max(maximum, active); if (++started === 4) release();
    const close = file.close.bind(file);
    vi.spyOn(file, 'close').mockImplementation(async () => { try { await close(); } finally { active--; } });
    await gate;
    if (String(path).endsWith('parallel-0.txt')) {
      vi.spyOn(file, 'read').mockRejectedValue(new Error('synthetic read failure'));
    }
    return file;
  });
  try {
    await expect(captureVerificationState(f.project)).rejects.toThrow('synthetic read failure');
    expect(maximum).toBeGreaterThan(1); expect(maximum).toBeLessThanOrEqual(4); expect(active).toBe(0);
  } finally { clearTimeout(timer); release(); }
});
it('keeps the full content budget when several files are read concurrently', async () => {
  const f = await fixture();
  // Sparse files keep fixture setup cheap while capture reads every byte.
  for (let i = 0; i < 9; i++) {
    const file = await fs.open(join(f.project, `large-${i}`), 'w');
    try { await file.truncate(30 * 1024 * 1024); } finally { await file.close(); }
  }
  await expect(captureVerificationState(f.project)).rejects.toThrow('content budget');
});
it('rejects a tracked artifact changed after its shared hash was computed', async () => {
  const f = await fixture(), actual = await vi.importActual<typeof fs>('node:fs/promises');
  vi.spyOn(fs, 'open').mockImplementation(async (path, flags, mode) => {
    const file = await actual.open(path, flags, mode), close = file.close.bind(file);
    if (path === join(f.project, 'source.txt')) vi.spyOn(file, 'close').mockImplementation(async () => {
      await close(); await writeFile(join(f.project, 'source.txt'), 'changed after hashing');
    });
    return file;
  });
  await expect(captureVerificationState(f.project, ['source.txt'])).rejects.toThrow('changed while hashing');
});
it('fingerprints tracked/untracked contents, revision and ignored artifacts without treating identical rewrites as changes', async () => {
  const f = await fixture(), first = await captureVerificationState(f.project, ['dist']);
  expect(first.clean).toBe(true); expect(first.artifactFiles).toEqual([{ path: 'dist/index.html', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }]);
  await writeFile(join(f.project, 'source.txt'), 'version-one'); expect(sameVerificationState(first, await captureVerificationState(f.project, ['dist']))).toBe(true);
  await writeFile(join(f.project, 'new.txt'), 'untracked'); expect(sameVerificationState(first, await captureVerificationState(f.project, ['dist']))).toBe(false);
  await rm(join(f.project, 'new.txt')); await writeFile(join(f.project, 'dist/index.html'), 'changed-page'); expect((await captureVerificationState(f.project, ['dist'])).artifactDigest).not.toBe(first.artifactDigest);
  await writeFile(join(f.project, 'dist/index.html'), 'verified-page'); f.git('commit', '--allow-empty', '-qm', 'new revision'); expect((await captureVerificationState(f.project, ['dist'])).head).not.toBe(first.head);
});
it('ignores local Git replacement objects when binding the actual HEAD and source state', async () => {
  const f = await fixture(), base = await captureVerificationState(f.project, ['dist']);
  await writeFile(join(f.project, 'source.txt'), 'candidate bytes'); f.git('add', 'source.txt'); f.git('commit', '-qm', 'candidate'); const candidate = f.git('rev-parse', 'HEAD');
  f.git('checkout', '--detach', base.head); f.git('replace', base.head, candidate);
  // Ordinary Git now compares against the substituted candidate tree. Capture must use the real base.
  expect(f.git('status', '--porcelain')).not.toBe('');
  expect(await captureVerificationState(f.project, ['dist'])).toEqual(base);
  await writeFile(join(f.project, 'source.txt'), 'candidate bytes'); f.git('add', 'source.txt'); expect(f.git('status', '--porcelain')).toBe('');
  const changed = await captureVerificationState(f.project, ['dist']); expect(changed.head).toBe(base.head); expect(changed.clean).toBe(false); expect(changed.treeDigest).not.toBe(base.treeDigest);
});
it('rejects symlinks and artifact traversal rather than reading outside the project', async () => {
  const f = await fixture(); await symlink('/etc/passwd', join(f.project, 'leak')); await expect(captureVerificationState(f.project)).rejects.toThrow('regular file');
  await rm(join(f.project, 'leak')); await expect(captureVerificationState(f.project, ['../outside'])).rejects.toThrow('relative');
  await symlink('/tmp', join(f.project, 'dist/link')); await expect(captureVerificationState(f.project, ['dist'])).rejects.toThrow('symlinks');
  const empty = join(f.root, 'empty'); await mkdir(empty); await rm(join(f.project, 'dist/link')); await symlink(f.root, join(f.project, 'dist/link'));
  await expect(captureVerificationState(f.project, ['dist/link/empty'])).rejects.toThrow('traverse symlinks');
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
it('revalidates shared release input bytes once per distinct artifact set and never across calls', async () => {
  const f = await fixture(), key = randomBytes(32), state = await captureVerificationState(f.project, ['dist']);
  const plan: VerificationPlan = { version: 1, id: 'publish', mode: 'release', checks: ['unit', 'browser', 'lint'].map(id => ({ id, command: `synthetic-${id}`, artifactPaths: ['dist'] })) };
  const receipts = plan.checks.map((check, index) => signVerificationReceipt({ version: 1, id: `synthetic-${index}`, mode: 'release', checkId: check.id, planDigest: verificationPlanDigest(plan), commandDigest: verificationCommandDigest(check.command), state: 'completed', exitCode: 0, completedAt: Date.now() - 100, unchanged: true, before: state, after: state, environmentDigest: 'a'.repeat(64) } as VerificationReceipt, key));
  const observed = vi.spyOn(fs, 'open'), count = () => observed.mock.calls.filter(([path]) => path === join(f.project, 'source.txt')).length;
  expect((await verifyReleaseReceipts(receipts, plan, f.project, key)).checkIds).toEqual(['unit', 'browser', 'lint']);
  expect(count()).toBe(1);
  await writeFile(join(f.project, 'dist/index.html'), 'changed');
  await expect(verifyReleaseReceipts(receipts, plan, f.project, key)).rejects.toThrow('changed');
  expect(count()).toBe(2);
});
it('binds upload byte buffers to the signed artifact manifest, rejecting omissions, substitutions and duplicates', async () => {
  const f = await fixture(), state = await captureVerificationState(f.project, ['dist']);
  expect(() => assertVerificationArtifactContents(state, [{ path: 'dist/index.html', content: Buffer.from('verified-page') }])).not.toThrow();
  expect(() => assertVerificationArtifactContents(state, [{ path: 'dist/index.html', content: Buffer.from('unverified-page') }])).toThrow('bytes');
  expect(() => assertVerificationArtifactContents(state, [])).toThrow('bytes');
  expect(() => assertVerificationArtifactContents(state, [{ path: 'dist/index.html', content: Buffer.from('verified-page') }, { path: 'dist/index.html', content: Buffer.from('verified-page') }])).toThrow('bytes');
});
it('writes immutable private receipt files', async () => {
  const f = await fixture(), state = await captureVerificationState(f.project, ['dist']), key = randomBytes(32), plan: VerificationPlan = { version: 1, id: 'release', mode: 'release', checks: [{ id: 'unit', command: 'must-run', artifactPaths: ['dist'] }] };
  const r = signVerificationReceipt({ version: 1, id: 'synthetic', mode: 'release', checkId: 'unit', planDigest: verificationPlanDigest(plan), commandDigest: verificationCommandDigest('must-run'), state: 'completed', exitCode: 0, completedAt: Date.now(), unchanged: true, before: state, after: state, environmentDigest: 'a'.repeat(64) }, key);
  await writeVerificationReceipt(f.root, r); expect(await readVerificationReceipt(f.root)).toEqual(r); await expect(writeVerificationReceipt(f.root, { ...r, exitCode: 1 })).rejects.toThrow();
});
