# CLI reference

The `milo` binary (`packages/cli/src/cli.ts`) dispatches to one subcommand.
Output below was copied from running the built CLI
(`node packages/cli/dist/cli.js ...`) after `pnpm build`.

## `milo` (no command) / `milo --help`

```
$ milo
Usage: milo <command> [options]

The Milo CLI: run the gateway locally and inspect its routing decisions.

Commands:
  serve       Start the Milo gateway server
  explain     Explain one routing decision
  decisions   List recent routing decisions
  stats       Summarize the decision log
  roster      Show the effective tier-to-model roster

Run "milo <command> --help" for command-specific options.
```

Exit code: **1** with no command; **0** for `--help`, `-h`, or `help`.

An unknown command prints the same usage block after an
`milo: unknown command "<name>"` line and exits **1**.

## `milo serve`

```
Usage: milo serve [options]

Start the Milo gateway server. Reads Milo's Jev key from the JEV_API_KEY
environment variable.

Options:
  --config <path>   Path to milo.config.json (default: ./milo.config.json if present)
  --port <n>        Port to listen on (overrides config)
  --db <url>        Decision log libsql URL (overrides config)
  -h, --help        Show this help
```

Env: **`JEV_API_KEY`** (required) — Milo's own Jev key. Jev is the only
decision backend; there is no fallback. Missing it prints
`milo serve: JEV_API_KEY is not set. Export JEV_API_KEY with Milo's Jev key
before running \`milo serve\`.` and exits **1**.

Startup output:

```
$ JEV_API_KEY=dummy milo serve --port 8799 --db "file:/tmp/milo-doctest/decisions.db"
milo: gateway listening on http://localhost:8799 (policy v2)
milo: set OPENAI_BASE_URL=http://localhost:8799/v1 and use model: "milo/auto"
```

`--port` and `--db` (a libsql URL, `:memory:` or `file:<path>`) override the
config file. A non-positive-integer `--port` exits **1** with a usage error.
On success `serve` returns `undefined` rather than an exit code — the open
HTTP server keeps the process alive until `SIGINT`/`SIGTERM`, at which point
it drains pending decision-log writes, closes the log, and exits.

## `milo roster`

```
Usage: milo roster [list] [options]

Print the effective tier-to-model roster, what each model costs, how popular
it is, and where the entry came from.

Subcommands:
  list               List the per-key rosters stored in the decision log

Options:
  --config <path>    Path to milo.config.json (default: ./milo.config.json if present)
  --key-hash <hash>  Print the roster stored for one key hash (SHA-256 hex)
  --db <url>         Decision log libsql URL (default: file:./.milo/decisions.db)
  -h, --help         Show this help
```

Sample output (no config file present, so it falls back to `DEFAULT_ROSTER`):

```
$ milo roster
Roster source: defaults
Default roster version: 2026-09-17
  usage: OpenRouter weekly usage ranking, programming category, week ending 2026-09-16 (committed snapshot)
  pricing: OpenRouter /api/v1/models on 2026-09-17

  TIER      MODEL                                 IN/M   OUT/M  USE  SOURCE
  fast      deepseek/deepseek-v4-flash           $0.07   $0.14   #2  default
            z-ai/glm-5.3-flash                   $0.09    $0.3   #4  default
            xiaomi/mimo-v2.5                     $0.14   $0.28   #6  default
            tencent/hy3                        $0.0825   $0.33   #7  default
  mid       openai/gpt-5.6-luna                   $0.2    $1.2   #1  default
            deepseek/deepseek-v4.1-flash         $0.15    $0.6   #5  default
  frontier  z-ai/glm-5.3                          $1.4    $4.4   #9  default
            google/gemini-3.8-flash              $0.75   $3.75  #10  default
            tencent/hy4-preview                 $0.834  $2.501   #3  default
            nvidia/nemotron-3-ultra-550b-a55b   $0.625  $3.125   #8  default

Defaults are the models people actually run on OpenRouter, ordered by weekly usage within price bands; nothing above $5 per million output tokens is chosen unless you list it in `candidates` or your roster config.
Premium models (Fable, Opus, Astra, Sonnet) are one line away: list their OpenRouter ids per request in `milo.candidates`, or per deployment under `roster` in `milo.config.json`.
```

Prices are USD per million tokens and `USE` is the model's rank in
OpenRouter's weekly usage ranking for the programming category
(`docs/config.md`, "Why these models"). `SOURCE` says where the entry came
from: `default` for a model Milo ships, `default (<tier>)` for one it ships on
a different tier than this config lists it under, and `config` for an id Milo
does not ship — those print `-` for price and rank, because `milo roster`
makes no network calls and will not guess.

`Roster source:` reads `config file (<path>)` when a `milo.config.json` with
a `roster` field was found, otherwise `defaults`. Exit code **0**.

### Per-key rosters

A user can store their own model list against their key with
`PUT /v1/roster` (ADR-008, `docs/api/gateway.md`). Those rosters live in the
decision log, keyed by a SHA-256 of the key — never the key itself — so the
CLI reads them by hash:

```
$ milo roster list
KEY HASH                                                          MODELS  SOURCE  UPDATED
9f2c...e41a                                                       6       user    2026-09-18T09:14:02.331Z
1b07...cc93                                                       3       user    2026-09-17T22:03:55.007Z

$ milo roster --key-hash 9f2c...e41a
Roster source: user (key hash 9f2c...e41a)
Stored: 2026-09-17T18:22:10.114Z
Updated: 2026-09-18T09:14:02.331Z

  TIER      MODEL                         IN/M  OUT/M  USE  SOURCE
  fast      deepseek/deepseek-v4-flash   $0.07  $0.14   #2  default
  mid       openai/gpt-5.6-luna           $0.2   $1.2   #1  default
  frontier  anthropic/claude-opus-5           -      -    -  user
```

`list` prints shapes, not contents: an operator can see that per-key rosters
are in use, and how many models each names, without reading anybody's list.
`--key-hash` takes only a 64-character hex digest and refuses anything else,
so a key cannot be passed here by accident; get the hash from `list`. An
unknown hash exits **1**. Both read `--db` (default
`file:./.milo/decisions.db`) rather than the config file's roster.

## `milo explain <decision-id>`

```
Usage: milo explain <decision-id> [options]

Print a plain-language explanation of one routing decision.

Options:
  --db <url>   Decision log libsql URL (default: file:./.milo/decisions.db)
  --json       Print the raw decision record as JSON
  -h, --help   Show this help
```

Missing the positional id: `milo explain: missing <decision-id>` on stderr,
followed by the help text, exit **1**. An id not found in the log: `milo
explain: no decision found with id "<id>"` on stderr, exit **1**.

Sample output (a decision that forced a tier and skipped Jev, so it has no signals):

```
$ milo explain 01M2R1Q051K81ZJJM304BDAH04 --db "file:/tmp/milo-doctest/decisions.db"
Decision 01M2R1Q051K81ZJJM304BDAH04
  Chosen model: anthropic/claude-sonnet-5 (tier: mid)
  Reason: forced to the mid tier by the request
  Signals: unavailable (no Jev call recorded)
  Sticky: no
  Upstream: not recorded
  Policy version: v2
  Created: 2026-09-17T16:03:07.554Z
```

A decision with signals instead prints a `Signals:` block with task type,
difficulty and its confidence, the per-level difficulty distribution as a bar
chart, `needs_reasoning`, `long_output`, the Jev request id and model, and
Jev's latency:

```
  Task type: debug
  Difficulty: 2.40 (confidence 81%)
  Difficulty levels:
    0 trivial     [                        ] 1%
    1 routine     [==                      ] 9%
    2 substantial [=========               ] 39%
    3 hard        [============            ] 51%
  Needs reasoning: 94%
```

Policy v2 decides on those masses (`docs/routing.md`), so the bars are what
back up the `Reason:` line. `--json` prints the raw `DecisionRecord` instead
of this formatted text. Exit code **0** on success.

## `milo decisions`

```
Usage: milo decisions [options]

List recent routing decisions as a compact table.

Options:
  --limit <n>   Max rows to print (default: 20)
  --db <url>    Decision log libsql URL (default: file:./.milo/decisions.db)
  -h, --help    Show this help
```

Sample output:

```
$ milo decisions --db "file:/tmp/milo-doctest/decisions.db"
ID                          TIME                      TIER  MODEL                      TASK  DIFF  FLAGS
01M2R1Q051K81ZJJM304BDAH04  2026-09-17T16:03:07.554Z  mid   anthropic/claude-sonnet-5  -     -     -
```

`TASK` and `DIFF` read `-` for a decision with no signals recorded (a forced
tier). `FLAGS` shows `sticky`, or `-` when the decision was not served from
the fingerprint cache. An empty log prints `(no decisions logged)`. A
non-positive-integer `--limit` exits **1** with a usage error. Exit code **0**
otherwise.

## `milo stats`

```
Usage: milo stats [options]

Print a summary of the decision log.

Options:
  --since <iso>   Only include decisions at or after this ISO 8601 timestamp
  --db <url>      Decision log libsql URL (default: file:./.milo/decisions.db)
  -h, --help      Show this help
```

Sample output:

```
$ milo stats --db "file:/tmp/milo-doctest/decisions.db"
Total decisions: 1
By tier:
  mid: 1
By model:
  anthropic/claude-sonnet-5: 1
Sticky: 0
Average Jev latency: n/a
```

`Average Jev latency` reads `n/a` when no in-scope decision carries Jev
signals (as above, where the only decision had no signals recorded). An
invalid `--since` value exits **1** with `milo stats: --since is not a valid
ISO 8601 timestamp: "<value>"`. Exit code **0** otherwise.

## Exit codes, summarized

| Code | Meaning |
|---|---|
| 0 | Success, or `--help` |
| 1 | No command, unknown command, bad flag, missing `JEV_API_KEY`, missing/invalid config, not-found decision, invalid `--limit`/`--port`/`--since` |
| *(none)* | `serve` on a successful start — the process keeps running |

There is no `milo eval` subcommand. The eval runner is a separate package
entry point invoked as `pnpm eval` (see `docs/evals.md`).
