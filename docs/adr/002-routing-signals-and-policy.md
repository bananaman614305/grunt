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
