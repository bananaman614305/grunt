# Config reference

`milo serve` reads `milo.config.json` from the current directory by default,
or from `--config <path>`. Every field is optional; a missing file (when no
path was given explicitly) means every default applies. An explicit
`--config` path that cannot be read, or a file that fails schema validation,
is an error — `milo serve` (and `milo roster`) refuse to start rather than
silently ignore it. The schema is defined with Zod in
`packages/cli/src/config.ts` and rejects unknown top-level fields (`.strict()`).

A starting point is checked in at the repo root as `milo.config.example.json`:

```json
{
  "port": 8787,
  "hostname": "127.0.0.1",
  "roster": {
    "fast": ["deepseek/deepseek-v4-flash", "z-ai/glm-5.3-flash"],
    "mid": ["openai/gpt-5.6-luna", "deepseek/deepseek-v4.1-flash"],
    "frontier": ["anthropic/claude-opus-5", "z-ai/glm-5.3"]
  },
  "rateLimit": {
    "routedPerMinute": 120
  },
  "decisionLog": "file:./.milo/decisions.db",
  "referer": "https://your-app.example.com",
  "title": "Your App Name"
}
```

## Fields

| Field | Type | Default | Effect |
|---|---|---|---|
| `port` | positive integer | `8787` | Port the gateway listens on. Overridable per-run with `milo serve --port <n>`. |
| `hostname` | non-empty string | *(unset — the server binds its own default)* | Hostname to bind. `milo serve`'s startup message shows `localhost` when unset. |
| `roster` | object, see below | `DEFAULT_ROSTER` (see below) | Maps each tier to an ordered list of OpenRouter model ids. The first entry in a tier's list is that tier's default model. |
| `rateLimit.routedPerMinute` | positive integer | `120` | Token-bucket capacity and refill rate for routed (`milo/auto`) requests, keyed per hashed OpenRouter key (`docs/api/gateway.md` "Rate limiting"). |
| `decisionLog` | non-empty string | `"file:./.milo/decisions.db"` | libsql URL for the decision log: `":memory:"` or `"file:<path>"`. Overridable per-run with `milo serve --db <url>`. |
| `referer` | non-empty string | *(unset)* | Sent to OpenRouter as `HTTP-Referer` for their app-attribution / leaderboard tracking. |
| `title` | non-empty string | *(unset)* | Sent to OpenRouter as `X-Title`, same purpose. |

### `roster`

```ts
type Roster = { fast: string[]; mid: string[]; frontier: string[] };
```

Each tier's array must have at least one model id. All three tiers
(`fast`, `mid`, `frontier`) are required if `roster` is present at all —
there is no partial override of just one tier. The default, used whenever
`roster` is absent from config:

```json
{
  "fast": [
    "deepseek/deepseek-v4-flash",
    "z-ai/glm-5.3-flash",
    "xiaomi/mimo-v2.5",
    "tencent/hy3"
  ],
  "mid": ["openai/gpt-5.6-luna", "deepseek/deepseek-v4.1-flash"],
  "frontier": [
    "z-ai/glm-5.3",
    "google/gemini-3.8-flash",
    "tencent/hy4-preview",
    "nvidia/nemotron-3-ultra-550b-a55b"
  ]
}
```

To override a tier, list your own model ids under it in `milo.config.json`
and restart `milo serve`; `milo roster` prints the effective table and
whether it came from a config file or from defaults. A per-request `milo.
candidates` field further restricts the roster's search to a subset of ids
for that one request (README, "Per-request options").

#### Why these models

Milo is built for a frontier agent you already pay for on a subscription
(Opus, Fable, Sol) to plan the work and hand the implementation sub-tasks to
Milo, which routes each one to something cheap and popular. So the default
roster is the ten models that carry the most tokens in OpenRouter's
programming category, tiered by output price, collected 2026-09-17 from
OpenRouter's weekly ranking (week ending 2026-09-16) and its public model
catalogue:

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

The rule: the ten most-used models after folding dated builds into their
current id and dropping `:free`, `:batch` and the other data-sharing plan
variants, anything that cannot call a tool, and anything at or above **$5 per
million output tokens**; tiered by output price (fast at most $0.35/M, mid at
most $1.50/M, frontier at most $5/M); ordered by usage within a tier, with a
model whose max output is below 65,536 tokens last, because the router skips
it whenever a long answer is expected (`tencent/hy4-preview` at 64,000 and
`nvidia/nemotron-3-ultra-550b-a55b` at 32,768 are the two today).

Defaults are the models people actually run on OpenRouter, ordered by weekly
usage within price bands; nothing above $5 per million output tokens is chosen
unless you list it in `candidates` or your roster config. Premium models
(Fable, Opus, Astra, Sonnet) are never chosen by default, and are one config
line away when you want them — for example, Opus on the frontier tier with the
rest of the defaults left alone:

```json
{
  "roster": {
    "fast": ["deepseek/deepseek-v4-flash", "z-ai/glm-5.3-flash"],
    "mid": ["openai/gpt-5.6-luna", "deepseek/deepseek-v4.1-flash"],
    "frontier": ["anthropic/claude-opus-5", "z-ai/glm-5.3"]
  }
}
```

The table is data, not prose: it lives in
`packages/core/src/router/roster-default.json` with its provenance, is
generated by `packages/evals/scripts/roster-refresh.ts`, and is regenerated
from OpenRouter's rankings **every week** by
`.github/workflows/roster-refresh.yml`, which opens a pull request when the
list moves. `GET /v1/roster` serves the running table with the same numbers.

`decisionLog`'s parent directory is created automatically by `milo serve`,
whether the `file:` path is relative (resolved under the current directory)
or absolute (e.g. `file:/data/decisions.db`, for a mounted volume in the
container image — `docs/deploy.md`). `:memory:` is left alone.

`port` and `decisionLog` can also be set from the environment as `PORT` and
`MILO_DB`, for the container image, which ships no config file. Precedence
is `--port`/`--db` beats `PORT`/`MILO_DB` beats `milo.config.json` beats the
built-in default.

## `JEV_API_KEY` (environment variable, not config)

Milo's own Jev key, read only from the `JEV_API_KEY` environment variable —
there is no config-file field for it, and it must never be committed to
`milo.config.json`, a fixture, or a log. `milo serve` refuses to start
without it. Jev is the only decision backend (ADR-005): there is no
fallback tier or alternate backend to route through if the key is missing
or exhausted, so a routed request that cannot reach Jev gets a 503 rather
than a silently degraded model choice. In production this is delivered as a
revocable Squire egress grant; locally, export it yourself (in development,
fetch it through the Squire `use_credential` tool rather than pasting it
into a shell history). It is passed straight through to
`GatewayOptions.jevApiKey` and never appears in a response, an error
message, or the decision log (ADR-003).
