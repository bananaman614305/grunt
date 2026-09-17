# Milo

Milo is OpenRouter with an actual routing mechanism. You give Milo one key,
your OpenRouter key, point an OpenAI-compatible client at Milo's base URL,
and send `model: "milo/auto"`. Milo holds its own Jev key server-side. For
every routed request, Jev classifies the task type and how hard it is, a
policy table picks a tier (fast, mid, or frontier), the request goes to
OpenRouter with the resolved model, and the response comes back with
`x-milo-*` headers explaining why that model was chosen.

## Quickstart

```
git clone https://github.com/bananaman614305/milo && cd milo
pnpm install && pnpm build
export JEV_API_KEY=...                       # Milo's own Jev key; see docs/config.md
node packages/cli/dist/cli.js serve          # listens on http://localhost:8787
```

No Jev key? Route with the open-source replica instead (see `docs/adr/004-decision-backends.md`):

```
MILO_DECISION_BACKEND=system-one-open node packages/cli/dist/cli.js serve
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

A routed response carries seven `x-milo-*` headers naming the decision:

```
HTTP/1.1 200 OK
content-type: application/json
x-milo-decision-id: 01ARZ3NDEKTSV4RRFFQ69G5FAV
x-milo-model: anthropic/claude-opus-5
x-milo-tier: frontier
x-milo-task-type: debug
x-milo-difficulty: 2.40
x-milo-sticky: false
x-milo-degraded: false
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
  "model": "anthropic/claude-opus-5",
  "reason": "debug task, P(hard) 0.51 at or above 0.25 with balanced posture routes to frontier; chose anthropic/claude-opus-5",
  "policyVersion": "v2",
  "sticky": false,
  "degraded": false,
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
    "candidates": ["anthropic/claude-haiku-4.5", "anthropic/claude-sonnet-5"],
    "tier": "fast"
  }
}
```

- `posture` — `"low"`, `"balanced"`, or `"quality"`. Defaults to `"balanced"`. Shifts the policy table toward cheaper or more capable tiers (`docs/routing.md`).
- `candidates` — restricts the roster to these model ids for this request.
- `tier` — forces a tier (`"fast"`, `"mid"`, `"frontier"`) and skips the Jev call entirely; the decision is recorded with reason `"forced to the <tier> tier by the request"`.

## For agents

A running Milo serves its own onboarding: `GET /setup.md` walks an agent
through picking up an OpenRouter key and configuring a client, Claude Code,
or another OpenAI-compatible tool, in Markdown written for that purpose.
`GET /llms.txt` is the discovery entry point, and `GET /skill.md` serves the
same instructions as an installable skill (`skills/milo/SKILL.md`) — install
it in Claude Code with `claude plugin marketplace add bananaman614305/milo`
then `claude plugin install milo@milo`, or in any skill-aware agent with
`npx skills add bananaman614305/milo --skill milo`. See `skills/README.md`.

## Docs

- [`docs/api/gateway.md`](docs/api/gateway.md) — every route, request/response shape, headers, errors.
- [`docs/cli.md`](docs/cli.md) — the `milo` CLI: `serve`, `explain`, `decisions`, `stats`, `roster`.
- [`docs/config.md`](docs/config.md) — `milo.config.json` reference and `JEV_API_KEY`.
- [`docs/routing.md`](docs/routing.md) — how a routing decision gets made.
- [`docs/evals.md`](docs/evals.md) — running the routing eval set.
