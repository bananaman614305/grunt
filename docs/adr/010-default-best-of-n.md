# ADR-010: Best-of-N sampling as a default routing outcome

Status: accepted, 2026-09-18. Extends ADR-002 (policy) and ADR-005 (Jev-only).

## Context

Brown et al. 2024 ("Large Language Monkeys") show that a cheap model sampled
N times covers far more tasks than it does once, and that the gain converts
to accuracy only when a selector can pick the right sample. Milo already has
the selector: Jev. Two full live benchmark runs (120 labeled prompts, four
arms plus best-of-5 on the fast tier with varied prompt framings,
`packages/evals/reports/`) measured, per answer and graded on output:

- Jev ranks answers well: AUROC 0.87 and 0.91 against the graders' verdicts
  across the two runs; where samples disagreed, Jev's pick passed 85% and
  88% of the time against a 55% random pick.
- Best-of-5 on the fast tier beats the tier the policy would otherwise pick
  on some cells and loses on others. Stable winners across both runs:
  **edit** (92% vs 77% mid in the final run) and **docs** (100% vs 92%).
  Stable losers: feature, research, debug, where the mid tier wins outright.
- Cost per sampled answer (five fast draws plus five Jev ranks) is in the
  same band as one mid call and far below frontier; wall time is bounded by
  fast providers plus a per-sample cap (p50 under 10 s in the final run).

## Decision

Sampling is a **routing outcome, not a mode**: policy v4 may resolve a cell
to `{ tier: "fast", samples: N }` instead of a higher tier. Cells start
where the data is stable — `edit` and `docs` at difficulty bands 1..3
sample five; every other cell keeps its single-model outcome — and the
table stays diffable code, tuned by the benchmark like every other policy
change, gated in CI the same way.

The gateway executes a sampled decision by fanning out N identical upstream
calls on the user's key (varied framings appended to the system prompt),
ranking each finished answer with one Jev closed-rubric call on Milo's key,
and returning the best. The hierarchy evaluates truth/contract vetoes before
completion and scope requirements, then maintainability and task-specific
preferences. Unknown required evidence abstains; deterministic pairwise
comparison uses outcome, aggregate quality, correctness, then sample index.
A streamed request buffers until selection and
then replays the chosen answer as normal SSE. Tool-call answers are picked
like any other; the client executes only what it receives.

Revision 2 (2026-09-22) wires canonical task records into this production
path. When present, the record's criterion decisions and source-linked evidence
replace the inferred rubric. Confident Veritaserum vetoes dominate, required
unknowns abstain, and Jev makes one direct comparison between the two strongest
viable candidates. A non-decision falls back to the unsampled tier instead of
serving an arbitrary sample. The historical selector remains unchanged when a
request has no canonical task record.

Revision 3 (2026-09-22) makes the canonical record the verification and
persistence boundary across turns and attempts. The gateway atomically stores
one bounded state per caller and task id: current task version, relevant
criterion evidence, decision-scoped candidate deltas, unresolved obligations,
and provenance. Ranking and pairwise selection consume that state through a
decision-specific dossier with explicit truncation. Raw history and candidate
content are never persisted. Stale task versions, same-version rubric changes,
and unavailable persistence fail closed rather than silently reverting to
request-local verification.

Disclosure and control, in the ADR-002 explainability tradition:

- Headers on every sampled response: `x-milo-samples: 5`,
  `x-milo-sample-pick: <index>`; the decision record stores per-sample
  token counts, cost, Jev scores, and the pick, no content.
- Per-request opt-out `milo: { samples: 1 }` (or any explicit N, capped at
  8); `posture: "low"` never samples; a per-key roster-style setting can
  disable it for a deployment or key.
- Docs state plainly that a sampled cell spends roughly N fast-tier calls
  of the user's OpenRouter budget and why that is still cheaper than the
  tier it replaces.

## Consequences

Routed spend on sampled cells multiplies by N on the cheapest tier while
accuracy on those cells rises above the tier the policy used to buy; TTFT
on sampled cells rises to the slowest capped sample plus one Jev rank.
Jev spend per sampled request rises from one call to N+1, still under a
tenth of a cent. If a future eval shows a cell regressing, the fix is a
policy-table edit, not a feature flag hunt.
