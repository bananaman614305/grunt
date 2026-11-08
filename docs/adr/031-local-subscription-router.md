# ADR-031: Milo as a local router over the user's own subscriptions

Status: accepted, 2026-11-08. Supersedes the serving path of ADR-003 (bring
your own OpenRouter key), ADR-006/008/009 (OpenRouter rosters), ADR-007 (Milo
keys and credits) and the hosted deployment. Changes `docs/PLAN.md` "The one
thing".

## Context

Milo was OpenRouter with a routing layer: a hosted gateway, the user's
OpenRouter key, a tier roster of cheap models, and Milo-issued keys with
Stripe credits. The owner's direction (2026-11-08) is different: people who
already pay for ChatGPT and Claude subscriptions leave most of that capacity
unused, and the useful product is one that spends it. The models worth
routing to are the frontier ones those plans include, not a roster of cheap
API models.

The constraint that shapes everything: subscription logins belong to the
official CLIs. Anthropic has blocked third-party use of Claude subscription
tokens, and proxies that lift a CLI's OAuth token into their own HTTP client
(CLIProxyAPI and similar) depend on terms that can change under them. The
owner's instruction was explicit: nothing is copied into a proxy; Milo runs
on the user's own machine.

## Decision

Keep the repository, the name, the package names and the `milo` CLI.
Replace the backend.

### The backend contract

`SubscriptionBackend` (`packages/core/src/subscription/types.ts`) is one
official CLI that the user installed and logged into:

- `run(request)` spawns the binary as a child process under the user's
  account, writes the prompt to its stdin, streams its JSON events, and
  returns the answer text, token usage, any plan-limit reading, and a typed
  failure (`rate_limited`, `unavailable`, `auth`, `timeout`, `aborted`,
  `failed`).
- `readLimits()` is optional: it reads the plan's remaining capacity without
  spending any, when the CLI documents a way to.

Two implementations:

| Backend | Answers | Isolation | Plan limits |
|---|---|---|---|
| `codex` | `codex exec --json --ephemeral --skip-git-repo-check -C <scratch> -` | `--sandbox read-only`, scratch working directory | `codex app-server`, `account/rateLimits/read` (used percent, window, reset), no quota spent |
| `claude` | `claude -p --output-format stream-json --include-partial-messages` | `--tools ""` (no tools at all), `--restricted`, `--strict-mcp-config`, `--no-session-persistence`, `--permission-prompts none`, scratch working directory | the `rate_limit_event` Claude Code emits with every answer (utilization, window, reset). No documented way to read it without a call, so the reading is as fresh as the last Claude call |

Rules that hold for both:

1. **Milo never reads, copies, stores or forwards a login.** It does not open
   the CLIs' credential files or keychain entries, does not call vendor
   endpoints with their tokens, and does not call undocumented endpoints.
   `no-credential-access.test.ts` fails CI if any non-doc source file names
   one of those files.
2. `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY` and
   `CODEX_API_KEY` are removed from the child's environment (names only; the
   values are never read), so a CLI bills the logged-in subscription rather
   than a pay-per-token key that happens to be exported.
3. The CLIs answer; they do not act. Codex runs read-only, Claude Code runs
   with no tools. A request that wants workspace access is a later decision.

### Usage meter

`UsageMeter` keeps the last plan-limit reading per subscription and any
rate-limit refusal Milo saw, and produces a `CapacitySnapshot`: used and
remaining percent of the fullest window, its reset, whether the plan is
refusing work and until when, and a `source`:

- `cli`: the CLI reported a number.
- `estimated`: the CLI has not reported a number, so Milo only knows its own
  calls and refusals. A refusal without a reset time marks the plan limited
  for a cooldown (15 minutes by default). No percentage is invented.
- `unknown`: nothing yet.

Readings and every call (backend, timing, tokens, failure kind, the
API-equivalent cost when the CLI reports one) are stored in the existing
SQLite decision log, migration 12 (`subscription_calls`,
`subscription_limits`). No prompts or answers are stored. `milo usage` and
`GET /v1/usage` read it.

### Routing

`SubscriptionRouter` replaces tier selection with backend selection:

1. **Classify.** Jev when `JEV_API_KEY` is set (through the existing
   `Router`, read for task type and difficulty only), with any Jev failure
   falling back to a local keyword heuristic; the heuristic alone otherwise.
2. **Prefer by task.** Code-changing work (edit, feature, debug, ops) starts
   on Codex; conversation, research, docs, review and classification start on
   Claude. This is a starting guess for the replay to revise, not a measured
   ranking.
3. **Adjust by capacity.** A limited subscription goes last. One below its
   reserve (10% left by default) yields to one with more. When both report
   numbers and the other has more than 30 points more left, the work moves.
4. **Fail over.** On `rate_limited`, `unavailable`, `auth` or `failed`, the
   other subscription is tried, unless the request named its backend or
   answer text already reached the caller. Timeouts and aborts do not fail
   over.

The decision travels in `x-milo-*` headers: `x-milo-backend`,
`x-milo-model`, `x-milo-reason`, `x-milo-task-type`, `x-milo-difficulty`,
`x-milo-classifier`, `x-milo-capacity`, `x-milo-failover`,
`x-milo-decision-id`.

### Gateway

`milo serve` listens on `127.0.0.1` by default and needs no API key. It
serves `POST /v1/chat/completions` (buffered and streamed) for `milo/auto`,
`milo/codex`, `milo/claude`, and `codex/<model>` / `claude/<model>`, plus
`/v1/models`, `/v1/usage` and `/healthz`. Requests with `tools` or `n > 1`
are refused with 400: the CLIs answer in text and do not run
caller-defined tools.

## Removed

Deleted in this change, reachable in git history before it:

- `packages/billing`, `packages/stripe`, `packages/provisioning`, the
  `milo billing` command and the core billing types (ADR-007).
- The hosted gateway: OpenRouter chat/messages/responses/proxy routes, the
  per-key auth and rate limits, tenant limits, account pages, preference and
  fact-memory routes, the best-of-N, gate, pruning and speculation route
  wiring, and `milo configure` with its onboarding.
- `Dockerfile`, `fly.toml`, `.dockerignore`, `scripts/fly-smoke.sh`, and the
  `deploy`, `image`, `provision-db` and `roster-refresh` workflows.
- `docs/billing.md`, `docs/deploy.md`, `docs/claude-code.md` and `docs/codex.md` (they set up the removed `/v1/messages` and `/v1/responses` routes). The other OpenRouter-era docs carry a superseded banner.

Kept: the core libraries the hosted gateway used (Jev client and router,
sampling and candidate checks, gates, pruning, verification, preferences,
memory, tasks), the OpenRouter client that the eval tooling uses, the eval
packages, and the CLI's decision-log and eval commands. Best-of-N and the
completeness gate are not wired to subscriptions in this milestone: each
sample would spend a whole subscription call, which needs its own decision.

## Consequences

- No hosted service, no accounts, no money handling. The trust boundary is
  the user's machine and the official binaries.
- Codex calls carry Codex's own agent prompt, about 14,000 input tokens per
  call (mostly cached). That counts against the ChatGPT plan's limits, not
  against money.
- Claude's capacity is known only after a Claude call. Until then the router
  treats it as unknown and follows the task preference.
- The heuristic classifier was written against the routing eval set (78%
  task-type agreement there), so that number is optimistic.
- If a vendor changes its CLI's output format, that backend fails with
  `failed` and the router fails over. Live tests (`cli.live.test.ts`,
  opt-in) catch format changes.
- If a vendor changes its terms for CLI automation, this design is still the
  conservative one: it is the user running the vendor's own program.

## Follow-ups

- Gemini CLI as a third backend.
- Wire best-of-N and the completeness gate to subscriptions, with an explicit
  quota budget per request.
- Per-backend model choice by difficulty (e.g. a smaller Claude model for
  trivial work), measured with the replay.
- Decide what the decision-log commands (`explain`, `stats`, `cost`,
  `tune`) should show for subscription calls.
