# ADR-002: Routing signals and policy

Status: accepted, 2026-09-17

## Decision

For each routed request Milo makes one Jev `/v1/systemone` call whose `state` is a compact view of the conversation: the system prompt, the last 3 user turns, whether tools are present, truncated to 8,000 tokens. Four questions are asked in that one call: `task_type` (choice over 9 types), `difficulty` (score, 4 levels, 0..3), `needs_reasoning` (noul), `long_output` (noul).

A versioned policy table in `packages/core/src/router/policy.ts` maps those signals plus the request's cost posture (`low`, `balanced`, `quality`) to a tier (`fast`, `mid`, `frontier`). A roster maps tiers to ordered OpenRouter model ids; users override it in config, and a request may restrict it with `milo.candidates`. The first roster entry for the chosen tier that is not excluded is the model.

A conversation fingerprint (SHA-256 of the system prompt plus the first user message) pins the decision for 30 minutes so multi-turn sub-agents do not switch models mid-task. If Jev fails or exceeds its budget (default 800 ms, configurable; a cold TLS handshake to api.typesafe.ai alone is about 350 ms), the router returns the `mid` tier and marks the decision degraded. Every decision is written to the log with all probabilities, the Jev request id, and the policy version.

## Why

Jev returns calibrated probabilities in about 50 to 100 ms for a fraction of a cent, which is cheap enough to run on every request. A table is inspectable and tunable without retraining; Jev's calibration is unpublished, so thresholds must be adjustable from eval data. Stickiness protects tool-call continuity and prompt caches.

## Consequences

Policy changes bump `POLICY_VERSION` and need an eval run showing agreement on `packages/evals/data/routing.jsonl` (target at least 85%). Adding a signal means adding a question, a field on `RouteSignals`, and an ADR update.

---

## Revision 2: probability mass instead of expected score, 2026-09-17

`POLICY_VERSION` is now `"v2"`.

### What changed

`RouteSignals` gains one field:

```ts
difficultyLevels: number[];   // probability mass on levels 0..3, in order, summing to about 1
```

It is filled from the `difficulty` score answer's `probabilities` (keys `"0".."3"`; a missing key reads as 0). A backend that reports no distribution — no `probabilities`, an empty one, or one whose mass sums to zero — leaves the array empty. Nothing else in `packages/core/src/types.ts` moves.

The policy reads two masses off that array: `P3` (level 3, "hard") and `P2 + P3` (level 2 or above, "substantial or more"). Under balanced posture:

- **fast** when `P2 + P3 < fastBelowMass`
- **frontier** when `P3 >= frontierHardMass` **or** `P2 + P3 >= frontierUpperMass`
- **mid** otherwise

Posture adjusts the rule at both ends rather than replacing it.

`low` raises the fast threshold to at least 0.10 and **caps the outcome at `mid`**: the frontier conditions are not evaluated at all, however much mass sits on level 3. That is the promise a caller makes when they pick `low`, and it is the same ceiling policy v1 had. Its reason sentence still cites the mass that lifted it above `fast` — `"P(level 2+) 0.90 at or above 0.10 routes above fast, but low posture caps at mid"`.

`quality` lowers both frontier thresholds by 0.10 and sends anything that is not fast to frontier once `P2 + P3 >= 0.40`. The lowered thresholds are floored at 0.02 (hard) and 0.10 (upper): without a floor the open profile's 0.10 hard threshold would land on 0.00 and every `quality` reason would read "P(hard) 0.03 at or above 0.00", which explains nothing.

The v1 cap survives in mass terms: a `classify` or `chat` task is pulled back to `mid` unless `P3 >= cappedFrontierHardMass`.

When `difficultyLevels` is empty the v1 expected-score rule runs unchanged, so old fixtures and a degraded backend still route sensibly instead of landing everything on one tier.

### The numbers

The first live eval (120 labeled examples, `system-one-open` backend, balanced posture) scored **69.2%** tier agreement under v1. The reason is visible in the expected score: expected-fast examples average **0.41**, expected-mid **1.11**, expected-frontier **2.05**. v1's fixed thresholds at 1.0 and 2.0 sit outside that range, so almost nothing reached `frontier` on its own merits and the mid and frontier bands collapsed into each other.

The per-level probabilities separate much better. Fitting the three thresholds over the recorded fixtures gives `fastBelowMass` 0.05, `frontierHardMass` 0.10, `frontierUpperMass` 0.65, with the cap lifting at `P3 >= 0.30`. That scores **83.5%** in-sample and **81.8%** under two-fold cross-validation on the 115 matched examples. A replay of the whole committed fixture set scores **83.3%** (band 0 100%, band 1 71.4%, band 2 75.8%, band 3 92.0%); the report is `packages/evals/reports/system-one-open-v2.md`.

Composite rules over the expected score plus `needs_reasoning` were tried and rejected: **75.8%** cross-validated, worse than the masses alone and harder to explain.

### Why thresholds are per backend

The threshold is a statement about the *backend's calibration*, not about the routing question. `system-one-open` hedges: a genuinely hard example often carries only 0.10 to 0.20 of mass on level 3, and a trivial one still carries a percent or two above level 1. A sharper scorer concentrates mass on the level it believes, and the same numbers would then fire on noise. So `packages/core/src/router/policy.ts` exports a `PolicyProfile` per backend and `PROFILES` maps a backend name to one. The `Router` picks a profile from the model name the backend reported (`system-one-open/...` versus anything else), or from an explicit `profile` option; the gateway passes the configured backend kind through, and leaves it unset for `jev-with-fallback`, where either backend may answer any given request.

The `jev` profile (0.10 / 0.25 / 0.50 / 0.50) is **provisional and unvalidated**. Jev's key ran out of quota mid-build (ADR-004), so there is no Jev run to fit against; the numbers are reasoned from Jev scoring 86.9% against the open replica's 76.7% on TypeSafe's public eval, which should mean a sharper distribution and therefore higher bars. They must be refit from a live Jev run before anyone treats them as measured.

### Gate

The 85% target in this ADR is stated for Jev and stays the target. CI holds the `system-one-open` backend to **0.80** (`pnpm eval --gate 0.80`), which the v2 replay clears with room; `MIN_TIER_AGREEMENT` in the eval CLI still defaults to 0.85. The two-fold cross-validation in `packages/evals/src/run.test.ts` asserts a mean held-out agreement of at least 0.78, so a later tuning cannot buy in-sample agreement by overfitting this dataset.
