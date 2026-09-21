# ADR-026: Static candidate verification and top-K exposure

Status: accepted, 2026-09-21. Extends ADR-010 (best-of-N sampling) and ADR-024
(adaptive-N). The verification signal is **config-gated and default OFF**; with
it off the sampled ranking is byte-identical to ADR-010 (verified by test).
Top-K exposure is **per-request and opt-in**; absent, the response is the single
best choice exactly as ADR-010 ships it.

## Context

Best-of-N (ADR-010) ranks its candidates with Jev: one score+correctness call
per finished answer, and the highest expected quality wins. Jev's ranking is a
**text judgment**, and a text judgment can rate a **structurally-broken**
candidate highly -- an answer whose code block was cut off at the token limit,
whose diff hunk counts do not add up, or whose JSON does not parse. The eval
runs behind ADR-010 graded on output, but the live selector has no gate against
a candidate that is obviously incomplete as *text*, so a truncated-but-confident
draw can win a sampled request over a shorter, complete one.

Milo is a **stateless chat/completions gateway**. It has no code sandbox and no
access to the client's repository, so it **cannot** compile a candidate, apply
it as a patch, or run the project's tests. Full executable verification belongs
to the client's workspace (a harness such as pi), not to the gateway. What the
gateway *can* do, cheaply and language-agnostically, is inspect the completion
text it already holds for high-confidence structural breakage. And where a
client *does* have a workspace, the gateway can hand it more than one candidate
so the client runs the real tests itself.

## Decision

### 1. Static candidate verification as a ranking gate

A pure verifier (`packages/core/src/router/candidate-check.ts`, `checkCandidate`)
scores each candidate on cheap, language-agnostic **structural validity**. The
checks are deliberately conservative -- low false-positive, so a valid answer is
never demoted -- and they never attempt per-language syntax parsing:

- **Truncation / incompleteness:** `finish_reason: "length"` (the model hit the
  token cap), an **odd** number of ``` fences (a code block opened and never
  closed), an answer that ends **mid-token** (a dangling `\` escape or a lone
  high surrogate).
- **Unbalanced delimiters** `()[]{}` inside a **closed** fenced code block --
  string literals and their contents are skipped so a bracket in a string is not
  read as structure. Prose is **never** checked, because prose routinely carries
  stray brackets (asides, smileys); only code fences and structured formats are.
- **Unified-diff well-formedness** when the candidate is a diff: every `@@` hunk
  header parses, and each hunk's body line counts (` ` context to both sides,
  `-` to old, `+` to new) match the header's declared old/new counts. A dangling
  header with no body, or counts that disagree, is malformed.
- **JSON validity** when JSON is expected: a fenced ```json block, or the whole
  answer when the request asked for JSON via `response_format`
  (`json_object` / `json_schema`, detected by `expectsJsonResponse`).

What is deliberately **NOT** done, and why: no compilation, no patch
application, no test execution, no real language parsing. The gateway is
stateless and has neither the sandbox nor the repo to do any of it; that
verification is the client harness's job. These checks catch *obviously* broken
candidates from format and completeness alone.

**Folding into the ranking.** The gate does not replace Jev; it precedes it. The
fan-out's comparator (`bySampleRank` in
`packages/gateway/src/routes/sampling.ts`) sorts a **structurally-broken
candidate below every structurally-valid one**, and orders by Jev's expected
quality (then correctness, then index) *among candidates of equal validity*. So
a broken candidate cannot win on Jev's text score alone, while a request whose
candidates are all fine picks exactly as it does today. The `broken` marker is
set only when the gate is on; with it off no candidate carries the marker, the
validity comparison is always a tie, and `bySampleRank` is byte-identical to
ADR-010's. When *every* candidate is broken the best-effort pick is Jev's best
among them -- the degraded case is never worse than today.

**Config, default OFF.** `sampling.verifyCandidates` (default false), alongside
the ADR-024 knobs in `milo.config.json` / `GatewayOptions` / `AppDeps`. Off, the
ranking is byte-identical to ADR-010. On, it is a **ranking change ADR-010's
benchmark has not measured**, so a deployment validates it with `milo canary`
(continuous eval + drift detection) and/or `pnpm bench` on the labeled set
before turning it on in production, exactly as ADR-012's measurement discipline
and ADR-024's gate require.

### 2. Top-K candidate exposure (opt-in)

A client with its own workspace can do the executable verification the gateway
cannot -- but only if it receives the candidates. When the client asks for more
than one choice via the OpenAI **`n`** field (`n > 1`), the sampled response
returns the **top-K ranked candidates** as multiple `choices[]` entries,
**best-first**, capped at the number of samples actually drawn. Absent or `n = 1`
returns the single best choice, exactly as ADR-010. Choice 0 is the served pick
(gate-applied and reasoning-scrubbed as before); the remaining choices are the
next-best ranked successes, each reasoning-scrubbed the same way, streamed as
well-formed multi-choice SSE or returned as one JSON body.

`n` is the request-visible knob because Milo's own `milo` body field is stripped
before the forward, and `n` already carries OpenAI's "give me n choices"
meaning. On a sampled request each draw still generates a **single** completion
(the sub-request's `n` is forced to 1 when top-K is requested), so a client `n`
never fans one draw out into n upstream generations; Milo synthesizes the
multiple choices from the top ranked *samples*. Nothing beyond the completion
text the client already paid to generate is exposed -- no Jev scores, no
per-sample internals; those stay in the decision log. Disclosure header
`x-milo-exposed: K` reports how many choices were returned.

## No `types.ts` change

Neither part changes `packages/core/src/types.ts`.

- The verifier is a new core module with its own exported types; it touches no
  contract.
- `verifyCandidates` is a gateway execution knob (`AppDeps.sampling`), not a
  core type.
- Top-K reads the standard OpenAI `n` field already present on the body; it adds
  no request-extension field, so `MiloRequestExtension` is unchanged.
- The per-sample decision-log row carries two additive markers, `broken` and
  `flaws` (structural class names, never candidate content -- the decision log's
  no-content rule holds). They ride the same gateway-local `SampleRow` extension
  the `aborted` marker already uses (`SampleUpstream & { … }`), so the stored
  `SampleUpstream` contract in `types.ts` is untouched. Folding either marker
  into the type itself would need its own ADR, as the `aborted` note already
  says.

## Consequences

On sampled cells with `verifyCandidates` on, a truncated or structurally-broken
draw can no longer win a request on Jev's text score alone; a valid candidate is
picked instead, and the decision log records which candidates were broken and
why. Worst case (all broken) is unchanged. Because the gate is an unmeasured
ranking change it stays dark until a benchmark run authorizes it. Top-K exposure
lets a client that owns a workspace run the executable verification the stateless
gateway cannot, at no extra generation cost, while the default single-best
response is exactly what ADR-010 returns.
