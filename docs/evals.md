# Routing evals

`pnpm eval` (`packages/evals/src/cli.ts`) replays the 120-prompt labeled set
at `packages/evals/data/routing.jsonl` through a fresh `Router` per example
and reports how often the policy's tier choice agrees with the label. See
`packages/evals/data/README.md` for the labeling rules and
`docs/routing.md` for how the policy works.

## Running it

```
pnpm eval                                    # fixtures mode, balanced posture
pnpm eval -- --mode record                   # needs JEV_API_KEY
pnpm eval -- --mode live                     # needs JEV_API_KEY
pnpm eval -- --posture low --limit 20 --out ./tmp/report.md --json ./tmp/report.json
```

(`pnpm eval` forwards arguments after `--` to `packages/evals/src/cli.ts`,
which runs via `tsx`.)

### Modes (`--mode`)

| Mode | Behavior | Needs `JEV_API_KEY` |
|---|---|---|
| `fixtures` (default) | Replays recorded fixtures under `packages/evals/fixtures/jev`. Never touches the network. A prompt with no matching fixture makes that example `unscored` rather than aborting the run. | No |
| `record` | Replays a fixture when one exists for a prompt; otherwise calls the real Jev API and records the exchange as a new fixture, growing the fixture set. | Yes |
| `live` | Always calls the real Jev API, ignoring any recorded fixtures. | Yes |

`record` and `live` read `JEV_API_KEY` straight from the environment and
never log, return, or embed it in an error message; in development, fetch
it through the Squire `use_credential` tool rather than exporting it
directly (same rule as `milo serve`, ADR-003).

A Jev fixture is looked up by a hash of the *whole* request, base URL
included, so replaying the committed Jev fixtures in `--mode fixtures` needs
`MILO_DECISION_BACKEND=jev` and `JEV_BASE_URL` set to the exact URL the
recording session used — a Squire egress grant, not `https://api.typesafe.ai`
— or every lookup misses and the run comes back all-unscored. `.github/workflows/ci.yml`
shows the value the committed fixtures were recorded against. This never
touches the network in `fixtures` mode; the base URL is only part of the
lookup key. `JEV_MODEL` matters the same way for the model field in the
request body — Jev fixtures are recorded on `jev-latest` only, which is also
`JevClient`'s default, so `record`/`live` runs need no override to stay
consistent with the committed set.

### Other flags

| Flag | Default | Effect |
|---|---|---|
| `--posture <low\|balanced\|quality>` | `balanced` | Cost posture to route every example under. The dataset's `expected_tier_balanced` label assumes `balanced`, so other postures are for exploration, not for checking the gate. |
| `--limit <n>` | all 120 | Only run the first `n` examples. |
| `--out <path>` | `packages/evals/reports/latest.md` | Where the markdown report is written (also printed to stdout). |
| `--json <path>` | *(not written)* | Also write the full `EvalReport` as JSON to this path. |
| `--gate <0..1>` | `0.85` | Minimum overall tier agreement before the run exits 2. CI passes `0.80` (see below). |

## What the report contains

`formatMarkdown` (`packages/evals/src/report.ts`) produces, in order:

- **Header** — posture, policy version, generation timestamp, total/scored/unscored counts.
- **Unscored** — a table of how many examples failed to score, grouped by cause (`timeout`, `network`, `http`, `validation`, or another classified error). Every example scored prints "Every example was scored."; every example failing prints guidance to run `--mode record` first.
- **Tier agreement** — overall agreement rate (`predictedTier === expectedTier`) among scored examples, then broken down by task type and by difficulty band.
- **Task-type accuracy** — how often Jev's classified `task_type` matched the dataset's label (informational; not gated on).
- **Tier confusion matrix** — a 3×3 table, rows are the expected tier, columns the predicted tier.
- **Jev latency** — mean and p95 latency in ms across scored examples.
- **Disagreements** — one bullet per scored example where the predicted tier did not match the label: expected vs. predicted tier, `difficulty`/`needs_reasoning` values, the router's one-sentence reason, and the label's `notes`.
- **Policy ceiling note** — the share of difficulty-band-2 examples labeled `mid` in the dataset. Policy v1 sent every `difficulty >= 2.0` under balanced posture straight to `frontier` and so could not tell those apart; policy v2 reads the per-level probability masses instead, and the band-2 row above measures how much of that ceiling it lifts (see `docs/routing.md`'s "Resolved divergence" section).

Each scored example in the JSON dump also carries `difficultyLevels`, the
backend's probability mass on levels 0..3. That is the column the profile's
thresholds are fitted on, which is what makes the cross-validation test
possible.

## The agreement gate

`pnpm eval` exits **0** when every example was unscored (a legitimate
outcome with no fixtures recorded yet — nothing to gate on) or when at
least one example was scored and overall tier agreement is at or above the
gate. It exits **2** when at least one example was scored and agreement falls
below it, printing what it measured, so CI can fail a policy change that
regresses agreement.

The gate defaults to **0.85** (`MIN_TIER_AGREEMENT` in
`packages/evals/src/cli.ts`) and `--gate` overrides it.

| backend | CI expects | why |
|---|---|---|
| `jev` (`jev-latest`) | **0.80** | Validated (ADR-002 revision 3) on the committed `jev-latest` fixtures: 81.7% overall (bands 96.3 / 60.0 / 84.8 / 92.0), 90.8% task-type accuracy, two-fold cross-validation mean 78.3% (folds 83.3% and 73.3%; the fast/mid boundary is the noisy one). CI holds it to 0.80; 0.85 stays the target. |

CI runs the fixture replay at `--gate 0.80` with no extra environment: fixtures are keyed by the request's API path and body, not the recording address, so replay never touches the network

## Refreshing the default roster

The same package holds the job that regenerates Milo's default roster, since
it is the one that already talks to OpenRouter:

```
pnpm --filter @milo/evals run roster:refresh            # dry run, prints the diff
pnpm --filter @milo/evals run roster:refresh -- --write # rewrites roster-default.json
```

It reads prices and capabilities from `https://openrouter.ai/api/v1/models`
and popularity from OpenRouter's rankings page for the programming category
(there is no public usage API, so the ranking is scraped out of the page; when
the page's shape changes and nothing parses, the script falls back to the
committed snapshot in `packages/evals/scripts/popular.json` and says so). The
selection rule is `packages/evals/src/roster-select.ts`, unit-tested against a
recorded catalogue fixture — no test in this package touches the network.

`.github/workflows/roster-refresh.yml` runs it every Monday at 09:00 UTC and
opens a pull request when the roster moves. See `docs/adr/006-default-roster.md`
for the rule and `docs/config.md` for the shipped table.

## Changing the policy

Changing a threshold in `packages/core/src/router/policy.ts` requires bumping
`POLICY_VERSION` and re-running the eval to confirm the gate still passes. The
two-fold cross-validation in `packages/evals/src/run.test.ts` refits the
thresholds on half the recorded examples and scores them on the other half,
asserting a mean held-out agreement of at least **0.78** — so a later tuning
cannot buy in-sample agreement by overfitting this dataset.

## Benchmark (`pnpm bench`)

`pnpm eval` measures whether the router picks the tier a labeler would. It
says nothing about whether the routed model then gets the task right, how
long the trip took, or what it cost. `pnpm bench`
(`packages/evals/src/bench/cli.ts`) measures those three things, live,
against a running gateway.

For every example in `routing.jsonl` it makes one streamed chat completion
per **arm**, in a per-example shuffled order so no arm always goes first:

| arm | what it calls | why |
|---|---|---|
| `milo` | `milo/auto` through the gateway (`--gateway`), at one posture per run (`--posture`) | the thing being benchmarked |
| `fast`, `mid`, `frontier` | that tier's default roster model, directly on OpenRouter (`--openrouter`) | the fixed-model alternatives, and the twins the routed call is timed against |
| `oracle` | no extra calls: the fixed arm of each example's labeled tier | the ceiling perfect routing could reach |

Every successful answer is graded. `packages/evals/data/graders.jsonl` holds
one grader per example id: a **mechanical** one (`regex`, `contains_all`,
`contains_any`, `not_contains`, or an `all` of those) where a correct answer
has an unambiguous token, else a **judge** rubric with a `must` list that a
grading model (`--judge-model`, default `openai/gpt-5.6-luna`) scores 0..1;
a score at or above 0.7 passes. Judge cost is reported apart from the arms.
`--no-judge` skips it, leaving judged examples ungraded.

The judge is a cheap model by default, and audited so it can be trusted or
caught drifting: `--judge-audit <fraction>` (default `0.1`) has that fraction
of judged answers *also* graded by `anthropic/claude-sonnet-5`. The pick is
deterministic per (example id, arm) — a hash of the slot falls below the
fraction or it does not — so reruns audit the same answers, and raising the
fraction only adds slots. The report's **Judge audit** line gives the two
judges' agreement on the audited subset, the pass-rate delta (primary minus
audit; positive means the cheap judge is more lenient), and both judges'
costs. `--judge-audit 0` disables the audit, as does pointing
`--judge-model` at the audit model itself.

Judge verdicts are **cached** under `packages/evals/.judge-cache/`
(gitignored), one JSON file per verdict, keyed by a sha256 of the example
id, the grader's content, the judge model, and the answer text. A rerun over
unchanged answers makes no judge calls at all; the header's judge-cost line
counts fresh calls only and prints the hit/miss counts. Changing the answer,
the rubric, or the judge model changes the key and misses; a failed judge
call (timeout or non-200) is never cached, so it is retried next run.
Mechanical grades are free and never cached. `--no-judge-cache` bypasses the
cache entirely, neither reading nor writing it.

The header also prints one **Spend** line: the run's total upstream cost,
split into arms (the routed and fixed calls), samples (best-of-N draws, when
drawn), and judge (fresh judge and audit calls) — the price of the run
without reconstructing it from columns.

### The three numbers

- **Speed.** Time to first token and total time, p50 and p95, per arm. For
  the routed arm the report also gives the **routing overhead**: routed TTFB
  minus the fixed arm's TTFB on the same model, per example, so the cost of
  the Jev hop is separated from the model's own speed. Jev's own latency
  comes from each decision record (`GET /v1/decisions/:id`).
- **Accuracy.** Pass rate per arm; **quality retained**, the routed pass rate
  over the frontier arm's on the examples both graded; **bad downgrades**
  (routed cheaper than frontier, failed, frontier passed) and **missed
  savings** (routed to frontier, fast passed); and tier agreement with the
  label, the same number `pnpm eval` gates on, now measured live.
- **Cost.** Real cost from OpenRouter's `usage.cost` on every response
  (falling back to tokens times catalogue price), against an **estimated
  baseline**: what the same prompt and completion tokens would cost on
  `anthropic/claude-fable-5.1` at its OpenRouter rate card. The baseline is
  never called. Prompt tokens are identical across models, so that half is
  exact; completion tokens are the assumption, and the report prints savings
  at the observed count and at twice it (`2x`). Reasoning tokens are reported
  separately because they are where cheap reasoning models spend.

### Running it

```
export OPENROUTER_API_KEY=sk-or-...          # sent as the bearer to the gateway and OpenRouter, nowhere else
pnpm bench                                   # local gateway, balanced posture, all arms, judge on
pnpm bench -- --gateway https://milo-gateway.fly.dev/v1 --limit 20 --no-judge
pnpm bench -- --posture low --ids r-013,r-049 --json ./tmp/bench.json
pnpm bench -- --openrouter https://<squire-egress-proxy>/api/v1   # a key-injecting proxy in front of OpenRouter
pnpm bench -- --judge-audit 0.25 --no-judge-cache                 # audit a quarter of judged answers, force fresh verdicts
```

Every call, the routed arm and the judge included, is pinned to an
OpenRouter provider (`--providers`, default `streamlake,openai,tencent,anthropic`,
sent as `provider.order` with fallbacks off). OpenRouter takes the first
entry that serves the model being called, so one list covers whichever
model Milo picks. The pin is what makes two runs comparable: providers
count prompt tokens differently (the same DeepSeek prompt measured 10
tokens on one and 108 on another), which moves both the cost and the
estimated baseline. `--providers none` lets OpenRouter choose, and the
report names the provider each routed call actually used.

The gateway supplies its own Jev key; the benchmark never sees it. A full run
is 120 examples times four arms plus up to three judge calls per example,
in the low single-digit dollars on the default roster. Reports land at
`packages/evals/reports/bench-latest.md` (`--out`), with the full per-call
detail as JSON under `--json`.

### Stickiness

The router's sticky cache keys on the conversation fingerprint and the
user-turn count, not the posture, with a 30 minute TTL persisted on the
gateway. A rerun inside that window, or a second posture in the same window,
gets the earlier decision back. The report counts those as **sticky
(inherited)** and excludes them from the Jev latency figures. Pass
`--salt <anything>` to append a marker to each example's first user message,
which changes the fingerprint and nothing else, when you need fresh
decisions.

The benchmark is on demand, not a CI gate: it spends money and depends on
OpenRouter's live latency. The fixture-replay gate above stays the check on
every push.
