# Pointing Claude Code at Milo

Claude Code talks to an Anthropic-compatible `POST /v1/messages`. Milo serves
one, so routing a whole Claude Code session through Jev is three environment
variables and no code change.

Verified against Claude Code's own documentation on 2026-09-17:

- <https://code.claude.com/docs/en/env-vars> (the settings page at
  `docs.anthropic.com/en/docs/claude-code/settings` now redirects to
  `code.claude.com/docs/en/settings`, and the variable table moved to the
  page above)
- <https://code.claude.com/docs/en/llm-gateway-protocol> — what a gateway
  behind `ANTHROPIC_BASE_URL` actually has to serve
- <https://code.claude.com/docs/en/model-config> — `ANTHROPIC_MODEL`, `--model`

## The three variables

```sh
export ANTHROPIC_BASE_URL="http://127.0.0.1:8787"   # Milo's root, no /v1
export ANTHROPIC_AUTH_TOKEN="$OPENROUTER_API_KEY"   # your OpenRouter key
export ANTHROPIC_API_KEY=""                         # explicitly empty
export ANTHROPIC_MODEL="milo/auto"

claude
```

Or per session, leaving the environment alone: `claude --model milo/auto`.

`8787` is `milo serve`'s default port. For a hosted instance use its URL.

### Why `ANTHROPIC_BASE_URL` has no `/v1`

Claude Code appends the path itself — the docs' own check is
`curl -X POST "$ANTHROPIC_BASE_URL/v1/messages"`. Setting it to
`http://127.0.0.1:8787/v1` would make Claude Code ask for `/v1/v1/messages`.
This is the one place Milo's Anthropic surface differs from its OpenAI one,
where the OpenAI SDK's `baseURL` *does* end in `/v1`.

### Which variable carries the key

The two are not interchangeable — they put the credential in different
headers, and Claude Code's docs are explicit about it:

> Each variable sends the credential in a different HTTP header:
> `ANTHROPIC_AUTH_TOKEN` in `Authorization: Bearer`, `ANTHROPIC_API_KEY` in
> `x-api-key`, and `apiKeyHelper` in both.

**Milo accepts either on `/v1/messages`** and normalizes both to
`Authorization: Bearer <key>` before calling OpenRouter, which is the only
scheme OpenRouter documents. So either variable works. Prefer
`ANTHROPIC_AUTH_TOKEN`, which is also what OpenRouter's own Claude Code guide
recommends, and set `ANTHROPIC_API_KEY=""` explicitly: a non-empty
`ANTHROPIC_API_KEY` takes precedence over a Claude subscription, and an
already-exported Anthropic key would otherwise be sent to Milo and forwarded
to OpenRouter, where it is not a valid key.

The key is never logged, never stored, never echoed in an error, and never
written into a decision record (ADR-003). It reaches exactly one place:
OpenRouter.

## Selecting the router

`model: "milo/auto"` is the trigger. Anything else passes through to
OpenRouter untouched, so you can mix:

```sh
export ANTHROPIC_MODEL="milo/auto"                     # the main loop is routed
export ANTHROPIC_DEFAULT_HAIKU_MODEL="anthropic/claude-haiku-4.5"
```

`ANTHROPIC_DEFAULT_HAIKU_MODEL` is what the `haiku` alias and Claude Code's
background work resolve to. Pinning it to a cheap model directly, rather than
`milo/auto`, keeps Milo from spending a Jev call on work that is already known
to be trivial. (`ANTHROPIC_SMALL_FAST_MODEL` is the deprecated spelling of the
same setting.) `CLAUDE_CODE_SUBAGENT_MODEL` and the other
`ANTHROPIC_DEFAULT_*_MODEL` variables take model ids the same way — point any
of them at `milo/auto` to route that slice of traffic.

Each routed response carries the seven `x-milo-*` headers, and
`GET /v1/decisions/:id` explains the choice. Claude Code does not surface
response headers, so `milo decisions` or `milo explain <id>` is how you read
them back.

## What Claude Code sends that Milo passes through unrouted

| Request | What Milo does |
|---|---|
| `POST /v1/messages` with `model: "milo/auto"` | Routes it: Jev, policy, roster, decision log, `x-milo-*` headers |
| `POST /v1/messages` with any other model id | Forwards verbatim; no Jev call, no decision, no rate-limit token spent |
| `POST /v1/messages?beta=true` | Same; the query string is preserved |
| `POST /v1/messages/count_tokens` | Proxied to OpenRouter unchanged — **but OpenRouter has no such endpoint and answers 404.** Claude Code treats a missing token-counting endpoint as optional and falls back to a character-based estimate, so `/context` shows an approximation rather than breaking |
| `GET /v1/models?limit=1000` | Served by Milo's models route (OpenRouter's catalogue with `milo/auto` first). Only requested when `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`. This route requires a bearer token, so discovery needs `ANTHROPIC_AUTH_TOKEN` — another reason to prefer it |
| `HEAD /api/hello` | Not a `/v1` path, so Milo 404s the connection-warming probe. Claude Code tolerates a rejected probe |

Request headers `anthropic-version` and `anthropic-beta` are forwarded
verbatim, as the gateway protocol asks — no per-value allow-list. OpenRouter's
schema does not model either header, so treat them as passed on rather than
honoured. `cache_control` blocks and block-form `system` and message content
are forwarded unchanged: Milo rewrites `model` and strips its own `milo`
field, nothing else.

Streaming is piped straight through — Milo never buffers a complete response
before relaying it, which is what would stall Claude Code.

## Milo's own request extension

Optional, and stripped before the body reaches OpenRouter:

```json
{
  "model": "milo/auto",
  "max_tokens": 4096,
  "system": "...",
  "messages": [],
  "milo": { "posture": "low", "candidates": ["anthropic/claude-sonnet-5"] }
}
```

Claude Code has no way to add a top-level body field, so this is for the
Anthropic SDK and for harnesses you write yourself. Per-session cost posture
from Claude Code is a config-file setting instead.

## Caveats

- OpenRouter says the Claude Code integration "is only guaranteed to work with
  the Anthropic first-party provider" — Claude Code is built around Anthropic
  request semantics. Milo's roster is Anthropic-heavy by default, so the
  common case is fine, but a roster pointed at other providers may see tool
  calls behave differently from run to run.
- Remote Control and Claude Code's fast-mode availability check talk to
  `api.anthropic.com` directly rather than following `ANTHROPIC_BASE_URL`.
- If a proxy-related feature misbehaves, the escape hatches Claude Code
  documents are `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`,
  `CLAUDE_CODE_ATTRIBUTION_HEADER=0`, and
  `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1`.

## Checking it works

```sh
curl -sS -D - -o /dev/null -X POST "$ANTHROPIC_BASE_URL/v1/messages" \
  -H "x-api-key: $OPENROUTER_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{"model":"milo/auto","max_tokens":64,
       "system":"You are a build engineer.",
       "messages":[{"role":"user","content":"Why would a CI job flake one run in five?"}]}'
```

The response headers name the decision:

```
x-milo-decision-id: 01K5...
x-milo-model: anthropic/claude-opus-5
x-milo-tier: frontier
x-milo-task-type: debug
x-milo-difficulty: 2.31
x-milo-sticky: false
x-milo-degraded: false
```

Then `milo explain 01K5...` for the full record, Jev probabilities included.
