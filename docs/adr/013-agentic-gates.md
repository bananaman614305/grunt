# ADR-013: Agentic gates and the pi benchmark

Status: accepted, 2026-09-18. Builds on ADR-012 (compute controller);
sequencing ratified in conversation the same day.

## Context

The compute controller tied Fable 5 on the hard-30 (22/30 vs 23/30) at
about a sixth of its estimated cost, and the single-shot economics are
settled. What remains unproven is exactly what the long-horizon suite
could not measure: multi-turn agent sessions, where the expensive failure
modes are a bad tool call that wastes a whole turn, an agent looping
without progress, and answers that silently drop required parts. Every
model we measured — Fable included — failed multi-part deliverables more
than anything else (controller 2/4, Fable's own misses were mostly
completeness).

## Decision

Six gates, all Jev classification, each failing toward more compute or
disclosure, never silent acceptance; and one new instrument to measure the
multi-turn ones honestly.

**Phase A — ships with the gateway compute controller, measurable on the
existing suites:**

1. **Completeness gate.** After a routed answer on a non-trivial cell, one
   Jev call asks whether the answer addresses every part of the request.
2. **Failure-typed retry.** A failing completeness verdict is classified
   (incomplete / off-task / wrong format) and buys exactly ONE retry with a
   fixed template per failure type; Jev then rates both answers and the
   better one is served. Headers disclose the gate verdict and the retry;
   the decision records both answers' metadata, no content. `milo: { gates:
   false }` opts out; low posture never retries.

**Phase B — the instrument:** an agentic benchmark driving pi (already
configured to route through Milo) over ~10 small repository tasks in
sandboxes; success is the task's own test suite passing; measured: solve
rate, turns, tool calls, wall time, tokens, and cost from the decision
log. The current gateway is baselined BEFORE any phase-C gate ships, so
each gate lands against a number.

**Phase C — measured on the pi benchmark, in order:**

3. **Tool-call arbitration.** When sampled candidates propose tool calls,
   Jev ranks the calls (plausible? on-task? destructive?) and the pick
   judges the action, not the prose.
4. **Loop detection.** Over the recent turn window, "is this agent
   repeating itself without progress?" surfaces as a header and, above a
   confidence bar, an injected nudge.
5. **Consistency check.** "Does this contradict an earlier answer in this
   conversation?" — header only.
6. **Context pruning.** Jev scores conversation chunks for relevance and
   Milo drops the rest before forwarding. Opt-in per request (`milo: {
   prune: true }`) because it edits the caller's message history; the
   benchmark must price its savings and its failure rate before any
   default changes.

## Consequences

Jev spend per hard routed request grows to at most N+3 calls (sizing,
ranks, completeness, retry recheck), still under a tenth of a cent. A
retried answer roughly doubles that request's generation cost on the cells
where it fires, bounded by firing at most once. The pi benchmark becomes
the gate for every phase-C item, the way the routing eval gates policy.

## Revision 1 (2026-09-18): what the first long-horizon run showed

Phase A shipped and ran. Four things the decision log (`GET /v1/decisions`)
showed, and what changed because of them. None of this moves a threshold in
`types.ts` or the policy profile, so `POLICY_VERSION` stands at `v4`.

1. **The verdict's confidence was being thrown away.** `complete` verdicts at
   confidence 0.31-0.57 sat on answers whose own sampled `jevQuality` was
   0.6-2.1; genuinely complete answers were called at 0.82-0.99. A `complete`
   verdict below `GATE_TRUST_CONFIDENCE` (0.6) is now *suspect*: the gate
   rates the answer itself, serves it with
   `x-milo-completeness: complete-low-confidence` when it rates at or above
   `GATE_SUSPECT_QUALITY` (2.0), and otherwise treats it as a failure. A
   verdict the gate cannot re-rate is still served. Cost: one extra Jev call
   on the low-confidence slice only.

2. **A retry must escalate, not re-beg.** The one retry that fired re-prompted
   the same fast model whose five samples had all rated 0.57-0.85; the retry
   scored 0.79. Same-model re-prompting cannot fix a capability miss. A
   warranted retry now runs on the strongest model the decision already names
   (`escalationFor`: `unsampledModel`, a sampled cell's `unsampledTier`
   resolved against the caller's roster, or the controller's band-3
   orchestrator below band 3), with the failure type's template unchanged.
   Same-model retry remains only when nothing stronger exists. Still at most
   ONE retry; the model it ran on is in the gate record and on
   `x-milo-retry-model`.

3. **Band 3 is not a sampling cell.** Roster-mode `edit`/`docs` decisions in
   band 3 were drawing best-of-5 on FAST while their own `unsampledTier` was
   `frontier` -- five draws of a model that cannot do the task. The ADR-012
   controller, measured on the same bands, spends band 3 on its *stronger*
   model instead. Policy v4's sampling cells now stop at band 2: band 3 keeps
   `chooseTier`'s single call. The simpler of the two options on the table,
   and the eval is unmoved (it scores `unsampledTier ?? tier`, which is the
   same tier either way): 81.7% at the 0.80 gate, as before.

4. **The all-samples-failed fallback 404'd.** Two band-3 `docs` decisions lost
   all five samples to the 60 s per-sample cap, and the fallback to the
   frontier model then recorded upstream status 404. Cause: the outgoing body
   carries `provider.max_price`, a ceiling `applyProviderStrategy` computed
   for the *sampled* model, and `prepareBody` only rewrites `model` -- so the
   fast model's ceiling went out with a frontier model's request and excluded
   every endpoint it has. The fallback (and the escalated retry) now recompute
   the ceiling for the model actually being called
   (`retargetProviderStrategy`); a caller-supplied `provider` is still never
   touched. Separately, a prompt over `LARGE_PROMPT_CHARS` (~8k characters)
   doubles the per-sample cap, so the 60 s default becomes 120 s.
