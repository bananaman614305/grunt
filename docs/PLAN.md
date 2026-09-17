# Milo MVP plan

Status: draft v2.1, 2026-09-17. Owner: Alan. Orchestrator: Claude Fable 5.1. Builders: Opus and Sonnet subagents.

Progress (2026-09-17): waves 0, 1, and 2 are merged on `main` (266 unit tests, 4 e2e). Wave 3 in flight: messages endpoint, docs, cleanup. Deploy not started. The vault's Jev key ran out of quota mid-build, so no live eval run against Jev yet; the Jev budget was raised to 800 ms after measuring a 520 ms cold round trip. Decision backends are now pluggable (ADR-004): `jev`, `system-one-open`, and `jev-with-fallback`, selected in config or by `MILO_DECISION_BACKEND`, so routing still works while the Jev key is dry. First live eval with system-one-open, 120 examples, policy v1, balanced posture: 69.2% tier agreement (band 0 100%, band 1 62.9%, band 2 42.4%, band 3 80.0%), task-type accuracy 76.7%, mean latency 390 ms; report in packages/evals/reports/system-one-open-v1.md. Policy v2 (ADR-002 revision 2) replaces v1's fixed expected-score thresholds with a probability-mass rule over the difficulty levels, with per-backend threshold profiles: replaying the same recorded fixtures scores **83.3%** (band 0 100%, band 1 71.4%, band 2 75.8%, band 3 92.0%), report in packages/evals/reports/system-one-open-v2.md, and 80.9% mean held-out agreement under two-fold cross-validation. CI gates the open backend at 0.80; 0.85 remains the target for Jev, which still has no live run. Policy v2 merged: 83.3% agreement on the replay (band 0 100%, band 1 71.4%, band 2 75.8%, band 3 92.0%). Container image publishes to ghcr.io/bananaman614305/milo on every push to main (private, like the repo). Fly app `milo-gateway` exists in org andyli_7-yahoo-com with a 1 GB volume in iad, shared IPv4 66.241.125.214 and an IPv6; the machine is not created yet because deploying a private image needs a Fly token in GitHub secrets (`FLY_API_TOKEN`, see .github/workflows/deploy.yml), which the vaulted token cannot mint. A CPU-classifier comparison (RouteLLM BERT, NVIDIA task/complexity) against the same 120 prompts is in progress. Deployed: https://milo-gateway.fly.dev (Fly app milo-gateway, deploy via .github/workflows/deploy.yml with the FLY_API_TOKEN secret). Live check: healthz reports policy v2 and the system-one-open backend; a routed request returned a non-degraded decision. Known gap: when the open backend's public demo is cold (about 35 s), the first routed request degrades to mid; fix is self-hosting the backend with a warm container. CPU classifier experiment (RouteLLM, NVIDIA) ruled both out; report in packages/evals/reports/cpu-classifiers/comparison.md. Verified with a real OpenRouter key through a vault egress proxy: non-streaming and streaming completions routed by milo/auto (Haiku, fast tier, $0.00004), and Claude Code pointed at Milo via ANTHROPIC_BASE_URL answered through /v1/messages with its calls logged. Claude Code warns that milo/auto is not in its model catalog but works. Jev early access granted late on 2026-09-17; first live Jev run (120 examples, jev-preview, via a vault proxy): 75.0% agreement under the provisional profile, task-type accuracy 90.8%, frontier recall 41/42, mean latency 412 ms through the proxy. A Jev-specific profile fitted on the recorded fixtures reaches 84.2% in-sample and 80.8% cross-validated; being implemented as policy revision 3. The `system-one-open` replica and the `jev-with-fallback` backend were removed on 2026-09-17 (ADR-005): Milo is Jev-only now, with no fallback tier. A routed request the router cannot answer fails with a 503 (or 429 when rate limited) rather than silently degrading to `mid`; resilience comes from exponential-backoff retries, a short circuit breaker, in-flight coalescing of identical asks, and a persisted sticky cache instead of a second backend. CLI and eval-runner support for `system-one-open` and the `--degraded` surface are gone along with it, and CI's fixture-replay gate runs once, against the Jev fixtures, at `--gate 0.80` while the Jev-tuned policy profile lands. Jev-only cutover shipped the same evening: replica and degraded fallback removed (ADR-005), routing failures are 503 with Retry-After, rate limits 429, Jev client retries with backoff, router circuit breaker, in-flight coalescing, tool-loop-scoped persistent stickiness; agents can self-configure from /setup.md and the milo skill. Replay on jev-latest fixtures: 81.7%, CV 78.3%, task type 90.8%. Codex verified live: `codex exec` with wire_api responses through a local Milo routed to the fast tier and answered. Billing layer started (ADR-007): @milo/stripe and @milo/provisioning merged; @milo/billing (Postgres store), gateway metering, and account pages pending. Fly org has no Managed Postgres cluster and andyli-shared-pg is not a Fly Postgres app, so the billing database needs either a new MPG cluster (from $38/month) or Neon.

## The one thing

Milo is OpenRouter with an actual routing mechanism. A user gives Milo one key, their OpenRouter key, points their agent harness at Milo's base URL, and asks for `milo/auto`. Milo holds its own Jev key, since Jev is early access and users cannot get one yet. For every request, Milo asks Jev what kind of task the prompt is and how hard it is, picks a model from a policy table, forwards the request to OpenRouter with the user's key, and streams the answer back with headers that say which model was chosen and why.

The target user runs agents that orchestrate other agents. Each sub-agent's calls go through Milo and get routed on their own merits, so a crew stops paying frontier prices for trivial work and stops sending hard work to cheap models.

Out of scope for the MVP: preference memory, capture, output grading, harness hooks, billing. Those stay on the long-term horizon in `docs/HORIZON.md`.

## Decisions

| Area | Decision | Why |
|---|---|---|
| Keys | User brings only an OpenRouter key as `Authorization: Bearer`, forwarded unchanged and never stored. Milo's own Jev key lives in the server environment (`JEV_API_KEY`, delivered as a Squire egress grant on Fly). | Jev is closed early access, so users cannot bring one. The OpenAI SDK already sends Authorization, so the client change is one base URL. Stateless on the user side. |
| Abuse control | Per-request Jev spend is Milo's. A token-bucket rate limit keyed on a hash of the OpenRouter key, plus the 8k-token context cap, bounds it. Rejected requests still pass through to OpenRouter unrouted on the `mid` tier. | Jev calls cost about $0.00002 each, but a hosted endpoint with an open router is an invitation. |
| API surface | OpenAI-compatible `POST /v1/chat/completions` (streaming and non-streaming), `GET /v1/models` (OpenRouter's list plus `milo/auto`), everything else under `/v1` proxied to OpenRouter unchanged | Drop-in for any OpenAI SDK client. |
| Routing trigger | `model: "milo/auto"`. Any other model id passes through untouched. Optional `milo` request field overrides candidates and cost posture per request. | Zero-risk adoption: nothing changes until you ask for it. |
| Routing signals | One Jev call per routed request over the conversation: `task_type` (choice), `difficulty` (score 0..3), `needs_reasoning` (noul), `long_output` (noul). | Cheap (about $0.00002 per call), 50 to 100 ms, calibrated. |
| Policy | Versioned table in code mapping signals plus cost posture to a tier, and a roster mapping tiers to OpenRouter model ids. Default roster ships; users override in config. | Inspectable and diffable. Jev's calibration is unpublished, so the policy must be tunable without retraining anything. |
| Stickiness | A conversation fingerprint (hash of system prompt plus first user message) pins the chosen model for 30 minutes | Switching models mid-conversation breaks tool-call continuity and wastes cache. Sub-agents are multi-turn. |
| Explainability | Response headers `x-milo-decision-id`, `x-milo-model`, `x-milo-task-type`, `x-milo-difficulty`; `GET /v1/decisions/:id` returns the full decision with Jev probabilities | The audit trail is the product's proof and the basis for tuning. |
| Routing failures | Jev is the only decision backend (ADR-005): no fallback tier. If Jev fails or times out (800 ms default budget, configurable), the routed request fails with a 503 and a `Retry-After` header rather than degrading to a cheaper tier; a rate-limited request gets a 429 the same way. Exponential-backoff retries, a circuit breaker, in-flight coalescing, and a persisted sticky cache absorb the ordinary case before it reaches a caller. | A silently substituted tier is invisible to the caller; an explicit, retryable error is not. |
| Stack | TypeScript, Node 22, pnpm, Hono, Vitest, Zod, SQLite via libsql for the decision log | See ADR-001. |
| Deploy | Local first (`milo serve`), Fly.io for a hosted instance | Existing account. |
| License | Proprietary for now | Keeps monetization open. |

## Architecture

```
client (OpenAI SDK, agent harness)
  │  POST /v1/chat/completions  model: milo/auto
  │  Authorization: Bearer <openrouter key>
  ▼
gateway ──▶ fingerprint ──▶ sticky cache hit? ──yes──▶ model
  │                              │ no
  │                              ▼
  │                      router: Jev /v1/systemone with Milo's key (task_type, difficulty, needs_reasoning, long_output)
  │                              │ signals + confidences
  │                              ▼
  │                      policy table v1 + roster ──▶ model, effort
  │                              │
  │                              ▼
  │                      decision log (SQLite) ◀── decision id, probabilities, model, latency
  ▼
OpenRouter  POST /api/v1/chat/completions  (model swapped, everything else untouched, stream passthrough)
  │
  ▼
client  (+ x-milo-* headers)
```

### Packages

```
packages/
  core/      jev client, router (signals, policy, roster, stickiness), decision log
  gateway/   Hono server: auth headers, milo/auto, OpenRouter passthrough, /v1/decisions
  cli/       milo serve | explain <decision-id> | roster | eval
  evals/     labeled routing prompts, runner, agreement report
docs/        PLAN.md, HORIZON.md, adr/, api/
```

Core has no HTTP server. Gateway and CLI depend on core. Evals depends on core.

## Core contracts

Fixed in `packages/core/src/types.ts` before parallel work starts.

```ts
type TaskType = "chat" | "edit" | "feature" | "debug" | "research" | "review" | "docs" | "ops" | "classify";
type Tier = "fast" | "mid" | "frontier";
type CostPosture = "low" | "balanced" | "quality";

type RouteSignals = {
  taskType: TaskType;
  difficulty: number;            // 0..3 expected score
  difficultyLevels: number[];    // mass on levels 0..3; empty when a backend reports none (ADR-002 rev 2)
  needsReasoning: number;        // noul
  longOutput: number;            // noul
  confidences: Record<string, number>;
  jevRequestId: string;
  jevModel: string;
  latencyMs: number;
};

type Roster = Record<Tier, string[]>;   // ordered OpenRouter model ids per tier; first is default

type RouteRequest = {
  messages: ChatMessage[];        // OpenAI shape
  tools?: unknown[];
  posture: CostPosture;           // from request `milo.posture`, else config, else "balanced"
  candidates?: string[];          // from request `milo.candidates`; restricts the roster
  fingerprint: string;
};

type RouteDecision = {
  id: string;
  fingerprint: string;
  signals?: RouteSignals;         // absent when degraded
  tier: Tier;
  model: string;
  reason: string;                 // one sentence, human readable
  policyVersion: string;
  sticky: boolean;                // served from cache
  degraded: boolean;
  createdAt: string;
};
```

Request extension (optional, stripped before forwarding to OpenRouter):

```json
{ "model": "milo/auto", "messages": [...],
  "milo": { "posture": "low", "candidates": ["anthropic/claude-sonnet-5", "anthropic/claude-haiku-4.5"] } }
```

### Policy v1 (starting point, tuned by evals)

| difficulty | needs_reasoning | posture | tier |
|---|---|---|---|
| < 1.0 | any | any | fast |
| 1.0 to 2.0 | < 0.5 | low, balanced | fast (low) / mid (balanced) |
| 1.0 to 2.0 | ≥ 0.5 | any | mid |
| ≥ 2.0 | any | low | mid |
| ≥ 2.0 | any | balanced, quality | frontier |
| any | any | quality, and difficulty ≥ 1.0 | frontier |

`task_type` of `classify` or `chat` caps at `mid` unless difficulty ≥ 2.5. `long_output` ≥ 0.7 excludes models with small max output from the tier's list.

Superseded by **policy v2** (ADR-002 revision 2, `docs/routing.md`): the table above is now only the fallback for a backend that reports no per-level distribution. v2 decides on `P(level 3)` and `P(level 2 or above)` against per-backend thresholds, because the open backend's expected score turned out to be too compressed for fixed cut points at 1.0 and 2.0.

Default roster (ADR-006, `packages/core/src/router/roster-default.json`, version 2026-09-17): fast = `deepseek/deepseek-v4-flash`, `z-ai/glm-5.3-flash`, `xiaomi/mimo-v2.5`, `tencent/hy3`; mid = `openai/gpt-5.6-luna`, `deepseek/deepseek-v4.1-flash`; frontier = `z-ai/glm-5.3`, `google/gemini-3.8-flash`, `tencent/hy4-preview`, `nvidia/nemotron-3-ultra-550b-a55b`. It is the ten most-used models in OpenRouter's programming category, tool-capable, nothing at or above $5/M output, tiered by output price — the frontier agent that orchestrates runs on the user's own subscription, so Milo's job is the cheap half of that pair. Regenerated weekly from OpenRouter's rankings and disclosed at `GET /v1/roster`, on the root page, in `/setup.md`, in the skill and by `milo roster`. Users override in `milo.config.json` or per request with `milo.candidates`.

## Waves

Each task is one subagent in its own worktree, one branch, one PR, tests green before reporting. Opus takes correctness-critical work, Sonnet takes well-specified work.

### Wave 0: foundation (orchestrator, sequential)

| # | Task | Deliverable |
|---|---|---|
| 0.1 | Monorepo scaffold, CI, CLAUDE.md, core types, ADRs 001 to 003 | `pnpm test` green |
| 0.2 | Initial commit on main so worktrees have a base | commit |

### Wave 1: primitives (parallel)

| # | Owner | Task | Acceptance |
|---|---|---|---|
| 1.1 | Sonnet | Jev client in `core/src/jev`: typed builders for noul/choice/score, bearer auth, configurable timeout, one retry with jitter, request-id capture, fixture recorder and replayer | Fixtures replay in unit tests; one opt-in live test hits `/v1/models` |
| 1.2 | Opus | Router in `core/src/router`: Jev question set over the conversation (system prompt, last 3 user turns, tool presence, truncated to 8k tokens), policy table v1, roster resolution with candidates filter, sticky cache with TTL, degraded fallback, one-sentence reason | Unit tests for every policy row; ≥ 85% tier agreement on the eval set once 1.4 lands |
| 1.3 | Sonnet | OpenRouter client in `core/src/openrouter`: chat completions with SSE passthrough, models list with cache, error mapping, forwarding rules (strip the `milo` body field, pass `Authorization` through) | Tests against a mocked OpenRouter; streams byte-for-byte |
| 1.4 | Sonnet | Routing eval set in `evals/data/routing.jsonl`: 120 prompts across all task types and difficulties, labeled with task_type, difficulty band, and expected tier under `balanced` | README on labeling rules; orchestrator reviews 30 |
| 1.5 | Sonnet | Decision log in `core/src/log`: libsql table, insert, get by id, list recent, JSON export | Tests on a temp db |

### Wave 2: surfaces (parallel, after wave 1)

| # | Owner | Task | Acceptance |
|---|---|---|---|
| 2.1 | Opus | Gateway in `packages/gateway`: `POST /v1/chat/completions` (routing on `milo/auto`, passthrough otherwise, streaming and non-streaming), `GET /v1/models`, `GET /v1/decisions/:id`, generic `/v1/*` proxy, key handling and rate limit per ADR-003, `x-milo-*` headers, request timing | Drop-in for the OpenAI SDK against a mocked OpenRouter and fixture Jev; e2e test with both mocked |
| 2.2 | Sonnet | CLI in `packages/cli`: `milo serve` (`JEV_API_KEY` from env, config file, port), `milo explain <id>`, `milo roster`, `milo eval` | Runs locally against the real gateway |
| 2.3 | Sonnet | Eval runner in `packages/evals`: runs the set through the router on fixtures or live, prints agreement per task type and difficulty band, writes a markdown report | `pnpm eval` in CI on fixtures; `--live` opt-in |

### Wave 3: proof (parallel, after wave 2)

| # | Owner | Task | Acceptance |
|---|---|---|---|
| 3.1 | Opus | Anthropic-compatible `POST /v1/messages` through OpenRouter's messages endpoint, same routing | Claude Code pointed at Milo via `ANTHROPIC_BASE_URL` gets routed |
| 3.2 | Sonnet | Docs: README quickstart (two keys, one base URL, three lines of SDK config), `docs/api/gateway.md`, config reference | Reviewed by orchestrator |
| 3.3 | Orchestrator | Fly deploy, Squire egress grants, dogfood with a multi-agent crew for a week, policy v2 from the decision log | Deployed URL, policy v2 ADR with before/after agreement |

## Orchestration rules

- One task per subagent, one worktree, one PR. Every builder prompt includes the task row, the contract section verbatim, the acceptance criteria, and "run tests before reporting, paste output".
- Builders never handle real keys. Dev calls to Jev go through the Squire `use_credential` tool. Fixtures are committed with request ids kept and key material stripped.
- Interface changes to `types.ts` need an ADR update merged before dependent tasks start.
- Opus tasks use the Agent tool's `opus` option, Sonnet tasks use `sonnet`.

## Risks

| Risk | Mitigation |
|---|---|
| Jev tier agreement below 85% | Eval set measures it from wave 1; policy thresholds are tunable; low-confidence decisions can default to `mid` |
| Model switch mid-conversation breaks tool calls | Sticky fingerprint cache, 30 min TTL |
| Jev adds latency to every call | 800 ms default budget, degraded fallback, sticky cache means one Jev call per conversation |
| OpenRouter API drift | Generic passthrough for everything not explicitly handled; only `model` is rewritten |
| Key leakage | User keys live only in request headers, never stored or logged. Milo's Jev key lives only in server env as a revocable egress grant. Decision log stores no message content. |
| Jev spend abuse on a hosted endpoint | Rate limit per OpenRouter-key hash, 8k-token context cap, degraded passthrough when limited |

## Definition of done

A user sets one base URL and their OpenRouter key, sends `milo/auto`, and gets a streamed answer from a model chosen by Jev, with headers naming the decision and a `/v1/decisions/:id` record explaining it. A multi-agent crew running through Milo shows trivial sub-tasks landing on the fast tier and hard ones on frontier, with at least 85% agreement against the labeled eval set.
