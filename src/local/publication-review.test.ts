import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { createPublicationReviewer } from './publication-review.js';
import type { PublicationPolicy, PublicationRecord } from './publication.js';
const policy: PublicationPolicy = { version: 1, projectRoot: '/synthetic/project', repository: 'synthetic/project', base: 'main', headPrefix: 'grunt/', requiredChecks: ['tests'], reviewPaths: ['src'], artifactDirectory: 'dist', pagesBranch: 'gh-pages', allowMerge: true, allowDeploy: true };
const value: PublicationRecord = { version: 1, id: randomUUID(), createdAt: 1, updatedAt: 1, phase: 'reviewing', verificationIds: [randomUUID()], request: { head: 'a'.repeat(40), branch: 'grunt/test', title: 'fixture', body: 'fixture', verificationIds: [] }, snapshot: { projectRoot: policy.projectRoot, head: 'a'.repeat(40), treeDigest: 'b'.repeat(64), artifactDigest: 'c'.repeat(64), clean: true, branch: 'grunt/test', baseHead: 'd'.repeat(40), baseIsAncestor: true, gitTree: 'e'.repeat(40) } };
function fixture() {
  const job = randomUUID(), artifact = randomUUID();
  const worker = { start: vi.fn(async () => ({ batchId: randomUUID() })), wait: vi.fn(async () => ({ state: 'completed', results: [{ ok: true, id: job, text: JSON.stringify({ head: value.snapshot.head, verdict: 'approve' }) }] })), artifact: vi.fn(async () => ({ artifact: { id: artifact, complete: true, truncated: false, files: [] } })), close: vi.fn(async () => {}) };
  const review = createPublicationReviewer({ context: async () => 'untrusted fixture diff', workers: () => worker });
  return { worker, review, job, artifact };
}
it('derives authority from an actual separate worker and retained zero-edit artifact', async () => {
  const f = fixture(), result = await f.review(value, policy);
  expect(result).toMatchObject({ reviewerRunId: f.job, artifactId: f.artifact, independent: true, noEdits: true, verdict: 'approve', head: value.snapshot.head });
  expect(f.worker.start.mock.calls[0]![0]).toMatchObject({ tasks: [{ activity: 'review', ownedPaths: ['src'] }] }); expect(f.worker.artifact).toHaveBeenCalledWith(f.job); expect(f.worker.close).toHaveBeenCalledTimes(1);
});
it.each(['edits', 'truncated', 'forged-head', 'failed'])('does not accept %s reviewer evidence', async mode => {
  const f = fixture();
  if (mode === 'edits') f.worker.artifact.mockResolvedValueOnce({ artifact: { id: f.artifact, complete: true, truncated: false, files: [{ path: 'src/file' }] } } as never);
  if (mode === 'truncated') f.worker.artifact.mockResolvedValueOnce({ artifact: { id: f.artifact, complete: true, truncated: true, files: [] } });
  if (mode === 'forged-head') f.worker.wait.mockResolvedValueOnce({ state: 'completed', results: [{ ok: true, id: f.job, text: JSON.stringify({ head: '0'.repeat(40), verdict: 'approve' }) }] });
  if (mode === 'failed') f.worker.wait.mockResolvedValueOnce({ state: 'completed', results: [{ ok: false }] } as never);
  await expect(f.review(value, policy)).rejects.toThrow(); expect(f.worker.close).toHaveBeenCalledTimes(1);
});
