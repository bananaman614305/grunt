# ADR-018: Two-stage fact retrieval

Status: accepted, 2026-09-18. Extends ADR-017 (personal-fact memory).

## Context

ADR-017 gave Milo an encrypted store of a caller's personal facts and one
gate that decides, per routed request, which of them belong in *this* request:
a Jev relevance noul **per stored fact**. That is exactly right for precision
and exactly wrong for scale. The floor of the cost is one Jev call whose size
grows with the vault: a caller with two hundred stored facts pays two hundred
nouls on every routed request, whether or not the turn has anything to do with
any of them. The gate that makes fact memory cheap in tokens makes it linear in
Jev.

The fix is not to weaken the gate -- it is the privacy control and must keep the
final, per-fact say -- but to stop asking it about facts that plainly cannot be
relevant. That is a retrieval problem: given the turn, find the few facts worth
judging, and judge only those.

## Decision

Retrieval runs in **two stages**. A cheap, local pre-filter narrows the vault
to a handful of candidates; the ADR-017 Jev gate then judges only those.

### Stage one: an embedding pre-filter (local, cheap, fail-open)

Each fact is embedded once, at capture, and the vector is stored beside it
(`facts.embedding`, migration 8; a JSON array, nullable). On a routed request
the incoming turn is embedded too, and **cosine similarity** -- plain local
arithmetic, microseconds, no network -- ranks the facts against the turn. Only
the closest few (`RETRIEVAL_TOP_K = 8`) that clear a similarity floor
(`RETRIEVAL_SIM_FLOOR = 0.3`) become candidates. If nothing clears the floor,
there are no candidates and the request spends **zero** Jev relevance calls.

The pre-filter **fails open**. A fact with no stored vector -- captured before
this ADR, or whose capture-time embedding failed -- is passed through as a
candidate rather than dropped, and when embedding is unavailable for a request
at all, *every* fact passes through, which is exactly the pre-ADR-018 behaviour.
A lost or missing vector can only cost a fact a Jev question; it can never
silently forget it.

### Stage two: the ADR-017 gate, unchanged, on the candidates

The relevance noul runs exactly as ADR-017 defined it, but over the candidate
set rather than the whole vault. It still **fails closed**: a candidate that
clears the similarity floor but not the relevance noul is never injected. Stage
one only chooses *what to ask about*; stage two still has the final say on what
reaches the model. Privacy is stage two's job and it is untouched.

### The embedding call, and where its latency goes

Embedding is one small round trip -- a single forward pass, no token
generation, on the order of 50 ms -- against an OpenAI-compatible `/embeddings`
endpoint, authenticated with the **caller's forwarded key** (the same BYOK
credential already paying for the completion). So hosted Milo needs no
embedding key of its own and a self-hoster brings none; the default endpoint is
the same OpenRouter base URL the completions go to, overridable for a provider
that does not serve embeddings.

The turn's embedding is kicked off **in parallel with the routing Jev call**,
not after it. Routing already costs ~350 ms; the ~50 ms embedding hides under
it and adds ~0 ms to the critical path. By the time the relevance gate runs the
vector is already in hand.

### Backfill, so the pre-filter grows complete

A fact stored before this ADR has no vector and would fail open forever,
keeping the old linear cost. So when the gate runs with embeddings available,
it embeds any still-unvectored facts in one batched call and writes them back,
**off the response path** (fire-and-forget, never delaying or failing the
request). After one touch a caller's vault is fully vectored and the Jev cost
is flat.

### Default-on

Retrieval is on wherever fact memory is on (ADR-017's default-on stands); it
adds no server-side key and, failing open, cannot break a request. It is
disabled only where fact memory itself is (no encryption key), or explicitly
via `factRetrieval.enabled = false` in config.

## Consequences

The Jev cost of fact memory stops growing with the vault: it is bounded by
`RETRIEVAL_TOP_K`, and is zero on a turn that matches nothing. Latency is
unchanged in practice, because the one added network call overlaps the routing
call already on the path.

The cost is a new place content leaves the vault: **embedding a fact sends its
text to the embedding provider once, at storage** (and once more per fact on a
backfill). This is the same provider already serving the caller's completions,
under the caller's own key, and the vector it returns is one-way -- but it is a
real disclosure and is recorded here and in `docs/memory.md`. The stored vector
is derived from content, not content, so unlike `content_encrypted` it is kept
as plain JSON; it is used server-side only for ranking and is not returned in
the owner's `GET /v1/memory` listing. `packages/core/src/types.ts` is untouched:
this ADR adds a store column and gateway wiring, no request-contract field.
