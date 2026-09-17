# ADR-008: A user's own model list, stored per key

Status: accepted, 2026-09-17

## Context

ADR-006 made the default roster popular-and-cheap and turned it into data, and
that is the right answer for a user who has no opinion. Most of Milo's users
are not that user. They came from OpenRouter. They already know which models
they run, they have preferences that took real money to form, and the first
thing Milo does today is hand them a list of ten models somebody else picked.

There were two ways to change it and neither fit:

- **`milo.candidates` per request.** Right for one request, wrong as a
  preference. Nobody wants to send their model list with every call.
- **`roster` in `milo.config.json`.** Right for an operator, wrong for a user.
  It is one table for the whole deployment, it needs a restart, and on the
  hosted instance the user does not have the file.

Meanwhile onboarding (`/setup.md`, `skills/milo/SKILL.md`) told an agent to
configure Milo and *then* disclose the default roster. The disclosure was the
right instinct pointed backwards: the moment to ask someone which models they
want is before you configure anything, not after.

The constraint that shapes everything below: Milo stores no key material
(ADR-003). A per-user setting needs a per-user handle, and the only handle
Milo has is the key itself, which it must not keep.

## Decision

### Onboarding asks first

`/setup.md` and the skill open with "Ask before configuring": two questions --
*which OpenRouter models do you already use?* and *which should Milo choose
from?* -- asked before any config is written. Named models are stored with one
`PUT /v1/roster`; "just pick" falls through to the shipped default. Either way
the agent shows the resulting table once and moves on.

### The handle is a hash, not a key

A stored roster is keyed by the SHA-256 of the caller's normalized bearer
credential -- the same `hashKey` the rate limiter already buckets on, so one
key is one identity whichever header carried it. The `rosters` table holds that
hash, the roster JSON, a source and two timestamps. Nothing else about the
user is stored, and `assertKeyHash` refuses a write whose key is not a 64-char
hex digest, so a caller that passes a credential by mistake gets an error
rather than a row containing it.

This is weaker than an account: anyone holding the key can read and overwrite
that roster. It is exactly as strong as the key itself, which is the right
bar -- holding the key already lets you spend it.

### Tiering is the default roster's own rule, minus the ceiling

`tierByPrice` in `packages/core/src/router/roster-from-models.ts` cuts a flat
model list on the bands from `roster-default.json` (fast at most $0.35/M, mid
at most $1.50/M, frontier at most $5/M), preserving the user's order inside a
tier and demoting to the end of its tier anything that caps output below
`smallOutputBelowTokens` or cannot call a tool -- the same demotion the default
roster applies, for the same reason: such a model must never be a tier's
default.

`excludedAbove` does **not** apply. That ceiling exists to stop Milo *choosing*
a $75 model on behalf of someone who never asked. A user who types
`anthropic/claude-opus-5` asked. It lands on `frontier`.

A user who wants to place models by hand sends `tiers` instead, and Milo
stores what they wrote.

### The roster is resolved per request, not per process

`Router` took its roster at construction, which is fine for one table per
deployment and impossible for one table per key. `RouteRequest` gains an
optional `roster`; the constructor's stays the default. The gateway resolves
it once per request in `routes/shared.ts` -- stored per-key roster, else the
deployment's config roster, else the shipped default -- so every dialect, and
every route added later, gets the same precedence for free. `milo.candidates`
still filters *within* whichever table won; the two answer different questions.

### Stickiness is scoped to the caller

`fingerprint(messages, scope?)` mixes the caller's key hash into the digest.
Without it, two users who send the same conversation share a sticky decision,
which was merely surprising before and is wrong now: the second user could be
served a model that is not on their roster at all. The digest keeps its shape,
so the decision log and the `/v1/decisions?fingerprint=` filter do not change.

## Consequences

- `GET /v1/roster` now depends on who is asking. It gains `rosterSource`
  (`"user"`, `"config"`, `"default"`) rather than overloading `source`, which
  already names the provenance of the shipped numbers.
- `PUT /v1/roster` spends one OpenRouter `/models` call, cached five minutes
  per process, to validate ids and price them. An unknown id is a 400 naming
  it -- a typo should fail at the moment it is typed, not an hour later as a
  404 from a provider.
- Two users on one instance can now be routed to different models for the same
  prompt. That is the point, and it is visible in the decision log, which still
  records one row per request with the model that answered it.
- The decision log is still per deployment, not per key (see
  `routes/decisions.ts`): one key can read another's *decisions*, though not
  their roster. Unchanged by this ADR and still on the list before Milo is
  multi-tenant.
- A user who stores a roster of models that all fail the long-output rule can
  make `resolveModel` throw where the defaults would have answered. The failure
  is loud (502, "Milo could not route this request") rather than silent, which
  is the same trade ADR-005 made.
