# Routing eval report

- Posture: `balanced`
- Policy version: `v1`
- Generated: 2026-09-17T15:52:34.337Z
- Examples: 120 total — 0 scored, 120 unscored

## Unscored

No example could be scored. This usually means no fixtures are recorded under `packages/evals/fixtures/jev` yet — run in `--mode record` with `JEV_API_KEY` set to populate them, then re-run in `--mode fixtures` for a network-free eval.

| error class | count |
| --- | --- |
| `network` | 120 |

## Tier agreement

Overall: n/a (n=0)

### By task type

| task type | agreement | n |
| --- | --- | --- |
| chat | n/a | 0 |
| edit | n/a | 0 |
| feature | n/a | 0 |
| debug | n/a | 0 |
| research | n/a | 0 |
| review | n/a | 0 |
| docs | n/a | 0 |
| ops | n/a | 0 |
| classify | n/a | 0 |

### By difficulty band

| band | agreement | n |
| --- | --- | --- |
| 0 | n/a | 0 |
| 1 | n/a | 0 |
| 2 | n/a | 0 |
| 3 | n/a | 0 |

## Task-type accuracy

Jev's `task_type` matched the dataset label n/a of the time (n=0).

## Tier confusion matrix (rows: expected, columns: predicted)

| expected \ predicted | fast | mid | frontier |
| --- | --- | --- | --- |
| fast | 0 | 0 | 0 |
| mid | 0 | 0 | 0 |
| frontier | 0 | 0 | 0 |

## Jev latency

Mean: n/a; p95: n/a (n=0)

## Disagreements

No scored examples to compare.

## Policy ceiling note

48.5% (n=16/33) of difficulty-band-2 examples in the dataset are labeled `mid`. Policy v1 sends difficulty at or above 2.0 under balanced posture to the frontier tier (docs/PLAN.md § Policy v1, ADR-002), so the static labels and the policy table diverge at band 2 by construction. This is a known divergence between the labels and the table that the orchestrator will settle from the live run, not a defect in this report.
