# Routing eval report

- Posture: `balanced`
- Policy version: `v2`
- Generated: 2026-09-17T19:54:23.600Z
- Examples: 120 total — 120 scored, 0 unscored

## Unscored

Every example was scored.

## Tier agreement

Overall: 81.7% (n=120)

### By task type

| task type | agreement | n |
| --- | --- | --- |
| chat | 83.3% | 12 |
| edit | 76.9% | 13 |
| feature | 78.6% | 14 |
| debug | 76.9% | 13 |
| research | 69.2% | 13 |
| review | 75.0% | 12 |
| docs | 91.7% | 12 |
| ops | 92.3% | 13 |
| classify | 88.9% | 18 |

### By difficulty band

| band | agreement | n |
| --- | --- | --- |
| 0 | 96.3% | 27 |
| 1 | 60.0% | 35 |
| 2 | 84.8% | 33 |
| 3 | 92.0% | 25 |

## Task-type accuracy

Jev's `task_type` matched the dataset label 90.8% of the time (n=120).

## Tier confusion matrix (rows: expected, columns: predicted)

| expected \ predicted | fast | mid | frontier |
| --- | --- | --- | --- |
| fast | 34 | 13 | 0 |
| mid | 1 | 25 | 5 |
| frontier | 1 | 2 | 39 |

## Jev latency

Mean: 2 ms; p95: 5 ms (n=120)

## Disagreements

- **r-006** (chat): expected `fast`, predicted `mid` (difficulty 0.88, needs_reasoning 0.17)
  - Router: chat task, P(hard) 0.00 below 0.05 and P(level 2+) 0.00 below 0.65 with balanced posture routes to mid; chose anthropic/claude-sonnet-5
  - Notes: Difficulty band 1 but essentially a style preference lookup, little reasoning, stays fast.
- **r-012** (chat): expected `frontier`, predicted `fast` (difficulty 0.52, needs_reasoning 0.61)
  - Router: chat task, P(level 1+) 0.34 below 0.35 with balanced posture routes to fast; chose anthropic/claude-haiku-4.5
  - Notes: Sustained adversarial philosophical argumentation across turns is genuinely hard reasoning; band 3 lifts the chat/classify cap, so frontier.
- **r-024** (classify): expected `mid`, predicted `fast` (difficulty 0.28, needs_reasoning 0.21)
  - Router: review task, P(level 1+) 0.28 below 0.35 with balanced posture routes to fast; chose anthropic/claude-haiku-4.5
  - Notes: Requires checking against a spec and explaining the deviation (missing type prefix, two changes bundled), more than pattern match.
- **r-030** (classify): expected `frontier`, predicted `mid` (difficulty 1.47, needs_reasoning 0.88)
  - Router: classify task, P(hard) 0.04 below 0.05 and P(level 2+) 0.48 below 0.65 with balanced posture routes to mid; chose anthropic/claude-sonnet-5
  - Notes: Deliberately overlapping legal categories and a clause that touches sub-processing, retention, and liability cap simultaneously; band 3 lifts the classify cap to frontier.
- **r-034** (docs): expected `fast`, predicted `mid` (difficulty 0.93, needs_reasoning 0.15)
  - Router: docs task, P(hard) 0.00 below 0.05 and P(level 2+) 0.00 below 0.65 with balanced posture routes to mid; chose anthropic/claude-sonnet-5
  - Notes: Boilerplate instructions from known commands, low reasoning.
- **r-045** (review): expected `fast`, predicted `mid` (difficulty 0.95, needs_reasoning 0.21)
  - Router: review task, P(hard) 0.00 below 0.05 and P(level 2+) 0.00 below 0.65 with balanced posture routes to mid; chose anthropic/claude-sonnet-5
  - Notes: Mechanical style checklist (naming, spacing), low reasoning.
- **r-046** (review): expected `fast`, predicted `mid` (difficulty 1.25, needs_reasoning 0.54)
  - Router: review task, P(hard) 0.00 below 0.05 and P(level 2+) 0.42 below 0.65 with balanced posture routes to mid; chose anthropic/claude-sonnet-5
  - Notes: Small mechanical diff, straightforward to verify by eye.
- **r-048** (review): expected `mid`, predicted `frontier` (difficulty 1.72, needs_reasoning 0.61)
  - Router: review task, P(hard) 0.05 at or above 0.05 with balanced posture routes to frontier; chose anthropic/claude-opus-5
  - Notes: Needs to reason about whether Postgres 15's fast-path default applies at this row count, a bit of domain knowledge beyond pattern matching.
- **r-058** (edit): expected `fast`, predicted `mid` (difficulty 0.47, needs_reasoning 0.11)
  - Router: edit task, P(hard) 0.00 below 0.05 and P(level 2+) 0.00 below 0.65 with balanced posture routes to mid; chose anthropic/claude-sonnet-5
  - Notes: Trivial types for a trivial function.
- **r-060** (edit): expected `fast`, predicted `mid` (difficulty 0.78, needs_reasoning 0.10)
  - Router: edit task, P(hard) 0.00 below 0.05 and P(level 2+) 0.00 below 0.65 with balanced posture routes to mid; chose anthropic/claude-sonnet-5
  - Notes: Additive, mechanical struct field change.
- **r-062** (edit): expected `frontier`, predicted `mid` (difficulty 1.06, needs_reasoning 0.65)
  - Router: edit task, P(hard) 0.01 below 0.05 and P(level 2+) 0.04 below 0.65 with balanced posture routes to mid; chose anthropic/claude-sonnet-5
  - Notes: Preserving exact behavior across mount/update/unmount semantics with hooks (avoiding stale closures, race conditions on rapid userId changes, and the unmount guard) is subtle enough to need frontier.
- **r-068** (feature): expected `fast`, predicted `mid` (difficulty 0.81, needs_reasoning 0.14)
  - Router: feature task, P(hard) 0.00 below 0.05 and P(level 2+) 0.00 below 0.65 with balanced posture routes to mid; chose anthropic/claude-sonnet-5
  - Notes: Placeholder flag with no real logic, purely mechanical.
- **r-069** (feature): expected `fast`, predicted `mid` (difficulty 0.52, needs_reasoning 0.09)
  - Router: edit task, P(hard) 0.00 below 0.05 and P(level 2+) 0.00 below 0.65 with balanced posture routes to mid; chose anthropic/claude-sonnet-5
  - Notes: Mongoose has built-in `timestamps` support for exactly this, mechanical.
- **r-070** (feature): expected `fast`, predicted `mid` (difficulty 0.59, needs_reasoning 0.09)
  - Router: feature task, P(hard) 0.00 below 0.05 and P(level 2+) 0.00 below 0.65 with balanced posture routes to mid; chose anthropic/claude-sonnet-5
  - Notes: Textbook health-check endpoint, no design decisions.
- **r-083** (debug): expected `fast`, predicted `mid` (difficulty 0.74, needs_reasoning 0.16)
  - Router: debug task, P(hard) 0.00 below 0.05 and P(level 2+) 0.00 below 0.65 with balanced posture routes to mid; chose anthropic/claude-sonnet-5
  - Notes: Textbook fix (default prop or guard clause), obvious once stated.
- **r-084** (debug): expected `fast`, predicted `mid` (difficulty 0.48, needs_reasoning 0.29)
  - Router: debug task, P(hard) 0.00 below 0.05 and P(level 2+) 0.00 below 0.65 with balanced posture routes to mid; chose anthropic/claude-sonnet-5
  - Notes: Off-by-one is immediately visible in a 3-line function.
- **r-089** (debug): expected `mid`, predicted `frontier` (difficulty 1.74, needs_reasoning 0.61)
  - Router: debug task, P(hard) 0.11 at or above 0.05 with balanced posture routes to frontier; chose anthropic/claude-opus-5
  - Notes: Root cause is directly stated in the setup (two parallel jobs applying the same workspace), standard fix is serializing them, mid.
- **r-096** (research): expected `fast`, predicted `mid` (difficulty 0.57, needs_reasoning 0.10)
  - Router: research task, P(hard) 0.00 below 0.05 and P(level 2+) 0.00 below 0.65 with balanced posture routes to mid; chose anthropic/claude-sonnet-5
  - Notes: Well-worn comparison, recall more than reasoning.
- **r-097** (research): expected `fast`, predicted `mid` (difficulty 1.29, needs_reasoning 0.30)
  - Router: research task, P(hard) 0.00 below 0.05 and P(level 2+) 0.29 below 0.65 with balanced posture routes to mid; chose anthropic/claude-sonnet-5
  - Notes: Standard factual comparison of well-documented tools.
- **r-099** (research): expected `mid`, predicted `frontier` (difficulty 2.13, needs_reasoning 0.88)
  - Router: research task, P(hard) 0.14 at or above 0.05 with balanced posture routes to frontier; chose anthropic/claude-opus-5
  - Notes: A grounded comparison against stated constraints, moderate synthesis but a well-trodden design space, mid.
- **r-102** (research): expected `mid`, predicted `frontier` (difficulty 2.24, needs_reasoning 0.88)
  - Router: research task, P(hard) 0.24 at or above 0.05 with balanced posture routes to frontier; chose anthropic/claude-opus-5
  - Notes: A grounded, constrained recommendation among three well-known options, moderate synthesis, mid.
- **r-116** (ops): expected `mid`, predicted `frontier` (difficulty 2.23, needs_reasoning 0.83)
  - Router: feature task, P(hard) 0.23 at or above 0.05 with balanced posture routes to frontier; chose anthropic/claude-opus-5
  - Notes: Standard OpenTelemetry adoption pattern (spans, context propagation) replacing ad hoc console logs; well-trodden but requires real setup work, mid.
