# ADR-028: Speculative routing under the DeepSeek compute controller

Status: accepted, 2026-09-21. Extends ADR-025 (speculative routing) and ADR-012
(the DeepSeek compute controller). Default: **off** (inherits ADR-025's
`speculation.enabled`, default false). No `types.ts` change.

## Context

ADR-025 added opt-in speculative routing to hide Jev classification latency: on
a cache miss, start the fast-tier model call before Jev answers, and reuse it
when the real Jev-driven decision independently resolves to that exact model as
a single, ungated call. But `Router.speculativeModel` gated itself to
`"roster"` mode with a hard `if (this.mode !== "roster") return undefined`, so
speculation never fired under the ADR-012 compute controller.

Production runs `MILO_MODE=deepseek`. Under that mode the "cheapest branch an
easy request resolves to" is not a roster fast-tier lookup at all -- it is the
controller's band-0 budget: a single ungated call to `DEEPSEEK_BRANCH_MODEL`
(`deepseek/deepseek-v4-flash`). So the entire latency win of ADR-025 was dark
in the one mode that ships.

## Decision

Remove the roster-only gate. Keep every other ADR-025 guard exactly as it was
(off unless enabled; never for a forced tier; never with tools; never on
`quality` posture; never over `maxPromptChars`; never on an in-memory sticky
hit or a classification-cache hit -- those already have Jev's answer). Make only
the *model choice* mode-aware, and only after all those shared guards have
passed.

### Roster mode: unchanged

The request's own resolved fast-tier model -- the first fast model the
request's `candidates` allow, never climbing to a mid/frontier model via tier
fallback (it declines instead). Byte-for-byte ADR-025 behaviour.

### DeepSeek mode: the branch model, text-only

- Speculate `DEEPSEEK_BRANCH_MODEL`. Under the compute controller a
  probably-easy request lands in band 0, whose budget (`computeBudget`) is a
  single call to exactly this model. That is what an easy request actually
  resolves to, so it is what we speculate.
- **Ignore per-request `candidates`/`roster`.** The compute controller's
  premise is one model family and it does not read per-request candidate
  allow-lists when sizing a band, so the branch model is the real resolution
  regardless of what the request named. (This differs from roster mode, which
  *does* filter by candidates, because in roster mode candidates genuinely
  change which fast model resolves.)
- **Text only.** If `detectModality(req.messages) !== "text"`, decline. The
  ADR-020 multimodal pre-gate pins a *different*, capable model for non-text
  input (image -> `deepseek/deepseek-v4.1-flash`, audio/video -> the free
  Nemotron omni model), so speculating the text branch model for a multimodal
  request would always miss. Declining avoids the guaranteed wasted call.

`detectModality` is already imported by `router.ts` for the controller's own
pre-gate, is pure, and makes no Jev call, so `speculativeModel` stays pure and
offline.

### Why band 0 only, and why the misses are acceptable

The gateway (`chat.ts`) reuses a speculative answer *only* on the plain,
ungated, single-call forward. In DeepSeek mode that is band 0. The other cells
discard the speculative call:

- **Band 1** is also a single call to `DEEPSEEK_BRANCH_MODEL`, but it is a
  *gated* single call (the completeness gate runs on band >= 1); a gated call
  buffers, grades, and may retry before replaying, so it cannot be served
  straight from a speculative result and the gateway aborts it.
- **Bands 2-3** are best-of-5 (sampled); a single call can never stand in for
  best-of-N, so the gateway aborts it.

Each discard is a bounded, aborted cheap-call miss -- at most one
`deepseek-v4-flash` call, cancelled the moment the real decision resolves,
never a wrong answer. This is acceptable and intended: band 0 is the trivial,
latency-sensitive cell where the win lands, and the probably-easy heuristic
(short prompt, no tools, not `quality`) keeps the request's mass in band 0/1,
so misses stay rare and cheap. Correctness is unchanged from ADR-025: the served
answer is always the one Jev's decision dictates.

## This changes no band budget and no routing decision

Speculation is a **pure latency optimisation**. It changes no band's model, no
band's sample count, and no routing decision -- `computeBudget`, `computeBand`,
and `modalityBudget` are untouched, and `speculativeModel` only tells the
gateway when to start (and later reuse or abort) a call the request would make
anyway. Because no band budget changed, **ADR-012's "re-run the benchmark before
changing a band's budget" rule does not apply here** -- there is no budget
change to measure. (Contrast ADR-024/ADR-026, which *are* ranking/budget changes
and stay dark until a benchmark authorises them.)

## Scope

Core-only. `packages/core/src/router/router.ts` (`speculativeModel` and its doc
comment) and its test. No change to `packages/gateway/`, to `sampling.ts`, to
`gate.ts`, or to any `types.ts` contract; `speculativeModel`'s signature is
unchanged. The gateway's existing reconciliation logic (ADR-025) already handles
a DeepSeek branch-model speculation correctly -- it reuses on the ungated
single-call forward and aborts on gated/sampled -- so no gateway change was
needed.

## Possible future extension (not done here)

Band 0 and band 1 are the *same* model and the *same* single call; they differ
only in that band 1 runs the completeness gate. A later change could let band 1
also reuse the speculative answer by feeding it into the completeness gate as
the first draft to grade, instead of aborting and re-calling. That would widen
the hit rate to the whole single-call region of the controller. It is out of
scope for this ADR (band-1 reuse touches the gateway's gated-forward path) and
is noted only as a direction.

## Consequences

- Speculative routing now fires in the mode production actually runs
  (`deepseek`), where before it was structurally dead.
- The win is bounded by how often an easy cache-miss lands in band 0; band-1 and
  sampled bands still discard, as intended.
- A miss is one aborted `deepseek-v4-flash` call; the heuristic keeps misses
  rare and the abort keeps them cheap, exactly as ADR-025's cost analysis.
