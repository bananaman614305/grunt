import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { bindReview, parseReviewRecord, reviewSummaryLimit } from './publication-review.js';
import type { PublicationRecord } from './publication.js';
const release: PublicationRecord = { version: 1, id: randomUUID(), createdAt: 1, updatedAt: 1, phase: 'awaiting_review', verificationIds: [randomUUID()], request: { head: 'a'.repeat(40), branch: 'grunt/test', title: 'fixture', body: 'fixture', verificationIds: [] }, snapshot: { projectRoot: '/synthetic/project', head: 'a'.repeat(40), treeDigest: 'b'.repeat(64), artifactDigest: 'c'.repeat(64), clean: true, branch: 'grunt/test', baseHead: 'd'.repeat(40), baseIsAncestor: true, gitTree: 'e'.repeat(40) } };
const input = { id: release.id, head: 'a'.repeat(40), gitTree: 'e'.repeat(40), verdict: 'approve', summary: 'Read the diff; no findings.' };
it('accepts exactly the five review fields and binds them to the verified candidate', () => {
  const parsed = parseReviewRecord(input);
  expect(bindReview(release, parsed, 5)).toEqual({ source: 'builder', verdict: 'approve', head: release.snapshot.head, gitTree: release.snapshot.gitTree, treeDigest: release.snapshot.treeDigest, artifactDigest: release.snapshot.artifactDigest, summary: input.summary, recordedAt: 5 });
  expect(parseReviewRecord({ ...input, verdict: 'changes_requested', summary: 'x'.repeat(reviewSummaryLimit) }).verdict).toBe('changes_requested');
});
it.each([
  ['an unknown field', { ...input, independent: true }], ['a missing field', { id: input.id, head: input.head, verdict: 'approve', summary: 'ok' }],
  ['a short commit', { ...input, head: 'abc123' }], ['an unknown verdict', { ...input, verdict: 'approved' }], ['a NUL summary', { ...input, summary: 'a\0b' }],
  ['an oversized summary', { ...input, summary: 'x'.repeat(reviewSummaryLimit + 1) }], ['a non-object', 'approve'],
])('rejects %s', (_name, value) => { expect(() => parseReviewRecord(value)).toThrow('Invalid review record'); });
it('refuses a verdict naming another commit or tree', () => {
  expect(() => bindReview(release, parseReviewRecord({ ...input, head: 'f'.repeat(40) }), 1)).toThrow('exact release candidate');
  expect(() => bindReview(release, parseReviewRecord({ ...input, gitTree: 'f'.repeat(40) }), 1)).toThrow('exact release candidate');
});
