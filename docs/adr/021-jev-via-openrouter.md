# ADR-021: Jev classification through OpenRouter (forwarded-key transport)

Status: accepted, 2026-09-20

## Decision

The router's Jev classification call can run over a second **transport**,
selected by config, in addition to the direct TypeSafe path:

- `"typesafe"` (the default, unchanged): `POST https://api.typesafe.ai/v1/systemone`
  with Milo's own `JEV_API_KEY` (ADR-003).
- `"openrouter"`: `POST https://openrouter.ai/api/alpha/decisions` with the
  **caller's own forwarded OpenRouter key** — the same key that pays for the
  completion. TypeSafe's Jev is published on OpenRouter's alpha "Decisions"
  router under the slug `~typesafe/jev-latest`, and the systemone wire shape is
  identical there: `{ model, state, questions }` in, `{ model, answers, usage }`
  out, question types `noul`/`choice`/`score`, per-level probabilities and
  confidences intact.

The transport is chosen with `GatewayOptions.jevTransport`, the
`jevTransport` field in `milo.config.json`, or the `MILO_JEV_TRANSPORT`
environment variable (env beats config beats the `"typesafe"` default). The
direct TypeSafe path stays the default and the fallback — nothing changes for
a deployment that does not opt in.

`jev-latest`-only still holds: the OpenRouter alias `~typesafe/jev-latest`
always resolves to the newest released Jev (observed `typesafe/jev-1.13-20260917`)
and never to a preview, and the client rewrites a bare `jev-latest` to that
alias. The policy profile (`JEV_PROFILE`) is unchanged, because it is the same
scorer answering.

### Scope: only the classification call moves

Only the router's per-request classification call (ADR-002's `task_type` /
`difficulty` / `needs_reasoning` / `long_output` question set) runs on the
OpenRouter transport. Milo's other Jev uses — best-of-N sample ranking
(ADR-010), preference capture (ADR-011), the completeness gate (ADR-013),
fact-relevance (ADR-017/018) and context pruning (ADR-014) — keep running on
Milo's own TypeSafe `JEV_API_KEY`. That is deliberate: the classification call
is the one that fires on *every* routed request, so moving it to the user's
key captures essentially all of the Jev spend and makes the critical routing
path independent of Milo's key, while the auxiliary features (all of which
fail open) keep a single, simple key story.

## Why

- **Cost.** The classification call is one per routed request. Billing it to
  the user's single OpenRouter key removes Milo's per-request Jev cost for it
  and folds it into the one key the user already brought. Measured through
  OpenRouter: `~$0.0000165` per call (393 in / 72 out at $0.042/M input,
  $0/M output), at parity with the direct path's `~$0.00002` and with no
  Milo-side spend.
- **Outage risk.** ADR-005 made Jev the only decision backend with no fallback
  tier, so Milo's single `JEV_API_KEY` running dry (as it did mid-build, see
  `docs/PLAN.md`) turns every `milo/auto` request into a 503. Under this
  transport the routing decision rides the user's own OpenRouter key and its
  own quota, so a Milo-key outage no longer stops routing.

## How the key reaches the call, safely

The forwarded key is threaded per request, never held in a shared client:

- `RouteRequest.jevKey` (core `types.ts`) carries the caller's resolved
  upstream OpenRouter key. The gateway sets it — from
  `forwardedUpstreamKey(c)`, the same resolved key that pays for the
  completion (the account sub-key for a Milo-billed caller, the caller's own
  key for BYOK) — only when the transport is `"openrouter"` (`AppDeps.forwardJevKey`).
- `JevClientLike.systemone`'s `opts.apiKey` (core `types.ts`) is a per-call
  bearer. The router passes `req.jevKey` through as `opts.apiKey` on the
  classification call only.
- The **TypeSafe transport ignores `opts.apiKey`** and always authenticates
  with its configured `JEV_API_KEY`. A forwarded OpenRouter key can therefore
  never be sent to `api.typesafe.ai`, whatever the caller does. The OpenRouter
  transport prefers the per-call key and rejects a call that has neither a
  per-call nor a configured key rather than sending one unauthenticated.

The forwarded key is read once to authenticate the Jev call. It is never
placed on a `RouteDecision`, never written to the decision log, and never
logged (ADR-003 is unchanged: Milo stores no key material and no message
content).

## Relationship to ADR-003 and ADR-005

ADR-003 held that "Milo supplies the Jev key itself" and already foresaw this
as additive: *"When Jev opens up, an optional way to let users bring their own
[Jev credential] … is an additive change."* Jev is now reachable on the user's
own OpenRouter key through OpenRouter, which is exactly that opening. This ADR
revises the single-Milo-key stance (ADR-003's key model, and the
single-backend outage exposure ADR-005 accepted) **under the user's direction**:
routing Jev on the forwarded OpenRouter key is now a supported, config-selected
mode. It does not retract ADR-005's "no fallback tier" — a failed decision is
still a 503 — nor ADR-003's no-storage/no-logging guarantees. The default
deployment is unchanged: TypeSafe direct, on Milo's key.

## Wire-shape deltas handled

The OpenRouter Decisions response is a superset of native systemone and needed
three small adaptations in the client, all transport-local:

1. **Endpoint path**: `/api/alpha/decisions` instead of `/v1/systemone`.
2. **Request id**: read from the `x-generation-id` header (the `gen-dec-…` id),
   falling back to the response body's `id` when a proxy strips the header,
   instead of TypeSafe's `x-typesafe-request-id`.
3. **Extra body fields**: the response carries additional `id`, `provider`, and
   a `usage.cost` field; the existing tolerant validator accepts them.

## Consequences

- `packages/core/src/types.ts` gains two optional, additive fields —
  `RouteRequest.jevKey` and `JevClientLike.systemone`'s `opts.apiKey` — plus
  the `JevTransport` type and the `JEV_OPENROUTER_*` constants. This ADR covers
  those contract changes (per CLAUDE.md, a `types.ts` change needs an ADR).
  Both fields are optional, so every existing caller compiles and behaves
  unchanged.
- `GatewayOptions.jevTransport`, `milo.config.json`'s `jevTransport`, and
  `MILO_JEV_TRANSPORT` are new, all defaulting to `"typesafe"`.
- `JEV_API_KEY` is still required in either mode, because the auxiliary Jev
  uses stay on Milo's key.
- The OpenRouter transport depends on an **alpha** OpenRouter endpoint
  (`/api/alpha/decisions`); if OpenRouter changes or withdraws it, flip the
  config back to `"typesafe"` — no code change and no key rotation.
