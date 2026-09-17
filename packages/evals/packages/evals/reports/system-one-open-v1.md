# Routing eval report

- Posture: `balanced`
- Policy version: `v1`
- Generated: 2026-09-17T16:26:36.238Z
- Examples: 120 total — 120 scored, 0 unscored

## Unscored

Every example was scored.

## Tier agreement

Overall: 69.2% (n=120)

### By task type

| task type | agreement | n |
| --- | --- | --- |
| chat | 58.3% | 12 |
| edit | 69.2% | 13 |
| feature | 92.9% | 14 |
| debug | 61.5% | 13 |
| research | 46.2% | 13 |
| review | 66.7% | 12 |
| docs | 75.0% | 12 |
| ops | 76.9% | 13 |
| classify | 72.2% | 18 |

### By difficulty band

| band | agreement | n |
| --- | --- | --- |
| 0 | 100.0% | 27 |
| 1 | 62.9% | 35 |
| 2 | 42.4% | 33 |
| 3 | 80.0% | 25 |

## Task-type accuracy

Jev's `task_type` matched the dataset label 76.7% of the time (n=120).

## Tier confusion matrix (rows: expected, columns: predicted)

| expected \ predicted | fast | mid | frontier |
| --- | --- | --- | --- |
| fast | 44 | 3 | 0 |
| mid | 15 | 13 | 3 |
| frontier | 1 | 15 | 26 |

## Jev latency

Mean: 390 ms; p95: 454 ms (n=120)

## Disagreements

- **r-007** (chat): expected `mid`, predicted `fast` (difficulty 0.98, needs_reasoning 0.88)
  - Router: chat task, difficulty 0.98 is below 1, so any posture routes to fast; chose anthropic/claude-haiku-4.5
  - Notes: Needs to weigh the async/distributed constraint against generic icebreaker advice, light reasoning, so mid.
- **r-008** (chat): expected `mid`, predicted `fast` (difficulty 0.71, needs_reasoning 0.63)
  - Router: chat task, difficulty 0.71 is below 1, so any posture routes to fast; chose anthropic/claude-haiku-4.5
  - Notes: Requires synthesizing a balanced take rather than reciting a list, mid.
- **r-010** (chat): expected `mid`, predicted `fast` (difficulty 0.29, needs_reasoning 0.93)
  - Router: chat task, difficulty 0.29 is below 1, so any posture routes to fast; chose anthropic/claude-haiku-4.5
  - Notes: Genuinely needs reasoning about the person's specifics, would be frontier-worthy under general policy, but task_type chat caps at mid at band 2.
- **r-011** (chat): expected `mid`, predicted `fast` (difficulty 0.81, needs_reasoning 0.90)
  - Router: chat task, difficulty 0.81 is below 1, so any posture routes to fast; chose anthropic/claude-haiku-4.5
  - Notes: Needs real constraint-juggling reasoning, but capped at mid because task_type is chat and band is only 2, not 3.
- **r-012** (chat): expected `frontier`, predicted `mid` (difficulty 1.47, needs_reasoning 0.41)
  - Router: chat task, difficulty 1.47 with needs_reasoning 0.41 below 0.5 and balanced posture routes to mid; chose anthropic/claude-sonnet-5
  - Notes: Sustained adversarial philosophical argumentation across turns is genuinely hard reasoning; band 3 lifts the chat/classify cap, so frontier.
- **r-024** (classify): expected `mid`, predicted `fast` (difficulty 0.54, needs_reasoning 0.76)
  - Router: review task, difficulty 0.54 is below 1, so any posture routes to fast; chose anthropic/claude-haiku-4.5
  - Notes: Requires checking against a spec and explaining the deviation (missing type prefix, two changes bundled), more than pattern match.
- **r-026** (classify): expected `mid`, predicted `fast` (difficulty 0.92, needs_reasoning 0.61)
  - Router: classify task, difficulty 0.92 is below 1, so any posture routes to fast; chose anthropic/claude-haiku-4.5
  - Notes: Needs to compare phrasing and infer that 1 and 2 are the same bug while 3 is a different, unrelated feature request.
- **r-027** (classify): expected `mid`, predicted `fast` (difficulty 0.57, needs_reasoning 0.48)
  - Router: classify task, difficulty 0.57 is below 1, so any posture routes to fast; chose anthropic/claude-haiku-4.5
  - Notes: Requires reasoning about row-level locking behavior under concurrent decrements, not just classifying the verb.
- **r-028** (classify): expected `mid`, predicted `fast` (difficulty 0.76, needs_reasoning 0.63)
  - Router: classify task, difficulty 0.76 is below 1, so any posture routes to fast; chose anthropic/claude-haiku-4.5
  - Notes: Distinguishing tone-based churn risk (2, 5, 7) from surface sentiment needs real reasoning, but classify caps at mid even at band 2.
- **r-030** (classify): expected `frontier`, predicted `fast` (difficulty 0.76, needs_reasoning 0.72)
  - Router: classify task, difficulty 0.76 is below 1, so any posture routes to fast; chose anthropic/claude-haiku-4.5
  - Notes: Deliberately overlapping legal categories and a clause that touches sub-processing, retention, and liability cap simultaneously; band 3 lifts the classify cap to frontier.
- **r-034** (docs): expected `fast`, predicted `mid` (difficulty 1.06, needs_reasoning 0.55)
  - Router: docs task, difficulty 1.06 with needs_reasoning 0.55 at or above 0.5 routes to mid; chose anthropic/claude-sonnet-5
  - Notes: Boilerplate instructions from known commands, low reasoning.
- **r-037** (docs): expected `mid`, predicted `fast` (difficulty 0.95, needs_reasoning 0.58)
  - Router: docs task, difficulty 0.95 is below 1, so any posture routes to fast; chose anthropic/claude-haiku-4.5
  - Notes: Requires inferring both success and error response shapes and writing them out clearly, mild reasoning.
- **r-041** (docs): expected `frontier`, predicted `mid` (difficulty 1.96, needs_reasoning 0.91)
  - Router: docs task, difficulty 1.96 with needs_reasoning 0.91 at or above 0.5 routes to mid; chose anthropic/claude-sonnet-5
  - Notes: Needs careful reasoning to match mitigations to threat classes and correctly identify the VPN timeout as only a partial mitigation for a stolen, already-authenticated laptop; frontier.
- **r-047** (review): expected `mid`, predicted `fast` (difficulty 0.43, needs_reasoning 0.42)
  - Router: debug task, difficulty 0.43 is below 1, so any posture routes to fast; chose anthropic/claude-haiku-4.5
  - Notes: Needs to spot a second-order issue (integer division truncation) after the first is found, mild reasoning.
- **r-049** (review): expected `frontier`, predicted `mid` (difficulty 1.63, needs_reasoning 0.67)
  - Router: review task, difficulty 1.63 with needs_reasoning 0.67 at or above 0.5 routes to mid; chose anthropic/claude-sonnet-5
  - Notes: Needs to reason about concurrent request races on the shared Map (two requests reading before either writes), unbounded memory growth from never evicting keys, and missing-header handling; genuine correctness reasoning, so frontier.
- **r-050** (review): expected `frontier`, predicted `mid` (difficulty 1.74, needs_reasoning 0.93)
  - Router: review task, difficulty 1.74 with needs_reasoning 0.93 at or above 0.5 routes to mid; chose anthropic/claude-sonnet-5
  - Notes: The refactor swaps jwt.verify for jwt.decode, silently dropping signature verification, and adds a token-in-query-string vector; spotting both requires careful security reasoning, frontier.
- **r-051** (review): expected `mid`, predicted `fast` (difficulty 0.73, needs_reasoning 0.61)
  - Router: ops task, difficulty 0.73 is below 1, so any posture routes to fast; chose anthropic/claude-haiku-4.5
  - Notes: Requires reasoning about deploy ordering causing the app to reference a dropped column, a fairly standard migration-safety pattern, mid.
- **r-059** (edit): expected `mid`, predicted `fast` (difficulty 0.72, needs_reasoning 0.60)
  - Router: edit task, difficulty 0.72 is below 1, so any posture routes to fast; chose anthropic/claude-haiku-4.5
  - Notes: Requires noticing the shared formatting core across three differently-worded functions and designing a clean helper signature.
- **r-061** (edit): expected `mid`, predicted `fast` (difficulty 0.94, needs_reasoning 0.82)
  - Router: edit task, difficulty 0.94 is below 1, so any posture routes to fast; chose anthropic/claude-haiku-4.5
  - Notes: Needs to decide what 'required' checks look like (missing vs empty string vs type) and how to respond, a bit more than pure mechanics.
- **r-062** (edit): expected `frontier`, predicted `mid` (difficulty 1.32, needs_reasoning 0.91)
  - Router: edit task, difficulty 1.32 with needs_reasoning 0.91 at or above 0.5 routes to mid; chose anthropic/claude-sonnet-5
  - Notes: Preserving exact behavior across mount/update/unmount semantics with hooks (avoiding stale closures, race conditions on rapid userId changes, and the unmount guard) is subtle enough to need frontier.
- **r-065** (edit): expected `frontier`, predicted `mid` (difficulty 1.39, needs_reasoning 0.88)
  - Router: edit task, difficulty 1.39 with needs_reasoning 0.88 at or above 0.5 routes to mid; chose anthropic/claude-sonnet-5
  - Notes: Needs a design that adds multi-region support (provider aliases, for_each over regions) while guaranteeing zero-change behavior for existing single-region callers; frontier.
- **r-076** (feature): expected `frontier`, predicted `mid` (difficulty 1.36, needs_reasoning 0.90)
  - Router: feature task, difficulty 1.36 with needs_reasoning 0.9 at or above 0.5 routes to mid; chose anthropic/claude-sonnet-5
  - Notes: Needs to design the version-check-and-increment as a single atomic operation to avoid a race between the check and the write, easy to implement incorrectly; frontier.
- **r-083** (debug): expected `fast`, predicted `mid` (difficulty 1.18, needs_reasoning 0.88)
  - Router: debug task, difficulty 1.18 with needs_reasoning 0.88 at or above 0.5 routes to mid; chose anthropic/claude-sonnet-5
  - Notes: Textbook fix (default prop or guard clause), obvious once stated.
- **r-086** (debug): expected `frontier`, predicted `mid` (difficulty 1.75, needs_reasoning 0.87)
  - Router: debug task, difficulty 1.75 with needs_reasoning 0.87 at or above 0.5 routes to mid; chose anthropic/claude-sonnet-5
  - Notes: The log pattern suggests a proxy timeout specific to slower upstream responses under concurrency, needing hypothesis formation across several log lines and a decision-relevant correlation (tier vs failure); frontier.
- **r-088** (debug): expected `frontier`, predicted `mid` (difficulty 1.67, needs_reasoning 0.95)
  - Router: debug task, difficulty 1.67 with needs_reasoning 0.95 at or above 0.5 routes to mid; chose anthropic/claude-sonnet-5
  - Notes: The close handler removes from `subscriptions` but never calls `eventBus.off(handler)`, so the eventBus itself retains every handler forever; noticing the asymmetry between the two registries takes careful tracing, frontier.
- **r-089** (debug): expected `mid`, predicted `frontier` (difficulty 2.10, needs_reasoning 0.79)
  - Router: debug task, difficulty 2.1 with balanced posture routes to frontier; chose anthropic/claude-opus-5
  - Notes: Root cause is directly stated in the setup (two parallel jobs applying the same workspace), standard fix is serializing them, mid.
- **r-090** (debug): expected `mid`, predicted `fast` (difficulty 1.00, needs_reasoning 0.79)
  - Router: debug task, difficulty 1 is below 1, so any posture routes to fast; chose anthropic/claude-haiku-4.5
  - Notes: Diagnosis was already supplied in the prior turn; remaining work is picking a robust fix (pad the wait or use fake timers), mid.
- **r-097** (research): expected `fast`, predicted `mid` (difficulty 1.83, needs_reasoning 0.92)
  - Router: research task, difficulty 1.83 with needs_reasoning 0.92 at or above 0.5 routes to mid; chose anthropic/claude-sonnet-5
  - Notes: Standard factual comparison of well-documented tools.
- **r-099** (research): expected `mid`, predicted `frontier` (difficulty 2.04, needs_reasoning 0.95)
  - Router: research task, difficulty 2.04 with balanced posture routes to frontier; chose anthropic/claude-opus-5
  - Notes: A grounded comparison against stated constraints, moderate synthesis but a well-trodden design space, mid.
- **r-101** (research): expected `frontier`, predicted `mid` (difficulty 1.82, needs_reasoning 0.51)
  - Router: research task, difficulty 1.82 with needs_reasoning 0.51 at or above 0.5 routes to mid; chose anthropic/claude-sonnet-5
  - Notes: Requires synthesizing ML calibration concepts and proposing a practical detection method without labels, genuinely open-ended reasoning, frontier.
- **r-102** (research): expected `mid`, predicted `frontier` (difficulty 2.05, needs_reasoning 0.95)
  - Router: research task, difficulty 2.05 with balanced posture routes to frontier; chose anthropic/claude-opus-5
  - Notes: A grounded, constrained recommendation among three well-known options, moderate synthesis, mid.
- **r-104** (research): expected `frontier`, predicted `mid` (difficulty 1.53, needs_reasoning 0.93)
  - Router: research task, difficulty 1.53 with needs_reasoning 0.93 at or above 0.5 routes to mid; chose anthropic/claude-sonnet-5
  - Notes: Requires reasoning about GDPR sub-processor disclosure obligations against a concrete, incomplete privacy-policy draft and identifying the specific gap (Jev unmentioned); frontier.
- **r-106** (research): expected `frontier`, predicted `mid` (difficulty 1.89, needs_reasoning 0.97)
  - Router: feature task, difficulty 1.89 with needs_reasoning 0.97 at or above 0.5 routes to mid; chose anthropic/claude-sonnet-5
  - Notes: Requires connecting calibration-drift theory to a concrete, constrained schema and designing a monitoring approach without adding new fields; frontier.
- **r-107** (research): expected `frontier`, predicted `mid` (difficulty 1.85, needs_reasoning 0.97)
  - Router: research task, difficulty 1.85 with needs_reasoning 0.97 at or above 0.5 routes to mid; chose anthropic/claude-sonnet-5
  - Notes: Open-ended competitive synthesis translated into concrete, roadmap-consistent recommendations; frontier.
- **r-112** (ops): expected `mid`, predicted `fast` (difficulty 0.80, needs_reasoning 0.59)
  - Router: ops task, difficulty 0.8 is below 1, so any posture routes to fast; chose anthropic/claude-haiku-4.5
  - Notes: Needs to know the setup-node `cache: pnpm` option and correct ordering relative to pnpm/action-setup, slightly more than copy-paste.
- **r-114** (ops): expected `frontier`, predicted `mid` (difficulty 1.99, needs_reasoning 0.92)
  - Router: feature task, difficulty 1.99 with needs_reasoning 0.92 at or above 0.5 routes to mid; chose anthropic/claude-sonnet-5
  - Notes: Multiple interacting infra components (primary, replica, pooler, backup schedule) that must be wired together correctly; frontier.
- **r-115** (ops): expected `frontier`, predicted `mid` (difficulty 1.99, needs_reasoning 0.88)
  - Router: ops task, difficulty 1.99 with needs_reasoning 0.88 at or above 0.5 routes to mid; chose anthropic/claude-sonnet-5
  - Notes: Requires designing the traffic-cutover and rollback trigger logic correctly, not just applying a template; frontier.

## Policy ceiling note

48.5% (n=16/33) of difficulty-band-2 examples in the dataset are labeled `mid`. Policy v1 sends difficulty at or above 2.0 under balanced posture to the frontier tier (docs/PLAN.md § Policy v1, ADR-002), so the static labels and the policy table diverge at band 2 by construction. This is a known divergence between the labels and the table that the orchestrator will settle from the live run, not a defect in this report.
