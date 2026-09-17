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
  "milo": { "posture": "low", "candidates": ["anthropic/claude-haiku-4.5"], "tier": "fast" }
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
  `anthropic/claude-opus-5` (tier frontier, decision `01ARZ3ND...`)" rather
  than guessing which model ran.

Claude Code does not surface response headers to the model driving it, so
inside a Claude Code session reach for `milo explain <id>` or
`milo decisions` (the CLI, if installed) instead of trying to read headers
that never arrive.
