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
Usage: milo roster [options]

Print the effective tier-to-model roster and where it came from.

Options:
  --config <path>   Path to milo.config.json (default: ./milo.config.json if present)
  -h, --help         Show this help
```

Sample output (no config file present, so it falls back to `DEFAULT_ROSTER`):

```
$ milo roster
Roster source: defaults
  fast      anthropic/claude-haiku-4.5, google/gemini-2.5-flash
  mid       anthropic/claude-sonnet-5
  frontier  anthropic/claude-opus-5
```

`Roster source:` reads `config file (<path>)` when a `milo.config.json` with
a `roster` field was found, otherwise `defaults`. Exit code **0**.

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
