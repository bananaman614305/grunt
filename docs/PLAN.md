# Milo MVP plan

Status: draft v2.1, 2026-09-17. Owner: Alan. Orchestrator: Claude Fable 5.1. Builders: Opus and Sonnet subagents.

Progress (2026-09-17): waves 0, 1, and 2 are merged on `main` (266 unit tests, 4 e2e). Wave 3 in flight: messages endpoint, docs, cleanup. Deploy not started. The vault's Jev key ran out of quota mid-build, so no live eval run against Jev yet; the Jev budget was raised to 800 ms after measuring a 520 ms cold round trip. Decision backends are now pluggable (ADR-004): `jev`, `system-one-open`, and `jev-with-fallback`, selected in config or by `MILO_DECISION_BACKEND`, so routing still works while the Jev key is dry. First live eval with system-one-open, 120 examples, policy v1, balanced posture: 69.2% tier agreement (band 0 100%, band 1 62.9%, band 2 42.4%, band 3 80.0%), task-type accuracy 76.7%, mean latency 390 ms; report in packages/evals/reports/system-one-open-v1.md. A probability-mass rule over the difficulty levels reaches 83.5% in-sample and 81.8% cross-validated on the same signals and is being built as policy v2.

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
| Fallback | If Jev fails or times out (800 ms default budget, configurable), route to the roster's `mid` tier, mark the decision degraded | Never block a request on the router. |
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

Default roster: fast = `anthropic/claude-haiku-4.5`, `google/gemini-2.5-flash`; mid = `anthropic/claude-sonnet-5`; frontier = `anthropic/claude-opus-5`. Users override in `milo.config.json`.

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
