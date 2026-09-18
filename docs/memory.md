# Preference memory

Milo remembers *how you like answers made* — not what you said — and applies
it to every routed request from your key, on any client, forever, until you
delete it. This is ADR-011; the short version follows.

## Why the gateway, not the harness

Harness-side memory (a CLAUDE.md, a memory file) lives inside a context
window and gets compacted away, so you re-teach the same preferences to
every agent, every session. Milo sits at the one chokepoint every request
already crosses and already recognizes callers without storing keys (the
ADR-008 key hash), so a preference taught once survives any client's
compaction — and can shape routing itself, which no prompt can.

## What gets stored

One row per (your key hash, scope, field). The field vocabulary is closed —
twelve fields in two families:

| Family | Field | Values |
|---|---|---|
| routing-shaping | `posture_default` | `low`, `balanced`, `quality` |
| routing-shaping | `tier_floor` | `fast`, `mid`, `frontier` |
| routing-shaping | `sampling` | `on`, `off` |
| output-shaping | `verbosity` | `concise`, `balanced`, `detailed` |
| output-shaping | `format` | `prose`, `bullets`, `code_first` |
| output-shaping | `evidence_style` | `citations`, `examples`, `assertions` |
| output-shaping | `testing_depth` | `none`, `smoke`, `thorough` |
| output-shaping | `tone` | `friendly`, `direct`, `jovial`, `professional` |
| output-shaping | `working_style` | `test_first`, `code_first`, `plan_first`, `just_do` |
| output-shaping | `change_autonomy` | `ask_first`, `autonomous` |
| output-shaping | `verification_depth` | `light`, `standard`, `thorough` |
| output-shaping | `explanation_style` | `code_first`, `explain_then_code`, `code_only` |

`scope` is `global` or one task type (`edit`, `docs`, …); a task-scoped row
beats the global one for that task type. Each row carries a confidence, a
version, and a provenance — the fingerprint hash of the conversation that
taught it. **No message content is ever stored** (the ADR-003 line): the
value is always one of the labels above, and the store refuses anything
else.

## How a preference gets learned

Two Jev questions ride the routing call Milo already makes for every
`milo/auto` request: *does the latest user turn state a durable preference
about how answers should be produced or presented*, and *which field*. Only
when that fires — say you told your agent "never add tests unless I ask" —
does Milo spend one extra Jev call resolving the value as a choice over that
field's closed vocabulary. Classification only, never generation; weak
detections are dropped, not stored.

Saying the same thing again raises the row's confidence (capped at 1).
Saying the opposite replaces the value, bumps the version, and resets
confidence. Nothing waits on any of this: capture runs after your response
is already on its way.

## What the memory does

**Output-shaping** rows compile into the *brief*: a deterministic system
message (fixed template per field, ranked by confidence then recency, hard
cap 300 tokens ≈ 1,200 chars) appended as the final message of routed
requests only. The response then carries `x-milo-brief-version`, a hash of
exactly the rows that shaped it — no header, no brief.

**Routing-shaping** rows never enter the prompt. They set your default
posture, tier floor and sampling before the policy runs, so "I care about
quality, not cost" changes which model answers, not just how.

## Seeing, skipping, deleting

```
GET    /v1/preferences        # every stored row, with provenance, plus your switches
DELETE /v1/preferences/:id    # remove one row
```

Both are scoped to your bearer key: nobody else's key can read or delete
your rows, and rotating your key orphans them entirely.

- Per request: `"milo": { "brief": false }` skips injection on that call.
- Per key: the `briefEnabled` / `captureEnabled` switches turn the brief or
  capture off for everything from your key.

Full endpoint shapes: [`docs/api/gateway.md`](api/gateway.md). The binding
decision: [`adr/011-preference-memory.md`](adr/011-preference-memory.md).
