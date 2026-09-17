# Routing eval report

- Posture: `balanced`
- Policy version: `v2`
- Generated: 2026-09-17T16:43:50.006Z
- Examples: 120 total — 120 scored, 0 unscored

## Unscored

Every example was scored.

## Tier agreement

Overall: 83.3% (n=120)

### By task type

| task type | agreement | n |
| --- | --- | --- |
| chat | 91.7% | 12 |
| edit | 69.2% | 13 |
| feature | 78.6% | 14 |
| debug | 76.9% | 13 |
| research | 76.9% | 13 |
| review | 83.3% | 12 |
| docs | 91.7% | 12 |
| ops | 92.3% | 13 |
| classify | 88.9% | 18 |

### By difficulty band

| band | agreement | n |
| --- | --- | --- |
| 0 | 100.0% | 27 |
| 1 | 71.4% | 35 |
| 2 | 75.8% | 33 |
| 3 | 92.0% | 25 |

## Task-type accuracy

Jev's `task_type` matched the dataset label 76.7% of the time (n=120).

## Tier confusion matrix (rows: expected, columns: predicted)

| expected \ predicted | fast | mid | frontier |
| --- | --- | --- | --- |
| fast | 42 | 4 | 1 |
| mid | 5 | 22 | 4 |
| frontier | 0 | 6 | 36 |

## Jev latency

Mean: 2 ms; p95: 4 ms (n=120)

## Disagreements

- **r-012** (chat): expected `frontier`, predicted `mid` (difficulty 1.47, needs_reasoning 0.41)
  - Router: chat task, P(hard) 0.23 at or above 0.10 with balanced posture routes to frontier, but a chat task caps at mid below P(hard) 0.30; chose anthropic/claude-sonnet-5
  - Notes: Sustained adversarial philosophical argumentation across turns is genuinely hard reasoning; band 3 lifts the chat/classify cap, so frontier.
- **r-024** (classify): expected `mid`, predicted `fast` (difficulty 0.54, needs_reasoning 0.76)
  - Router: review task, P(level 2+) 0.01 below 0.05 with balanced posture routes to fast; chose anthropic/claude-haiku-4.5
  - Notes: Requires checking against a spec and explaining the deviation (missing type prefix, two changes bundled), more than pattern match.
- **r-030** (classify): expected `frontier`, predicted `mid` (difficulty 0.76, needs_reasoning 0.72)
  - Router: classify task, P(hard) 0.02 below 0.10 and P(level 2+) 0.18 below 0.65 with balanced posture routes to mid; chose anthropic/claude-sonnet-5
  - Notes: Deliberately overlapping legal categories and a clause that touches sub-processing, retention, and liability cap simultaneously; band 3 lifts the classify cap to frontier.
- **r-034** (docs): expected `fast`, predicted `mid` (difficulty 1.06, needs_reasoning 0.55)
  - Router: docs task, P(hard) 0.00 below 0.10 and P(level 2+) 0.12 below 0.65 with balanced posture routes to mid; chose anthropic/claude-sonnet-5
  - Notes: Boilerplate instructions from known commands, low reasoning.
- **r-047** (review): expected `mid`, predicted `fast` (difficulty 0.43, needs_reasoning 0.42)
  - Router: debug task, P(level 2+) 0.01 below 0.05 with balanced posture routes to fast; chose anthropic/claude-haiku-4.5
  - Notes: Needs to spot a second-order issue (integer division truncation) after the first is found, mild reasoning.
- **r-049** (review): expected `frontier`, predicted `mid` (difficulty 1.63, needs_reasoning 0.67)
  - Router: review task, P(hard) 0.09 below 0.10 and P(level 2+) 0.55 below 0.65 with balanced posture routes to mid; chose anthropic/claude-sonnet-5
  - Notes: Needs to reason about concurrent request races on the shared Map (two requests reading before either writes), unbounded memory growth from never evicting keys, and missing-header handling; genuine correctness reasoning, so frontier.
- **r-059** (edit): expected `mid`, predicted `fast` (difficulty 0.72, needs_reasoning 0.60)
  - Router: edit task, P(level 2+) 0.02 below 0.05 with balanced posture routes to fast; chose anthropic/claude-haiku-4.5
  - Notes: Requires noticing the shared formatting core across three differently-worded functions and designing a clean helper signature.
- **r-061** (edit): expected `mid`, predicted `fast` (difficulty 0.94, needs_reasoning 0.82)
  - Router: edit task, P(level 2+) 0.02 below 0.05 with balanced posture routes to fast; chose anthropic/claude-haiku-4.5
  - Notes: Needs to decide what 'required' checks look like (missing vs empty string vs type) and how to respond, a bit more than pure mechanics.
- **r-062** (edit): expected `frontier`, predicted `mid` (difficulty 1.32, needs_reasoning 0.91)
  - Router: edit task, P(hard) 0.00 below 0.10 and P(level 2+) 0.33 below 0.65 with balanced posture routes to mid; chose anthropic/claude-sonnet-5
  - Notes: Preserving exact behavior across mount/update/unmount semantics with hooks (avoiding stale closures, race conditions on rapid userId changes, and the unmount guard) is subtle enough to need frontier.
- **r-065** (edit): expected `frontier`, predicted `mid` (difficulty 1.39, needs_reasoning 0.88)
  - Router: edit task, P(hard) 0.00 below 0.10 and P(level 2+) 0.40 below 0.65 with balanced posture routes to mid; chose anthropic/claude-sonnet-5
  - Notes: Needs a design that adds multi-region support (provider aliases, for_each over regions) while guaranteeing zero-change behavior for existing single-region callers; frontier.
- **r-070** (feature): expected `fast`, predicted `mid` (difficulty 0.98, needs_reasoning 0.72)
  - Router: feature task, P(hard) 0.00 below 0.10 and P(level 2+) 0.06 below 0.65 with balanced posture routes to mid; chose anthropic/claude-sonnet-5
  - Notes: Textbook health-check endpoint, no design decisions.
- **r-072** (feature): expected `mid`, predicted `frontier` (difficulty 1.98, needs_reasoning 0.75)
  - Router: feature task, P(level 2+) 0.92 at or above 0.65 with balanced posture routes to frontier; chose anthropic/claude-opus-5
  - Notes: Needs a deterministic hashing scheme for consistent per-user rollout, a known pattern applied carefully, mid.
- **r-076** (feature): expected `frontier`, predicted `mid` (difficulty 1.36, needs_reasoning 0.90)
  - Router: feature task, P(hard) 0.03 below 0.10 and P(level 2+) 0.34 below 0.65 with balanced posture routes to mid; chose anthropic/claude-sonnet-5
  - Notes: Needs to design the version-check-and-increment as a single atomic operation to avoid a race between the check and the write, easy to implement incorrectly; frontier.
- **r-083** (debug): expected `fast`, predicted `mid` (difficulty 1.18, needs_reasoning 0.88)
  - Router: debug task, P(hard) 0.01 below 0.10 and P(level 2+) 0.22 below 0.65 with balanced posture routes to mid; chose anthropic/claude-sonnet-5
  - Notes: Textbook fix (default prop or guard clause), obvious once stated.
- **r-084** (debug): expected `fast`, predicted `mid` (difficulty 0.92, needs_reasoning 0.85)
  - Router: debug task, P(hard) 0.04 below 0.10 and P(level 2+) 0.15 below 0.65 with balanced posture routes to mid; chose anthropic/claude-sonnet-5
  - Notes: Off-by-one is immediately visible in a 3-line function.
- **r-089** (debug): expected `mid`, predicted `frontier` (difficulty 2.10, needs_reasoning 0.79)
  - Router: debug task, P(hard) 0.19 at or above 0.10 with balanced posture routes to frontier; chose anthropic/claude-opus-5
  - Notes: Root cause is directly stated in the setup (two parallel jobs applying the same workspace), standard fix is serializing them, mid.
- **r-097** (research): expected `fast`, predicted `frontier` (difficulty 1.83, needs_reasoning 0.92)
  - Router: research task, P(level 2+) 0.80 at or above 0.65 with balanced posture routes to frontier; chose anthropic/claude-opus-5
  - Notes: Standard factual comparison of well-documented tools.
- **r-099** (research): expected `mid`, predicted `frontier` (difficulty 2.04, needs_reasoning 0.95)
  - Router: research task, P(hard) 0.11 at or above 0.10 with balanced posture routes to frontier; chose anthropic/claude-opus-5
  - Notes: A grounded comparison against stated constraints, moderate synthesis but a well-trodden design space, mid.
- **r-102** (research): expected `mid`, predicted `frontier` (difficulty 2.05, needs_reasoning 0.95)
  - Router: research task, P(hard) 0.14 at or above 0.10 with balanced posture routes to frontier; chose anthropic/claude-opus-5
  - Notes: A grounded, constrained recommendation among three well-known options, moderate synthesis, mid.
- **r-112** (ops): expected `mid`, predicted `fast` (difficulty 0.80, needs_reasoning 0.59)
  - Router: ops task, P(level 2+) 0.02 below 0.05 with balanced posture routes to fast; chose anthropic/claude-haiku-4.5
  - Notes: Needs to know the setup-node `cache: pnpm` option and correct ordering relative to pnpm/action-setup, slightly more than copy-paste.

## Policy ceiling note

48.5% (n=16/33) of difficulty-band-2 examples in the dataset are labeled `mid`, and the rest `frontier`. Policy v1 could not tell those apart: it sent every expected difficulty at or above 2.0 to the frontier tier under balanced posture, which put a hard ceiling on band-2 agreement. Policy v2 reads the per-level probability masses instead (ADR-002 revision 2), so the band-2 row above measures how much of that ceiling the distribution actually lifts. The thresholds are per decision backend and were fitted on this dataset, so treat an in-sample number here as an upper bound; the cross-validated figure is in `run.test.ts`.
