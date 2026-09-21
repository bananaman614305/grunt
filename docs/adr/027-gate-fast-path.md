# ADR-027: Completeness-gate fast paths and a bounded retry

Status: accepted, 2026-09-21. Extends ADR-013 (the completeness gate, phase A)
and reuses ADR-026's structural intuitions. Nothing here changes
`packages/core/src/types.ts`: every new field rides the gateway-local
`GateRecord` extension the way `retryModel`/`lowConfidence`/`verify` already do,
and the new header/verdict string values are just strings (`GateUpstream.verdict`
is typed `string`).

## Context

The completeness gate (ADR-013, `runGate` in
`packages/gateway/src/routes/gate.ts`) runs on every band>=1, non-`low`-posture
routed answer -- the single forward's body, or the sampled fan-out's pick. As it
shipped it ALWAYS spends a Jev `checkCompleteness` call after the answer, and on
a failing or low-confidence verdict it fires a full retry on the strongest model
(`escalationFor`). Two things about that are wasteful:

- **It never inspects `finish_reason`.** An answer the caller's own `max_tokens`
  cap truncated (`finish_reason: "length"`) reads as "incomplete" to a text
  judge, so it draws a retry -- and the retry, generated under the same
  `max_tokens`, just re-truncates. Latency doubles for no benefit. This is the
  top gate complaint.
- **It spends a Jev call even on answers that are obviously complete.** A
  non-truncated answer that ends on a sentence terminator with balanced code
  fences is complete by inspection; paying Jev to confirm it adds a round trip
  to the common case.

On a **sampled** request the waste compounds: when the pick fails the gate we
send a fresh escalated retry even though the fan-out already generated, ranked,
and paid for several other complete candidates sitting in hand.

And a fresh retry has no time bound: an escalated retry on the strongest model
can run long, and a slow one blows up the tail latency of a request that already
has a serviceable answer.

## Decision

Four changes to `runGate`, all serving an answer on every path (the gate still
NEVER throws and NEVER fails a request), and all gated so the ADR-019
ground-truth `forceRetry` behaviour is preserved exactly.

### 1. Free local pre-gate: skip the Jev call when clearly complete

After the ADR-019 verify/`forceRetry` block is computed but before the
`checkCompleteness` call, and only when `!forceRetry`, a cheap local check reads
the buffered answer:

- `finishReason(json)` -- `choices[0].finish_reason` as a string, if any.
- `looksComplete(text)` -- true only when the trimmed answer is non-empty, has an
  **even** count of ``` fences (balanced), and ends on one of `.!?)]}"'` or a
  backtick. Conservative by design: a false negative just falls through to the
  Jev check, so a valid answer is never demoted.

When `finishReason === "stop"` and `looksComplete(answered)`, the answer is
served exactly as a passing check serves it -- `x-milo-completeness: complete`,
record `{ verdict: "complete", checkSkipped: true }` -- with **no Jev call**. The
verify disclosure still merges through the existing `withVerify(...)` wrapper.

### 2. Never retry a `max_tokens` truncation

In the same `!forceRetry` pre-check, **before** the change-1 clause: when
`finishReason === "length"`, the caller's own `max_tokens` cap truncated the
answer. A retry runs under the same cap and only re-truncates, so there is
nothing to gain. The answer is served as-is with `x-milo-completeness: truncated`
and record `{ verdict: "truncated" }` -- no Jev call, no retry. (Order: length
first, then stop+`looksComplete`; if neither matches, or `forceRetry` is set, the
existing `checkCompleteness` path runs unchanged.)

### 3. Reuse a best-of-N sibling before a fresh retry (sampled path only)

`GateRunner`/`runGate` take an optional `siblings?: GateAnswer[]` -- the other
finished sample answers, ranked best-first, already generated on a sampled
request (the single-forward call in `chat.ts` passes none, so its behaviour is
unchanged). When the verdict path has decided a retry is warranted, before
building the fresh retry we scan `siblings` in rank order for the first one that
is complete by the SAME cheap test as change 1
(`finishReason(s.json) === "stop" && looksComplete(s.text)`). If one qualifies we
serve THAT sibling instead of a fresh retry: `x-milo-gate-pick: "sibling"`,
`x-milo-completeness` carries the disclosed verdict, `x-milo-retry` is NOT set
(no upstream retry happened), record `{ ...verdict, pick: "sibling",
checkSkipped: true }`, and **no** `extraUsage` -- nothing new was generated.
Only when no sibling qualifies do we fall through to the existing fresh-retry
logic.

### 4. Bound the fresh retry with a hard time budget

When a fresh retry IS sent, it runs under an `AbortController` whose timeout is
`GATE_RETRY_BUDGET_MS` (30000 ms). A retry normally finishes well under this; the
cap exists so a slow escalated retry cannot blow up tail latency on a request
that already holds a serviceable answer. On abort/timeout the existing `catch`
serves the original (an `AbortError` already `classify`s as `"timeout"` into
`record.retry.error`).

The escalation MODEL choice (`escalationFor`, the strongest the decision knows
about) is deliberately UNCHANGED. The time budget is the latency bound;
downgrading the retry model would hurt the retry's fix-rate, which is the whole
reason the retry escalates in the first place (ADR-013). Bounding the wall clock
gets the tail-latency protection without giving up the escalation's quality.

## No `types.ts` change

`GateUpstream.verdict` is `string`, so `"truncated"` and the sibling's disclosed
verdict need no contract change, and the new header/pick values are plain
strings. `checkSkipped` is a purely additive gateway-local field on `GateRecord`
(`GateUpstream & { … }`), exactly like `retryModel`, `lowConfidence`, and
`verify`; the decision log stores the gate block as JSON, so it round-trips
without touching the core type. `siblings` is a runner argument, not a stored
type. Folding any of these into `GateUpstream` itself would need its own ADR.

## Consequences

The obvious-complete case skips a Jev round trip; a `max_tokens` truncation never
buys a re-truncating retry; a sampled pick that fails the gate reuses an
already-paid-for complete sibling before spending a fresh generation; and any
fresh retry that does fire is bounded to 30 s. The changes are conservative and
local: a false negative on `looksComplete` merely falls through to the Jev check
as before, `forceRetry` (ADR-019) still overrides every fast path, and every new
path serves an answer.
