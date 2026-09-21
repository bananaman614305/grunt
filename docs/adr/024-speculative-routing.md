# ADR-024: Speculative routing to hide Jev classification latency

Status: accepted (2026-09-20). Default: **off**.

## Context

Every routed `milo/auto` request that misses the sticky cache and the
classification cache (ADR-023) waits for one Jev `/v1/systemone` call
(~150–400 ms, 800 ms budget) *before* any inference starts. `Router.route()`
must return a decision before `packages/gateway/src/routes/chat.ts` can forward
to OpenRouter, so on a cache miss the user pays the classification latency in
full, on the critical path, ahead of the first token.

Most easy requests route to the fast tier's cheapest model
(`deepseek/deepseek-v4-flash`) anyway. If we start that call *before* Jev
answers, its wall time overlaps the classification (and the brief/facts/prune
Jev calls that follow it), and on the common case we serve an answer that was
already in flight.

The risk is cost. A cancelled speculative call still burns some tokens, and
best-of-N sampling is already ⅔ of spend (ADR-010). A naive "speculate
everything, best-of-N included" would make spend worse and could change what a
client is served. So this feature is conservative by construction and off by
default.

## Decision

Add opt-in speculative routing on the OpenAI chat surface only.

**Correctness invariant (non-negotiable): the response a client receives is
always the one Jev's decision dictates.** Speculation only changes *latency*,
never *routing*. The speculative result is used only when the real, Jev-driven
decision independently resolves to the exact same model as a single, ungated
call, and the forwarded body is byte-identical to what the normal path would
send. In every other case the speculative call is discarded and the normal
forward runs. A speculative call can never turn into a routing change, a
different model, or a different request body.

### What is speculated, and when (`Router.speculativeModel`, core)

A single call, on the request's **resolved fast-tier model** — the cheapest
branch, strictly within the fast tier (never a mid/frontier model via tier
fallback), and never best-of-N. It is offered only when *all* hold:

- speculation is enabled (default off);
- `"roster"` mode (the deepseek compute controller's own band budget is out of
  scope);
- not a forced tier (no Jev call to hide);
- a fresh Jev call would actually happen: no in-memory sticky hit at this same
  ask, no classification-cache hit (on a hit there is no latency to hide, so
  speculating would only waste a call). The async sticky *store* is not
  consulted — reading it would itself add latency to the hot path, and a rare
  store-only hit costs at most one wasted cheap call, never a wrong answer;
- a cheap heuristic marks the request probably-easy: no tools, a short prompt
  (`maxPromptChars`, default 2,000), not `quality` posture. These are the
  requests that overwhelmingly route to the fast tier; an uncertain request
  would mostly miss.

The method never calls Jev and never mutates state.

### How the gateway uses it (`chat.ts`)

1. Before `route()`, `beginSpeculation` starts the fast-tier call in parallel,
   with an `AbortController`. The speculative body is built with the same
   non-decision-dependent transforms the plain forward applies
   (`applyProviderStrategy` for the speculated model + the default reasoning
   exclusion), so a later hit is byte-identical when no enrichment fired.
2. `route()` runs, then brief/facts/prune/gate as usual — the speculative
   inference overlaps all of it.
3. Reconcile at the forward branch:
   - sampled decision (`samples > 1`) → abort, run the fan-out (a single call
     can never stand in for best-of-N);
   - gated decision → abort, run the gated forward (the grade/retry must run
     over the answer first);
   - plain forward → **hit** iff `decision.model` equals the speculated model
     **and** it is a single call **and** the fully-enriched forwarded body is
     byte-identical to what the speculative call already sent. A hit awaits the
     in-flight response instead of making a new call; a miss aborts and forwards
     normally.

The byte-equality guard means any brief/fact/prune enrichment that changed the
body safely degrades to a miss rather than serving a differently-built
response — correctness holds without enumerating every enricher.

### Cost safety

- **Single cheap call only.** Always one fast-tier model, never best-of-N,
  never a hard-tier model (structural: `speculativeModel` returns only a
  fast-tier id, and the gateway reuses it only for a single-call decision).
- **Cache-miss only.** No speculation on a sticky or classification-cache hit,
  so we never spend a call where there was no latency to hide.
- **Prompt cancel.** A miss aborts the in-flight request immediately, stopping
  token spend and releasing the upstream concurrency slot, so a wasted call
  does not keep counting against concurrency.
- **Hit costs nothing extra.** On a hit the speculative call *is* the real
  call, charged once through the normal forward path. On a miss the user is not
  charged for the discarded call (it is aborted and never recorded).

### Rate-limit / concurrency accounting

- The routed **Jev rate limiter** (`deps.rateLimiter`, ADR-003) is consumed
  once per request before routing and bounds *Jev* spend. A speculative call is
  an OpenRouter call, not a Jev call, so it never touches this budget.
- **Tenant limits** (request/token rate, spend cap, ADR-008) are consumed once
  per request in `handleChat`, before routing. A speculative call is not a new
  gateway request, so it never double-consumes a user's request or token
  budget. On a hit it is the one forward the request always makes; on a miss it
  is aborted.
- The OpenRouter client's **per-model concurrency limiter** counts the
  speculative call as one in-flight call for the fast model. On a hit that is
  the real call; on a miss the prompt abort releases the slot at once.

Net: a speculative call never double-consumes a user's rate budget on a hit,
and a miss releases what it briefly held.

### Disclosure

`x-milo-speculation: hit | miss | off` on the response (absent when the
deployment did not opt in), plus a structured `speculation` log line per
started call, so an operator can compute hit-rate and wasted-call count. No new
decision-log field and no message content is stored (ADR-003 unchanged).

## Config

```json
{ "speculation": { "enabled": true, "maxPromptChars": 2000 } }
```

`GatewayOptions.speculation` and `RouterOptions.speculation` (core), wired in
`createGateway` and validated by the CLI config schema. Both default off, so an
unconfigured deployment behaves exactly as before this ADR.

## Consequences

- No change to `packages/core/src/types.ts`: `RouteRequest`/`RouteDecision` are
  unchanged. The speculation state is gateway-local disclosure, and the
  eligibility check is a new pure `Router` method plus a new `RouterOptions`
  field (neither is in `types.ts`), so no core-contract ADR to `types.ts` was
  required — this ADR documents the design and the default-off stance.
- Latency win is bounded by how often an easy cache-miss actually routes to the
  fast tier as a single, ungated call. Gated (band ≥ 1) and sampled (band ≥ 2)
  decisions never hit; that is intended — they are the expensive requests we do
  not want to guess at.
- A miss is one wasted `deepseek-v4-flash` call. The heuristic keeps misses
  rare, the abort keeps them cheap, and the operator can watch the hit-rate and
  turn the feature off if it is not paying off.
