/**
 * Two-stage retrieval, stage one (ADR-018): the cheap, local pre-filter that
 * narrows a caller's whole fact vault down to the handful worth spending a Jev
 * relevance call on.
 *
 * The relevance gate (ADR-017, `inject.ts`) asks Jev one question per stored
 * fact. That is exactly right for precision and exactly wrong for scale: a
 * caller with two hundred facts would pay two hundred nouls on every routed
 * request. This module removes that cost without touching the privacy gate.
 * An embedding turns each fact and the incoming turn into a vector; cosine
 * similarity -- plain local arithmetic, microseconds, no network -- ranks the
 * facts by how close they are to the turn; only the top few go on to Jev.
 *
 * Everything here is pure and offline. The one network dependency, turning
 * text into a vector, is behind `EmbedClientLike`, injected exactly as
 * `JevClientLike` is, so the math is tested with plain arrays and no provider.
 *
 * Two invariants hold the design together:
 *
 *   - **The pre-filter fails OPEN.** A fact with no stored vector, or any fact
 *     at all when embedding is unavailable, is passed through as a candidate
 *     rather than dropped. Losing a vector must never silently forget a fact;
 *     the worst an embedding outage can do is fall back to the old behaviour of
 *     asking Jev about everything.
 *   - **The Jev gate still fails CLOSED.** This module only chooses *what to
 *     ask about*. Whether a candidate is actually injected is still decided by
 *     the Jev noul in `inject.ts`, which drops anything it cannot confirm. A
 *     fact that clears the similarity floor but not the relevance noul never
 *     leaves the vault.
 */

import type { InjectableFact } from "./inject.js";

/** A dense embedding of a piece of text. Plain numbers, JSON-portable. */
export type EmbeddingVector = number[];

/**
 * The network boundary for turning text into vectors, injected by the gateway
 * exactly as the Jev client is. The gateway's implementation calls an
 * OpenAI-compatible `/embeddings` endpoint with the caller's forwarded key
 * (ADR-018); tests pass a deterministic double. `embed` takes a batch and
 * returns one vector per input, in order.
 */
export interface EmbedClientLike {
  embed(
    texts: string[],
    opts?: { signal?: AbortSignal; budgetMs?: number },
  ): Promise<EmbeddingVector[]>;
}

/** A fact plus the vector we stored for it, or undefined if we never did. */
export type EmbeddableFact = InjectableFact & { embedding?: EmbeddingVector };

/**
 * How many facts the pre-filter forwards to the Jev relevance gate. Small on
 * purpose: the gate's whole point is that it is cheap, and eight candidates is
 * far more than any single turn has been observed to need while still being a
 * flat, bounded Jev cost no matter how large the vault grows.
 */
export const RETRIEVAL_TOP_K = 8;

/**
 * The minimum cosine similarity a vectored fact must reach to become a
 * candidate. Below this a fact is judged plainly unrelated and never reaches
 * Jev, so an unrelated turn against a full vault can cost zero Jev calls. Set
 * deliberately low: the Jev gate is the precise filter, so this floor only has
 * to shed the obviously-irrelevant, not to make fine distinctions.
 */
export const RETRIEVAL_SIM_FLOOR = 0.3;

/**
 * Cosine similarity of two equal-length vectors, in [-1, 1]. Returns 0 for a
 * length mismatch or a zero-magnitude vector rather than throwing or emitting
 * NaN -- a degenerate vector is "no signal", which the floor then discards.
 */
export function cosineSimilarity(a: EmbeddingVector, b: EmbeddingVector): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    ma += x * x;
    mb += y * y;
  }
  if (ma === 0 || mb === 0) return 0;
  const sim = dot / (Math.sqrt(ma) * Math.sqrt(mb));
  if (!Number.isFinite(sim)) return 0;
  return sim;
}

/** A fact the pre-filter forwarded, with the score that got it through. */
export type ScoredCandidate = {
  fact: InjectableFact;
  /** Cosine to the query, or undefined for a fail-open pass-through. */
  score: number | undefined;
};

export type SelectOptions = {
  topK?: number;
  floor?: number;
};

/**
 * Stage one of retrieval: the facts worth asking Jev about, given the query
 * vector. Two groups survive, unioned and de-duplicated by id:
 *
 *   1. **Vectored facts** whose cosine to the query clears `floor`, keeping at
 *      most `topK` of them, highest similarity first.
 *   2. **Unvectored facts** -- any fact we never embedded -- passed straight
 *      through with an undefined score. This is the fail-open half: a missing
 *      vector must never drop a fact, only cost it a Jev question.
 *
 * When `query` is undefined (embedding was unavailable this request) every
 * fact passes through, which is exactly the pre-ADR-018 behaviour: ask Jev
 * about all of them. The relevance gate downstream is unchanged and still has
 * the final, fail-closed say on injection.
 */
export function selectCandidates(
  query: EmbeddingVector | undefined,
  facts: EmbeddableFact[],
  opts: SelectOptions = {},
): ScoredCandidate[] {
  const topK = opts.topK ?? RETRIEVAL_TOP_K;
  const floor = opts.floor ?? RETRIEVAL_SIM_FLOOR;

  // No query vector: fail open to every fact, order preserved.
  if (query === undefined || query.length === 0) {
    return facts.map((f) => ({ fact: strip(f), score: undefined }));
  }

  const passthrough: ScoredCandidate[] = [];
  const scored: { cand: ScoredCandidate; score: number }[] = [];
  for (const f of facts) {
    if (f.embedding === undefined || f.embedding.length === 0) {
      passthrough.push({ fact: strip(f), score: undefined });
      continue;
    }
    const score = cosineSimilarity(query, f.embedding);
    if (score >= floor) scored.push({ cand: { fact: strip(f), score }, score });
  }

  scored.sort((x, y) => y.score - x.score);
  const top = scored.slice(0, topK).map((s) => s.cand);

  // Union, de-duped by id (a fact is in at most one group already, but guard
  // anyway so the contract is "distinct facts out").
  const seen = new Set<string>();
  const out: ScoredCandidate[] = [];
  for (const c of [...top, ...passthrough]) {
    if (seen.has(c.fact.id)) continue;
    seen.add(c.fact.id);
    out.push(c);
  }
  return out;
}

/** The `InjectableFact` view of an embeddable fact -- the vector dropped. */
function strip(f: EmbeddableFact): InjectableFact {
  return { id: f.id, category: f.category, text: f.text };
}

/**
 * The ids of candidate facts that still lack a stored vector, so the gateway
 * can embed and backfill them off the response path (ADR-018). Once every
 * fact is vectored, the pre-filter is fully in force and the Jev cost is flat.
 */
export function unvectoredIds(facts: EmbeddableFact[]): string[] {
  return facts.filter((f) => f.embedding === undefined || f.embedding.length === 0).map((f) => f.id);
}
