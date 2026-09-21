# ADR-023: Short-TTL Jev classification cache

Status: accepted, 2026-09-20

## Decision

The router gains a second, complementary cache alongside stickiness
(`StickyCache`, ADR-002): a short-TTL `ClassificationCache`
(`packages/core/src/router/classification-cache.ts`) that remembers a Jev
classification (`RouteSignals`) rather than a whole `RouteDecision`.

- **Keyed** on the same string in-flight coalescing already uses --
  `` `${fingerprint}\0${userTurns}` `` -- so a hit requires the exact
  fingerprint (already scoped to the caller by the gateway's `callerScope`,
  ADR-008: never shared across two different keys) *and* the exact
  user-turn count. This is deliberately the same discipline stickiness
  already established for "is this really the same ask", not a looser one:
  two existing tests (`Router.route: user-turn-aware stickiness > re-evaluates
  when the user takes another turn`, `> pins the new decision`) already pin
  the invariant that a later user turn on the same fingerprint gets its own
  Jev answer, because it may be a much harder or much easier question than
  the first. A classification cache that ignored user-turn count would
  violate that invariant.
- **Reuses only the classification**, never the decision: every hit still
  runs policy (`Router.decide`) fresh against the caller's own
  posture/candidates/roster/best-of-N for *this* request. A sticky hit
  replays the whole prior decision unchanged (by design -- a tool loop must
  not have its model swapped mid-call); a classification-cache hit does not
  carry that constraint, so it is free to answer a changed request-level
  knob correctly instead of replaying whatever the first request happened to
  resolve to.
- **Short TTL** (default 5 minutes, vs. stickiness' 30) and **bounded size**
  (default 5,000 entries, LRU), both independently configurable
  (`RouterOptions.classificationCache*`, `GatewayOptions.classificationCache`,
  `milo.config.json`'s `classificationCache`) and independently disableable.
  The short default matters because the two caches fail differently: a stale
  *decision* pinned past its usefulness is a correctness bug (the whole
  reason stickiness re-evaluates on a new user turn); a stale *classification*
  replayed for a few minutes only costs the policy an occasionally-outdated
  difficulty guess for the same caller's same opening ask, never a wrong user
  and never model-pinning across a conversation that has moved on.
- Checked in `Router.route` after a sticky miss and before a fresh Jev call
  (a new step 3, renumbering the old "ask Jev" step to 4). Under a
  deployment's default config (`stickyTtlMs` 30 minutes, classification cache
  TTL 5 minutes, same key), an exact repeat within 5 minutes is already a
  sticky hit, so the classification cache's own value shows up specifically
  when a deployment configures the two caches' windows differently -- for
  example, a short or disabled `stickyTtlMs` (no continuity pinning wanted)
  paired with the classification cache's default window (cost savings still
  wanted), or a sticky entry evicted by its own LRU bound while the
  classification cache, a smaller structure, still holds the answer.

## Why

Jev classification now bills to the caller's own forwarded OpenRouter key
under the `"openrouter"` transport (ADR-021, ADR-022), so a repeat
classification is a repeat charge on the user's own key, not Milo's. A cache
that skips it on an exact repeat both saves that spend and removes
~150-400ms of Jev latency from the critical path, without touching the
transport, the key-isolation guarantees those ADRs established, or
stickiness' own conversation-continuity behaviour.

## `types.ts` addition

`RouteDecision.cached?: boolean` -- optional, additive. Set only on a
classification-cache hit, distinct from `sticky` (which also covers a
sticky-cache/store hit and an in-flight-coalescing join, none of which are
classification-cache hits). The distinction is not cosmetic: `sticky`
implies "no fresh Jev call was made", which is still true for a
classification-cache hit and is why it is reported as `sticky: true` too; but
unlike an ordinary sticky hit, a `cached` decision's tier/model were decided
fresh, so they can legitimately differ from whatever request first produced
the cached signals. Reusing `sticky` alone for this would have collapsed two
different guarantees into one flag; a second field was the smaller change
against having to widen `sticky` into an enum (a wire-format change every
existing reader of `x-milo-sticky` and `decision.sticky` would need to
account for) or duplicate a full second decision-shaped type. `cached` is not
persisted to the decision log (no new SQL column, no migration): it is a
per-request disclosure, exactly like `RouteDecision.unsampledModel` already
is today.

The gateway discloses it as `x-milo-cache: hit|miss` (`applyMiloHeaders`,
`packages/gateway/src/routes/shared.ts`), on all three routed dialects (chat
completions, `/v1/messages`, `/v1/responses`) and the sampled/gated forward
paths, which all funnel through the same helper.

## Consequences

- `RouterOptions` gains `classificationCache`, `classificationCacheTtlMs`,
  `classificationCacheMaxEntries`, `classificationCacheEnabled` -- all
  optional, mirroring the existing `sticky`/`stickyTtlMs` shape.
  `GatewayOptions.classificationCache` and `milo.config.json`'s
  `classificationCache` are new and optional; a deployment that sets nothing
  gets the cache on with the defaults above.
- Two existing router tests (`stickiness > takes a stickyTtlMs option`,
  `coalescing identical asks > clears the entry on settle`) pin behaviour that
  is specific to stickiness' or in-flight coalescing's own mechanism and now
  pass `classificationCacheEnabled: false` so the new, correctly-complementary
  cache does not mask what they are testing.
- Preference-capture detection (`RouteSignals.capture`, ADR-011) rides along
  with a cached classification exactly as it already does on a sticky hit:
  neither cache strips it, so a capture signal detected on the call that
  populated the cache can be replayed on a later hit. This is an existing,
  accepted imprecision (stickiness already does it), not a new one, and
  `capture` never carries message content.
