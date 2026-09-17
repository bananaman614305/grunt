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
    "fast": ["anthropic/claude-haiku-4.5", "google/gemini-2.5-flash"],
    "mid": ["anthropic/claude-sonnet-5"],
    "frontier": ["anthropic/claude-opus-5"]
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
  "fast": ["anthropic/claude-haiku-4.5", "google/gemini-2.5-flash"],
  "mid": ["anthropic/claude-sonnet-5"],
  "frontier": ["anthropic/claude-opus-5"]
}
```

To override a tier, list your own model ids under it in `milo.config.json`
and restart `milo serve`; `milo roster` prints the effective table and
whether it came from a config file or from defaults. A per-request `milo.
candidates` field further restricts the roster's search to a subset of ids
for that one request (README, "Per-request options").

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
