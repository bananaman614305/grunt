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
seven fields in two families:

| Family | Field | Values |
|---|---|---|
| routing-shaping | `posture_default` | `low`, `balanced`, `quality` |
| routing-shaping | `tier_floor` | `fast`, `mid`, `frontier` |
| routing-shaping | `sampling` | `on`, `off` |
| output-shaping | `verbosity` | `concise`, `balanced`, `detailed` |
| output-shaping | `format` | `prose`, `bullets`, `code_first` |
| output-shaping | `evidence_style` | `citations`, `examples`, `assertions` |
| output-shaping | `testing_depth` | `none`, `smoke`, `thorough` |

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

# Personal-fact memory

Preferences are *how* you like answers made. Facts are *what Milo needs to
know about you*: an address, an account id, a teammate and their role, a house
spelling. An agent re-teaches these every session; Milo learns them once, from
your key, and injects them only when a request actually needs one. This is
ADR-017, and it is **on by default** — a Milo feature, not an opt-in.

## The one place Milo keeps your words

Preferences store labels, never content (the ADR-003 line). A fact *is*
content — "my staging box is `10.2.0.7`" is not a label from a fixed list — so
the fact store crosses that line, and only it does. It is bought with three
guarantees, non-negotiable because this is PII:

1. **Encrypted at rest.** The fact text is sealed with the same AES-256-GCM
   envelope (`MILO_ENCRYPTION_KEY`) that protects your OpenRouter sub-key. The
   `facts` row holds ciphertext; the plaintext is decrypted only to serve you
   or to judge relevance.
2. **Fully listable.** `GET /v1/memory` returns every fact you stored,
   decrypted, with its category and provenance. Nothing is hidden.
3. **One-call deletable.** `DELETE /v1/memory/:id` removes one fact.

Each fact carries a **category** label — `address`, `contact`, `identifier`,
`credential-hint`, `convention`, `other` — which is *not* content and rides
alongside the ciphertext. The category is a label; the content is encrypted.

## How a fact gets learned

Off the response path, one Jev call (classification only) reads the latest
turn and asks: should this be remembered as a durable personal fact, and under
which category? It fires on an explicit "remember that …" / "my … is …" and on
a durable fact stated in passing, leaning conservative. The fact **text is
lifted from your own message**, never generated by Jev — the model that
classifies never writes what is stored. Weak signals are dropped. Capture is
fire-and-forget: it never delays or fails your response.

## How a fact gets used — the relevance gate

Before a routed request is forwarded, one Jev call classifies which of your
stored facts, if any, are relevant to *this* request (one yes/no per fact).
Only the relevant ones are appended, as a single system note alongside the
brief; the response carries `x-milo-facts-injected: <n>`. If none are
relevant, nothing is injected and no fact reaches the model.

This gate is both controls at once. **Privacy:** an irrelevant fact never
leaves the vault. **Cost:** your prompt grows only on the requests a fact
actually helps — the standing cost is one Jev relevance call per routed
request when you have facts stored and the switch is on; input tokens grow
only when a fact is injected. Injection is skipped on `low` posture.

## Seeing, skipping, deleting, killing

```
GET    /v1/memory              # every stored fact, decrypted, plus your kill switch
DELETE /v1/memory/:id          # remove one fact
PUT    /v1/memory/settings     # { "enabled": false } turns fact memory off for your key
```

All scoped to your bearer key: nobody else's key can read or delete your
facts, and rotating your key orphans them entirely.

- Per request: `"milo": { "facts": false }` skips injection on that call.
- Per key: `PUT /v1/memory/settings { "enabled": false }` is the kill switch —
  it turns both capture and injection off for everything from your key.

## The honest note

This is a PII store. Milo now persists your words, encrypted, so the
encryption key is load-bearing: lose it and the facts are unreadable; leak it
and the ciphertext is readable. If the deployment has no `MILO_ENCRYPTION_KEY`
(billing not configured), fact memory **degrades to disabled** — nothing is
captured, nothing is injected, `GET /v1/memory` answers empty and says so,
because a fact store with no envelope must not keep plaintext. Fact content
never reaches a log line, a response header, a decision row, or an error
message; the decision log stays content-free.

The binding decision: [`adr/017-personal-fact-memory.md`](adr/017-personal-fact-memory.md).
