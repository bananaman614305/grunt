# Gateway API reference

The gateway is a Hono app (`packages/gateway/src/app.ts`) that speaks the
OpenAI `/v1` surface plus a small decisions API. Every route lives under one
of two auth regimes: `GET /healthz` needs nothing, and every `/v1/*` route
needs a bearer token.

## Auth

Every `/v1/*` request must carry a bearer token, and there are two kinds
(ADR-003, ADR-007). Which one you sent decides everything else on this page:
who pays, what the response headers say, and whose decisions you can read.

```
Authorization: Bearer <your OpenRouter key>     # bring your own key (BYOK)
Authorization: Bearer mk_<your Milo key>        # a Milo account
```

**BYOK.** Any bearer that does not start with `mk_` is your own OpenRouter
key. Milo only checks that the header is present and bearer-shaped
(`^Bearer\s+\S.*$`); it does not validate the key against OpenRouter, since
doing so would cost a call. The value is forwarded to OpenRouter unchanged
and is never logged, stored, or echoed back in a response. Milo charges
nothing: you pay OpenRouter directly, and no `x-milo-cost-usd` header
appears.

**Milo key.** A bearer starting with `mk_` is a key Milo issued. It is looked
up by its SHA-256 (the only form the database holds) and the request goes
upstream on that account's own OpenRouter sub-key, which Milo mints on the
account's first paid request and stores encrypted. The account is charged
what OpenRouter reports plus margin (see "Credits and cost headers" below).
The Milo key never reaches OpenRouter and the sub-key never reaches you.

| condition | answer |
| --- | --- |
| no bearer at all | `401 missing_authorization` |
| `mk_` key on a deployment with no billing configured | `401 milo_keys_disabled`, "Milo keys are not enabled on this deployment." |
| `mk_` key that is unknown or revoked | `401 invalid_api_key` |
| `mk_` key whose account is suspended | `403 account_suspended` |
| `mk_` key whose account is below the reserve | `402 insufficient_credits` |

```
401 { "error": { "message": "No OpenRouter API key provided. Send it as `Authorization: Bearer <key>`.", "type": "authentication_error", "code": "missing_authorization" } }
```

`/v1/messages` also accepts the key as `x-api-key`, in either kind, because
that is where the Anthropic SDK and Claude Code put it; refusals on that path
wear Anthropic's error envelope.

Milo's own Jev key never appears on this surface at all — it lives in the
server's `JEV_API_KEY` environment variable (`docs/config.md`).

## `GET /healthz`

No auth. Returns immediately so a health probe works before anyone has a key.

```
GET /healthz
200 { "ok": true, "policyVersion": "v4", "decisionBackend": "jev", "mode": "roster" }
```

`mode` names the routing mode this deployment runs (ADR-012): `"roster"`
(the default) or `"deepseek"`, the experimental compute controller. `GET /`
reports the same field.

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
   plus the first user message, scoped to the caller's key hash so two keys
   never share a sticky decision — ADR-008) and the roster is resolved for
   that key (stored, else config, else default). Both are handed to the
   router (`docs/routing.md`),
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
   | `x-milo-brief-version` | Hash of the preference brief appended to this request (ADR-011). Absent when no brief was injected — no stored output-shaping preferences, `milo: { "brief": false }` on the request, or the key's brief switch off. |
   | `x-milo-facts-injected` | How many stored personal facts the relevance gate found relevant to this request and appended (ADR-017). Absent when none were injected — no stored facts, none relevant, `milo: { "facts": false }`, the key's kill switch off, or `low` posture. |

   These headers are only ever present on a decision that actually routed;
   a request that could not be routed at all (see "Routing failures" below)
   gets an error response instead, with none of them.

### Best-of-N sampling (ADR-010)

For the cells where the benchmark showed a cheap model tried five times beats
the tier the policy used to buy — `edit` and `docs` tasks above the trivial
band, under `balanced` or `quality` posture — the decision resolves to
best-of-5 on the fast tier instead of a single higher-tier call, and this
route executes it:

1. Five upstream calls go out in parallel on the caller's key, each
   internally streamed (SSE), each with one of the varied framings appended
   to the system prompt and each under its own wall-clock cap (60 s by
   default; `sampling.sampleTimeoutMs` in `milo.config.json`). Unless the
   request carries a `provider` field of its own, each sampled call adds
   `provider: { sort: "throughput" }` so OpenRouter's rolling window routes
   it to the currently fastest provider; a caller-supplied `provider` passes
   through untouched, and unsampled forwards are never touched.
2. Each answer is scored the moment its stream completes, by one Jev call on
   Milo's key (quality 0–3 plus a correctness probability). Once
   `sampling.minRanked` answers (default 3) are ranked, a clear winner —
   expected quality at or above 2.5, or the first success when ranking is
   degraded — is returned immediately and the still-streaming samples are
   aborted, which stops their token spend. Otherwise the fan-out runs to the
   per-sample cap and the best answer — highest expected quality,
   correctness breaking ties — goes back to the client. Tool-call answers
   are ranked and picked like any other.
3. Two more headers disclose it, on top of the six above:

   | Header | Meaning |
   |---|---|
   | `x-milo-samples` | how many samples were drawn (`x-milo-tier` is `fast`) |
   | `x-milo-sample-pick` | the zero-based index of the sample returned |

A non-streaming request gets the chosen answer reassembled as one
`chat.completion` body. A streaming request gets it replayed as well-formed
SSE: one chunk carrying the whole answer as a delta, a final chunk with the
finish reason and the chosen sample's usage, then `[DONE]`. Time-to-first-byte
on a sampled request is therefore bounded by the `minRanked`-th fastest sample
plus one Jev rank when a clear winner emerges — and by the slowest capped
sample only when none does — not the fast model's own TTFT.

**Spend:** a sampled request spends roughly N fast-tier calls of the caller's
OpenRouter budget (plus N+1 Jev calls on Milo's), which the benchmark showed
lands in the same cost band as the one mid-tier call it replaces and well
below frontier. A Milo key (`mk_`) is charged the sum of every sample's usage
as one usage row against the decision. The decision record at
`GET /v1/decisions/:id` aggregates tokens and cost across samples in its
`upstream` block and stores per-sample metadata — tokens, cost, Jev scores,
the pick, failure classes — never content. A sample aborted by the early
return carries `aborted: true` and only the partial usage its stream had
reported; the aggregate sums only what was actually billed.

Failure behavior: if every sample fails, the request is answered by one
ordinary call on the decision's `unsampledTier` (the tier the policy would
have picked without sampling; the headers then name that model and tier). If
Jev cannot rank any sample, the first successful sample is returned and the
decision record says `ranking_failed`.

Opting out: `milo: { "samples": 1 }` disables sampling for one request (any
explicit integer up to 8 sets the count instead); `posture: "low"` never
samples; `sampling: { "enabled": false }` in `milo.config.json` turns it off
for the deployment. Sampling currently executes on this route only — routed
`/v1/messages` and `/v1/responses` requests always take their single-model
outcome.

Under `"mode": "deepseek"` (ADR-012, `docs/routing.md`) the sampled
decision comes from the compute controller instead of a policy cell — the
model is a fixed DeepSeek family model rather than the roster's fast tier —
and the all-samples-failed fallback is one call on that same model
(`unsampledModel`), never a roster lookup.

### The completeness gate (ADR-013 phase A)

On this route only, in both routing modes, a routed answer on a non-trivial
cell is checked before it is served: one Jev call on Milo's key asks
whether the answer addresses every part of the request. The gate runs when
the decision's difficulty band is 1 or above, the posture is not `low`, and
the request did not send `milo: { "gates": false }`; forced tiers never
gate. A gated request is buffered internally whatever the client asked for,
and a streaming client gets the served answer replayed as well-formed SSE,
exactly like a sampled decision.

| Header | Meaning |
|---|---|
| `x-milo-completeness` | the verdict: `complete`, `incomplete`, `off_task`, or `wrong_format`. Also `complete` when the check itself failed — the gate never fails a request that has an answer (the decision record then says `error`). Absent when the gate did not run. |
| `x-milo-retry` | `"1"` when a failing verdict bought the single retry (same model, the failure type's fixed template appended as a final system message). At most one, ever. |
| `x-milo-gate-pick` | which answer was served after a retry: `original` or `retry`, per a second Jev call rating both. The original wins ties and wins whenever the rating fails. |

Spend: the check is one Jev classification; a retry roughly doubles that
request's generation cost on the cells where it fires, bounded by firing at
most once. A Milo key is charged for both answers when a retry fired — the
tokens were generated either way — and the decision record's `upstream`
block aggregates them, stores the verdict and the retry's own usage under
`gate`, and stores no content.

### Context pruning (ADR-014, ADR-013 phase C)

On this route only, when it is enabled (`pruning.enabled`, or `milo: {
"prune": true }` on the request) and the history is over the token floor,
Milo may shed a safe older range of messages before forwarding — replacing
it with one system note, `[earlier context pruned by Milo: <n> messages]`.
It never runs on `low` posture, never drops the system prompt, the latest
user turn, or half of a tool-call/result pair. `milo: { "prune": false }`
always opts out. See `docs/routing.md`, "Context pruning".

| Header | Meaning |
|---|---|
| `x-milo-pruned` | how many older messages were dropped. Absent when nothing was pruned. |
| `x-milo-pruned-tokens` | approximate input tokens saved by the drop (characters / 4). |

Spend: one extra Jev classification on a request over the floor; the win is
fewer input tokens forwarded on every subsequent turn. The decision record's
`upstream.prune` block stores the counts (dropped, tokens saved, the range,
the verdict confidence, the floor, the fill ratio) and no content.

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

## `POST /v1/responses`

The OpenAI Responses dialect, for Codex CLI and anything else configured with
`wire_api = "responses"`. Bearer auth only. Upstream is
`POST https://openrouter.ai/api/v1/responses`.

Behavior forks on `model` exactly as `/v1/chat/completions` does: `milo/auto`
routes and anything else passes through with only the `milo` field stripped.
Same rate limiter and same forced-tier skip, the same six `x-milo-*` headers
on a routed response, and the same 429 / 502 / 503 refusals in the OpenAI
error shape.

What differs is the request shape the router reads. There are no `messages`:

| Responses field | What the router sees |
|---|---|
| `instructions` (string) | the system message |
| `input` (string) | one user message |
| `input` item `{ type: "message", role, content }` | that role's turn; `content` is a string or parts whose `input_text` / `output_text` / `text` contribute their text |
| `input` item `{ type: "function_call" }` | an assistant marker line naming the tool |
| `input` item `{ type: "function_call_output" }` | a `role: "tool"` message — a continuation, **not** a new user turn, so the pinned decision is reused |
| `input` item `{ type: "reasoning" }` and other item types | ignored |
| `tools` | passed along as the tool list |

`previous_response_id` and `store` are forwarded untouched. Stickiness does
not use them: the router keys on the conversation fingerprint, which is what
makes a stateless client that resends its whole `input` every turn (Codex,
with `store: false`) stick to one model across a tool loop. OpenRouter's own
schema rejects a non-null `previous_response_id` with a 400 and declares
`store` `const false`; Milo lets that refusal come from them.

Usage for the decision log is read off `usage.input_tokens`,
`usage.output_tokens`, and OpenRouter's `usage.cost`. A streamed response is
never parsed, so it records status and latency only — in this dialect usage
rides on the `response.completed` event inside the stream.

Any other `/v1/responses/*` path (retrieve, cancel, delete, input items) is
not claimed here and falls through to the generic `/v1/*` proxy below.

See [`docs/codex.md`](../codex.md) for the client-side setup.

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
      "description": "Routes to a model chosen by Jev from task type and difficulty. Default roster 2026-09-17: the 10 most-used models on OpenRouter for coding, popular-and-cheap, nothing above $5/M output. Override per request with milo.candidates; see GET /v1/roster.",
      "pricing": { "prompt": "-1", "completion": "-1", "request": "-1", "image": "-1" },
      "context_length": 1050000,
      "...": "..."
    },
    { "id": "anthropic/claude-opus-5", "...": "OpenRouter's own entries follow" }
  ]
}
```

The description names the roster version and what the defaults optimize for,
because a model picker is where most users first meet `milo/auto`.

`milo/auto`'s `pricing` fields are all `"-1"`, the same convention OpenRouter
itself uses for its own auto router: the real price is whichever model the
decision lands on. The rest of the list is cached in-process for five
minutes. An upstream failure passes through OpenRouter's own status and body
when there is one (e.g. a 401 for a bad key); a total network failure
returns the same `502 upstream_unavailable` shape as chat completions.

## `GET /v1/roster`

Returns the tier-to-model table **this caller** is routed against, with
everything Milo knows about each entry. A caller who sent `milo/auto` handed
the model choice to Milo; this is how they find out what they handed it to.

Precedence, which is the same one the routed path applies (ADR-008):

1. the roster this key stored with `PUT /v1/roster` — `rosterSource: "user"`;
2. the roster this deployment was configured with — `rosterSource: "config"`;
3. the shipped default — `rosterSource: "default"`.

`source` (the provenance of the shipped numbers) and `rosterSource` (where the
table being described came from) are different fields; neither replaces the
other. A `"user"` view also carries `storedAt`, the ISO 8601 time of the last
`PUT`.

```json
{
  "version": "2026-09-17",
  "rosterSource": "default",
  "source": {
    "usage": "OpenRouter weekly usage ranking, programming category, week ending 2026-09-16 (committed snapshot)",
    "pricing": "OpenRouter /api/v1/models on 2026-09-17"
  },
  "topModels": 10,
  "bands": {
    "fast": { "maxOutputUsdPerM": 0.35 },
    "mid": { "maxOutputUsdPerM": 1.5 },
    "frontier": { "maxOutputUsdPerM": 5 }
  },
  "excludedAbove": 5,
  "smallOutputBelowTokens": 65536,
  "usingDefaults": true,
  "tiers": {
    "fast": [
      {
        "id": "deepseek/deepseek-v4-flash",
        "inputUsdPerM": 0.07,
        "outputUsdPerM": 0.14,
        "usageRank": 2,
        "weeklyTokens": 15400000000000,
        "contextLength": 1024000,
        "maxOutputTokens": 384000,
        "source": "default",
        "isTierDefault": true
      },
      { "...": "the rest of the tier, in preference order" }
    ],
    "mid": ["..."],
    "frontier": ["..."]
  },
  "policy": {
    "posture": {
      "low": "favors fast and never returns frontier, whatever the difficulty says",
      "balanced": "fast for easy work, mid by default, frontier once the difficulty mass clears the bar",
      "quality": "reaches frontier as soon as the work looks substantial"
    },
    "longOutput": "A request whose answer is expected to be long skips any model capping output below 65536 tokens, which is why those are listed last in their tier."
  },
  "overrides": {
    "perRequest": "Send `\"milo\": { \"candidates\": [\"<openrouter id>\", ...] }` with a chat completion.",
    "perDeployment": "Set `roster` in `milo.config.json` (see docs/config.md) and restart `milo serve`.",
    "perKey": "PUT /v1/roster with `{ \"models\": [...] }` to store your own list against your key; DELETE /v1/roster reverts."
  },
  "table": "| Tier | Model | In $/M | Out $/M | Max output |\n|---|---|---|---|---|\n| fast | `deepseek/deepseek-v4-flash` | ...",
  "note": "Defaults are the models people actually run on OpenRouter, ...",
  "premium": "Premium models (Fable, Opus, Astra, Sonnet) are one line away: ..."
}
```

Per entry: `source` is `"default"` for a model Milo ships, `"config"` for an id
this deployment's `milo.config.json` added, and `"user"` for one this caller
stored. A `"config"` or `"user"` entry read back here carries only its id —
Milo does not know what an id it does not ship costs without spending an
OpenRouter call, and this route spends none (`PUT` does, so its response does
carry the prices). `isTierDefault` marks the first entry of a tier, which is
what that tier resolves to unless `candidates` or the long-output rule excludes
it. `defaultTier` appears when a shipped model is listed under a tier other
than the one Milo ships it on. `usingDefaults` is `false` as soon as anything
differs from the shipped table. `table` is the same tiers rendered as a
Markdown table, for an agent that has to show a user their roster once.

Bearer-gated like every other `/v1` route, so it is not an unauthenticated
description of a deployment — and so one key cannot read another's roster. The
bare `GET /` carries a shorter version — the roster version and the ids per
tier — without a key, for discovery; that one is always the deployment's
table, never a stored one.

## `PUT /v1/roster`

Stores a roster against the caller's key, so every routed request from that
key picks from their own models (ADR-008). The body names models one of two
ways, exactly one of which may be present.

**A flat list**, tiered for you by output price:

```json
{ "models": ["deepseek/deepseek-v4-flash", "openai/gpt-5.6-luna", "anthropic/claude-opus-5"] }
```

Tiering uses the same bands as the default roster — fast at most $0.35/M, mid
at most $1.50/M, frontier at most $5/M — keeps your order inside a tier, and
sorts last anything that caps output below `smallOutputBelowTokens` or cannot
call a tool, so such a model is never a tier's default. The default roster's
`excludedAbove` ceiling is **not** applied: it exists to stop Milo choosing a
premium model on its own, and an id you typed is not Milo choosing. A model
priced above the top band lands on `frontier`.

**Explicit tiers**, placed by hand:

```json
{
  "tiers": {
    "fast": ["deepseek/deepseek-v4-flash"],
    "mid": ["openai/gpt-5.6-luna"],
    "frontier": ["anthropic/claude-opus-5"]
  }
}
```

A missing tier is stored empty; at least one model must be named overall. Ids
are stored in the order given, with no re-tiering.

Every id is checked against OpenRouter's `/v1/models` first, fetched with the
caller's own key and cached in-process for five minutes. An id that is not in
the catalogue rejects the whole request — a roster is stored whole or not at
all:

```
400 { "error": { "message": "OpenRouter has no model with this id: typo/model. Check GET /v1/models for the exact ids.", "type": "invalid_request_error", "code": "unknown_model" } }
```

A body naming neither `models` nor `tiers`, or both, or a list that is not an
array of non-empty strings:

```
400 { "error": { "message": "Send exactly one of `models` ... or `tiers` ...", "type": "invalid_request_error", "code": "invalid_roster" } }
```

If OpenRouter cannot be reached to check the ids, nothing is stored:

```
502 { "error": { "message": "Milo could not reach OpenRouter to check those model ids. Retry shortly.", "type": "api_error", "code": "upstream_unavailable" } }
```

On success the response is the same shape as `GET`, with `rosterSource:
"user"`, a `storedAt` timestamp, `table`, and — because this route has just
fetched the catalogue — each entry's prices, context length and output cap.

A second `PUT` replaces the stored roster; there is no merge.

**What is stored.** The row is keyed by a SHA-256 of the caller's normalized
bearer credential (the same hash the rate limiter buckets on) and holds only
that hash, the roster JSON, `source: "user"`, and created/updated timestamps.
The key itself is never written anywhere (ADR-003), and the store refuses a
write whose key is not a 64-character hex digest. `milo roster list` shows the
stored rosters by hash; `milo roster --key-hash <hash>` prints one.

## `DELETE /v1/roster`

Removes the caller's stored roster, putting that key back on the deployment's
roster (or the shipped default). Answers with `deleted` and the view that now
applies:

```
200 { "deleted": true, "rosterSource": "default", "tiers": { "...": "..." }, "...": "..." }
```

`deleted` is `false` when there was nothing stored; the request still succeeds.
One key's `DELETE` never touches another's row.

## `GET /v1/preferences`

Everything Milo remembers about how the calling key wants answers produced
(ADR-011), plus that key's capture and brief switches. Rows are scoped by the
same key-hash derivation as per-key rosters (ADR-008): the SHA-256 of the
bearer credential, or the account key's hash for a Milo key — one caller can
never see another's rows.

```
200 {
  "data": [
    {
      "id": "01J8Z3NDEKTSV4RRFFQ69G5FAV",
      "scope": "global",
      "field": "verbosity",
      "value": "concise",
      "confidence": 0.87,
      "version": 1,
      "provenance": "3f9a…c1",
      "createdAt": "2026-09-18T10:00:00.000Z",
      "updatedAt": "2026-09-18T12:00:00.000Z"
    }
  ],
  "settings": { "captureEnabled": true, "briefEnabled": true }
}
```

Every row is a label from a closed vocabulary, never text the user wrote:

- **scope** — `"global"`, or one task type (`edit`, `docs`, …) the
  preference is limited to. A task-scoped row beats the global row for that
  task type.
- **field** — routing-shaping: `posture_default`, `tier_floor`, `sampling`;
  output-shaping: `verbosity`, `format`, `evidence_style`, `testing_depth`.
- **value** — a member of that field's fixed vocabulary (e.g. `verbosity`:
  `concise` | `balanced` | `detailed`).
- **confidence** — 0..1. Stating the same preference again raises it (capped
  at 1); contradicting it replaces the value, bumps `version`, and resets it.
- **provenance** — the fingerprint hash of the conversation that taught the
  row. A digest, resolvable against the decision log, never content.

Output-shaping rows compile into the injected brief (see
`x-milo-brief-version` under `POST /v1/chat/completions`); routing-shaping
rows set the caller's default posture, tier floor and sampling before the
policy runs and never enter the prompt.

## `DELETE /v1/preferences/:id`

Removes one stored preference row.

```
200 { "deleted": true, "id": "01J8Z3NDEKTSV4RRFFQ69G5FAV" }
404 { "error": { "message": "No preference with that id.", "type": "not_found_error", "code": "preference_not_found" } }
```

A row that exists under a *different* key gets the same 404 as one that does
not exist at all, so the endpoint cannot be used to probe other callers'
ids. The whole set also dies with the key hash: rotate the key and Milo has
never heard of you.

## `GET /v1/memory`

Every personal fact Milo has stored for the calling key (ADR-017), **decrypted**,
plus that key's kill switch. Scoped by the same key-hash derivation as
preferences and rosters — one caller can never see another's facts. Unlike
preferences, a fact row carries the user's own words: the `text` is decrypted
here for the owner, and is ciphertext at rest.

```
200 {
  "data": [
    {
      "id": "01J8Z4P0EKTSV4RRFFQ69G5FBW",
      "category": "address",
      "text": "my staging box is 10.2.0.7",
      "provenance": "3f9a…c1",
      "createdAt": "2026-09-18T10:00:00.000Z",
      "updatedAt": "2026-09-18T10:00:00.000Z"
    }
  ],
  "settings": { "enabled": true }
}
```

- **category** — a closed-vocabulary label (`address`, `contact`, `identifier`,
  `credential-hint`, `convention`, `other`). The category is a label; the
  `text` is the content, and only the content is encrypted at rest.
- **text** — the fact, decrypted for the owner. Never appears in a log, a
  header, a decision row, or an error message.
- **provenance** — the fingerprint hash of the capturing turn. A digest, never
  content.

When the deployment has no encryption key (billing, and thus
`MILO_ENCRYPTION_KEY`, is not configured), fact memory is disabled: the
response is `{ "data": [], "settings": { "enabled": … }, "disabled": true }`.
A fact store with no envelope must not decrypt or keep anything.

## `DELETE /v1/memory/:id`

Removes one stored fact.

```
200 { "deleted": true, "id": "01J8Z4P0EKTSV4RRFFQ69G5FBW" }
404 { "error": { "message": "No fact with that id.", "type": "not_found_error", "code": "fact_not_found" } }
```

A fact under a *different* key gets the same 404 as a missing one, so the
endpoint cannot probe other callers' ids. The whole set dies with the key
hash.

## `PUT /v1/memory/settings`

The per-key kill switch (ADR-017). `enabled: false` turns fact capture and
injection off for everything from the calling key; the stored facts remain
listable and deletable so a user can still see and remove them.

```
PUT /v1/memory/settings
{ "enabled": false }

200 { "settings": { "enabled": false } }
400 { "error": { "message": "Body must be a JSON object with a boolean \"enabled\".", … } }
```

Turning capture or the brief off per key is a settings row
(`captureEnabled`, `briefEnabled` above); per request, send
`milo: { "brief": false }` to skip injection on that call.

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

What the three `/v1/decisions*` routes return depends on how you
authenticated (ADR-007):

- **with a Milo key**, only that account's decisions. Every routed request
  made with a Milo key stamps the account on its decision row; the list and
  the stats filter on it, and `/v1/decisions/:id` answers 404 for a row
  belonging to someone else — the same answer a row that does not exist
  gets, so the endpoint cannot be used to probe for other accounts.
- **with an OpenRouter key**, the whole deployment, exactly as before. The
  log is per deployment, not per key, so on a shared instance one BYOK user
  can read another's decisions. This is the known single-tenant gap called
  out in ADR-008; Milo keys are the path off it, and BYOK behaviour is
  deliberately unchanged.

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

## Credits and cost headers

Only a request authenticated with a Milo key is charged. Everything in this
section is absent from a BYOK response.

**Before the call.** If the account's balance is below the reserve
(`reserveMicroUsd`, $0.05 by default) the request is refused before Jev and
before OpenRouter — nothing upstream is called and nothing is charged:

```
402
x-milo-balance-usd: 0.000000
{ "error": { "message": "Milo credits exhausted. Add credits at https://<host>/account.", "type": "insufficient_quota", "code": "insufficient_credits" } }
```

On `/v1/messages` the same refusal arrives as
`{ "type": "error", "error": { "type": "billing_error", "message": "..." } }`.

**After the call.** The charge is

```
charged = round(upstream_cost * (1 + margin)) + decision_fee
```

in integer micro-USD, where `upstream_cost` is what OpenRouter reports for
the call (`usage.cost`, in USD) and `decision_fee` is charged only on a
routed (`milo/auto`) request, because only that one called Jev. An
explicit-model passthrough is charged too — the tokens were spent on Milo's
sub-key either way — but without the fee. The charge is posted to the ledger
(reference: the decision id, or `passthrough:<upstream id>`), recorded in
`/v1/account/usage`, and reported on the response:

```
x-milo-cost-usd: 0.002350      # what this request cost the account, USD
x-milo-balance-usd: 4.997650   # what is left, USD
```

**Streamed responses.** HTTP trailers are not available here, so a streamed
response cannot report its own cost in a header. Milo reads the usage off a
tee of the stream — the last chat chunk's `usage`, `response.completed` for
the Responses dialect, `message_start` plus `message_delta` for the Anthropic
one — without altering a byte, and posts the charge when the stream ends. The
two headers on a streamed response therefore say:

```
x-milo-cost-usd: pending
x-milo-balance-usd: 5.000000   # the balance BEFORE this request
```

The settled figures are in `GET /v1/account/usage` and `GET
/v1/account/ledger` a moment later.

**When Milo cannot price a call** — no `usage.cost` came back and the model
is not one the shipped roster has prices for, or a stream ended without ever
reporting usage — nothing is charged and a warning naming the decision id is
logged, so the gap can be reconciled against OpenRouter's own usage figures.
On the Anthropic dialect, where OpenRouter does not always include a cost,
the charge falls back to the roster's per-million token prices.

The generic `/v1/*` proxy is gated (a broke account gets the 402) but not
metered; the sub-key's own OpenRouter spend limit, kept equal to the
account's balance, is what bounds it.

## Account and billing routes

These need a Milo key. A BYOK caller gets `403 milo_key_required` with a
pointer at the account page, because there is no account behind an
OpenRouter key. They are absent entirely (404) on a deployment with no
billing configured.

| route | what it does |
| --- | --- |
| `GET /v1/account` | the account, `balanceUsd`, the account's keys (id, name, prefix, timestamps — never a hash or a secret), and the pricing config with the credit packs |
| `POST /v1/account/keys` | `{ "name": "laptop" }` mints a key; the response carries `secret` **once** and it is never retrievable again |
| `DELETE /v1/account/keys/:id` | revokes one of this account's keys; another account's id reads as 404 |
| `GET /v1/account/usage?since=<iso>` | `{ summary, records }` — the aggregate and the 50 most recent usage rows |
| `GET /v1/account/ledger?limit=` | every balance movement, newest first, each with `amountUsd` and `balanceAfterUsd` |
| `POST /v1/account/checkout` | `{ "packId": "pack_20" }` returns `{ url }` for Stripe Checkout; success and cancel URLs are derived from the request origin (`/account/success?session_id={CHECKOUT_SESSION_ID}` and `/account`) |
| `POST /v1/account/portal` | `{ url }` for Stripe's customer portal. 409 until the account has a Stripe customer, which the first checkout creates |

Two routes have no auth:

**`POST /billing/stripe/webhook`** is authenticated by Stripe's signature
over the raw body: `400 invalid_signature` when it does not verify, `200`
when the event is applied *or* deliberately ignored (a non-2xx would only
make Stripe retry an event nobody wants). A credited event posts the credit
and raises the account's OpenRouter sub-key limit to the new balance.

**`POST /v1/signup`** takes `{ "email": "you@example.com" }` and returns
`{ accountId, key }` with the key shown once; `409` if the email already has
an account. **This is MVP onboarding and deliberately thin**: there is no
email sign-in yet, so anyone who can reach the deployment can claim an
address they do not own. What stands in for verification until there is: a
hard limit of 5 signups an hour per client address (`429`), the 409 above so
an existing account can never be taken over, and a starting balance of zero,
so the worst a stranger can do is create an empty account. Replace it with
an email sign-in link before advertising it.

## Rate limiting

Jev spend is Milo's, not the user's, so only routed (`milo/auto`) requests
are rate limited — passthrough traffic and the generic proxy cost Milo
nothing and are never limited. The limiter is a token bucket keyed on the
caller's identity — the SHA-256 of the Milo key for a Milo key, the SHA-256
of the `Authorization` header value for a BYOK caller, never a raw key —
capacity and refill rate both defaulting to 120 per minute
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

Only the model field is rewritten, plus at most two *appended* system
messages, each off per request with one field. In full: `model` is rewritten
only on the routed path; a routed request may gain the preference brief (a
final system message, disclosed in `x-milo-brief-version`, skipped with
`milo: { "brief": false }`, ADR-011) and a relevance-gated personal-fact note
(another appended system message, disclosed in `x-milo-facts-injected`,
skipped with `milo: { "facts": false }`, ADR-017); every other field in a chat
completions body — `messages` as sent, `tools`, `stream`, `temperature`,
sampling params, anything else — is forwarded exactly as received. The `milo`
field is the one addition Milo's surface makes over OpenRouter's own API, and
it is always stripped before the request leaves Milo.

## Errors

Every Milo-originated error uses the OpenAI SDK's error shape so the
`openai` client's own error classes key off it correctly:

```json
{ "error": { "message": "...", "type": "authentication_error" | "invalid_request_error" | "not_found_error" | "rate_limit_error" | "insufficient_quota" | "api_error", "code": "..." } }
```

`/v1/messages` uses Anthropic's envelope instead, with `billing_error` for a
402 and `permission_error` for a 403.

No Milo error message ever interpolates a request header or an upstream
error's raw text (ADR-003) — the log line for an unhandled server error is
`{"level":"error","msg":"unhandled gateway error","error":"..."}`, and the
response body is a generic:

```
500 { "error": { "message": "Milo failed to handle this request.", "type": "api_error", "code": "internal_error" } }
```
