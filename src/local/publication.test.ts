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
  const review = vi.fn(async () => ({ reviewerRunId: randomUUID(), artifactId: randomUUID(), verdict: 'approve' as const, head, treeDigest: current.treeDigest, artifactDigest: current.artifactDigest, independent: true as const, noEdits: true as const }));
  const transport = { ensurePullRequest: vi.fn(async () => ({ number: 7, url: 'https://github.com/synthetic/project/pull/7' })), merge: vi.fn(async () => { current = { ...current, baseHead: merged, baseIsAncestor: false }; return merged; }), deploy: vi.fn(async () => ({ commit: pages, url: 'https://synthetic.github.io/project/' })) };
  const options: PublicationOptions = { directory: join(root, 'authority'), policy, capture: async () => ({ ...current }), verification: async id => evidence.get(id), review, transport };
  const queue = await PublicationQueue.open(options), request = { head, branch: current.branch, title: 'A synthetic release', body: 'Synthetic fixture only', verificationIds: evidenceIds };
  return { root, queue, options, policy, request, evidence, evidenceIds, review, transport, mutate: (v: Partial<PublicationSnapshot>) => { current = { ...current, ...v }; } };
}
it('runs separate authenticated checks/review/PR/exact-tree merge/Pages stages and survives reopen', async () => {
  const f = await fixture(), release = await f.queue.prepare(f.request);
  expect(release.phase).toBe('awaiting_review');
  expect((await f.queue.advance(release.id)).phase).toBe('ready');
  expect(f.review).toHaveBeenCalledTimes(1);
  expect((await f.queue.advance(release.id)).phase).toBe('pull_request');
  expect((await f.queue.advance(release.id)).phase).toBe('deploying');
  expect((await f.queue.advance(release.id)).phase).toBe('deployed');
  const restored = await PublicationQueue.open(f.options);
  expect((await restored.advance(release.id)).phase).toBe('deployed');
  expect(f.transport.merge).toHaveBeenCalledTimes(1); expect(f.transport.deploy).toHaveBeenCalledTimes(1);
  const view = await restored.status(release.id);
  expect(view).not.toHaveProperty('request'); expect(view).not.toHaveProperty('review');
});
it('reconciles a stable host request UUID after a lost response and rejects a changed replay', async () => {
  const f = await fixture(), requestId = randomUUID(), first = await f.queue.prepare(f.request, requestId);
  expect(first.id).toBe(requestId); await f.queue.advance(first.id);
  expect(await f.queue.prepare(f.request, requestId)).toMatchObject({ id: requestId, phase: 'ready' });
  await expect(f.queue.prepare({ ...f.request, title: 'different intent' }, requestId)).rejects.toThrow('different intent');
  expect(f.review).toHaveBeenCalledTimes(1);
});
it('recovers a dead advancement owner without stealing a live lock', async () => {
  const f = await fixture(), path = join(f.options.directory, 'queue.lock');
  await writeFile(path, JSON.stringify({ ownerPid: 2147483647, token: randomUUID() }), { mode: 0o600 });
  expect((await f.queue.prepare(f.request)).phase).toBe('awaiting_review');
  await writeFile(path, JSON.stringify({ ownerPid: process.pid, token: randomUUID() }), { mode: 0o600 });
  await expect(f.queue.prepare(f.request)).rejects.toThrow('live advancement owner');
});
it.each(['missing', 'scoped', 'forged', 'failed', 'wrong-head', 'wrong-artifact', 'duplicate-check'])('blocks %s evidence before independent review or external mutation', async mode => {
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
  expect((await f.queue.advance(release.id)).phase).toBe('blocked'); expect(f.review).not.toHaveBeenCalled(); expect(f.transport.ensurePullRequest).not.toHaveBeenCalled();
});
it.each([{ head: '0'.repeat(40) }, { baseHead: '0'.repeat(40) }, { artifactDigest: '0'.repeat(64) }, { treeDigest: '0'.repeat(64) }])('invalidates stale candidate before publishing (%j)', async change => {
  const f = await fixture(), release = await f.queue.prepare(f.request); await f.queue.advance(release.id);
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
it('fails closed on changes requested or interrupted independent review', async () => {
  const f = await fixture(), release = await f.queue.prepare(f.request);
  f.review.mockImplementationOnce(async () => { throw new Error('review transport lost'); });
  await expect(f.queue.advance(release.id)).rejects.toThrow('lost');
  expect(await f.queue.advance(release.id)).toMatchObject({ phase: 'blocked', reason: 'operation_interrupted' });
  expect(f.review).toHaveBeenCalledTimes(1);
  const other = await f.queue.prepare(f.request);
  f.review.mockImplementationOnce(async () => ({ reviewerRunId: randomUUID(), artifactId: randomUUID(), verdict: 'changes_requested' as 'approve', head, treeDigest: 'f'.repeat(64), artifactDigest: '1'.repeat(64), independent: true, noEdits: true }));
  expect(await f.queue.advance(other.id)).toMatchObject({ phase: 'blocked', reason: 'changes_requested' });
});
it('reconciles a lost merge response without marking a changed candidate approved', async () => {
  const f = await fixture(), release = await f.queue.prepare(f.request); await f.queue.advance(release.id); await f.queue.advance(release.id);
  f.transport.merge.mockImplementationOnce(async () => { f.mutate({ baseHead: merged, baseIsAncestor: false }); throw new Error('reply lost after merge'); });
  await expect(f.queue.advance(release.id)).rejects.toThrow('reply lost');
  expect((await f.queue.status(release.id)).phase).toBe('merging');
  expect((await f.queue.advance(release.id)).phase).toBe('deploying');
  f.mutate({ head: '0'.repeat(40) }); expect((await f.queue.advance(release.id)).phase).toBe('blocked'); expect(f.transport.deploy).not.toHaveBeenCalled();
});
it('keeps deployment pending until exact build proof and rejects state symlinks', async () => {
  const f = await fixture(), release = await f.queue.prepare(f.request); await f.queue.advance(release.id); await f.queue.advance(release.id); await f.queue.advance(release.id);
  f.transport.deploy.mockResolvedValueOnce({ commit: pages } as { commit: string; url: string });
  expect((await f.queue.advance(release.id)).phase).toBe('deploying');
  expect((await f.queue.advance(release.id)).phase).toBe('deployed');
  const path = join(f.options.directory, release.id + '.json'), bytes = await readFile(path);
  await rm(path); const other = join(f.root, 'elsewhere'); await mkdir(other); const target = join(other, 'record');
  const { writeFile } = await import('node:fs/promises'); await writeFile(target, bytes); await symlink(target, path);
  await expect(f.queue.status(release.id)).rejects.toThrow();
});
