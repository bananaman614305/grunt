# ADR-022: Full Jev offload — every Jev call on the forwarded key

Status: accepted, 2026-09-20

## Decision

ADR-021 moved the router's **classification** call onto the `"openrouter"`
Jev transport, so it bills to the caller's own forwarded OpenRouter key. This
ADR extends that to **every other Jev call the gateway makes on a user
request**. Under the `"openrouter"` transport, all of these now authenticate
per request with the caller's forwarded OpenRouter key, exactly like the
classification call, and never with Milo's own `JEV_API_KEY`:

- **best-of-N sample ranking** (ADR-010) — `rankAnswer`, the heaviest Jev
  path, one call per sampled answer;
- **the completeness gate** (ADR-013) — `checkCompleteness`, the
  low-confidence re-rating and the both-answers rating (`rankAnswer`), and the
  ground-truth verification (`verifyClaims`, ADR-019) it runs;
- **the standalone `POST /v1/verify` surface** (ADR-019) — `verifyClaims`;
- **context pruning** (ADR-014) — `checkPrune`;
- **personal-fact capture and the relevance gate** (ADR-017/018) — the two
  `systemone` calls in `maybeCaptureFact` and `routedFacts`;
- **preference capture** (ADR-011) — the resolution call in `maybeCapture`.

Consequently, under `"openrouter"`, **`JEV_API_KEY` is not used for any
user-facing Jev call**, and Milo's gateway no longer requires it in that mode.
The default `"typesafe"` transport is unchanged in every respect: every one of
these calls still runs on Milo's own `JEV_API_KEY`, and that key is still
required.

This revises ADR-021's "Scope: only the classification call moves", which had
deliberately kept the auxiliary features on Milo's key for "a single, simple
key story." Under the user's direction, the simpler story is now the better
one: under `"openrouter"` **all** Jev spend lands on the one key the user
already brought, and no user request touches Milo's key at all.

## How the key reaches each call, safely

The mechanism is ADR-021's, applied at each site: the forwarded key is
threaded **per request**, never held in a shared client.

- The gateway resolves the key once per request with `forwardedJevKey(c, deps)`
  (`packages/gateway/src/billing.ts`): the caller's `forwardedUpstreamKey(c)` —
  the same resolved upstream key that pays for the completion (the account
  sub-key for a Milo-billed caller, the caller's own key for BYOK) — but only
  when `AppDeps.forwardJevKey` is set, which the gateway sets only under the
  `"openrouter"` transport. It returns `undefined` under `"typesafe"` and when
  no key is present.
- That value is passed into each Jev-calling function as an explicit
  `apiKey`/`jevKey` argument, which becomes `systemone`'s per-call `opts.apiKey`
  (the contract ADR-021 added to `JevClientLike.systemone`). The core wrappers
  (`rankAnswer`, `checkCompleteness`, `checkPrune`, `verifyClaims`) gained an
  optional trailing `apiKey?: string`; the gateway helpers (`maybeCapture`,
  `maybeCaptureFact`, `routedFacts`, `maybePrune`) carry it as an optional
  `jevKey`. `routes/chat.ts` computes `forwardedJevKey` once and threads it to
  every feature on the path (and to `RouteRequest.jevKey` for classification);
  `routes/gate.ts`, `routes/sampling.ts` and `routes/verify.ts` compute it from
  the `c`/`deps` they already hold.
- The **TypeSafe transport ignores `opts.apiKey`** and always authenticates
  with its configured `JEV_API_KEY` (unit-tested since ADR-021). A forwarded
  `sk-or-…` key can therefore never be sent to `api.typesafe.ai`, whatever the
  caller does — so the gateway threads the key unconditionally where it is
  convenient, and the transport, not the call site, decides. The OpenRouter
  transport prefers the per-call key and **rejects** a call that has neither a
  per-call nor a configured key rather than sending one unauthenticated.

### The no-user-key case

A per-request Jev call under `"openrouter"` always has the forwarded key: it is
the same key that pays for the completion, present on every real request. If a
call somehow has none (an empty forwarded key), the site passes `undefined`,
and the `"openrouter"` Jev client — built with an empty configured key — throws
a validation error rather than falling back to Milo's key (there is none to
fall back to, by construction). Every auxiliary feature already **fails open**
(ranking marks the sample, the gate serves the answer as-is, pruning forwards
unpruned, fact/preference capture no-op), so the request still succeeds without
that feature. It never silently reaches for `JEV_API_KEY`.

## Configuration

- `GatewayOptions.jevApiKey` becomes optional and is required at runtime only
  under `"typesafe"`. `createGateway` builds one transport-selected `JevClient`
  used both as the router's classification client and as `AppDeps.jev` for the
  auxiliary features: under `"openrouter"` it is an OpenRouter-transport client
  with no configured key; under `"typesafe"` it is Milo's key, unchanged.
- `milo serve` resolves `MILO_JEV_TRANSPORT` / config `jevTransport` before the
  key check and requires `JEV_API_KEY` only under `"typesafe"`.

## `types.ts` additions

None. This change needs no change to `packages/core/src/types.ts`: it reuses
the contract ADR-021 already added there and in `packages/core/src/jev/types.ts`
(`RouteRequest.jevKey`, `JevClientLike.systemone`'s `opts.apiKey`, the
`JevTransport` type and the `JEV_OPENROUTER_*` constants). The new
`apiKey`/`jevKey` parameters live on functions in other files
(`router/sampling.ts`, `router/gates.ts`, `router/pruning.ts`, `verify/verify.ts`,
and the gateway helpers), all optional and additive, so every existing caller
compiles and behaves unchanged.

## Consequences

- Under `"openrouter"`, a deployment can run with **no** `JEV_API_KEY` at all;
  ADR-021's note that "`JEV_API_KEY` is still required in either mode" is
  superseded for this transport.
- The dependency on OpenRouter's **alpha** Decisions endpoint
  (`/api/alpha/decisions`, slug `~typesafe/jev-latest`) now covers the
  auxiliary features too, not just classification. If OpenRouter changes or
  withdraws it, flipping the transport back to `"typesafe"` restores the
  direct-on-Milo's-key behaviour for every call — no code change, and (under
  `"openrouter"`) a `JEV_API_KEY` must be supplied again for `"typesafe"`.
- ADR-003's no-storage/no-logging guarantees are unchanged: the forwarded key
  is read once to authenticate each Jev call and is never placed on a
  `RouteDecision`, written to the decision log, or logged. ADR-005's "no
  fallback tier" is unchanged: a failed routing decision is still a 503; the
  auxiliary features still fail open.
