# ADR-019: Milo ground-truth verification (veritaserum)

Status: accepted, 2026-09-18. Builds on ADR-013 (agentic gates, the
completeness gate) and ADR-015 (the worker fleet). No change to
`packages/core/src/types.ts`.

## Context

The completeness gate (ADR-013) checks whether an answer addresses every part
of the request; the fleet supervisor (ADR-015) infers a worker's state from the
shape of its traffic. Both reason over *what the agent said or did*. Neither
checks the agent's confident claims against *what is actually true on disk* --
and an empirical SWE-bench Verified study found roughly 7.8% of patches pass the
given tests while being wrong. An agent that says "all tests pass" or
"implemented the parser" is trusted on its word.

The "veritaserum" concept (an npm package by a third party, "Trusty Squire")
answers this: on an agent's turn-end, a cross-family auditor extracts the
load-bearing claims and checks each against the only two sources that cannot
lie -- read-only git probes taken right now, and the harness's receipts of what
actually ran. Each claim is `supported`, `unsupported`, or `contradicted`;
honest uncertainty is never flagged; a claim with no oracle "demands" one, a
failing check persisted as git-tracked case law. It is push-not-pull (a hook,
because an agent skips a self-check exactly when it is confabulating) and
fail-open (a hiccup never blocks the agent).

Milo has a structural fit no external tool has: it already holds the Jev key
server-side. So Milo can be the auditor without the user bringing a TypeSafe
key -- and Jev is structurally CROSS-FAMILY, a classifier that never wrote the
code it judges.

## Decision

Reimplement the idea NATIVELY (no dependency on the veritaserum npm package),
as one shared core layer reused by three surfaces.

### Shared core layer: `packages/core/src/verify`

Pure except one Jev call, so every piece is unit-tested with fixtures:

- **claim extraction** (`claims.ts`): mechanical, drops hedged and
  forward-looking sentences, so honest uncertainty is never a claim and so
  never flagged. The auditor judges; extraction only decides what is worth
  judging.
- **git-probe and receipt parsing** (`probes.ts`): `git status`/`diff`/`log`
  and command receipts into a structured, tolerant `GitProbeState` and
  `Receipt[]`. A probe that fails to parse degrades, never throws.
- **the auditor question** (`questions.ts`): one Jev `choice` per claim --
  `supported | unsupported | contradicted` -- judged only against the evidence.
  A claim the evidence does not speak to is `unsupported`, never
  `contradicted`; only refuting evidence contradicts.
- **verify + aggregate** (`verify.ts`): several claims ride one Jev call as
  separate questions over the shared ground-truth state. `blocking` is true
  only on a `contradicted` claim at or above a confidence bar -- the one
  confident, positive finding a block may act on. `isCrossFamily` records the
  auditor/executor family assertion (always true with Jev).
- **case law** (`caselaw.ts`): an `unsupported` claim demands an oracle -- an
  open, git-tracked obligation, re-checked mechanically and resolved when the
  claim later comes back supported.

These are the verify module's own types; **none live in
`packages/core/src/types.ts`**, so the pinned contract is unchanged and this ADR
licenses no edit to it.

### Layer 1 -- harness Stop hook, Milo-native

`POST /v1/verify` runs the auditor on Milo's server-side Jev: input is the turn
text (or extracted claims), git probes, and receipts; output is the per-claim
verdicts, a summary line, the demanded case law, and a `blocking` flag.
**Fail-open is the contract**: no Jev, an error, a timeout, or a malformed body
all return a 200 with an empty, non-blocking verdict -- never a 5xx that could
stall the agent.

`milo verify install <claude-code|codex|goose>` writes a self-contained Stop
hook and wires it into the harness config. The hook gathers claims + read-only
git probes + receipts and POSTs to Milo (so the user needs a Milo endpoint and
a Milo key, NOT a TypeSafe key), then warns at the next prompt. Warn-primary;
an opt-in `MILO_VERIFY_BLOCK` allows a block only on a confident contradiction,
at most twice per session. Push-not-pull; git-tracked case law persisted.

### Layer 2 -- fleet done-gate

A finished worker's "done" is self-reported (pi exited 0). The done-gate
(`packages/fleet/src/done-gate.ts`) verifies it against the worker's ACTUAL git
diff and receipts with one cross-family Jev call, and the fleet surfaces a
finished worker whose done is `unsupported`/`contradicted` (empty diff, failing
receipts) for attention. It runs ONCE per finish, so the fleet still quiesces
(ADR-015); fail-open leaves the process result untouched on any Jev error.

This done-gate reads the worker's diff as ground truth, which is a deliberate
exception to ADR-015's content-free *supervision*: the diff is the worker's
produced artifact being verified, not model message content fed into a
liveness classification. ADR-015's routine `worker_state`/`needs_human`
supervision stays content-free; only the one-shot done-gate reads the diff, and
this ADR licenses that.

### Layer 3 -- completeness gate ground-truth extension

When a coding/agentic request supplies git/receipts via
`milo: { verify: { git, receipts } }`, the completeness gate
(`packages/gateway/src/routes/gate.ts`) additionally checks the answer's
load-bearing claims against that ground truth -- not just the text's
self-consistency. A confident contradiction takes the gate's existing single
retry; a non-blocking finding is disclosure only, on `x-milo-verify`. It stays
fail-open, gated exactly as today (band >= 1, not `low` posture, a Jev client
present), and opted out by the same `milo: { gates: false }`. With no ground
truth supplied the gate behaves byte-for-byte as before.

## Consequences

Verification is one extra Jev call per checked turn/worker/finish (several
claims share the call), still well under a tenth of a cent, and it fires only
where ground truth is present or the fleet finishes a worker. Nothing this
feature adds can fail a request, a worker, or an agent turn on its own hiccup:
every path fails open. The vocabulary from the source project is not carried
into the code; Milo's terms are claims, verdicts, ground truth, and case law.

## Scope and honesty

What is real and unit-tested with fakes: the whole core verify module, the
/v1/verify handler (stubbed Jev), the CLI install and its pure config/verdict
logic, the fleet done-gate, and the gate extension. What is deliberately out of
the `pnpm test` path: the generated hook script running inside a real harness
(only `node --check`ed here), and the exact Codex/Goose Stop-hook config keys --
the claude-code wiring is precise; the codex/goose wiring is a v0
marker-delimited block and the installer prints what it added. Receipts for the
fleet done-gate are populated only when a runtime captures them; the v0 node
runtime runs no test of its own, so the gate checks the diff alone there.
