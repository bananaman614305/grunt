# Routing eval report

- Posture: `balanced`
- Policy version: `v2`
- Generated: 2026-09-17T19:07:39.888Z
- Examples: 120 total — 120 scored, 0 unscored

## Unscored

Every example was scored.

## Tier agreement

Overall: 84.2% (n=120)

### By task type

| task type | agreement | n |
| --- | --- | --- |
| chat | 91.7% | 12 |
| edit | 76.9% | 13 |
| feature | 78.6% | 14 |
| debug | 76.9% | 13 |
| research | 69.2% | 13 |
| review | 83.3% | 12 |
| docs | 91.7% | 12 |
| ops | 92.3% | 13 |
| classify | 94.4% | 18 |

### By difficulty band

| band | agreement | n |
| --- | --- | --- |
| 0 | 96.3% | 27 |
| 1 | 62.9% | 35 |
| 2 | 84.8% | 33 |
| 3 | 100.0% | 25 |

## Task-type accuracy

Jev's `task_type` matched the dataset label 90.8% of the time (n=120).

## Tier confusion matrix (rows: expected, columns: predicted)

| expected \ predicted | fast | mid | frontier |
| --- | --- | --- | --- |
| fast | 34 | 13 | 0 |
| mid | 1 | 26 | 4 |
| frontier | 0 | 1 | 41 |

## Jev latency

Mean: 2 ms; p95: 5 ms (n=120)

## Disagreements

- **r-006** (chat): expected `fast`, predicted `mid` (difficulty 0.88, needs_reasoning 0.19)
  - Router: chat task, P(hard) 0.00 below 0.05 and P(level 2+) 0.00 below 0.65 with balanced posture routes to mid; chose anthropic/claude-sonnet-5
  - Notes: Difficulty band 1 but essentially a style preference lookup, little reasoning, stays fast.
- **r-024** (classify): expected `mid`, predicted `fast` (difficulty 0.28, needs_reasoning 0.20)
  - Router: review task, P(level 1+) 0.28 below 0.35 with balanced posture routes to fast; chose anthropic/claude-haiku-4.5
  - Notes: Requires checking against a spec and explaining the deviation (missing type prefix, two changes bundled), more than pattern match.
- **r-034** (docs): expected `fast`, predicted `mid` (difficulty 0.94, needs_reasoning 0.16)
  - Router: docs task, P(hard) 0.00 below 0.05 and P(level 2+) 0.00 below 0.65 with balanced posture routes to mid; chose anthropic/claude-sonnet-5
  - Notes: Boilerplate instructions from known commands, low reasoning.
- **r-045** (review): expected `fast`, predicted `mid` (difficulty 0.95, needs_reasoning 0.22)
  - Router: review task, P(hard) 0.00 below 0.05 and P(level 2+) 0.00 below 0.65 with balanced posture routes to mid; chose anthropic/claude-sonnet-5
  - Notes: Mechanical style checklist (naming, spacing), low reasoning.
- **r-046** (review): expected `fast`, predicted `mid` (difficulty 1.24, needs_reasoning 0.53)
  - Router: review task, P(hard) 0.00 below 0.05 and P(level 2+) 0.39 below 0.65 with balanced posture routes to mid; chose anthropic/claude-sonnet-5
  - Notes: Small mechanical diff, straightforward to verify by eye.
- **r-058** (edit): expected `fast`, predicted `mid` (difficulty 0.47, needs_reasoning 0.11)
  - Router: edit task, P(hard) 0.00 below 0.05 and P(level 2+) 0.00 below 0.65 with balanced posture routes to mid; chose anthropic/claude-sonnet-5
  - Notes: Trivial types for a trivial function.
- **r-060** (edit): expected `fast`, predicted `mid` (difficulty 0.78, needs_reasoning 0.10)
  - Router: edit task, P(hard) 0.00 below 0.05 and P(level 2+) 0.00 below 0.65 with balanced posture routes to mid; chose anthropic/claude-sonnet-5
  - Notes: Additive, mechanical struct field change.
- **r-062** (edit): expected `frontier`, predicted `mid` (difficulty 1.05, needs_reasoning 0.65)
  - Router: edit task, P(hard) 0.01 below 0.05 and P(level 2+) 0.04 below 0.65 with balanced posture routes to mid; chose anthropic/claude-sonnet-5
  - Notes: Preserving exact behavior across mount/update/unmount semantics with hooks (avoiding stale closures, race conditions on rapid userId changes, and the unmount guard) is subtle enough to need frontier.
- **r-068** (feature): expected `fast`, predicted `mid` (difficulty 0.84, needs_reasoning 0.14)
  - Router: feature task, P(hard) 0.00 below 0.05 and P(level 2+) 0.00 below 0.65 with balanced posture routes to mid; chose anthropic/claude-sonnet-5
  - Notes: Placeholder flag with no real logic, purely mechanical.
- **r-069** (feature): expected `fast`, predicted `mid` (difficulty 0.49, needs_reasoning 0.09)
  - Router: edit task, P(hard) 0.00 below 0.05 and P(level 2+) 0.00 below 0.65 with balanced posture routes to mid; chose anthropic/claude-sonnet-5
  - Notes: Mongoose has built-in `timestamps` support for exactly this, mechanical.
- **r-070** (feature): expected `fast`, predicted `mid` (difficulty 0.62, needs_reasoning 0.09)
  - Router: feature task, P(hard) 0.00 below 0.05 and P(level 2+) 0.00 below 0.65 with balanced posture routes to mid; chose anthropic/claude-sonnet-5
  - Notes: Textbook health-check endpoint, no design decisions.
- **r-083** (debug): expected `fast`, predicted `mid` (difficulty 0.73, needs_reasoning 0.15)
  - Router: debug task, P(hard) 0.00 below 0.05 and P(level 2+) 0.00 below 0.65 with balanced posture routes to mid; chose anthropic/claude-sonnet-5
  - Notes: Textbook fix (default prop or guard clause), obvious once stated.
- **r-084** (debug): expected `fast`, predicted `mid` (difficulty 0.48, needs_reasoning 0.30)
  - Router: debug task, P(hard) 0.00 below 0.05 and P(level 2+) 0.00 below 0.65 with balanced posture routes to mid; chose anthropic/claude-sonnet-5
  - Notes: Off-by-one is immediately visible in a 3-line function.
- **r-089** (debug): expected `mid`, predicted `frontier` (difficulty 1.78, needs_reasoning 0.58)
  - Router: debug task, P(hard) 0.13 at or above 0.05 with balanced posture routes to frontier; chose anthropic/claude-opus-5
  - Notes: Root cause is directly stated in the setup (two parallel jobs applying the same workspace), standard fix is serializing them, mid.
- **r-096** (research): expected `fast`, predicted `mid` (difficulty 0.52, needs_reasoning 0.10)
  - Router: research task, P(hard) 0.00 below 0.05 and P(level 2+) 0.00 below 0.65 with balanced posture routes to mid; chose anthropic/claude-sonnet-5
  - Notes: Well-worn comparison, recall more than reasoning.
- **r-097** (research): expected `fast`, predicted `mid` (difficulty 1.30, needs_reasoning 0.30)
  - Router: research task, P(hard) 0.00 below 0.05 and P(level 2+) 0.31 below 0.65 with balanced posture routes to mid; chose anthropic/claude-sonnet-5
  - Notes: Standard factual comparison of well-documented tools.
- **r-099** (research): expected `mid`, predicted `frontier` (difficulty 2.19, needs_reasoning 0.87)
  - Router: research task, P(hard) 0.19 at or above 0.05 with balanced posture routes to frontier; chose anthropic/claude-opus-5
  - Notes: A grounded comparison against stated constraints, moderate synthesis but a well-trodden design space, mid.
- **r-102** (research): expected `mid`, predicted `frontier` (difficulty 2.24, needs_reasoning 0.88)
  - Router: research task, P(hard) 0.24 at or above 0.05 with balanced posture routes to frontier; chose anthropic/claude-opus-5
  - Notes: A grounded, constrained recommendation among three well-known options, moderate synthesis, mid.
- **r-116** (ops): expected `mid`, predicted `frontier` (difficulty 2.19, needs_reasoning 0.84)
  - Router: feature task, P(hard) 0.19 at or above 0.05 with balanced posture routes to frontier; chose anthropic/claude-opus-5
  - Notes: Standard OpenTelemetry adoption pattern (spans, context propagation) replacing ad hoc console logs; well-trodden but requires real setup work, mid.

## Policy ceiling note

48.5% (n=16/33) of difficulty-band-2 examples in the dataset are labeled `mid`, and the rest `frontier`. Policy v1 could not tell those apart: it sent every expected difficulty at or above 2.0 to the frontier tier under balanced posture, which put a hard ceiling on band-2 agreement. Policy v2 reads the per-level probability masses instead (ADR-002 revision 2), so the band-2 row above measures how much of that ceiling the distribution actually lifts. The thresholds are per decision backend and were fitted on this dataset, so treat an in-sample number here as an upper bound; the cross-validated figure is in `run.test.ts`.
