# ADR-014: Context pruning (ADR-013 phase C, gate 6)

Status: accepted, 2026-09-18. Implements the sixth gate scoped in ADR-013
("Context pruning. Jev scores conversation chunks for relevance and Milo
drops the rest before forwarding. Opt-in per request because it edits the
caller's message history"). Adapts the compact-adviser project, which uses
Jev to decide when older context is safe to shed.

## Context

A long-running sub-agent accumulates a conversation whose oldest turns --
the first tool loop, an already-finished sub-task, a superseded plan -- no
longer bear on the current request but are re-sent, and re-billed as input
tokens, on every turn. The frontier orchestrator on the user's own
subscription pays for that; Milo's job is the cheap half of the pair, and
the cheapest token is one never sent. ADR-013 scoped a gate for exactly
this and made it opt-in, because unlike the other five gates it edits the
caller's own `messages` array rather than only classifying or disclosing.

## Decision

A new routed gate on `POST /v1/chat/completions`, off by default, that asks
Jev whether the earliest context is safe to shed and, when it is, replaces a
contiguous older range with one short marker before the request is
forwarded. The saved input tokens are the entire point.

**When it fires.** Only on a routed request whose message history exceeds a
token floor (`pruning.minContextTokens`, default 40,000; tokens estimated as
characters / 4, the router's own approximation). Off unless the deployment
sets `pruning.enabled` or the request sends `milo: { prune: true }`; a
per-request `milo: { prune: false }` always wins. It never fires on `low`
posture ("cheap" is a promise), and never without a Jev client to ask.

**The Jev call.** One `systemone` call over the conversation, separate from
and never touching the router's own routing call, with two compact-adviser
questions (`packages/core/src/router/pruning.ts`):

- `oldest_finished` (noul): is the earliest unit of work in this
  conversation finished and safe to drop?
- `prunable` (score, 0..3): how prunable is the older context -- from
  "still load-bearing, keep it" to "fully superseded, safe to shed".

**The sliding threshold** (faithful to compact-adviser). The confidence
floor to act loosens as the context fills: 0.90 when at most 10% of the
model's context window is used, falling linearly to 0.50 at 90% or more.
Milo prunes only when `oldest_finished` clears the floor at the current
fill, and only when `prunable` is at least `PRUNE_MIN_SCORE` (1.0). The
`prunable` score then sets how much of the safe window to drop
(`prunable / 3` of it), snapped down to a tool-group boundary. Fill ratio is
the estimated input tokens over the picked model's `contextLength`
(`DEFAULT_ROSTER_INFO`), else `pruning.contextWindowTokens`
(default 128,000).

**Safety (critical -- this edits the caller's history).** `prunableWindow`
and `decidePrune` are pure and exhaustively unit-tested. The invariants:

1. never drop a system or developer message;
2. never drop the latest user turn or anything after it;
3. never split an open tool-call / tool-result pair -- the droppable window
   is aligned to whole tool groups (an assistant message bearing
   `tool_calls` plus its trailing `tool` results), and a stray `tool`
   message with no in-window call is treated as protected;
4. only ever a single contiguous older range;
5. prefer **summarize** over silent deletion: the dropped range is replaced
   by one system note, `[earlier context pruned by Milo: <n> messages]`, so
   the model sees that context was shed.

**Disclosure and control.** `x-milo-pruned` (messages dropped) and
`x-milo-pruned-tokens` (approx input tokens saved) on the response. The
decision record's `upstream` block gains a `prune` block with counts only
(dropped, tokens saved, the range, the verdict confidence, the floor, the
fill ratio) -- no content, like every other decision-log field.

## types.ts

Two additive edits, licensed by this ADR and kept minimal:

- `MiloRequestExtension.prune?: boolean` -- the per-request opt-in/opt-out.
  Both values are meaningful (unlike `brief`/`gates`, which are default-on
  and only read `false`), because pruning is default-off.
- `DecisionRecord["upstream"].prune?: PruneUpstream` -- the counts block. It
  is a top-level field rather than a gateway-local cast (the `SampleRow`
  /`GateRecord` precedent) because, unlike `aborted`/`retryModel`, it has no
  parent contract to extend; a documented type is cleaner than an untyped
  round-trip through the JSON column.

`POLICY_VERSION` is unchanged: pruning moves no routing threshold.

## Consequences

Jev spend on a pruned request rises by one classification call (still under
a tenth of a cent), paid only on requests over the token floor with the gate
enabled. The win is fewer input tokens forwarded on every subsequent turn of
a long conversation. Because it edits history, it stays opt-in until the pi
benchmark (ADR-013 phase B) prices its savings against its failure rate; the
`prune-measure` script reports tokens-before vs tokens-after on a
long-history fixture so that number exists before any default changes.

## Measurement

`pnpm --filter @milo/evals exec tsx scripts/prune-measure.ts` runs the pure
pipeline over a bundled long-history fixture and prints tokens-before,
tokens-after and the saving. See `docs/evals.md`.
