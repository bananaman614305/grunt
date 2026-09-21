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
  cost        Show routed-request spend from the decision log
  roster      Show the effective tier-to-model roster
  canary      Run the continuous eval canary and check for drift
  billing     Operate the billing database, Stripe, and provisioning
  verify      Install the ground-truth verification Stop hook into a harness

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

## `milo canary`

The continuous eval canary (`docs/PLAN.md`, `docs/evals.md`'s "The
continuous canary" section): runs a small labeled subset of the routing eval
set through the router, records a snapshot (pass rate, cost, latency,
tier/model mix), and compares it to a baseline. There is no scheduler here
-- point cron or a CI step at this command.

```
Usage: milo canary [options]

Options:
  --mode <fixtures|record|live>     Jev source (default: fixtures)
  --live                            Shorthand for --mode live
  --size <n>                        Subset size (default: 24)
  --posture <low|balanced|quality>  Cost posture (default: balanced)
  --history <path>                  Snapshot history file (default: ./.milo/canary-history.json)
  --baseline <rolling|path>         "rolling" (default), or a path to a pinned baseline snapshot
  --baseline-window <n>             Rolling baseline window, in prior runs (default: 5)
  --save-baseline <path>            After this run, save its snapshot as a pinned baseline at <path>
  --max-pass-drop <pts>             Drift threshold: pass-rate drop, in points (default: 10)
  --max-cost-increase <pct>         Drift threshold: mean-cost increase, in percent (default: 25)
  --max-latency-increase <pct>      Drift threshold: p95-latency increase, in percent (default: 50)
  --max-tier-shift <pts>            Drift threshold: any tier's share moving, in points (default: 20)
  --skip-save                       Do not append this run to the history file
  --json <path>                     Also write the snapshot and drift result as JSON
  -h, --help                        Show this help
```

Sample output, first run (no history yet, so nothing to compare against; a
tiny `--size 8` subset for a short doc example -- the default of 24 spreads
tier agreement over more examples and is less noisy):

```
$ milo canary --size 8 --history /tmp/milo-doctest/canary-history.json
Milo canary -- 2026-09-21T01:55:55.139Z
Mode: fixtures  Posture: balanced  Policy: v4  Subset: 8 requested, 8 run (8 scored, 0 unscored)

Snapshot
  Pass rate     62.5% (8 scored)
  Mean cost     $0.000628 (n=8 priced, estimated)
  Latency       p50 2 ms, p95 13 ms
  Tiers         fast 3, mid 5, frontier 0
  Models        openai/gpt-5.6-luna 5, deepseek/deepseek-v4-flash 3

Baseline: none yet -- this is the first recorded run, so nothing to drift against.

Result: PASS (no baseline)
```

A later run against the rolling baseline the first run wrote, with a metric
that regressed past its threshold:

```
Result: DRIFT DETECTED
  - Pass rate moved -12.5 pp (threshold 10)
  - Mean cost moved +38.1% (threshold 25)
```

"Cost" is a proxy, not a real spend: the canary only exercises the routing
decision (it never calls OpenRouter), so it prices the chosen model's known
roster rate against a fixed nominal token profile
(`CANARY_NOMINAL_INPUT_TOKENS`/`CANARY_NOMINAL_OUTPUT_TOKENS`,
`packages/evals/src/canary/snapshot.ts`). It still moves for the reasons a
real cost would -- a tier-mix shift, a roster price change -- without
spending anything.

Exit codes: **0** pass (drift-free, or no baseline yet), **1** a usage or
setup error (bad flag, missing `JEV_API_KEY` under `--live`/`--mode
record`, a pinned `--baseline` path that does not exist or does not parse),
**2** drift detected. `--history` and `--baseline`/`--save-baseline` files
are plain JSON with no message content, same rule as the decision log.

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

## `milo billing`

Operator access to the billing database (ADR-007) and the Stripe/OpenRouter
provisioning it depends on -- support and back-office work the account pages
(`docs/billing.md`) don't expose. Every subcommand takes `--db <url>`,
falling back to `MILO_DATABASE_URL`, and opens/closes its own connection.

```
$ milo billing --help
Usage: milo billing <subcommand> [options]

Operate the billing database and its Stripe / OpenRouter provisioning.

Subcommands:
  accounts                    List accounts, newest first
  grant <accountId> <usd>     Grant (or claw back) credit by hand
  keys <accountId>            List an account's Milo keys
  revoke-key <keyId>          Revoke one Milo key
  usage <accountId>           Summarize an account's usage
  ledger <accountId>          List an account's ledger entries
  stripe-setup                Ensure Stripe products, prices, and the webhook exist
  reconcile                   True up OpenRouter usage against the ledger

Run "milo billing <subcommand> --help" for subcommand-specific options.
Every subcommand takes --db <url> (default: $MILO_DATABASE_URL).
```

No subcommand: prints this help to stderr and exits **1**. An unknown
subcommand prints `milo billing: unknown subcommand "<name>"` plus the same
help and exits **1**. `--help`/`-h`/`help` prints it to stdout and exits **0**.
Missing `--db` with `MILO_DATABASE_URL` also unset: `milo billing <subcommand>:
--db or MILO_DATABASE_URL is required`, exit **1**.

### `milo billing accounts`

```
$ milo billing accounts --db "$MILO_DATABASE_URL"
ID                          EMAIL            STATUS  BALANCE  CREATED
01M2RKMCVGGH8NEZV8AQM49MHW  ada@example.com  active  $0.0000  2026-09-17T21:16:16.624Z
```

`--limit <n>` caps the rows (default 50); a non-positive value exits **1**.
No accounts prints `(no accounts)`. Exit **0** otherwise.

### `milo billing grant <accountId> <usd>`

Puts credit on an account by hand -- a goodwill grant, a support refund, a
migration from an old balance -- through the same ledger every other balance
change uses (ADR-007). `<usd>` may be negative to claw credit back; `--note`
is required and becomes the ledger entry's reference.

```
$ milo billing grant 01M2RKMCVGGH8NEZV8AQM49MHW 20 --note "initial credit" --db "$MILO_DATABASE_URL"
Granted $20.0000 to 01M2RKMCVGGH8NEZV8AQM49MHW. New balance: $20.0000. Ledger entry 01M2RKMPVRKBTYWZVK8MX8WT8N.
```

Missing `<accountId>`/`<usd>`, a zero or non-numeric `<usd>`, or a missing
`--note` all exit **1** with a usage error. An unknown account id exits **1**
with the store's own error. Exit **0** otherwise.

### `milo billing keys <accountId>`

```
$ milo billing keys 01M2RKMCVGGH8NEZV8AQM49MHW --db "$MILO_DATABASE_URL"
ID                          NAME    PREFIX    STATUS  CREATED                   LAST USED
01M2RKMCVJ2HFSHHN0GGSQ8345  laptop  UJ9iTmPR  active  2026-09-17T21:16:16.627Z  never
```

Newest first; revoked keys are included, marked `revoked` in `STATUS`. No
keys prints `(no keys)`. Exit **0**.

### `milo billing revoke-key <keyId>`

```
$ milo billing revoke-key 01M2RKMCVJ2HFSHHN0GGSQ8345 --db "$MILO_DATABASE_URL"
Revoked key 01M2RKMCVJ2HFSHHN0GGSQ8345.
```

A no-op (still exit **0**) if the key is already revoked or does not exist --
`revokeApiKey` on the billing store is intentionally silent either way.

### `milo billing usage <accountId>`

```
$ milo billing usage 01M2RKMCVGGH8NEZV8AQM49MHW --db "$MILO_DATABASE_URL"
Requests: 1
Charged: $0.2875
Upstream cost: $0.2500
By model:
  openai/gpt-5.6-luna: 1
```

`--since <iso>` filters to usage at or after that timestamp; an invalid one
exits **1** with `milo billing usage: --since is not a valid ISO 8601
timestamp: "<value>"`. Exit **0** otherwise.

### `milo billing ledger <accountId>`

```
$ milo billing ledger 01M2RKMCVGGH8NEZV8AQM49MHW --db "$MILO_DATABASE_URL"
ID                          KIND        AMOUNT    BALANCE AFTER  REFERENCE       CREATED
01M2RKMPVRKBTYWZVK8MX8WT8N  adjustment  $20.0000  $20.0000       initial credit  2026-09-17T21:16:26.857Z
```

Newest first; `--limit <n>` caps the rows (default 50). No entries prints
`(no ledger entries)`. Exit **0**.

### `milo billing stripe-setup --webhook-url <url>`

Ensures the "Milo credits" Stripe product and one price per credit pack
exist, and that a webhook endpoint is registered at `--webhook-url`. Safe to
run again: everything is looked up by name, lookup key, or url first. The
signing secret prints only the first time the endpoint is created:

```
$ STRIPE_SECRET_KEY=sk_... milo billing stripe-setup --webhook-url https://milo-gateway.fly.dev/<webhook-route>
Product: prod_...
  pack_5: price_...
  pack_20: price_...
  pack_100: price_...
Webhook endpoint: we_... (https://milo-gateway.fly.dev/<webhook-route>)
Signing secret (shown once): whsec_...
Store this as STRIPE_WEBHOOK_SECRET now -- Stripe will not show it again.
```

Running it again against the same `--webhook-url` finds the existing
endpoint and prints "Webhook endpoint already existed; its signing secret is
unchanged." instead. Missing `--webhook-url`, or a missing/invalid
`STRIPE_SECRET_KEY`, exits **1**.

### `milo billing reconcile`

True up OpenRouter's reported spend on each account's sub-key against what
Milo charged, posting a ledger `adjustment` for any gap (ADR-007; the case a
stream cut before its usage chunk arrived). Idempotent: running it again
immediately posts nothing new. Requires `OPENROUTER_PROVISIONING_KEY`.

```
$ OPENROUTER_PROVISIONING_KEY=... milo billing reconcile --db "$MILO_DATABASE_URL"
01M2RKMCVGGH8NEZV8AQM49MHW  discrepancy $0.0000  ok
Accounts checked: 1. Total posted: $0.0000
```

`--limit <n>` caps how many accounts one run considers (default 500). A
missing/invalid `OPENROUTER_PROVISIONING_KEY` exits **1** before touching the
database.

## Exit codes, summarized

| Code | Meaning |
|---|---|
| 0 | Success, or `--help` |
| 1 | No command, unknown command, bad flag, missing `JEV_API_KEY`, missing/invalid config, not-found decision, invalid `--limit`/`--port`/`--since`, missing `--db`/`MILO_DATABASE_URL`, a `milo billing` usage error, a `milo canary` usage/setup error |
| 2 | `milo canary` only: drift detected against the baseline |
| *(none)* | `serve` on a successful start — the process keeps running |

There is no `milo eval` subcommand. The eval runner is a separate package
entry point invoked as `pnpm eval` (see `docs/evals.md`).
