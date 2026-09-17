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

---

## Revision 3: Jev only, and no fallback tier, 2026-09-17

Two changes that are really one decision: Jev is the only decision backend, and
a request that cannot be routed fails instead of guessing.

### The contract change

`RouteDecision.degraded` and `DecisionRecord.degraded` are **removed**, along
with everything that read or wrote them — `degradedDecision`, the router's
degraded path, the decision log's `degradedOnly` filter and `degraded` stat.
A forward migration (`packages/core/src/log/schema.ts`, version 2) rebuilds the
`decisions` table without the column.

`Router.route` now **throws** `RoutingUnavailableError`
(`packages/core/src/router/errors.ts`) when Jev cannot answer, carrying the
cause (`timeout`, `network`, `http` with its status and Jev request id,
`validation`, `rate_limited`, `breaker_open`) and `retryAfterMs` when one is
known. The gateway turns that into a 503, or a 429 for `rate_limited`. An
explicit model id still passes through to OpenRouter untouched; only
`milo/auto` needs a routing answer, so only `milo/auto` can fail this way.

### Why there is no fallback tier

Returning `mid` and marking the decision degraded reads as robustness and is
not. A caller who sent `milo/auto` asked to be routed. A silent `mid` is a
wrong answer billed at Sonnet prices, and nothing in the response
distinguishes it from a right one — the `x-milo-degraded` header said so, and
no client read it. It also hides outages: the Fly deployment served degraded
decisions through an entire 35-second cold-start window and reported healthy
throughout (revision 2's operational note, and ADR-004's).

Failing loudly puts the choice back where it belongs. A caller who wants a
cheap fallback can send `milo/auto` with `milo.tier`, or retry, or name a
model. None of those options existed while Milo was quietly deciding for them.

The cost is that a Jev outage is now a user-visible error, so the router works
harder not to have one:

- **Retries with backoff.** The Jev client retries network failures, 429, 503
  and 529 with exponential backoff and full jitter (base 200 ms, factor 2, up
  to 3 retries), honouring a `Retry-After` header when the server sends one.
  No other 4xx is retried. All of it runs inside one total budget the router
  passes, so retries cannot outlive the router's own promise to answer.
- **A raised budget.** `ROUTER_LIMITS.jevTimeoutMs` goes from **800 ms to
  3,000 ms**. At 800 ms there was no room for a second attempt, which only
  made sense while a failure cost the caller nothing.
- **A circuit breaker.** Three consecutive transport failures (`network`,
  `timeout`, or 5xx) open it for 30 seconds; it then half-opens and lets one
  request probe. While open, `route` fails immediately with `breaker_open` and
  the remaining cooldown rather than making every caller spend the full budget
  rediscovering the outage. A `validation` failure or a 4xx does not count: Jev
  answered, and the problem is the request, not the backend.
- **Coalescing.** Concurrent `route` calls with the same fingerprint *and* the
  same user-turn count share one Jev call. Each caller still gets its own
  decision id, so the log stays one row per request and the gateway can attach
  each request's upstream outcome to its own row; the callers that joined are
  marked `sticky: true`, and all of them carry the `jevRequestId` of the single
  call that answered. That keeps the log honest about both what was served and
  what was spent.

### Stickiness is user-turn aware, and persists

A sticky entry now records `userTurns`, the number of user messages the
decision was made for, and is reused **only** when the request's count matches.

The fingerprint hashes the system prompt and the *first* user message, so every
turn of a conversation lands on the same key. That is right for a tool-result
continuation — the same ask coming back, where changing models mid-tool-loop
breaks tool-call continuity and throws away the prompt cache. It was wrong for
a follow-up turn: "now make the whole module concurrency-safe" was being served
the tier chosen for "rename res to rows", for up to thirty minutes. A request
with more user turns is a new ask, gets a fresh Jev call with the full recent
context, and replaces the entry.

`StickyStore` (`packages/core/src/router/sticky-store.ts`) backs the in-memory
cache: the router consults it on a memory miss and writes through on every
write. `DecisionLog` implements it over a `sticky` table (fingerprint, decision
id, user turns, expiry, and the decision itself), so the gateway can pass the
log as the store and a redeploy or a second instance stops re-asking Jev for
every live conversation. A store failure is reported and ignored — it costs an
extra Jev call, never a failed request. The 30-minute TTL is unchanged but is
now an option (`RouterOptions.stickyTtlMs`).

Because `StickyStore.get` takes a fingerprint, `DecisionLog.get(id)` was
renamed to **`DecisionLog.getDecision(id)`**. Two `get`s on one class that both
take a string and mean different things is the sort of thing that reads fine
and routes wrong.

### One profile

`system-one-open` is gone from the code (ADR-004 is superseded on this point),
and with it `PROFILES`, `PolicyProfileName`, `resolveProfile`, and
`profileForModel` — there is no backend to dispatch on. `PolicyProfile` stays
as a type and `chooseTier(signals, posture, profile = JEV_PROFILE)` still takes
one, so a tuning run can try a candidate threshold set without editing
`policy.ts`.

`JEV_PROFILE` is the fitted, validated set from the first live Jev run:

| fast gate | fast below | frontier `P3` | frontier `P2+P3` | cap lifts at `P3` |
|---|---|---|---|---|
| level 1+ | 0.35 | 0.05 | 0.65 | 0.25 |

The fast gate reading level 1+ rather than level 2+ is the substantive change.
Jev puts real mid-difficulty work on level 1 — expected-mid examples average
P0 0.17 / P1 0.62 / P2 0.18 / P3 0.03 — so a gate on `P2 + P3` waved most of it
through to `fast`. `PolicyProfile.fastMassFromLevel` selects which, because it
is a property of the scorer's calibration rather than of the routing question.

A replay of the 120 committed Jev fixtures scores **81.7%** overall (band 0
96.3%, band 1 60.0%, band 2 84.8%, band 3 92.0%), task-type accuracy 90.8%,
with every example scored. Confusion: frontier 39/42, mid 25/31, fast 34/47.
That clears the 0.80 CI gate and still sits under the **85% target this ADR
states for Jev**; the fast/mid boundary is where it is lost, and 13 fast-labeled
examples predicted `mid` is most of the gap. `jev-preview` is not used: its
calibration changes without notice and a profile does not transfer between
scorers, so `JEV_DEFAULT_MODEL` pins `jev-latest`.

### Fixtures are keyed by endpoint, not by URL

A fixture's lookup key was a hash of method + **whole URL** + body. Recordings
go through a key-injecting egress proxy that serves Jev at
`https://<proxy-host>/v1/egress/<grant-id>/v1/systemone`, so a replay only
matched when `JEV_BASE_URL` was pinned to that exact address — which is why CI
carried a grant URL in its environment, and why the grant id was effectively
baked into 120 committed filenames.

The key now hashes method + the **API-relative path** + body: no scheme, host,
port, or proxy mount point. `fixtureKeyFor(method, url, body)` is exported for
re-keying the committed fixtures, and the full recorded URL is still written
into each fixture file for tracing.
