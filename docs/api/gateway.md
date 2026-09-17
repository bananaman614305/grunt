# Gateway API reference

The gateway is a Hono app (`packages/gateway/src/app.ts`) that speaks the
OpenAI `/v1` surface plus a small decisions API. Every route lives under one
of two auth regimes: `GET /healthz` needs nothing, and every `/v1/*` route
needs a bearer token.

## Auth

Every `/v1/*` request must carry:

```
Authorization: Bearer <your OpenRouter key>
```

Milo only checks that the header is present and bearer-shaped
(`^Bearer\s+\S.*$`); it does not validate the key against OpenRouter, since
doing so would cost a call. A missing or empty bearer token gets:

```
401 { "error": { "message": "No OpenRouter API key provided. Send it as `Authorization: Bearer <key>`.", "type": "authentication_error", "code": "missing_authorization" } }
```

The header value is forwarded to OpenRouter unchanged and is never logged,
stored, or echoed back in a response (ADR-003). Milo's own Jev key never
appears on this surface at all — it lives in the server's `JEV_API_KEY`
environment variable (`docs/config.md`).

## `GET /healthz`

No auth. Returns immediately so a health probe works before anyone has a key.

```
GET /healthz
200 { "ok": true, "policyVersion": "v2" }
```

## `POST /v1/chat/completions`

The main surface. The body is OpenAI's chat completions shape, plus an
optional Milo-only `milo` field (see the README's "Per-request options").
Behavior forks on the `model` field:

### `model` is anything but `"milo/auto"` (passthrough)

The body is forwarded to `POST https://openrouter.ai/api/v1/chat/completions`
byte-for-byte except that the `milo` field, if present, is stripped (Open­Router
would reject it as an unknown field). No Jev call, no decision, no `x-milo-*`
headers. Streaming and non-streaming both pass through: the response body,
status, `content-type`, and `x-request-id` (OpenRouter's) travel back
unmodified.

### `model` is `"milo/auto"` (routed)

1. The gateway checks the rate limiter (see "Rate limiting" below). If the
   per-key bucket is empty, the request is rejected with a 429 before any
   Jev or OpenRouter call.
2. Otherwise the conversation is fingerprinted (SHA-256 of the system prompt
   plus the first user message) and handed to the router (`docs/routing.md`),
   which either serves a sticky hit or calls Jev and applies the policy
   table. Jev is the only decision backend (ADR-005) — there is no fallback
   tier to fall back to if it cannot answer.
3. The decision is written to the decision log **before** the upstream call
   starts, so `x-milo-decision-id` is always resolvable at
   `GET /v1/decisions/:id` by the time the client sees it.
4. `model` in the body is rewritten to the resolved OpenRouter model id and
   `milo` is stripped; the request is forwarded to OpenRouter with the
   client's own `Authorization` header.
5. The response comes back with the upstream body untouched (streamed
   responses pass through an identity transform; non-streaming bodies are
   buffered only to read `usage` for the decision log, then re-sent
   verbatim) plus six `x-milo-*` headers:

   | Header | Meaning |
   |---|---|
   | `x-milo-decision-id` | ID to look up at `GET /v1/decisions/:id` |
   | `x-milo-model` | The OpenRouter model id actually used |
   | `x-milo-tier` | `fast`, `mid`, or `frontier` |
   | `x-milo-task-type` | Jev's classified task type |
   | `x-milo-difficulty` | Jev's difficulty score to two decimals |
   | `x-milo-sticky` | `"true"` if served from the fingerprint cache |

   These headers are only ever present on a decision that actually routed;
   a request that could not be routed at all (see "Routing failures" below)
   gets an error response instead, with none of them.

An OpenRouter request that fails outright (network error, no response) on
either path returns:

```
502 { "error": { "message": "Upstream request to OpenRouter failed.", "type": "api_error", "code": "upstream_unavailable" } }
```

An OpenRouter response that comes back but is not a 2xx is passed through
with its own status and body — Milo does not rewrite upstream error bodies
on this route.

A malformed request body (not JSON, or not a JSON object) returns:

```
400 { "error": { "message": "Request body must be a JSON object.", "type": "invalid_request_error", "code": "invalid_request_body" } }
```

## `GET /v1/models`

Returns OpenRouter's model list with `milo/auto` prepended, so a model
picker built against this endpoint shows it like any other entry:

```json
{
  "data": [
    {
      "id": "milo/auto",
      "canonical_slug": "milo/auto",
      "name": "Milo auto-router",
      "description": "Routes to a model chosen by Jev from task type and difficulty",
      "pricing": { "prompt": "-1", "completion": "-1", "request": "-1", "image": "-1" },
      "context_length": 200000,
      "...": "..."
    },
    { "id": "anthropic/claude-opus-5", "...": "OpenRouter's own entries follow" }
  ]
}
```

`milo/auto`'s `pricing` fields are all `"-1"`, the same convention OpenRouter
itself uses for its own auto router: the real price is whichever model the
decision lands on. The rest of the list is cached in-process for five
minutes. An upstream failure passes through OpenRouter's own status and body
when there is one (e.g. a 401 for a bad key); a total network failure
returns the same `502 upstream_unavailable` shape as chat completions.

## `GET /v1/decisions/:id`

Returns one full decision record (the `DecisionRecord` type in
`packages/core/src/types.ts` — `RouteDecision` plus an optional `upstream`
block the gateway fills in after the OpenRouter call completes). No decision
with that id:

```
404 { "error": { "message": "No decision with that id.", "type": "not_found_error", "code": "decision_not_found" } }
```

## `GET /v1/decisions`

Lists recent decisions, newest first.

Query params:

| Param | Type | Default | Effect |
|---|---|---|---|
| `limit` | integer | 50 (server clamps to 1–500) | Max rows |

```
GET /v1/decisions?limit=5
200 { "data": [ /* DecisionRecord[] */ ] }
```

## `GET /v1/decisions/stats`

Registered before `/v1/decisions/:id` so the literal path `stats` is never
read as a decision id.

```
200 {
  "total": 42,
  "byTier": { "fast": 10, "mid": 20, "frontier": 12 },
  "byModel": { "anthropic/claude-sonnet-5": 20, "...": "..." },
  "sticky": 15,
  "avgJevLatencyMs": 87.4
}
```

`avgJevLatencyMs` is `null` when no decision is in scope.

The three `/v1/decisions*` routes require a bearer token like every other
`/v1` route, but any non-empty one is accepted — the decision log is
per-deployment, not per-key, so on a shared instance one user can read
another's decisions. This is a known gap for a single-tenant MVP, called out
in the source (`packages/gateway/src/routes/decisions.ts`) as needing
per-key scoping before Milo is multi-tenant.

## Generic `/v1/*` proxy

Registered last, so it only catches paths the routes above did not claim —
`/v1/generation`, `/v1/credits`, `/v1/keys`, and anything else OpenRouter
adds. Method, path, query string, and body all pass through unchanged; only
a small allow-list of headers travels (`authorization`, `content-type`,
`accept`, `http-referer`, `x-title`, `user-agent`), plus OpenRouter
attribution headers (`HTTP-Referer`, `X-Title`) if the gateway was
configured with them. A path containing `..` or `.` segments, or starting
with `//`, is refused before any network call:

```
400 { "error": { "message": "Milo will not proxy that path.", "type": "invalid_request_error", "code": "invalid_path" } }
```

## Rate limiting

Jev spend is Milo's, not the user's, so only routed (`milo/auto`) requests
are rate limited — passthrough traffic and the generic proxy cost Milo
nothing and are never limited. The limiter is a token bucket keyed on a
SHA-256 hash of the incoming `Authorization` header value (never the raw
key), capacity and refill rate both defaulting to 120 per minute
(`rateLimit.routedPerMinute` in config, or `GatewayOptions.rateLimit`).
Exceeding the bucket rejects the request before any Jev or OpenRouter call:

```
429 { "error": { "message": "Rate limit exceeded for routed requests.", "type": "rate_limit_error", "code": "rate_limited" } }
```

with a `Retry-After` header naming when the bucket next has capacity.

## Routing failures

Jev is the only decision backend (ADR-005): there is no fallback tier, so a
routed request the router cannot answer is not silently downgraded to a
cheaper model — it fails outright, with no decision written to the log and
none of the `x-milo-*` headers on the response:

```
503 { "error": { "message": "Routing is temporarily unavailable.", "type": "api_error", "code": "routing_unavailable" } }
```

with a `Retry-After` header. This covers a Jev timeout (default budget
800 ms, see `docs/config.md` and `docs/routing.md`), a network error, a
non-2xx from Jev, an unparseable/out-of-range answer, and the router's own
circuit breaker being open. Most of these never reach a client at all:
exponential-backoff retries, in-flight coalescing of identical concurrent
asks, and a persisted sticky cache (ADR-005) absorb the ordinary case of a
slow or momentarily flaky Jev call. The 503 is what is left over when none
of that resilience is enough.

A routing failure that is not a Jev problem at all (an unusable roster, a
router bug) is a separate, unrecoverable case:

```
502 { "error": { "message": "Milo could not route this request.", "type": "api_error", "code": "routing_failed" } }
```

## Passthrough to OpenRouter

Only the `model` field is ever rewritten, and only on the routed path. Every
other field in a chat completions body — `messages`, `tools`, `stream`,
`temperature`, sampling params, anything else — is forwarded exactly as
received. The `milo` field is the one addition Milo's surface makes over
OpenRouter's own API, and it is always stripped before the request leaves
Milo.

## Errors

Every Milo-originated error uses the OpenAI SDK's error shape so the
`openai` client's own error classes key off it correctly:

```json
{ "error": { "message": "...", "type": "authentication_error" | "invalid_request_error" | "not_found_error" | "api_error", "code": "..." } }
```

No Milo error message ever interpolates a request header or an upstream
error's raw text (ADR-003) — the log line for an unhandled server error is
`{"level":"error","msg":"unhandled gateway error","error":"..."}`, and the
response body is a generic:

```
500 { "error": { "message": "Milo failed to handle this request.", "type": "api_error", "code": "internal_error" } }
```
