# Routing evals

`pnpm eval` (`packages/evals/src/cli.ts`) replays the 120-prompt labeled set
at `packages/evals/data/routing.jsonl` through a fresh `Router` per example
and reports how often Policy v1's tier choice agrees with the label. See
`packages/evals/data/README.md` for the labeling rules and
`docs/routing.md` for how the policy table works.

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

### Other flags

| Flag | Default | Effect |
|---|---|---|
| `--posture <low\|balanced\|quality>` | `balanced` | Cost posture to route every example under. The dataset's `expected_tier_balanced` label assumes `balanced`, so other postures are for exploration, not for checking the 85% gate. |
| `--limit <n>` | all 120 | Only run the first `n` examples. |
| `--out <path>` | `packages/evals/reports/latest.md` | Where the markdown report is written (also printed to stdout). |
| `--json <path>` | *(not written)* | Also write the full `EvalReport` as JSON to this path. |

## What the report contains

`formatMarkdown` (`packages/evals/src/report.ts`) produces, in order:

- **Header** — posture, policy version, generation timestamp, total/scored/unscored counts.
- **Unscored** — a table of how many examples failed to score, grouped by cause (`timeout`, `network`, `http`, `validation`, or another classified error). Every example scored prints "Every example was scored."; every example failing prints guidance to run `--mode record` first.
- **Tier agreement** — overall agreement rate (`predictedTier === expectedTier`) among scored examples, then broken down by task type and by difficulty band.
- **Task-type accuracy** — how often Jev's classified `task_type` matched the dataset's label (informational; not gated on).
- **Tier confusion matrix** — a 3×3 table, rows are the expected tier, columns the predicted tier.
- **Jev latency** — mean and p95 latency in ms across scored examples.
- **Disagreements** — one bullet per scored example where the predicted tier did not match the label: expected vs. predicted tier, `difficulty`/`needs_reasoning` values, the router's one-sentence reason, and the label's `notes`.
- **Policy ceiling note** — the share of difficulty-band-2 examples labeled `mid` in the dataset, with an explanation that Policy v1 sends `difficulty >= 2.0` under balanced posture straight to `frontier`, so the static labels and the policy table diverge at band 2 by construction (see `docs/routing.md`'s "Known divergence" section for the full mechanism, including band 1).

## The 85% agreement gate

`pnpm eval` exits **0** when every example was unscored (a legitimate
outcome with no fixtures recorded yet — nothing to gate on) or when at
least one example was scored and overall tier agreement is **≥ 85%**
(`MIN_TIER_AGREEMENT` in `packages/evals/src/cli.ts`). It exits **2** when
at least one example was scored and agreement falls **below 85%**, so CI can
fail a policy change that regresses agreement once real fixtures or a live
run exist. Changing a threshold in `packages/core/src/router/policy.ts`
requires bumping `POLICY_VERSION` and re-running the eval to confirm the
gate still passes (ADR-002).
