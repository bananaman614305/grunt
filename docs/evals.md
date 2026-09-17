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
| `--gate <0..1>` | `0.85` | Minimum overall tier agreement before the run exits 2. Pass `0.80` for the `system-one-open` backend (see below). |

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
| `jev` | **0.80** | Validated (ADR-002 revision 3): 84.2% in-sample, 80.8% two-fold cross-validated (folds 75.0% and 86.7% — the fast/mid boundary is the noisy one). CI holds it to the same conservative 0.80 floor as the open backend rather than the 0.85 target, since a single fold measured as low as 75.0%; 0.85 stays the aspirational target. |
| `system-one-open` | **0.80** | The open replica is measurably less accurate than Jev (76.7% vs. 86.9% on TypeSafe's public eval). Policy v2 scores **83.3%** on the committed fixtures, so 0.80 leaves headroom without hiding a regression. |

CI runs the fixture replay against both backends at `--gate 0.80`:
`MILO_DECISION_BACKEND=system-one-open` against the open replica's fixtures,
and `MILO_DECISION_BACKEND=jev` (with `JEV_BASE_URL` pinned to the exact
request URL the committed Jev fixtures were recorded against — replay never
touches the network, but the fixture lookup is keyed by a hash of the whole
request) against Jev's. Both backends now have a validated profile; **0.85
remains the stated target** in ADR-002 for whichever backend a deployment
actually uses in production, and the 0.80 CI floor exists so a regression
still fails the build without demanding a perfect score from either replica
(ADR-002 revisions 2 and 3).

Changing a threshold in `packages/core/src/router/policy.ts` requires bumping
`POLICY_VERSION` and re-running the eval to confirm the gate still passes. The
two-fold cross-validation in `packages/evals/src/run.test.ts` refits the
thresholds on half the recorded examples and scores them on the other half,
asserting a mean held-out agreement of at least **0.78** — so a later tuning
cannot buy in-sample agreement by overfitting this dataset.
