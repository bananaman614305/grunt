import type { PublicationRecord, PublicationReview } from './publication.js';

const sha = /^[a-f0-9]{40}$/;
/** Largest summary the host retains. The builder chooses its text; the host keeps nothing else from the review. */
export const reviewSummaryLimit = 2000;
export interface ReviewRecordInput { id: string; head: string; gitTree: string; verdict: PublicationReview['verdict']; summary: string }

/**
 * The builder reviews its own release (owner decision) and records the outcome through the file channel.
 * The host cannot confirm who reviewed, so the evidence is labelled `source: "builder"`; what it does enforce is that
 * the verdict names the exact commit and tree of the candidate it verified. Unknown fields are refused.
 */
export function parseReviewRecord(value: unknown): ReviewRecordInput {
  const v = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  if (Object.keys(v).sort().join(',') !== 'gitTree,head,id,summary,verdict' || typeof v.id !== 'string' || typeof v.head !== 'string' || !sha.test(v.head)
    || typeof v.gitTree !== 'string' || !sha.test(v.gitTree) || v.verdict !== 'approve' && v.verdict !== 'changes_requested'
    || typeof v.summary !== 'string' || !v.summary.trim() || v.summary.length > reviewSummaryLimit || v.summary.includes('\0')) throw new Error('Invalid review record.');
  return { id: v.id, head: v.head, gitTree: v.gitTree, verdict: v.verdict, summary: v.summary };
}

/** Binds a recorded verdict to the release candidate; throws unless it names the exact verified commit and tree. */
export function bindReview(release: PublicationRecord, input: ReviewRecordInput, recordedAt: number): PublicationReview {
  const snapshot = release.snapshot;
  if (input.head !== snapshot.head || input.gitTree !== snapshot.gitTree) throw new Error('Review does not name the exact release candidate commit and tree.');
  return { source: 'builder', verdict: input.verdict, head: snapshot.head, gitTree: snapshot.gitTree, treeDigest: snapshot.treeDigest,
    artifactDigest: snapshot.artifactDigest, summary: input.summary, recordedAt };
}
