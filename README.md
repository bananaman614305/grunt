# Milo

Milo is OpenRouter with an actual routing mechanism. You give Milo one key,
your OpenRouter key, point an OpenAI-compatible client at Milo's base URL,
and send `model: "milo/auto"`. Milo holds its own Jev key server-side. For
every routed request, Jev classifies the task type and how hard it is, a
policy table picks a tier (fast, mid, or frontier), the request goes to
OpenRouter with the resolved model, and the response comes back with
`x-milo-*` headers explaining why that model was chosen.

## What it is for

Milo is built for a two-model setup. A frontier agent you already pay for on a
subscription — Opus, Fable, Sol, whatever you run — plans the work and
orchestrates it. The implementation sub-tasks it hands off go through Milo,
which routes each one to a model that is cheap and popular on OpenRouter. You
keep the good planner; you stop paying frontier prices for the hundred small
edits, tests and lookups underneath it. That is why Milo's default roster is
the most-used cheap models rather than a second copy of the frontier model you
are already subscribed to — see "Why these models" below.

## Quickstart

```
git clone https://github.com/bananaman614305/milo && cd milo
pnpm install && pnpm build
export JEV_API_KEY=...                       # Milo's own Jev key; see docs/config.md
node packages/cli/dist/cli.js serve          # listens on http://localhost:8787
```

Milo supplies the Jev key itself, so end users of a hosted Milo only need
their own OpenRouter key — nothing about Jev changes on the client side.

Point the OpenAI SDK at Milo and ask for `milo/auto`:

**Python**

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:8787/v1", api_key="sk-or-...")
resp = client.chat.completions.create(
    model="milo/auto",
    messages=[{"role": "user", "content": "..."}],
)
```

**TypeScript**

```ts
import OpenAI from "openai";

const client = new OpenAI({ baseURL: "http://localhost:8787/v1", apiKey: "sk-or-..." });
const resp = await client.chat.completions.create({
  model: "milo/auto",
  messages: [{ role: "user", content: "..." }],
});
```

That is the entire change: a base URL and a model id. `api_key` is your
OpenRouter key, forwarded to OpenRouter unchanged and never stored.

## What you get back

A routed response carries six `x-milo-*` headers naming the decision:

```
HTTP/1.1 200 OK
content-type: application/json
x-milo-decision-id: 01ARZ3NDEKTSV4RRFFQ69G5FAV
x-milo-model: z-ai/glm-5.3
x-milo-tier: frontier
x-milo-task-type: debug
x-milo-difficulty: 2.40
x-milo-sticky: false
```

`x-milo-decision-id` resolves at `GET /v1/decisions/:id`. Example (illustrative
— shaped from the `DecisionRecord` type in `packages/core/src/types.ts`, not a
captured response):

```json
{
  "id": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "fingerprint": "a94a8fe5ccb19ba61c4c0873d391e987982fbbd3",
  "signals": {
    "taskType": "debug",
    "difficulty": 2.4,
    "difficultyLevels": [0.01, 0.09, 0.39, 0.51],
    "needsReasoning": 0.94,
    "longOutput": 0.22,
    "confidences": { "task_type": 0.9, "difficulty": 0.81 },
    "jevRequestId": "req_e2e_0001",
    "jevModel": "jev-latest",
    "latencyMs": 87
  },
  "tier": "frontier",
  "model": "z-ai/glm-5.3",
  "reason": "debug task, P(hard) 0.51 at or above 0.25 with balanced posture routes to frontier; chose z-ai/glm-5.3",
  "policyVersion": "v2",
  "sticky": false,
  "createdAt": "2026-09-17T16:03:07.554Z",
  "upstream": { "status": 200, "latencyMs": 640, "inputTokens": 940, "outputTokens": 210 }
}
```

See `docs/api/gateway.md` for every route and `docs/routing.md` for how the
decision is made.

## Per-request options

A chat completions body can include a `milo` field to override routing for
that request. It is stripped before the request reaches OpenRouter.

```json
{
  "model": "milo/auto",
  "messages": [{ "role": "user", "content": "..." }],
  "milo": {
    "posture": "low",
    "candidates": ["deepseek/deepseek-v4-flash", "openai/gpt-5.6-luna"],
    "tier": "fast"
  }
}
```

- `posture` — `"low"`, `"balanced"`, or `"quality"`. Defaults to `"balanced"`. Shifts the policy table toward cheaper or more capable tiers (`docs/routing.md`).
- `candidates` — restricts the roster to these model ids for this request.
- `tier` — forces a tier (`"fast"`, `"mid"`, `"frontier"`) and skips the Jev call entirely; the decision is recorded with reason `"forced to the <tier> tier by the request"`.

## Why these models

Default roster `2026-09-17`:

| Tier | Model | In $/M | Out $/M | Usage rank | Weekly tokens |
|---|---|---|---|---|---|
| fast | `deepseek/deepseek-v4-flash` | 0.07 | 0.14 | 2 | 15.4T |
| fast | `z-ai/glm-5.3-flash` | 0.09 | 0.30 | 4 | 11.3T |
| fast | `xiaomi/mimo-v2.5` | 0.14 | 0.28 | 6 | 7.8T |
| fast | `tencent/hy3` | 0.0825 | 0.33 | 7 | 4.5T |
| mid | `openai/gpt-5.6-luna` | 0.20 | 1.20 | 1 | 17.3T |
| mid | `deepseek/deepseek-v4.1-flash` | 0.15 | 0.60 | 5 | 10.3T |
| frontier | `z-ai/glm-5.3` | 1.40 | 4.40 | 9 | 2.5T |
| frontier | `google/gemini-3.8-flash` | 0.75 | 3.75 | 10 | 2.2T |
| frontier | `tencent/hy4-preview` | 0.834 | 2.501 | 3 | 12.0T |
| frontier | `nvidia/nemotron-3-ultra-550b-a55b` | 0.625 | 3.125 | 8 | 3.5T |

The first entry in a tier is that tier's default. `nvidia/nemotron-3-ultra-550b-a55b`
caps output at 32,768 tokens, below the 60,000 floor, so it sorts last in its
tier and is skipped outright whenever a long answer is expected;
`tencent/hy4-preview` (64,000) and `google/gemini-3.8-flash` (65,536) stay
eligible.

**The rule**, collected 2026-09-17 from OpenRouter's weekly usage ranking for
the programming category (week ending 2026-09-16) and its public model
catalogue: take the ten most-used models after folding dated builds into their
current id and dropping `:free`, `:batch` and the other data-sharing plan
variants, anything that cannot call a tool, and anything at or above **$5 per
million output tokens**; tier them by output price (fast at most $0.35/M, mid
at most $1.50/M, frontier at most $5/M); order each tier by usage, small-output
models last.

Defaults are the models people actually run on OpenRouter, ordered by weekly
usage within price bands; nothing above $5 per million output tokens is chosen
unless you list it in `candidates` or your roster config. Premium models
(Fable, Opus, Astra, Sonnet) are never picked by default — you are almost
certainly paying for one of them on a subscription already, and that is the
agent that should be calling Milo rather than the one Milo calls.

The table is data, not a hand-kept list: it lives in
`packages/core/src/router/roster-default.json` with its provenance, is
generated by `packages/evals/scripts/roster-refresh.ts`, and is **regenerated
from OpenRouter's rankings every week** by
`.github/workflows/roster-refresh.yml`, which opens a pull request when the
list moves.

### Choosing your own models

Milo never locks you into that list.

- **Per request**: `"milo": { "candidates": ["anthropic/claude-opus-5"] }`
  restricts one request to the ids you name. Any OpenRouter id works.
- **Per deployment**: set `roster` in `milo.config.json` with your own ids per
  tier (`docs/config.md`). To put Opus on the frontier tier and leave the rest
  of the defaults alone:

```json
{
  "roster": {
    "fast": ["deepseek/deepseek-v4-flash", "z-ai/glm-5.3-flash"],
    "mid": ["openai/gpt-5.6-luna", "deepseek/deepseek-v4.1-flash"],
    "frontier": ["anthropic/claude-opus-5", "z-ai/glm-5.3"]
  }
}
```

`GET /v1/roster` returns the running roster with every price, usage rank and
provenance field, plus which tier each posture favors. `milo roster` prints
the same thing at the terminal.

## For agents

A running Milo serves its own onboarding: `GET /setup.md` walks an agent
through picking up an OpenRouter key and configuring a client, Claude Code,
or another OpenAI-compatible tool, in Markdown written for that purpose.
`GET /llms.txt` is the discovery entry point, and `GET /skill.md` serves the
same instructions as an installable skill (`skills/milo/SKILL.md`) — install
it in Claude Code with `claude plugin marketplace add bananaman614305/milo`
then `claude plugin install milo@milo`, or in any skill-aware agent with
`npx skills add bananaman614305/milo --skill milo`. See `skills/README.md`.

<!-- Codex: begin -->
### Codex CLI

Codex talks to a custom provider over the Responses API, which Milo serves at
`POST /v1/responses`. Put this in `~/.codex/config.toml`:

```toml
model_provider = "milo"
model = "milo/auto"

[model_providers.milo]
name = "Milo"
base_url = "https://milo-gateway.fly.dev/v1"
env_key = "OPENROUTER_API_KEY"
wire_api = "responses"
```

Then `export OPENROUTER_API_KEY=sk-or-...` and run `codex --model milo/auto`.
Full setup, the `-c` one-liner form, and what passes through unrouted:
[`docs/codex.md`](docs/codex.md).
<!-- Codex: end -->

<!-- begin: bring your own model list (ADR-008) -->

### Bring your own model list

Onboarding starts by asking, not telling: an agent setting Milo up asks which
OpenRouter models you already use and which Milo should choose from, before it
writes any config. Name some and it posts them to `PUT /v1/roster` with your
key — `{"models": ["deepseek/deepseek-v4-flash", "anthropic/claude-opus-5"]}` —
which tiers them by output price on the same bands as the default roster and
keeps your order within a tier; send `tiers` instead to place them by hand.
Every routed request from that key then picks from your list, `GET /v1/roster`
shows it back with prices, and `DELETE /v1/roster` reverts to the default. Say
"just pick" and you get the top-ten roster above, unchanged. Milo stores a
SHA-256 hash of your key as the row's name and nothing else about you — the
key itself is still never stored (ADR-003).

<!-- end: bring your own model list -->

## Credits and Milo keys

Bring-your-own-OpenRouter-key stays free and unchanged. If you'd rather not
hold your own OpenRouter key, create a Milo account at `/account/new`
(email only) and prepay for credits at `/account` — Stripe Checkout, three
fixed packs. A Milo key (`mk_...`) then routes through Milo's own OpenRouter
sub-key instead of yours, charged at upstream cost plus a margin and a flat
per-request decision fee (both shown on `/account`, never hard-coded), with
the running balance on `x-milo-balance-usd` on every response. No balance
means a `402` before any upstream call — Milo never fronts money you haven't
paid for. See [`docs/billing.md`](docs/billing.md) (ADR-007) for the full
walkthrough, including the `milo billing` operator CLI.

## Docs

- [`docs/api/gateway.md`](docs/api/gateway.md) — every route, request/response shape, headers, errors.
- [`docs/billing.md`](docs/billing.md) — Milo keys, prepaid credits, the account pages, and the `milo billing` CLI.
- [`docs/cli.md`](docs/cli.md) — the `milo` CLI: `serve`, `explain`, `decisions`, `stats`, `roster`, `billing`.
- [`docs/config.md`](docs/config.md) — `milo.config.json` reference and `JEV_API_KEY`.
- [`docs/routing.md`](docs/routing.md) — how a routing decision gets made.
- [`docs/evals.md`](docs/evals.md) — running the routing eval set.
