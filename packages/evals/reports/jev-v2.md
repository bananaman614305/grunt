# Routing eval report

- Posture: `balanced`
- Policy version: `v2`
- Generated: 2026-09-17T18:53:02.362Z
- Examples: 120 total — 120 scored, 0 unscored

## Unscored

Every example was scored.

## Tier agreement

Overall: 75.0% (n=120)

### By task type

| task type | agreement | n |
| --- | --- | --- |
| chat | 75.0% | 12 |
| edit | 61.5% | 13 |
| feature | 92.9% | 14 |
| debug | 76.9% | 13 |
| research | 69.2% | 13 |
| review | 75.0% | 12 |
| docs | 75.0% | 12 |
| ops | 84.6% | 13 |
| classify | 66.7% | 18 |

### By difficulty band

| band | agreement | n |
| --- | --- | --- |
| 0 | 100.0% | 27 |
| 1 | 51.4% | 35 |
| 2 | 66.7% | 33 |
| 3 | 92.0% | 25 |

## Task-type accuracy

Jev's `task_type` matched the dataset label 90.8% of the time (n=120).

## Tier confusion matrix (rows: expected, columns: predicted)

| expected \ predicted | fast | mid | frontier |
| --- | --- | --- | --- |
| fast | 45 | 2 | 0 |
| mid | 20 | 6 | 5 |
| frontier | 1 | 2 | 39 |

## Jev latency

Mean: 412 ms; p95: 720 ms (n=120)

## Disagreements

- **r-007** (chat): expected `mid`, predicted `fast` (difficulty 0.49, needs_reasoning 0.18)
  - Router: chat task, P(level 2+) 0.00 below 0.10 with balanced posture routes to fast; chose anthropic/claude-haiku-4.5
  - Notes: Needs to weigh the async/distributed constraint against generic icebreaker advice, light reasoning, so mid.
- **r-008** (chat): expected `mid`, predicted `fast` (difficulty 0.95, needs_reasoning 0.26)
  - Router: docs task, P(level 2+) 0.00 below 0.10 with balanced posture routes to fast; chose anthropic/claude-haiku-4.5
  - Notes: Requires synthesizing a balanced take rather than reciting a list, mid.
- **r-012** (chat): expected `frontier`, predicted `mid` (difficulty 0.57, needs_reasoning 0.61)
  - Router: chat task, P(hard) 0.07 below 0.25 and P(level 2+) 0.14 below 0.50 with balanced posture routes to mid; chose anthropic/claude-sonnet-5
  - Notes: Sustained adversarial philosophical argumentation across turns is genuinely hard reasoning; band 3 lifts the chat/classify cap, so frontier.
- **r-024** (classify): expected `mid`, predicted `fast` (difficulty 0.28, needs_reasoning 0.20)
  - Router: review task, P(level 2+) 0.00 below 0.10 with balanced posture routes to fast; chose anthropic/claude-haiku-4.5
  - Notes: Requires checking against a spec and explaining the deviation (missing type prefix, two changes bundled), more than pattern match.
- **r-026** (classify): expected `mid`, predicted `fast` (difficulty 0.67, needs_reasoning 0.42)
  - Router: classify task, P(level 2+) 0.01 below 0.10 with balanced posture routes to fast; chose anthropic/claude-haiku-4.5
  - Notes: Needs to compare phrasing and infer that 1 and 2 are the same bug while 3 is a different, unrelated feature request.
- **r-027** (classify): expected `mid`, predicted `fast` (difficulty 0.55, needs_reasoning 0.24)
  - Router: classify task, P(level 2+) 0.04 below 0.10 with balanced posture routes to fast; chose anthropic/claude-haiku-4.5
  - Notes: Requires reasoning about row-level locking behavior under concurrent decrements, not just classifying the verb.
- **r-028** (classify): expected `mid`, predicted `fast` (difficulty 0.90, needs_reasoning 0.57)
  - Router: classify task, P(level 2+) 0.03 below 0.10 with balanced posture routes to fast; chose anthropic/claude-haiku-4.5
  - Notes: Distinguishing tone-based churn risk (2, 5, 7) from surface sentiment needs real reasoning, but classify caps at mid even at band 2.
- **r-029** (classify): expected `mid`, predicted `fast` (difficulty 0.85, needs_reasoning 0.54)
  - Router: classify task, P(level 2+) 0.05 below 0.10 with balanced posture routes to fast; chose anthropic/claude-haiku-4.5
  - Notes: Several traces are genuinely ambiguous (3 could be permissions or config; 5 could be null-pointer or unknown), needs judgment, capped at mid for classify.
- **r-030** (classify): expected `frontier`, predicted `mid` (difficulty 1.52, needs_reasoning 0.87)
  - Router: classify task, P(level 2+) 0.52 at or above 0.50 with balanced posture routes to frontier, but a classify task caps at mid below P(hard) 0.50; chose anthropic/claude-sonnet-5
  - Notes: Deliberately overlapping legal categories and a clause that touches sub-processing, retention, and liability cap simultaneously; band 3 lifts the classify cap to frontier.
- **r-036** (docs): expected `mid`, predicted `fast` (difficulty 0.73, needs_reasoning 0.16)
  - Router: docs task, P(level 2+) 0.00 below 0.10 with balanced posture routes to fast; chose anthropic/claude-haiku-4.5
  - Notes: Needs to group and prioritize items into user-facing categories, a bit more than transcription.
- **r-037** (docs): expected `mid`, predicted `fast` (difficulty 0.87, needs_reasoning 0.15)
  - Router: docs task, P(level 2+) 0.00 below 0.10 with balanced posture routes to fast; chose anthropic/claude-haiku-4.5
  - Notes: Requires inferring both success and error response shapes and writing them out clearly, mild reasoning.
- **r-039** (docs): expected `mid`, predicted `fast` (difficulty 1.01, needs_reasoning 0.32)
  - Router: docs task, P(level 2+) 0.03 below 0.10 with balanced posture routes to fast; chose anthropic/claude-haiku-4.5
  - Notes: Mostly structuring known facts into a guide; some reasoning about what counts as breaking, but not deeply ambiguous, so mid.
- **r-046** (review): expected `fast`, predicted `mid` (difficulty 1.24, needs_reasoning 0.53)
  - Router: review task, P(hard) 0.00 below 0.25 and P(level 2+) 0.39 below 0.50 with balanced posture routes to mid; chose anthropic/claude-sonnet-5
  - Notes: Small mechanical diff, straightforward to verify by eye.
- **r-047** (review): expected `mid`, predicted `fast` (difficulty 0.50, needs_reasoning 0.34)
  - Router: review task, P(level 2+) 0.00 below 0.10 with balanced posture routes to fast; chose anthropic/claude-haiku-4.5
  - Notes: Needs to spot a second-order issue (integer division truncation) after the first is found, mild reasoning.
- **r-048** (review): expected `mid`, predicted `frontier` (difficulty 1.67, needs_reasoning 0.63)
  - Router: review task, P(level 2+) 0.63 at or above 0.50 with balanced posture routes to frontier; chose anthropic/claude-opus-5
  - Notes: Needs to reason about whether Postgres 15's fast-path default applies at this row count, a bit of domain knowledge beyond pattern matching.
- **r-059** (edit): expected `mid`, predicted `fast` (difficulty 0.84, needs_reasoning 0.18)
  - Router: edit task, P(level 2+) 0.00 below 0.10 with balanced posture routes to fast; chose anthropic/claude-haiku-4.5
  - Notes: Requires noticing the shared formatting core across three differently-worded functions and designing a clean helper signature.
- **r-061** (edit): expected `mid`, predicted `fast` (difficulty 1.00, needs_reasoning 0.20)
  - Router: edit task, P(level 2+) 0.00 below 0.10 with balanced posture routes to fast; chose anthropic/claude-haiku-4.5
  - Notes: Needs to decide what 'required' checks look like (missing vs empty string vs type) and how to respond, a bit more than pure mechanics.
- **r-062** (edit): expected `frontier`, predicted `fast` (difficulty 1.05, needs_reasoning 0.65)
  - Router: edit task, P(level 2+) 0.04 below 0.10 with balanced posture routes to fast; chose anthropic/claude-haiku-4.5
  - Notes: Preserving exact behavior across mount/update/unmount semantics with hooks (avoiding stale closures, race conditions on rapid userId changes, and the unmount guard) is subtle enough to need frontier.
- **r-063** (edit): expected `mid`, predicted `fast` (difficulty 1.00, needs_reasoning 0.32)
  - Router: edit task, P(level 2+) 0.00 below 0.10 with balanced posture routes to fast; chose anthropic/claude-haiku-4.5
  - Notes: Well-specified requirements (status codes, attempt count, base delay), implementation is standard, mid.
- **r-064** (edit): expected `mid`, predicted `fast` (difficulty 0.70, needs_reasoning 0.16)
  - Router: edit task, P(level 2+) 0.00 below 0.10 with balanced posture routes to fast; chose anthropic/claude-haiku-4.5
  - Notes: Standard SUM() OVER (PARTITION BY ... ORDER BY ...) pattern, mid.
- **r-071** (feature): expected `mid`, predicted `fast` (difficulty 1.00, needs_reasoning 0.30)
  - Router: edit task, P(level 2+) 0.00 below 0.10 with balanced posture routes to fast; chose anthropic/claude-haiku-4.5
  - Notes: Needs to decide offset math, defaults, and clamping, more than boilerplate but still standard, mid.
- **r-085** (debug): expected `mid`, predicted `fast` (difficulty 0.92, needs_reasoning 0.42)
  - Router: debug task, P(level 2+) 0.02 below 0.10 with balanced posture routes to fast; chose anthropic/claude-haiku-4.5
  - Notes: Requires reasoning about join fan-out from the one-to-many order_items relationship, not just a syntax read.
- **r-089** (debug): expected `mid`, predicted `frontier` (difficulty 1.78, needs_reasoning 0.58)
  - Router: debug task, P(level 2+) 0.64 at or above 0.50 with balanced posture routes to frontier; chose anthropic/claude-opus-5
  - Notes: Root cause is directly stated in the setup (two parallel jobs applying the same workspace), standard fix is serializing them, mid.
- **r-090** (debug): expected `mid`, predicted `fast` (difficulty 0.88, needs_reasoning 0.33)
  - Router: debug task, P(level 2+) 0.01 below 0.10 with balanced posture routes to fast; chose anthropic/claude-haiku-4.5
  - Notes: Diagnosis was already supplied in the prior turn; remaining work is picking a robust fix (pad the wait or use fake timers), mid.
- **r-097** (research): expected `fast`, predicted `mid` (difficulty 1.30, needs_reasoning 0.30)
  - Router: research task, P(hard) 0.00 below 0.25 and P(level 2+) 0.31 below 0.50 with balanced posture routes to mid; chose anthropic/claude-sonnet-5
  - Notes: Standard factual comparison of well-documented tools.
- **r-098** (research): expected `mid`, predicted `fast` (difficulty 0.91, needs_reasoning 0.15)
  - Router: research task, P(level 2+) 0.00 below 0.10 with balanced posture routes to fast; chose anthropic/claude-haiku-4.5
  - Notes: Requires organizing several strategies with accurate tradeoffs rather than a single fact, mid.
- **r-099** (research): expected `mid`, predicted `frontier` (difficulty 2.19, needs_reasoning 0.87)
  - Router: research task, P(level 2+) 0.99 at or above 0.50 with balanced posture routes to frontier; chose anthropic/claude-opus-5
  - Notes: A grounded comparison against stated constraints, moderate synthesis but a well-trodden design space, mid.
- **r-102** (research): expected `mid`, predicted `frontier` (difficulty 2.24, needs_reasoning 0.88)
  - Router: research task, P(level 2+) 1.00 at or above 0.50 with balanced posture routes to frontier; chose anthropic/claude-opus-5
  - Notes: A grounded, constrained recommendation among three well-known options, moderate synthesis, mid.
- **r-112** (ops): expected `mid`, predicted `fast` (difficulty 0.79, needs_reasoning 0.15)
  - Router: ops task, P(level 2+) 0.00 below 0.10 with balanced posture routes to fast; chose anthropic/claude-haiku-4.5
  - Notes: Needs to know the setup-node `cache: pnpm` option and correct ordering relative to pnpm/action-setup, slightly more than copy-paste.
- **r-116** (ops): expected `mid`, predicted `frontier` (difficulty 2.19, needs_reasoning 0.84)
  - Router: feature task, P(level 2+) 1.00 at or above 0.50 with balanced posture routes to frontier; chose anthropic/claude-opus-5
  - Notes: Standard OpenTelemetry adoption pattern (spans, context propagation) replacing ad hoc console logs; well-trodden but requires real setup work, mid.

## Policy ceiling note

48.5% (n=16/33) of difficulty-band-2 examples in the dataset are labeled `mid`, and the rest `frontier`. Policy v1 could not tell those apart: it sent every expected difficulty at or above 2.0 to the frontier tier under balanced posture, which put a hard ceiling on band-2 agreement. Policy v2 reads the per-level probability masses instead (ADR-002 revision 2), so the band-2 row above measures how much of that ceiling the distribution actually lifts. The thresholds are per decision backend and were fitted on this dataset, so treat an in-sample number here as an upper bound; the cross-validated figure is in `run.test.ts`.
