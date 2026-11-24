import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { PublicationQueue, publicationPolicy } from './publication.js';
import type { PublicationOptions, PublicationPolicy, PublicationSnapshot, PublicationVerification } from './publication.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const head = 'a'.repeat(40), base = 'b'.repeat(40), merged = 'c'.repeat(40), pages = 'd'.repeat(40), tree = 'e'.repeat(40);
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'grunt-publication-')); roots.push(root);
  const projectRoot = join(root, 'project'); await mkdir(projectRoot);
  const policy: PublicationPolicy = { version: 1, projectRoot, repository: 'synthetic/project', base: 'main', headPrefix: 'grunt/', requiredChecks: ['tests', 'build'], reviewPaths: ['src'], artifactDirectory: 'dist', pagesBranch: 'gh-pages', allowMerge: true, allowDeploy: true };
  let current: PublicationSnapshot = { projectRoot, head, treeDigest: 'f'.repeat(64), artifactDigest: '1'.repeat(64), clean: true, branch: 'grunt/example', baseHead: base, baseIsAncestor: true, gitTree: tree };
  const evidenceIds = [randomUUID(), randomUUID()], evidence = new Map<string, PublicationVerification>(evidenceIds.map((id, index) => [id, { verified: true, id, projectRoot, head, treeDigest: current.treeDigest, artifactDigest: current.artifactDigest, checkId: policy.requiredChecks[index]!, mode: 'release', state: 'completed', exitCode: 0, unchanged: true }]));
  const screen = vi.fn(async () => {});
  const transport = { ensurePullRequest: vi.fn(async () => ({ number: 7, url: 'https://github.com/synthetic/project/pull/7' })), merge: vi.fn(async () => { current = { ...current, baseHead: merged, baseIsAncestor: false }; return merged; }), deploy: vi.fn(async () => ({ commit: pages, url: 'https://synthetic.github.io/project/' })) };
  const options: PublicationOptions = { directory: join(root, 'authority'), policy, capture: async () => ({ ...current }), verification: async id => evidence.get(id), screen, transport };
  const queue = await PublicationQueue.open(options), request = { head, branch: current.branch, title: 'A synthetic release', body: 'Synthetic fixture only', verificationIds: evidenceIds };
  const record = (id: string, change: Record<string, unknown> = {}) => queue.recordReview(id, { id, head, gitTree: tree, verdict: 'approve', summary: 'Self-review: read the full diff, no findings.', ...change });
  return { root, queue, options, policy, request, evidence, evidenceIds, screen, record, transport, mutate: (v: Partial<PublicationSnapshot>) => { current = { ...current, ...v }; } };
}
it('runs separate authenticated checks/review/PR/exact-tree merge/Pages stages and survives reopen', async () => {
  const f = await fixture(), release = await f.queue.prepare(f.request);
  expect(release.phase).toBe('awaiting_review');
  expect((await f.queue.advance(release.id)).phase).toBe('awaiting_review');
  expect((await f.record(release.id)).phase).toBe('ready');
  expect(f.screen).toHaveBeenCalledTimes(1);
  expect((await f.queue.advance(release.id)).phase).toBe('pull_request');
  expect((await f.queue.advance(release.id)).phase).toBe('deploying');
  expect((await f.queue.advance(release.id)).phase).toBe('deployed');
  const restored = await PublicationQueue.open(f.options);
  expect((await restored.advance(release.id)).phase).toBe('deployed');
  expect(f.transport.merge).toHaveBeenCalledTimes(1); expect(f.transport.deploy).toHaveBeenCalledTimes(1);
  const view = await restored.status(release.id);
  expect(view).not.toHaveProperty('request'); expect(view).not.toHaveProperty('review');
  const stored = JSON.parse(await readFile(join(f.options.directory, release.id + '.json'), 'utf8'));
  expect(stored.review).toMatchObject({ source: 'builder', verdict: 'approve', head, gitTree: tree, summary: 'Self-review: read the full diff, no findings.' });
});
it('reconciles a stable host request UUID after a lost response and rejects a changed replay', async () => {
  const f = await fixture(), requestId = randomUUID(), first = await f.queue.prepare(f.request, requestId);
  expect(first.id).toBe(requestId); await f.record(first.id);
  expect(await f.queue.prepare(f.request, requestId)).toMatchObject({ id: requestId, phase: 'ready' });
  await expect(f.queue.prepare({ ...f.request, title: 'different intent' }, requestId)).rejects.toThrow('different intent');
  expect(f.screen).toHaveBeenCalledTimes(1);
});
it('recovers a dead advancement owner without stealing a live lock', async () => {
  const f = await fixture(), path = join(f.options.directory, 'queue.lock');
  await writeFile(path, JSON.stringify({ ownerPid: 2147483647, token: randomUUID() }), { mode: 0o600 });
  expect((await f.queue.prepare(f.request)).phase).toBe('awaiting_review');
  await writeFile(path, JSON.stringify({ ownerPid: process.pid, token: randomUUID() }), { mode: 0o600 });
  await expect(f.queue.prepare(f.request)).rejects.toThrow('live advancement owner');
});
it.each(['missing', 'scoped', 'forged', 'failed', 'wrong-head', 'wrong-artifact', 'duplicate-check'])('blocks %s evidence before a review can be recorded or external mutation', async mode => {
  const f = await fixture(), first = f.evidence.get(f.evidenceIds[0]!)!;
  if (mode === 'missing') f.evidence.delete(first.id);
  if (mode === 'scoped') Object.assign(first, { mode: 'scoped' });
  if (mode === 'forged') Object.assign(first, { verified: false });
  if (mode === 'failed') Object.assign(first, { exitCode: 1 });
  if (mode === 'wrong-head') Object.assign(first, { head: '0'.repeat(40) });
  if (mode === 'wrong-artifact') Object.assign(first, { artifactDigest: '0'.repeat(64) });
  if (mode === 'duplicate-check') f.evidence.get(f.evidenceIds[1]!)!.checkId = first.checkId;
  const release = await f.queue.prepare(f.request);
  expect(release).toMatchObject({ phase: 'blocked', reason: 'verification_required' });
  expect((await f.queue.advance(release.id)).phase).toBe('blocked'); await expect(f.record(release.id)).rejects.toThrow('awaits review'); expect(f.screen).not.toHaveBeenCalled(); expect(f.transport.ensurePullRequest).not.toHaveBeenCalled();
});
it.each([{ head: '0'.repeat(40) }, { baseHead: '0'.repeat(40) }, { artifactDigest: '0'.repeat(64) }, { treeDigest: '0'.repeat(64) }])('invalidates stale candidate before publishing (%j)', async change => {
  const f = await fixture(), release = await f.queue.prepare(f.request); await f.record(release.id);
  f.mutate(change);
  expect(await f.queue.advance(release.id)).toMatchObject({ phase: 'blocked', reason: 'stale_evidence' });
  expect(f.transport.ensurePullRequest).not.toHaveBeenCalled();
});
it('requires a clean candidate containing the pinned base and denies model-selected policies/paths', async () => {
  const f = await fixture(); f.mutate({ clean: false }); await expect(f.queue.prepare(f.request)).rejects.toThrow('clean');
  f.mutate({ clean: true, baseIsAncestor: false }); await expect(f.queue.prepare(f.request)).rejects.toThrow('current base');
  await expect(f.queue.prepare({ ...f.request, repository: 'attacker/repo' })).rejects.toThrow('Invalid release request');
  expect(() => publicationPolicy({ ...f.policy, artifactDirectory: '../outside' })).toThrow();
  expect(() => publicationPolicy({ ...f.policy, pagesBranch: 'main' })).toThrow();
  await expect(PublicationQueue.open({ ...f.options, directory: join(f.policy.projectRoot, '.authority') })).rejects.toThrow('outside');
  await expect(PublicationQueue.open({ ...f.options, directory: join(f.policy.projectRoot, '..authority') })).rejects.toThrow('outside');
});
it('blocks the release on a changes_requested review and never accepts a second verdict', async () => {
  const f = await fixture(), release = await f.queue.prepare(f.request);
  expect(await f.record(release.id, { verdict: 'changes_requested', summary: 'Found a broken save path.' })).toMatchObject({ phase: 'blocked', reason: 'changes_requested' });
  expect(await f.record(release.id, { verdict: 'changes_requested', summary: 'Found a broken save path.' })).toMatchObject({ phase: 'blocked', reason: 'changes_requested' });
  await expect(f.record(release.id)).rejects.toThrow('awaits review');
  expect(await f.queue.advance(release.id)).toMatchObject({ phase: 'blocked', reason: 'changes_requested' }); expect(f.transport.ensurePullRequest).not.toHaveBeenCalled();
});
it.each([
  ['another commit', { head: '0'.repeat(40) }, 'exact release candidate'],
  ['another tree', { gitTree: '0'.repeat(40) }, 'exact release candidate'],
  ['an unknown verdict', { verdict: 'lgtm' }, 'Invalid review record'],
  ['an empty summary', { summary: '  ' }, 'Invalid review record'],
  ['an oversized summary', { summary: 'x'.repeat(2001) }, 'Invalid review record'],
  ['extra reviewer fields', { independent: true }, 'Invalid review record'],
  ['another release id', { id: randomUUID() }, 'Invalid review record'],
])('refuses a review naming %s and keeps the release awaiting review', async (_name, change, message) => {
  const f = await fixture(), release = await f.queue.prepare(f.request);
  await expect(f.record(release.id, change)).rejects.toThrow(message);
  expect(await f.queue.status(release.id)).toMatchObject({ phase: 'awaiting_review' }); expect(f.screen).not.toHaveBeenCalled();
  expect(await f.queue.advance(release.id)).toMatchObject({ phase: 'awaiting_review' }); expect(f.transport.ensurePullRequest).not.toHaveBeenCalled();
  expect((await f.record(release.id)).phase).toBe('ready');
});
it('does not record a review for a candidate that moved after verification or that the host screen refuses', async () => {
  const f = await fixture(), release = await f.queue.prepare(f.request);
  f.screen.mockRejectedValueOnce(new Error('Private-looking changed paths'));
  await expect(f.record(release.id)).rejects.toThrow('Private-looking');
  expect(await f.queue.status(release.id)).toMatchObject({ phase: 'awaiting_review' });
  f.mutate({ treeDigest: '0'.repeat(64) });
  expect(await f.record(release.id)).toMatchObject({ phase: 'blocked', reason: 'stale_evidence' });
});
it('does not let a review make an unverified or merely prepared release publishable', async () => {
  const f = await fixture(); Object.assign(f.evidence.get(f.evidenceIds[0]!)!, { exitCode: 1 });
  const release = await f.queue.prepare(f.request);
  await expect(f.record(release.id)).rejects.toThrow('awaits review');
  const ok = await fixture(), prepared = await ok.queue.prepare(ok.request);
  Object.assign(ok.evidence.get(ok.evidenceIds[0]!)!, { exitCode: 1 });
  expect(await ok.record(prepared.id)).toMatchObject({ phase: 'blocked', reason: 'verification_required' });
  expect(ok.transport.ensurePullRequest).not.toHaveBeenCalled();
});
it('still honours an approval stored by an earlier host that ran its own reviewer', async () => {
  const f = await fixture(), release = await f.queue.prepare(f.request), path = join(f.options.directory, release.id + '.json'), stored = JSON.parse(await readFile(path, 'utf8'));
  await writeFile(path, JSON.stringify({ ...stored, phase: 'ready', review: { reviewerRunId: randomUUID(), artifactId: randomUUID(), verdict: 'approve', head, treeDigest: stored.snapshot.treeDigest, artifactDigest: stored.snapshot.artifactDigest, independent: true, noEdits: true } }) + '\n', { mode: 0o600 });
  expect((await f.queue.advance(release.id)).phase).toBe('pull_request');
});
it('reconciles a lost merge response without marking a changed candidate approved', async () => {
  const f = await fixture(), release = await f.queue.prepare(f.request); await f.record(release.id); await f.queue.advance(release.id);
  f.transport.merge.mockImplementationOnce(async () => { f.mutate({ baseHead: merged, baseIsAncestor: false }); throw new Error('reply lost after merge'); });
  await expect(f.queue.advance(release.id)).rejects.toThrow('reply lost');
  expect((await f.queue.status(release.id)).phase).toBe('merging');
  expect((await f.queue.advance(release.id)).phase).toBe('deploying');
  f.mutate({ head: '0'.repeat(40) }); expect((await f.queue.advance(release.id)).phase).toBe('blocked'); expect(f.transport.deploy).not.toHaveBeenCalled();
});
it('keeps deployment pending until exact build proof and rejects state symlinks', async () => {
  const f = await fixture(), release = await f.queue.prepare(f.request); await f.record(release.id); await f.queue.advance(release.id); await f.queue.advance(release.id);
  f.transport.deploy.mockResolvedValueOnce({ commit: pages } as { commit: string; url: string });
  expect((await f.queue.advance(release.id)).phase).toBe('deploying');
  expect((await f.queue.advance(release.id)).phase).toBe('deployed');
  const path = join(f.options.directory, release.id + '.json'), bytes = await readFile(path);
  await rm(path); const other = join(f.root, 'elsewhere'); await mkdir(other); const target = join(other, 'record');
  const { writeFile } = await import('node:fs/promises'); await writeFile(target, bytes); await symlink(target, path);
  await expect(f.queue.status(release.id)).rejects.toThrow();
});
