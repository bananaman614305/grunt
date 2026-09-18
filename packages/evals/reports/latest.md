# Routing eval report

- Posture: `balanced`
- Policy version: `v4`
- Generated: 2026-09-18T05:02:29.266Z
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
| review | 83.3% | 12 |
| docs | 83.3% | 12 |
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

Jev's `task_type` matched the dataset label 90.0% of the time (n=120).

## Tier confusion matrix (rows: expected, columns: predicted)

| expected \ predicted | fast | mid | frontier |
| --- | --- | --- | --- |
| fast | 33 | 14 | 0 |
| mid | 1 | 26 | 4 |
| frontier | 0 | 3 | 39 |

## Jev latency

Mean: 3 ms; p95: 5 ms (n=120)

## Disagreements

- **r-006** (chat): expected `fast`, predicted `mid` (difficulty 0.87, needs_reasoning 0.18)
  - Router: chat task, P(hard) 0.00 below 0.05 and P(level 2+) 0.00 below 0.65 with balanced posture routes to mid; chose openai/gpt-5.6-luna
  - Notes: Difficulty band 1 but essentially a style preference lookup, little reasoning, stays fast.
- **r-012** (chat): expected `frontier`, predicted `mid` (difficulty 0.61, needs_reasoning 0.60)
  - Router: chat task, P(hard) 0.08 at or above 0.05 with balanced posture routes to frontier, but a chat task caps at mid below P(hard) 0.25; chose openai/gpt-5.6-luna
  - Notes: Sustained adversarial philosophical argumentation across turns is genuinely hard reasoning; band 3 lifts the chat/classify cap, so frontier.
- **r-024** (classify): expected `mid`, predicted `fast` (difficulty 0.28, needs_reasoning 0.21)
  - Router: review task, P(level 1+) 0.28 below 0.35 with balanced posture routes to fast; chose deepseek/deepseek-v4-flash
  - Notes: Requires checking against a spec and explaining the deviation (missing type prefix, two changes bundled), more than pattern match.
- **r-030** (classify): expected `frontier`, predicted `mid` (difficulty 1.50, needs_reasoning 0.87)
  - Router: classify task, P(hard) 0.05 at or above 0.05 with balanced posture routes to frontier, but a classify task caps at mid below P(hard) 0.25; chose openai/gpt-5.6-luna
  - Notes: Deliberately overlapping legal categories and a clause that touches sub-processing, retention, and liability cap simultaneously; band 3 lifts the classify cap to frontier.
- **r-034** (docs): expected `fast`, predicted `mid` (difficulty 0.93, needs_reasoning 0.16)
  - Router: docs task, P(hard) 0.00 below 0.05 and P(level 2+) 0.00 below 0.65 with balanced posture routes to mid, and a docs task above the fast band samples best-of-5 on fast instead; chose deepseek/deepseek-v4-flash
  - Notes: Boilerplate instructions from known commands, low reasoning.
- **r-035** (docs): expected `fast`, predicted `mid` (difficulty 0.38, needs_reasoning 0.07)
  - Router: docs task, P(hard) 0.00 below 0.05 and P(level 2+) 0.00 below 0.65 with balanced posture routes to mid, and a docs task above the fast band samples best-of-5 on fast instead; chose deepseek/deepseek-v4-flash
  - Notes: Direct transcription of an already-clear signature into JSDoc.
- **r-045** (review): expected `fast`, predicted `mid` (difficulty 0.94, needs_reasoning 0.22)
  - Router: review task, P(hard) 0.00 below 0.05 and P(level 2+) 0.00 below 0.65 with balanced posture routes to mid; chose openai/gpt-5.6-luna
  - Notes: Mechanical style checklist (naming, spacing), low reasoning.
- **r-046** (review): expected `fast`, predicted `mid` (difficulty 1.28, needs_reasoning 0.51)
  - Router: review task, P(hard) 0.00 below 0.05 and P(level 2+) 0.43 below 0.65 with balanced posture routes to mid; chose openai/gpt-5.6-luna
  - Notes: Small mechanical diff, straightforward to verify by eye.
- **r-058** (edit): expected `fast`, predicted `mid` (difficulty 0.48, needs_reasoning 0.12)
  - Router: edit task, P(hard) 0.00 below 0.05 and P(level 2+) 0.00 below 0.65 with balanced posture routes to mid, and a edit task above the fast band samples best-of-5 on fast instead; chose deepseek/deepseek-v4-flash
  - Notes: Trivial types for a trivial function.
- **r-060** (edit): expected `fast`, predicted `mid` (difficulty 0.74, needs_reasoning 0.09)
  - Router: edit task, P(hard) 0.00 below 0.05 and P(level 2+) 0.00 below 0.65 with balanced posture routes to mid, and a edit task above the fast band samples best-of-5 on fast instead; chose deepseek/deepseek-v4-flash
  - Notes: Additive, mechanical struct field change.
- **r-062** (edit): expected `frontier`, predicted `mid` (difficulty 1.04, needs_reasoning 0.66)
  - Router: edit task, P(hard) 0.01 below 0.05 and P(level 2+) 0.04 below 0.65 with balanced posture routes to mid, and a edit task above the fast band samples best-of-5 on fast instead; chose deepseek/deepseek-v4-flash
  - Notes: Preserving exact behavior across mount/update/unmount semantics with hooks (avoiding stale closures, race conditions on rapid userId changes, and the unmount guard) is subtle enough to need frontier.
- **r-068** (feature): expected `fast`, predicted `mid` (difficulty 0.82, needs_reasoning 0.14)
  - Router: feature task, P(hard) 0.00 below 0.05 and P(level 2+) 0.00 below 0.65 with balanced posture routes to mid; chose openai/gpt-5.6-luna
  - Notes: Placeholder flag with no real logic, purely mechanical.
- **r-069** (feature): expected `fast`, predicted `mid` (difficulty 0.43, needs_reasoning 0.09)
  - Router: edit task, P(hard) 0.00 below 0.05 and P(level 2+) 0.00 below 0.65 with balanced posture routes to mid, and a edit task above the fast band samples best-of-5 on fast instead; chose deepseek/deepseek-v4-flash
  - Notes: Mongoose has built-in `timestamps` support for exactly this, mechanical.
- **r-070** (feature): expected `fast`, predicted `mid` (difficulty 0.61, needs_reasoning 0.09)
  - Router: feature task, P(hard) 0.00 below 0.05 and P(level 2+) 0.00 below 0.65 with balanced posture routes to mid; chose openai/gpt-5.6-luna
  - Notes: Textbook health-check endpoint, no design decisions.
- **r-083** (debug): expected `fast`, predicted `mid` (difficulty 0.73, needs_reasoning 0.15)
  - Router: debug task, P(hard) 0.00 below 0.05 and P(level 2+) 0.00 below 0.65 with balanced posture routes to mid; chose openai/gpt-5.6-luna
  - Notes: Textbook fix (default prop or guard clause), obvious once stated.
- **r-084** (debug): expected `fast`, predicted `mid` (difficulty 0.50, needs_reasoning 0.27)
  - Router: debug task, P(hard) 0.00 below 0.05 and P(level 2+) 0.00 below 0.65 with balanced posture routes to mid; chose openai/gpt-5.6-luna
  - Notes: Off-by-one is immediately visible in a 3-line function.
- **r-089** (debug): expected `mid`, predicted `frontier` (difficulty 1.74, needs_reasoning 0.58)
  - Router: debug task, P(hard) 0.10 at or above 0.05 with balanced posture routes to frontier; chose z-ai/glm-5.3
  - Notes: Root cause is directly stated in the setup (two parallel jobs applying the same workspace), standard fix is serializing them, mid.
- **r-096** (research): expected `fast`, predicted `mid` (difficulty 0.58, needs_reasoning 0.10)
  - Router: research task, P(hard) 0.00 below 0.05 and P(level 2+) 0.00 below 0.65 with balanced posture routes to mid; chose openai/gpt-5.6-luna
  - Notes: Well-worn comparison, recall more than reasoning.
- **r-097** (research): expected `fast`, predicted `mid` (difficulty 1.31, needs_reasoning 0.30)
  - Router: research task, P(hard) 0.00 below 0.05 and P(level 2+) 0.31 below 0.65 with balanced posture routes to mid; chose openai/gpt-5.6-luna
  - Notes: Standard factual comparison of well-documented tools.
- **r-099** (research): expected `mid`, predicted `frontier` (difficulty 2.16, needs_reasoning 0.88)
  - Router: research task, P(hard) 0.16 at or above 0.05 with balanced posture routes to frontier; chose z-ai/glm-5.3
  - Notes: A grounded comparison against stated constraints, moderate synthesis but a well-trodden design space, mid.
- **r-102** (research): expected `mid`, predicted `frontier` (difficulty 2.24, needs_reasoning 0.88)
  - Router: research task, P(hard) 0.24 at or above 0.05 with balanced posture routes to frontier; chose z-ai/glm-5.3
  - Notes: A grounded, constrained recommendation among three well-known options, moderate synthesis, mid.
- **r-116** (ops): expected `mid`, predicted `frontier` (difficulty 2.24, needs_reasoning 0.83)
  - Router: feature task, P(hard) 0.24 at or above 0.05 with balanced posture routes to frontier; chose z-ai/glm-5.3
  - Notes: Standard OpenTelemetry adoption pattern (spans, context propagation) replacing ad hoc console logs; well-trodden but requires real setup work, mid.
