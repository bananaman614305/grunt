# ADR-011: Preference memory and the injected brief

Status: accepted, 2026-09-18. Amends ADR-003 (what Milo stores) and the
pass-through rule in ADR-002; design capsule from docs/HORIZON.md.

## Context

Harness-side memory (CLAUDE.md, memory files) lives inside a context window
and gets compacted away; the user re-teaches the same preferences forever.
Milo sits at the one chokepoint every request already crosses and already
recognizes callers without storing keys (ADR-008's key-hash rosters), so
preferences kept server-side survive any client's compaction. Preferences
also have to shape routing itself: a user who values precision over pennies
should get a different posture, and different sampling cells, than one who
values cost.

## Decision

**Store.** A `preferences` table in the gateway's libsql database (decision
log migration v4), keyed like rosters by the SHA-256 of the bearer
credential (or the account for `mk_` keys). One row per (caller, scope,
field): scope is `global` or a task type; fields are a closed vocabulary in
two families — routing-shaping (`posture_default`, `tier_floor`,
`sampling`) and output-shaping (`verbosity`, `format`, `evidence_style`,
`testing_depth`). Each row carries value, confidence, version, timestamps,
and provenance as the fingerprint hash of the teaching turn. **No raw
message content is ever stored** — that is the ADR-003 line this ADR
deliberately does not cross; what is stored is a closed-vocabulary label.

**Capture.** Detection rides the routing call: two questions added to the
existing per-request Jev systemone (a noul "does the latest user turn state
a durable preference about how answers should be produced or presented",
plus a choice over the field vocabulary). Only when detection fires does a
second, targeted Jev call resolve the value as a choice over that field's
closed vocabulary. Classification only, never generation. Repetition
raises confidence; contradiction replaces the value and re-versions it.

**Brief.** Output-shaping preferences compile deterministically (fixed
template per field, ranked by confidence then recency) into a brief capped
at 300 tokens, appended as a final system message to routed requests only.
Routing-shaping preferences never enter the prompt; they set the default
posture and sampling cells for that caller before the policy runs.

**Disclosure and control.** `x-milo-brief-version` names the brief that
shaped a response; `GET /v1/preferences` lists every stored row with
provenance, `DELETE /v1/preferences/:id` removes one, and `milo: { brief:
false }` skips injection per request; a per-key setting disables capture
entirely. The README's pass-through contract changes from "only the model
field is rewritten" to "only the model field is rewritten, plus an optional
appended system brief, off per request with one field".

## Consequences

Milo becomes stateful per caller: a data-deletion story now exists
(preference rows die with the key hash; the endpoint deletes on demand).
Capture adds no latency on the common path (the questions ride the existing
call) and one extra Jev call on the rare preference-stating turn. The brief
consumes up to 300 tokens of every routed request's budget, which is the
price of never re-teaching a harness the same thing twice.
