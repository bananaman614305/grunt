# ADR-004: Pluggable decision backends

Status: accepted, 2026-09-17

## Decision

The thing that answers Milo's four routing questions is a *decision backend*, chosen at startup. Three are shipped:

| kind | what answers | needs `JEV_API_KEY` |
|---|---|---|
| `jev` (default) | TypeSafe's Jev, `POST /v1/systemone` | yes |
| `system-one-open` | a `mithalouni/system-one-open` deployment, `POST /decide` | no |
| `jev-with-fallback` | Jev, falling back to system-one-open | yes |

The router is untouched. It already depends only on `JevClientLike` from `packages/core/src/jev/types.ts` — `systemone(request, { signal }) -> SystemOneResult` — so a backend is an implementation of that one method. `packages/core/src/jev/types.ts` and `packages/core/src/types.ts` are unchanged; nothing about `RouteSignals`, `RouteDecision`, or the policy table moves.

`GatewayOptions.decisionBackend` selects one; `milo.config.json`'s `decisionBackend` block and the `MILO_DECISION_BACKEND` / `SYSTEM_ONE_OPEN_URL` environment variables feed it. `GET /healthz` reports the configured kind as `decisionBackend`.

### The backend interface

`SystemOneOpenClient` (`packages/core/src/decision/system-one-open.ts`) translates in both directions and hides every difference between the two wire formats:

- **Questions.** Jev takes a record keyed by question name; the open backend takes a list of objects each carrying its own `id`. Choice `criteria` (name to description-or-`null`) become `options` (name to description, with a `null` or blank description replaced by the name). Score `criteria` become `levels`. A noul question's `instructions` and its `criteria.true` / `criteria.false` are folded into one instruction string (`"...\n\nAnswer true when: ...\n\nAnswer false when: ..."`), so no part of the routing prompt in `router/questions.ts` is lost in translation.
- **Answers.** The list comes back keyed by question name. A choice answer passes through. A score answer's `legend` is rebuilt from the request's own criteria (index as string to text), because the open backend does not return one, and its `probabilities` are normalized to level-index keys. A noul answer becomes `{ type: "noul", noul }`.
- **Metadata.** `model` is `system-one-open/<the model the backend reports>`, so a decision-log row says which backend produced the signals. `usage` is zeroed: the backend reports no token counts and inventing them would put a fiction in the log. `requestId` is a locally generated ULID prefixed `s1o_`, since the backend sends none. `latencyMs` is measured client-side.
- **Failures.** Everything is raised as `JevError` with the same four kinds the Jev client uses — `timeout`, `network`, `http`, `validation` — so `classifyFailure` in the router keeps working and a degraded decision still names the class of failure and never upstream text (ADR-003).
- **Warmup.** `warmup()` GETs `/info` and swallows every error. The public demo scales to zero and takes about 35 s to answer its first call after idle, so the gateway fires it once at startup and the eval runner awaits it before a run.

### Fallback and breaker rules

`FallbackDecisionClient` (`packages/core/src/decision/fallback.ts`) wraps a primary and a secondary:

- Only a transport failure falls back: `JevError` of kind `http`, `network`, or `timeout`. A `validation` failure means a backend *answered* and the answer did not match the question; asking a different backend the same question would hide a contract bug, so it rethrows. Anything unrecognized rethrows too — an unknown error is a bug, not an outage, and must not silently double the latency of every request.
- A caller abort is not a primary failure. It does not count toward the breaker and does not start a second attempt. The caller's `AbortSignal` is passed to both attempts.
- The breaker opens after `failures` consecutive primary failures (default 3) and skips the primary entirely for `cooldownMs` (default 60 s). When the cooldown expires, exactly one request is let through as a probe; a success closes the breaker, a failure re-opens it for another cooldown. Concurrent requests during a probe go to the secondary rather than piling onto a primary that is probably still down.
- `onFallback({ cause, usedSecondary, breakerOpen })` is the observability hook. `cause` is a failure kind or `breaker-open` — never upstream text.

Because the open backend answers in roughly 850 ms warm and the router enforces its budget with a race, the gateway derives the router deadline from the backend shape rather than reusing the 800 ms Jev budget: the open backend gets its own timeout plus 250 ms of slack, and a fallback chain gets the sum of both hops. Without that, every request through the open backend would degrade to `mid`.

## Why

TypeSafe's Jev is closed early access and Milo's key ran out of quota mid-build, which stopped the eval run and would stop a demo. `mithalouni/system-one-open` is an open replica serving the same three primitives (`choice`, `score`, `noul`) with the same calibrated-probability output, so the router's signals keep their meaning. Making the backend pluggable rather than swapping the client outright keeps Jev the default, keeps a self-hosted deployment available for local work and for anyone who cannot get a Jev key, and turns "the key ran out" from an outage into a degraded mode.

## Consequences

**Accuracy.** The open replica is measurably worse than Jev: 76.7% against 86.9% on TypeSafe's public eval. Routing is a three-way tier choice rather than a fine-grained label, so some of that gap is absorbed by the policy table, but a run on `packages/evals/data/routing.jsonl` under `--mode system-one-open` must be compared against the Jev run before the open backend is made anyone's default. The 85% tier-agreement gate in ADR-002 is stated for Jev; a lower bar for the open backend, if we want one, needs its own ADR. Until then `jev-with-fallback` is the recommended production configuration: Jev answers, and the open backend catches the outage.

**Licensing.** `system-one-open` is MIT, so vendoring, self-hosting, and commercial use are all fine. The Qwen-based scorer we also looked at is CC-BY-NC and was rejected: Milo is a commercial product and a non-commercial clause would forbid a hosted instance. No other backend may be added without checking its licence the same way.

**Operations.** The public demo scales to zero, so a first request after idle takes about 35 s. That is acceptable behind `jev-with-fallback` (a cold secondary just means the degraded path is slower) and requires a warm deployment if `system-one-open` is the primary. `pnpm eval --mode system-one-open` runs at concurrency 2, not the usual 4, because the demo is one GPU; `--mode record` writes fixtures for either backend into its own directory, since a fixture is keyed by a hash of a request and the two wire formats differ.

**Keys.** `GatewayOptions.jevApiKey` stays a required string because that contract is pinned; whether a key is actually needed is checked at runtime against the configured kind, and `milo serve` no longer demands `JEV_API_KEY` when the backend is `system-one-open`. The open backend has no auth, and Milo must not invent one: no `Authorization` header is sent to it.
