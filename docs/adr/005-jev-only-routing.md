# ADR-005: Jev-only routing, no fallback tier

Status: accepted, 2026-09-17

## Decision

Jev is the only decision backend. The `system-one-open` open replica and the
`jev-with-fallback` backend introduced by ADR-004 are removed, along with the
`decisionBackend` config block, `MILO_DECISION_BACKEND`, and
`SYSTEM_ONE_OPEN_URL`. `milo serve` always requires `JEV_API_KEY` and always
routes through Jev; there is no other backend to select.

There is also no fallback tier. Previously, a Jev failure or timeout
degraded the decision to the `mid` tier and let the request through anyway
(ADR-003's "never block a request on the router"). That is gone. When the
router cannot get a clean answer from Jev, routing a request that asked for
`milo/auto` fails outright:

- **503**, with a `Retry-After` header, when Jev is unreachable, timed out,
  answered with a non-2xx, or answered with something that does not parse
  into `RouteSignals` — `packages/core/src/router/errors.ts`'s
  `RoutingUnavailableError`, carrying a `RoutingUnavailableCause`
  (`timeout | network | http | validation | breaker_open | rate_limited`)
  the gateway turns into the client's own error dialect, never upstream
  text (ADR-003 is unchanged on that point).
- **429**, with a `Retry-After` header, when the caller's own token bucket
  is empty (`docs/api/gateway.md`, "Rate limiting"). This was already a
  distinct case; it no longer gets silently downgraded to `mid` either.

An explicit model name on the request (anything other than `milo/auto`)
still passes through to OpenRouter untouched — Milo never gets in the way of
a request that did not ask to be routed. Only `milo/auto` without a usable
Jev answer is an error.

## Why

The degraded-to-`mid` fallback existed to paper over two different holes:
Jev being closed early access with a key that could run dry mid-build, and
`system-one-open` being slow to wake from cold. Neither reason holds once
Jev is the shipped, funded, sole backend. A silent downgrade is also the
wrong failure mode for a *routing* product: a user who asked for `milo/auto`
and got `mid` instead of `frontier` has no way to know that happened short
of reading `x-milo-tier` on every response, and `docs/PLAN.md`'s "known gap"
about a cold open-backend request quietly degrading was exactly this
problem. An explicit 503 is legible, retryable, and observable in a way a
silently-substituted tier is not.

Removing the second backend also removes an entire wire-format translation
layer (`SystemOneOpenClient`), a breaker over two hops instead of one
(`FallbackDecisionClient`), and a second fixture format and CI gate to keep
green. Milo is a single-vendor product now; the code should look like one.

## Resilience without a fallback tier

Cutting the fallback tier does not mean cutting resilience — it means
putting the resilience in front of the single backend instead of behind a
second one:

- **Exponential-backoff retries** on a Jev call that fails with a
  transient-looking cause, so a blip does not immediately become a 503.
- **A short circuit breaker**, opening after a run of consecutive Jev
  failures and skipping straight to a fast 503 for a cooldown window rather
  than piling timeouts on top of an outage — the same shape ADR-004's
  breaker had, now guarding one backend instead of arbitrating two.
  `RoutingUnavailableCause` includes `breaker_open` for exactly this case.
- **In-flight request coalescing**: identical concurrent asks (same
  fingerprint, no cached decision yet) share one Jev call instead of each
  opening its own, which is also what keeps a breaker's failure count
  meaningful under concurrent load.
- **A persisted sticky cache.** The in-process sticky cache already pinned a
  clean decision for 30 minutes (`docs/routing.md`, "Stickiness"); it is now
  backed by a store, `packages/core/src/router/sticky-store.ts`'s
  `StickyStore` (`get`/`set`/`delete` over a `StickyEntry`), so a redeploy or
  an instance restart does not force every live conversation to re-ask Jev
  the moment it comes back up. The in-memory cache stays the fast path; the
  store is what survives past it.

None of this is optional polish: with no second backend to catch a failure,
these are what keep an ordinary Jev hiccup from turning into a 503 that a
caller actually sees. The 503 is the last resort, not the first response to
a slow answer.

## Consequences

**A routed request can now fail.** Every caller of `POST
/v1/chat/completions` with `model: "milo/auto"` must handle a 503 (retry
after the given `Retry-After`) in addition to the errors it already handled.
This is a behavior change from every prior wave, where routing never
rejected a request.

**The CLI and evals lose the `--degraded` surface.** `milo decisions
--degraded`, the `Degraded:` line in `milo explain`/`milo stats`, and the
`degraded` field on `RouteDecision` no longer mean anything a client of
these tools needs to see: a decision that made it into the log succeeded, by
construction. Anywhere a decision could not be reached, there is no decision
row at all, only the 503 the caller already saw.

**Docs and fixtures.** `docs/adr/004-decision-backends.md` is deleted. Every
`system-one-open` fixture, report, and cross-validation test goes with it.
The eval set's policy profile stays keyed on the backend it is fitted for
(`packages/core/src/router/policy.ts`'s `JEV_PROFILE`), since that
distinction was never about which backend was reachable, only about how
each one spreads its probability mass (`docs/routing.md`).

**Fly and config.** `MILO_DECISION_BACKEND` and `SYSTEM_ONE_OPEN_URL` are
gone from `fly.toml`, `milo.config.example.json`, and every doc. `JEV_API_KEY`
is the one credential a deployment needs, already delivered as a Fly secret.
