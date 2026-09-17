# Routing eval set — labeling rules

`routing.jsonl` is 120 labeled prompts used to check the router's tier choice
against a human judgment call (`pnpm eval`, task 2.3) and to gate policy
changes (ADR-002: at least 85% agreement before bumping `POLICY_VERSION`).
This document is the labeling spec: a second labeler should be able to read
it, look at a new prompt, and produce the same label a first labeler would.

Each row is one JSON object:

```json
{
  "id": "r-001",
  "messages": [ { "role": "system", "content": "..." }, { "role": "user", "content": "..." } ],
  "has_tools": false,
  "task_type": "chat",
  "difficulty_band": 0,
  "expected_tier_balanced": "fast",
  "notes": "why this label"
}
```

- `messages` is OpenAI-shaped (`ChatMessage` in `packages/core/src/types.ts`).
  A leading `system` message is optional.
- `has_tools` records whether the *request* carried a `tools` array (i.e.
  whether this looks like an agentic call site), independent of whether any
  message in the transcript shows a tool being invoked.
- `task_type` is one of the 9 values in `TASK_TYPES`
  (`chat, edit, feature, debug, research, review, docs, ops, classify`).
- `difficulty_band` is the Jev difficulty score itself: an integer 0-3, not
  a bucketed continuous value. ADR-002 asks Jev for `difficulty` as "a score,
  4 levels, 0..3" — the band *is* that score.
- `expected_tier_balanced` is the tier (`fast`, `mid`, `frontier`) a labeler
  believes Policy v1 should produce for this prompt at `posture: "balanced"`.
  It is a label for evaluating the router, not something the router
  computes for you.
- `notes` explains the label in one or two sentences, in particular *why*
  a band-1 or band-2 example landed on the tier it did.

## How to assign `difficulty_band`

Read the prompt the way Jev would: as a compact view of the conversation
(system prompt, last few user turns, whether tools are present). Ask how
much a competent engineer would need to think, not how long the prompt is —
length and difficulty are different axes on purpose.

- **Band 0 — trivial.** Single fact, one-line mechanical edit, obvious
  confirmation. No real decision to make.
- **Band 1 — some judgment, but shallow.** A short, well-scoped task with
  one reasonable answer once you read it; a small amount of domain
  knowledge might be needed, but there's no real ambiguity or design space.
- **Band 2 — real reasoning, but bounded.** Multiple interacting pieces,
  genuine tradeoffs, or a bug/design question whose answer isn't obvious
  from the first read. This is where "does it need reasoning" starts to
  matter for the label (see below).
- **Band 3 — hard.** Requires holding several pieces of context at once,
  spotting a non-obvious interaction (a race, a contradiction between
  documents, a subtle security gap), or synthesizing across a genuinely
  large or open-ended input. Usually money-moving, security-sensitive,
  architecturally significant, or just large in scope.

## How to assign `expected_tier_balanced`

This eval set encodes the *intended* routing outcome at `posture: "balanced"`,
specialized to a discrete band instead of a continuous difficulty score. The
rule below was written against Policy v1 (ADR-002) and the labels have not
moved since; policy v2 is measured against these same labels, so they remain
the independent target rather than a restatement of the current table:

| band | rule |
|---|---|
| 0 | always `fast` |
| 1 | `fast` if little reasoning is needed, else `mid` — judgment call, explain it in `notes` |
| 2 | `mid` or `frontier` depending on whether real reasoning is needed — judgment call, explain it in `notes` |
| 3 | always `frontier` |

**The `chat`/`classify` cap.** Per the policy table, `task_type` of `chat`
or `classify` caps at `mid` unless difficulty is high enough to be "in
spirit" `>= 2.5`. Since bands are discrete, we treat band 3 as satisfying
that condition (it's the top band) and band 2 as not satisfying it. So for
`chat`/`classify` specifically:

- band 0 -> `fast`, band 1 -> `fast`/`mid` (same as any other type),
- band 2 -> **always `mid`**, even if the prompt would otherwise read as
  needing frontier-level reasoning — the cap overrides the reasoning call,
- band 3 -> `frontier` (the cap lifts).

For every other `task_type`, band 2 is `mid` or `frontier` depending on the
reasoning judgment call, with no cap.

## Worked examples, two per band

**Band 0**

- `r-001` (`chat`): `"hey, what's up"` -> `fast`. Pure small talk, nothing
  to reason about.
- `r-043` (`review`): *"Does this follow our style guide:
  `let x=5` should be `const x = 5;`? Confirm."* -> `fast`. One rule,
  already stated, just confirm it.

**Band 1**

- `r-006` (`chat`): asking whether `userCount` or `numUsers` is more
  idiomatic -> `fast`. Feels like it should need thought, but it's really a
  style-preference lookup with a clear conventional answer — "little
  reasoning" wins.
- `r-048` (`review`): reviewing a Postgres `ALTER TABLE ... ADD COLUMN ...
  NOT NULL DEFAULT` migration against a 40M-row table -> `mid`. Requires
  actual domain knowledge (does the Postgres 15 fast-path default apply
  here?) rather than a style check, so it crosses into "needs reasoning."

**Band 2**

- `r-064` (`edit`): add a running-total window function to an existing SQL
  query, filters unchanged -> `mid`. A single well-known SQL pattern
  (`SUM() OVER (PARTITION BY ... ORDER BY ...)`) applied to a query that's
  already fully specified — mechanical once you know the pattern, not a
  deep reasoning task, so it stays at `mid` rather than escalating.
- `r-049` (`review`): review a rate-limiting middleware diff for
  correctness and thread-safety -> `frontier`. The diff *looks* like a
  normal code review, but correctly spotting the shared-`Map` race
  condition and unbounded memory growth requires real concurrency
  reasoning, so it escalates past `mid` even though it's "only" band 2.

**Band 3**

- `r-080` (`feature`): implement Milo's own router module (question
  construction, policy table, roster resolution, sticky cache, degraded
  fallback) against ADR-002 -> `frontier`. Multi-part, correctness-critical,
  spec-driven; no discretion needed on the label, band 3 is always
  `frontier`.
- `r-030` (`classify`): classify one contract clause into 1 of 12
  deliberately overlapping legal risk categories -> `frontier`. Note that
  `classify` normally caps at `mid`, but band 3 lifts the cap — the clause
  genuinely spans three category boundaries at once, matching the band.

## Known ambiguity

- **`debug` vs `edit`.** When the fix is already obvious from the bug
  report (an off-by-one in a 3-line function, a clearly-missing null
  guard), the example is closer to `edit` in spirit even if it's phrased as
  "here's a bug, fix it." We kept these as `task_type: "debug"` when the
  user's framing is "something is broken, find out why," and `"edit"` when
  the framing already names the specific change to make — but a second
  labeler could reasonably draw that line differently for the band-1
  examples in each set (e.g. `r-083`, `r-084` vs `r-057`, `r-058`). This
  doesn't change `difficulty_band` or the tier, only the `task_type` label,
  so it's a minor source of disagreement, not a labeling error.
- **`feature` vs `edit` for "add X to existing Y."** Adding a field, a
  route, or an export param to something that already exists could be
  filed as either. We used `edit` when the change is localized to a
  function or a handful of lines and `feature` when it adds new
  user-visible behavior or a new code path, but the boundary (e.g. `r-071`
  pagination params, filed as `feature`) is genuinely fuzzy.
- **`review` vs `debug`.** A review that's really "find the bug in this
  diff" (e.g. `r-049`, `r-050`, `r-052`) reads a lot like `debug`. We used
  `review` whenever the prompt frames it as reviewing a diff/PR someone
  else wrote, and `debug` when the prompt frames it as an incident or a
  reported symptom with no diff attached.
- **Band 1 vs band 2 "needs reasoning" line.** This is the single biggest
  source of expected disagreement between labelers, by design — it's the
  same ambiguity the router itself has to resolve from Jev's calibrated
  probabilities, not a defect in the label. When in doubt, `notes` says
  explicitly what tipped it one way, so a reviewer can push back on that
  specific claim rather than re-deriving the whole judgment.
- **`ops` vs `feature` for infra-as-code.** Writing a Terraform module is
  arguably "building a feature" for the infra layer. We kept anything whose
  deliverable is infrastructure configuration (Terraform, Fly.io config, CI
  workflows, deployment pipelines) as `ops`, and anything whose deliverable
  is application code as `feature`, even when both involve design work.
