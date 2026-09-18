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
