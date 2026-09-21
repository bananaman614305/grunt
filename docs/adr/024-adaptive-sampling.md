# ADR-024: Adaptive-N sampling and cache-friendly framings

Status: accepted, 2026-09-20. Extends ADR-010 (best-of-N) and ADR-012 (the
compute controller). Both mechanisms here are **config-gated and default OFF**;
with them off the sampled path is byte-identical to ADR-010's fixed best-of-N.

## Context

Cost analysis of the live decision log shows best-of-N sampling is roughly
two-thirds of total routed spend: the compute controller (ADR-012) budgets
best-of-5 on bands 2 and 3, and the fan-out (`packages/gateway/src/routes/sampling.ts`)
draws all N up front. ADR-012 already names two of the levers to recover that
spend — "adaptive N — after the first ranked samples, 'good enough?' decides
stop or draw more" (phase 1) and "shared prompt caches across samples and
turns" (a single-family benefit) — and this ADR ships both as opt-in knobs.

ADR-012's measurement discipline is binding: "Do not change a band's budget
without re-running the benchmark." Neither mechanism here edits that budget
table; they change **how** a budgeted N is spent, and both are benchmark-gated
before a deployment may turn them on.

## Decision

### 1. Adaptive-N / early stopping

Under `sampling.adaptive.enabled` (default false), the fan-out draws samples
**incrementally** instead of launching the full N at once:

- An initial concurrent probe of `minSamples` (default `minRanked`, i.e. 3) is
  drawn and ranked as each stream completes, with the same Jev score+correctness
  call and the same comparator (`bySampleRank`) the fixed path uses.
- Drawing **stops** the moment the top ranked answer is confidently good enough:
  its expected quality clears `qualityBar` (default `EARLY_WIN_QUALITY` = 2.5),
  **or** it leads the runner-up by `leadMargin` (default 1.0 on the 0..3 scale),
  **or** the `maxSamples` cap is hit (default N, and always clamped to N). When
  no winner is clear and the whole in-flight batch has settled, one more sample
  is drawn — so a request that keeps failing keeps escalating toward more
  compute, the ADR-012 posture.
- The final pick, the degraded-ranking fallback (`ranking_failed`), and the
  all-samples-failed fallback are **unchanged**: the pick is `bestRanked` over
  whatever was ranked, exactly as fixed-N would compute it.

The difference from fixed-N's existing early-return is where the saving lands.
Fixed-N already aborts stragglers once a winner emerges, but it has already
**started** all N streams and paid their first-token latency and partial
generation. Adaptive-N never starts the tail samples at all, so on a
confidently-answered request it spends the probe count rather than N.

Because an early stop draws fewer than N, the disclosure header
`x-milo-samples` reports the count **actually drawn** (equal to N whenever
adaptive is off), and the decision log's per-sample array and aggregate
tokens/cost already sum only what was billed.

### 2. Cache-friendly framings

The N samples of one request share the same conversation. ADR-010's framings
(`PROMPT_VARIANTS`) are appended to the **system** message
(`applyVariant`), which sits at the head of the token sequence — so the N
samples diverge *before* any of the (usually much larger) user turns. A
provider that prompt-caches on the shared prefix (the DeepSeek family; ADR-012's
"shared prompt caches across samples and turns") therefore cannot reuse the
conversation body across the varied samples: the expensive tokens are
re-encoded on every draw. **Per-sample variation in the system prompt defeats
cross-sample and cross-turn prompt caching of the bulk tokens.**

Under `sampling.cacheFriendlyVariants` (default false), the same framing text is
instead appended to the **tail of the last message** (`applyVariantSuffix`), so
the whole prefix — system prompt plus every earlier turn — is byte-stable across
a request's samples and only a short suffix varies. The framing text, and thus
the sample diversity, is unchanged; only its position moves.

DeepSeek/OpenRouter caching is automatic on the prefix, so no `cache_control`
parameter is sent. Cache effectiveness is already visible in the decision log:
OpenRouter's `usage.cost` reflects the cached-input discount, so the existing
aggregate `costUsd` field captures the saving with no new stored field (and no
message content).

## The default-OFF stance and the benchmark gate

Both knobs default OFF, and with them off the sampled path is byte-identical to
ADR-010 (verified by test): fixed best-of-N draws every budgeted sample, and the
framing rides the system prompt as benchmarked.

Both are **prompt/compute changes ADR-010's benchmark has not measured**:

- Adaptive-N trades quality headroom (fewer samples for the selector to choose
  from) for cost, and its thresholds set that trade.
- Relocating the framing to the message tail is a prompt change, and ADR-010 is
  explicit that "changing it changes picks."

So enabling either in production **must be validated first** with `milo canary`
(continuous eval + drift detection) and/or `pnpm bench` on the 120-prompt set
and the long-horizon suite, exactly as ADR-012's gate requires. Until a run
clears the gate, the shipped behaviour is fixed best-of-N with system-prompt
framings.

### Diversity vs. cache: the conservative default

There is a genuine tension. Maximal cache reuse wants an identical prefix across
samples; maximal diversity wants each sample framed differently from the start.
`cacheFriendlyVariants` keeps full diversity (same N framings) and only moves
where they sit, so it does not silently reduce diversity — but because the move
is unmeasured, the conservative default is off. A secondary caveat: the sampled
sub-requests carry `provider: { sort: "throughput" }` (a load-bearing
availability wall, ADR-012), which may route each draw to a different provider
whose cache is independent; the durable win from a stable prefix is therefore
**cross-turn** (the next turn of the same conversation reuses the cached prefix)
and opportunistic across concurrent samples. The provider strategy is not
changed here.

## Config

Both knobs live in the existing `sampling` block of `milo.config.json` /
`GatewayOptions` / `AppDeps`, alongside `sampleTimeoutMs` and `minRanked` — no
`packages/core/src/types.ts` change:

```jsonc
{
  "sampling": {
    "adaptive": {
      "enabled": false,
      "minSamples": 3,       // initial concurrent probe (default minRanked)
      "maxSamples": 5,       // cap, clamped to the budgeted N
      "qualityBar": 2.5,     // top expected quality (0..3) that stops drawing
      "leadMargin": 1.0      // decisive lead over the runner-up that stops drawing
    },
    "cacheFriendlyVariants": false
  }
}
```

## Consequences

On sampled cells that are answered confidently, adaptive-N spends the probe
count rather than N, cutting into the largest line of routed spend; on hard
cells where no sample clears the bar it still draws up to N, so worst-case cost
and quality are unchanged. Cache-friendly framings make the DeepSeek prefix
cache reachable that ADR-012 assumed, most reliably across turns. Both stay dark
until a benchmark run authorises them, so no measured band budget changes on the
strength of this ADR alone.
