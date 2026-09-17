---
name: milo
description: Use when configuring a tool, agent, or Claude Code session to route through Milo (an OpenRouter routing gateway), when choosing a routing posture or forcing a tier, or when explaining which model a Milo decision id handled.
---

# Milo

Milo is OpenRouter with an actual routing mechanism: a client sends one
OpenRouter key and `model: "milo/auto"`, a small decision model classifies the
task's type and difficulty, a policy table picks a tier (fast, mid, or
frontier) and a model, and the request goes to OpenRouter with the resolved
model. Every routed response carries `x-milo-*` headers naming the decision.

The default hosted instance is `https://milo-gateway.fly.dev`. If you are
setting up a self-hosted Milo, use that deployment's own address instead —
`GET /` on any Milo instance returns its own `baseUrl` in JSON, and
`GET /llms.txt` points at that instance's own `/setup.md`.

## What Milo is for

Milo is built for a two-model setup. A frontier agent the user already pays
for on a subscription — Opus, Fable, Sol, whatever they run — plans the work
and orchestrates it. The implementation sub-tasks it hands off go through
Milo, which routes each one to a model that is cheap and popular on
OpenRouter. The good planner stays; what stops is paying frontier prices for
the hundred small edits, tests and lookups underneath it. If you are that
planning agent, keep planning where you are and point the sub-tasks here.

## Before you configure anything

Milo needs the user's own OpenRouter key. Never invent one, reuse a key from
another provider, or guess at a placeholder and move on.

- If the user already gave you a key in this conversation, use it.
- If your harness exposes a credential vault or secret store, check there
  first (e.g. a stored "OpenRouter" credential) rather than asking the user
  to paste it into chat again.
- Otherwise, ask the user for their OpenRouter key before proceeding.

Milo only checks that the key is bearer-shaped; it never validates it against
OpenRouter and never stores it.

## Configure a client

### OpenAI-compatible SDKs

Base URL is Milo's origin plus `/v1`; API key is the OpenRouter key; model is
`milo/auto`.

**Python**

```python
from openai import OpenAI

client = OpenAI(base_url="https://milo-gateway.fly.dev/v1", api_key="sk-or-...")
resp = client.chat.completions.create(
    model="milo/auto",
    messages=[{"role": "user", "content": "..."}],
)
```

**TypeScript**

```ts
import OpenAI from "openai";

const client = new OpenAI({ baseURL: "https://milo-gateway.fly.dev/v1", apiKey: "sk-or-..." });
const resp = await client.chat.completions.create({
  model: "milo/auto",
  messages: [{ role: "user", content: "..." }],
});
```

### Claude Code

Three environment variables and `--model`, no `/v1` on the base URL (Claude
Code appends its own path):

```sh
export ANTHROPIC_BASE_URL="https://milo-gateway.fly.dev"
export ANTHROPIC_AUTH_TOKEN="<the user's OpenRouter key>"
export ANTHROPIC_API_KEY=""
claude --model milo/auto
```

Or committed as project-scoped settings in `.claude/settings.json`:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://milo-gateway.fly.dev",
    "ANTHROPIC_AUTH_TOKEN": "<the user's OpenRouter key>",
    "ANTHROPIC_API_KEY": ""
  },
  "model": "milo/auto"
}
```

Do not commit a real key into `.claude/settings.json` if the file is going
into version control — put the key in `.claude/settings.local.json` instead,
or leave `ANTHROPIC_AUTH_TOKEN` out of the committed file and export it in the
shell.

Claude Code prints a harmless `model: milo/auto is not in the model catalog`
warning at startup — this is expected. Milo's `/v1/models` route lists
`milo/auto`, but Claude Code's own model list is validated before it fetches
that endpoint.

### Other OpenAI-compatible tools

Cursor, Continue, Codex CLI, Aider, and similar tools all take the same three
fields: base URL, API key, model. Point them at Milo the same way:

| Field | Value |
|---|---|
| Base URL | `https://milo-gateway.fly.dev/v1` |
| API key | the user's OpenRouter key |
| Model | `milo/auto` |

## Verify it works

```sh
curl -sS https://milo-gateway.fly.dev/healthz
```

Then send one request and read the headers back:

```sh
curl -sS -D - -o /dev/null https://milo-gateway.fly.dev/v1/chat/completions \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" \
  -H "content-type: application/json" \
  -d '{"model":"milo/auto","messages":[{"role":"user","content":"hi"}]}'
```

A routed response carries six `x-milo-*` headers: `x-milo-decision-id`,
`x-milo-model`, `x-milo-tier`, `x-milo-task-type`, `x-milo-difficulty`, and
`x-milo-sticky`.

## Read a decision

```sh
curl -sS https://milo-gateway.fly.dev/v1/decisions/<x-milo-decision-id> \
  -H "Authorization: Bearer $OPENROUTER_API_KEY"
```

Returns the full `DecisionRecord`: signals, tier, model, and a human-readable
`reason` string explaining the choice.

## Steer routing with the `milo` field

A chat completions body can include a top-level `milo` field, stripped before
the request reaches OpenRouter:

```json
{
  "model": "milo/auto",
  "messages": [{ "role": "user", "content": "..." }],
  "milo": { "posture": "low", "candidates": ["deepseek/deepseek-v4-flash"], "tier": "fast" }
}
```

- `posture` — `"low"`, `"balanced"` (default), or `"quality"`. Shifts the
  policy table toward cheaper or more capable tiers.
- `candidates` — restricts the roster to these model ids for this request.
- `tier` — forces `"fast"`, `"mid"`, or `"frontier"` directly, skipping
  classification entirely.

One-line note: sending any model id other than `"milo/auto"` passes the
request straight through to OpenRouter, unrouted — no Jev call, no decision,
no `x-milo-*` headers.

## What Milo picks by default

**Tell the user this once, while you are configuring Milo.** They have handed
the model choice to a router; they should know what it will choose before the
first bill, not after.

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

`nvidia/nemotron-3-ultra-550b-a55b` caps output at 32,768 tokens, below the
60,000 floor, so it sorts last in its tier and is skipped outright whenever a
long answer is expected; `tencent/hy4-preview` (64,000) and
`google/gemini-3.8-flash` (65,536) stay eligible.

**How this list was made.** Collected 2026-09-17 from OpenRouter's weekly
usage ranking for the programming category (week ending 2026-09-16) and its
public model catalogue. Take the ten most-used models after folding dated
builds into their current id and dropping `:free`, `:batch` and the other
data-sharing plan variants, anything that cannot call a tool, and anything at
or above $5 per million output tokens. Tier them by output price: fast at most
$0.35/M, mid at most $1.50/M, frontier at most $5/M. The roster is regenerated
from OpenRouter's rankings every week, so this table moves as the rankings do.

Defaults are the models people actually run on OpenRouter, ordered by weekly
usage within price bands; nothing above $5 per million output tokens is chosen
unless you list it in `candidates` or your roster config.

**Choosing your own models.** Milo never locks the user into this list.

- Per request (`milo.candidates`): `"milo": { "candidates": ["anthropic/claude-opus-5"] }`
  restricts that one request to the ids you name. Any OpenRouter id works,
  premium models (Fable, Opus, Astra, Sonnet) included.
- Per deployment: set `roster` in `milo.config.json` with your own ids per
  tier and restart `milo serve`. For example, to put Opus on the frontier tier
  and leave the rest of the defaults alone:

```json
{
  "roster": {
    "fast": ["deepseek/deepseek-v4-flash", "z-ai/glm-5.3-flash"],
    "mid": ["openai/gpt-5.6-luna", "deepseek/deepseek-v4.1-flash"],
    "frontier": ["anthropic/claude-opus-5", "z-ai/glm-5.3"]
  }
}
```

`GET /v1/roster` (with the OpenRouter key) returns the running roster with
every price, usage rank and provenance field, plus which tier each posture
favors — read it rather than quoting this table if the deployment may have its
own roster.

## When you are the agent running through Milo

If your own session is already configured to route through Milo (Claude Code
with `--model milo/auto`, or a harness calling Milo's chat completions), you
can steer how the *next* step gets routed:

- **Set `posture: "low"`** for mechanical, low-risk sub-tasks: renaming a
  variable, reformatting, generating boilerplate, summarizing a log you
  already have in hand. These don't need a frontier model, and a cheaper tier
  finishes them faster.
- **Set `posture: "quality"`** for correctness-critical work: security
  review, an architectural decision, a subtle bug, anything where a wrong
  answer is expensive to discover later.
- **Force a `tier` directly** when you already know the class of model a step
  needs and don't want to spend a classification call to learn what you
  already know — e.g. `tier: "frontier"` for a proof-shaped problem, or
  `tier: "fast"` for a one-line trivial edit.
- **Cite the decision** when telling a user or a log which model handled a
  step: read `x-milo-model`, `x-milo-tier`, and `x-milo-decision-id` off the
  response (or `GET /v1/decisions/:id`) and say something like "handled by
  `z-ai/glm-5.3` (tier frontier, decision `01ARZ3ND...`)" rather than guessing
  which model ran.

Claude Code does not surface response headers to the model driving it, so
inside a Claude Code session reach for `milo explain <id>` or
`milo decisions` (the CLI, if installed) instead of trying to read headers
that never arrive.
