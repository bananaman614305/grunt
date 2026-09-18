# ADR-009: Pre-release builds are never roster defaults

Status: accepted, 2026-09-17

## Context

The default roster (ADR-006) is generated from OpenRouter's weekly usage
ranking and its price catalogue. Popularity was doing more work than it should
have. A vendor that publishes a `-preview` build gets a burst of traffic from
people trying it, so the ranking floats that build high — high enough that
`tencent/hy4-preview` landed as the `frontier` tier's default in the
`2026-09-17` roster, ahead of every shipped model in its band.

A preview is a candidate the vendor has not committed to. Its price, its
weights and its very existence can change or vanish without a deprecation
window, and a default that every unconfigured deployment routes to should not
rest on a build with no such promise.

The measured case against it is stronger than the principle. The live
benchmark (`packages/evals`, run across the labeled routing prompts) put the
`frontier` preview head to head with the `mid` tier's shipped
`openai/gpt-5.6-luna`. The mid model was **more accurate** on the same tasks
and cost roughly **a tenth** as much per request. Paying frontier prices for a
preview that a cheaper shipped model beats is the opposite of what the router
is for.

## Decision

`selectRoster` skips any model whose id's final path segment ends in a
hyphen-delimited pre-release marker — `-preview`, `-beta`, `-alpha`, or `-rc`
(`PRE_RELEASE_MARKERS`). The match is anchored to the end of the segment after
the last `/`, so `tencent/hy4-preview` is dropped while a model that merely
contains one of the words mid-name, such as `vendor/preview-turbo`, is kept.
The skipped model is recorded in the `skipped` array with the reason
`"-preview pre-release build, never a default"`, alongside the other skips.

This is distinct from `DROPPED_VARIANTS`, which folds away `:free`, `:batch`
and the other `:variant` plan tiers. Those are a colon-delimited commercial
variant of a slug; this is a name suffix on the id itself. Both rules run; a
pre-release is skipped before the top-`N` cut, so it never consumes a survivor
slot.

`selectRoster` stays pure: the rule is a string test on the id, with no
network, clock or file system, and its own unit tests over the recorded
catalogue fixture.

### Result

Regenerated as version `2026-09-17`: `tencent/hy4-preview` leaves the roster.
`frontier` becomes `z-ai/glm-5.3`, `google/gemini-3.8-flash`,
`nvidia/nemotron-3-ultra-550b-a55b`, with `z-ai/glm-5.3` the new default. The
top-ten cut pulls the next eligible model, `minimax/minimax-m3`, into the
`mid` tier to fill the vacated slot. `fast` is unchanged.

## Consequences

- Any deployment that never configured a roster and was routing `frontier` to
  `hy4-preview` moves to `z-ai/glm-5.3` on upgrade — a shipped model, cheaper
  and inside the same band.
- A genuinely good preview cannot become a default until the vendor ships it
  under a stable id. That is the intended trade: the roster follows shipped
  models, not release candidates.
- The rule is a substring-safe suffix test, so a model whose stable name
  happens to contain `preview`, `beta`, `alpha` or `rc` is unaffected.
