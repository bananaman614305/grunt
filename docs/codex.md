# Pointing Codex CLI at Milo

OpenAI's Codex CLI talks to a custom provider over the **Responses API**.
Milo serves one at `POST /v1/responses`, so routing a whole Codex session
through Jev is a provider block in `~/.codex/config.toml` and no code change.

Verified on 2026-09-17 against:

- Codex CLI 0.154's configuration reference — `wire_api = "responses"` is now
  the only supported value (and the default when omitted). Chat Completions
  support was removed in February 2026, so any guide that still says
  `wire_api = "chat"` is out of date.
- OpenRouter's own OpenAPI document, <https://openrouter.ai/openapi.json>:
  `POST /responses`, `operationId: createResponses`, bearer auth, a `200` that
  is either `application/json` or `text/event-stream`.

## The provider block

```toml
model_provider = "milo"
model = "milo/auto"

[model_providers.milo]
name = "Milo"
base_url = "https://milo-gateway.fly.dev/v1"
env_key = "OPENROUTER_API_KEY"
wire_api = "responses"
```

`env_key` names the environment variable Codex reads the key out of and sends
as `Authorization: Bearer`. Export your own OpenRouter key into it:

```sh
export OPENROUTER_API_KEY="sk-or-..."
codex
```

For a local gateway, `base_url` is `http://127.0.0.1:8787/v1` — `8787` is
`milo serve`'s default port. Unlike Claude Code's `ANTHROPIC_BASE_URL`, this
one **does** end in `/v1`: Codex appends only `/responses` to it.

### Without editing the config file

Codex takes the same keys as `-c key=value` overrides for a single run, and
values parse as TOML, so a whole provider fits in one inline table:

```sh
codex -c model_provider=milo \
      -c 'model_providers.milo={name="Milo",base_url="https://milo-gateway.fly.dev/v1",env_key="OPENROUTER_API_KEY",wire_api="responses"}' \
      --model milo/auto
```

A CLI flag beats a profile, which beats a project `.codex/config.toml`, which
beats `~/.codex/config.toml`. So this form is also how you point one session
at a different Milo without touching the file.

## Selecting the router

`model = "milo/auto"` is the trigger, and `--model` overrides it per run.
Anything else is an ordinary OpenRouter model id and passes straight through,
so you can send the cheap work somewhere cheap:

```sh
codex --model milo/auto                 # routed
codex --model openai/gpt-5.3-codex      # forwarded untouched, no Jev call
```

The model id has to match an OpenRouter slug character for character when it
is not `milo/auto`, because Milo hands it over unchanged.

## Verify it works

```sh
export OPENROUTER_API_KEY="sk-or-..."
codex --model milo/auto          # then type a trivial prompt, e.g. "say ok"
```

Or without the TUI:

```sh
codex exec --model milo/auto "reply with the single word: ok"
```

Then read the decision back. Codex does not surface response headers, so the
gateway's own log is where the `x-milo-*` values live:

```sh
milo decisions --limit 1
milo explain <decision-id>
```

Against a hosted gateway, the HTTP route answers the same question with your
OpenRouter key:

```sh
curl -sS https://milo-gateway.fly.dev/v1/decisions/<decision-id> \
  -H "Authorization: Bearer ${OPENROUTER_API_KEY}"
```

To see the headers themselves, skip Codex and send the request by hand:

```sh
curl -sS -D - -o /dev/null https://milo-gateway.fly.dev/v1/responses \
  -H "Authorization: Bearer ${OPENROUTER_API_KEY}" \
  -H "content-type: application/json" \
  -d '{"model":"milo/auto","store":false,
       "instructions":"You are a build engineer.",
       "input":[{"type":"message","role":"user",
                 "content":[{"type":"input_text","text":"Why would a CI job flake one run in five?"}]}]}'
```

A routed response carries the same six headers as every other Milo surface:

```
x-milo-decision-id: 01K5...
x-milo-model: anthropic/claude-opus-5
x-milo-tier: frontier
x-milo-task-type: debug
x-milo-difficulty: 2.31
x-milo-sticky: false
```

## What Codex sends that Milo passes through unrouted

| Request | What Milo does |
|---|---|
| `POST /v1/responses` with `model: "milo/auto"` | Routes it: Jev, policy, roster, decision log, `x-milo-*` headers |
| `POST /v1/responses` with any other model id | Forwards verbatim; no Jev call, no decision, no rate-limit token spent |
| `POST /v1/responses` with `stream: true` | Same routing, and the SSE stream is piped through byte for byte — Milo never buffers a stream |
| `GET /v1/responses/<id>`, `POST /v1/responses/<id>/cancel`, `GET /v1/responses/<id>/input_items` | The generic `/v1/*` proxy: method, path, query and body unchanged. OpenRouter's Responses API is stateless, so these mostly 404 upstream — Codex does not need them for an ordinary session |
| `GET /v1/models` | Served by Milo's models route (OpenRouter's catalogue with `milo/auto` first) |

Only the `model` field is rewritten on this surface. Every other field —
`input`, `instructions`, `tools`, `tool_choice`, `reasoning`, `text`, `include`,
sampling parameters, `previous_response_id`, `store` — is forwarded exactly
as received. The Milo-only `milo` field is the one thing stripped. The chat
completions surface separately defaults routed requests to
`reasoning.exclude: true` so clients do not display an internal trace; a caller
can explicitly set `reasoning.exclude: false` to receive it.

### `previous_response_id` and `store`

OpenRouter's Responses API is stateless. Their schema says so outright:
`previous_response_id` is "Not supported … Requests with a non-null value are
rejected with a 400 error. Send the full conversation history in `input`
instead", and `store` is declared `const false`. Milo forwards both anyway,
so that refusal comes from the provider that owns it rather than from a guess
made here.

None of that affects routing. Milo's stickiness is keyed on a conversation
**fingerprint** — a hash of the system prompt plus the first user message —
not on a server-side response id, which is exactly the design a stateless
client needs. Codex resends the full `input` every turn with `store: false`,
so:

- a tool round-trip (a `function_call` item and its `function_call_output`)
  adds no `user` message, the user-turn count is unchanged, and the pinned
  model is reused — `x-milo-sticky: true`, no Jev call, no model swap in the
  middle of a tool loop;
- a genuine follow-up adds a `user` message, the count moves, and Milo asks
  Jev again rather than serving a tier chosen for an earlier question.

## Milo's own request extension

Optional, and stripped before the body reaches OpenRouter:

```json
{
  "model": "milo/auto",
  "instructions": "...",
  "input": [],
  "store": false,
  "milo": { "posture": "low", "candidates": ["anthropic/claude-sonnet-5"], "tier": "fast" }
}
```

Codex has no way to add a top-level body field, so this is for the OpenAI SDK
and for harnesses you write yourself.

## Caveats

- The Responses surface is bearer-only. There is no `x-api-key` fallback the
  way `/v1/messages` has one, because nothing in this dialect sends a key
  that way.
- Rate limiting counts routed requests per key, exactly as on the other two
  surfaces; an explicit model id costs nothing.
- Reasoning items in `input` are ignored when building the router's view of
  the conversation, so a reasoning trace never reaches Jev.
