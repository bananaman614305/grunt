# ADR-030: Cached-candidate benchmark for augmented Jev selection

Status: proposed, 2026-09-22. Extends ADR-010 (best-of-N), ADR-024
(adaptive sampling), and ADR-026 (closed-rubric and static candidate
verification).

## Context

The live best-of-N benchmark answers three questions at once: whether the
candidate model covers the task, whether Jev selects the right candidate, and
whether the result is worth its latency and cost. That is appropriate for an
end-to-end release gate, but wasteful while changing only the selector. Every
iteration regenerates the same candidate pool and may re-grade unchanged text.
Provider variance also changes the pool, so a selector comparison is not
paired.

The committed `bench-final.json` already shows that most selection work is
concentrated in a small subset. Of its 120 five-candidate rows, 39 have both a
passing and a failing candidate. Only those 39 rows can distinguish two
selectors by pass rate. They contain 195 candidates. At the benchmark's
documented $0.00002 per Jev call, one complete augmented ranking pass over the
informative rows costs $0.0039.

The report cannot itself be replayed through a new rubric: it deliberately
omits candidate text. A replayable benchmark therefore needs a local candidate
bank. Raw answers remain gitignored and local; committed reports continue to
carry only aggregate results and non-content metadata.

## Decision

Add a selector-only benchmark with three operating modes:

- **Offline:** read candidate, grade, and Jev-verdict caches. Make no network
  calls. Missing verdicts are unscored, never silently replaced.
- **Record:** read every cache first, then call Jev only for missing selector
  verdicts. It must never generate candidates or invoke an answer grader.
- **Repeat:** bypass the Jev-verdict cache only for a small deterministic
  reliability panel. Candidate generation and answer grading remain cached.

The benchmark compares selectors over exactly the same frozen candidate text:

1. **Historical baseline:** the ADR-010 quality-plus-correctness result stored
   with the candidate bank.
2. **Augmented Jev:** the production `compileRankingRubric`, `rankAnswer`, and
   `compareRanked` implementation imported from `@milo/core`. The benchmark
   must not copy the rubric or comparator.
3. **Augmented Jev plus static verification:** the same result after applying
   ADR-026's production `checkCandidate` gate. This is a separate arm so the
   value of the deterministic gate is not attributed to Jev.

The primary analysis ranks only mixed-outcome rows. Homogeneous rows cannot
change pass rate under selection and require no new Jev calls. Their common
outcome is folded back in when reporting reconstructed whole-suite pass rate.
A deterministic, stratified sentinel sample from homogeneous rows is retained
for API failure and abstention monitoring, but is not used to claim selector
lift.

### Local candidate bank

The live benchmark writes one immutable, content-addressed record per
candidate under `packages/evals/.candidate-cache/`, which remains gitignored.
A record contains:

- dataset and example ids plus a digest of the exact task messages;
- model id, provider pin, generation parameters, prompt variant and index;
- candidate text, finish reason, token use, latency, and generation cost;
- the cached grade and grader-content digest;
- the historical selector verdict, when available.

The key hashes every input that can change generated text: task messages,
model, provider policy, sampling parameters, prompt variant, and generation
schema version. A mismatch is a cache miss. API keys and request headers are
never stored. Candidate text is local benchmark data and must not appear in a
committed report, decision log, or test fixture.

Jev verdicts use a separate cache under
`packages/evals/.selector-cache/`. Its key hashes:

- task-message digest and candidate-text digest;
- resolved Jev model and transport-visible model name;
- compiled rubric, rank-state clipping version, and selector implementation
  version;
- static-verifier version when that arm is evaluated.

Successful, schema-valid verdicts are cached indefinitely because their inputs
are immutable and content-addressed. Timeouts, transport failures, malformed
responses, and partial results are not cached. A cache hit contributes zero to
fresh-call cost even though the stored record retains original latency, usage,
and cost for audit.

### Corpus discipline

The candidate bank is frozen before selector tuning. Example id hash assigns
rows to development and holdout halves; all candidates for one task stay in
the same half. Grades may determine whether a row is mixed, but grade content
is never included in a Jev request. Final claims come from the untouched
holdout and from a later end-to-end live benchmark.

Rows are the statistical unit. Candidates from one task are correlated, so
confidence intervals use paired bootstrap resampling by row, not by candidate.
The report always gives raw numerators and denominators alongside intervals;
small task-type slices are descriptive, not gates.

## Measures

### Selection quality

- **Pick pass rate on mixed rows**, paired against historical selection.
- **Oracle capture:** `(Jev pick - random expectation) / (oracle - random
  expectation)`, showing how much available selection headroom Jev captures.
- **Regret:** rows where a passing candidate exists but the selector picks a
  failing one.
- **Pairwise discrimination:** AUROC of Jev's score against cached pass/fail
  grades, conditional on mixed rows.
- **Reconstructed whole-suite pass rate:** homogeneous outcomes plus selected
  mixed outcomes, clearly labeled as replay rather than a fresh model run.
- **Static-verifier rescue/harm:** broken baseline picks corrected by the gate,
  and valid passing picks incorrectly displaced by it.

Primary quality gates on the holdout are paired non-inferiority: reconstructed
pass rate may not fall by more than one percentage point, and mixed-row regret
may not increase. Positive lift is reported with a paired 95% bootstrap
interval but is not required until the corpus is large enough for that interval
to be useful. Any static-verifier harm is listed row by row.

### Reliability

The deterministic reliability panel contains 12 mixed rows, stratified by task
type and by the first-pass winning margin: six smallest margins and six typical
or large margins. It is ranked three times total. The first pass is the normal
record pass; only the two repeats are extra calls.

Report:

- top-1 agreement across repeats and pairwise flip rate;
- per-candidate outcome agreement and quality/correctness score spread;
- accept/reject/abstain rates;
- timeout, HTTP, validation, and missing-verdict rates;
- p50/p95 call latency and per-row critical-path latency (maximum parallel
  candidate-rank latency, not the misleading sum or mean);
- 100% order-invariance from replaying cached verdicts with candidate order
  permuted.

The reliability gate is at least 90% top-1 agreement, at most 1% valid-response
failure, and exact order-invariance. A failed Jev call also runs the production
degraded picker against the cached row so the report states the user-visible
effect, not only the API error count.

### Cost

Report two different costs and do not combine them:

- **Benchmark spend:** fresh Jev calls and dollars in this run, with cache
  hits/misses. Candidate-generation and grading spend are historical sunk cost
  and are shown separately from the candidate-bank manifest.
- **Production selector cost:** Jev calls, dollars, and critical-path latency
  per sampled request for each selector arm. A multi-question `systemone` call
  is one call; the report also retains token usage in case pricing stops being
  flat per call.

Also report dollars per additional passing pick when lift is positive. If the
two selector arms use the same number of calls, say that incremental call cost
is zero rather than dividing by lift.

The default record budget is capped before execution. For the historical
five-candidate corpus it is:

| Work | Rows | Calls | Cost at $0.00002/call |
|---|---:|---:|---:|
| First augmented pass over mixed rows | 39 | 195 | $0.0039 |
| Two extra passes over 12-row reliability panel | 12 | 120 | $0.0024 |
| **Maximum fresh Jev spend** |  | **315** | **$0.0063** |

The CLI prints this upper bound and requires an explicit higher
`--max-jev-calls` before making call 316. Offline mode has a hard zero-call
assertion.

## Workflow and release gate

The intended workflow is:

1. Run the ordinary live benchmark once with candidate-bank recording enabled,
   or import an existing private bank that has the required text and hashes.
2. Iterate offline or in record mode. Rubric edits invalidate only affected
   Jev verdicts; unchanged candidates and grades remain hits.
3. Freeze the selector, evaluate the holdout once, and save a content-free
   report with corpus and implementation digests.
4. Before enabling the selector in production, run the existing full live
   benchmark/canary. Cached replay isolates selector quality; it does not prove
   provider behavior, generation coverage, or end-to-end latency.

This benchmark authorizes selector iteration, not deployment by itself.

## Consequences

Most selector changes cost less than one cent to evaluate and reruns are free.
Comparisons are paired because every arm sees identical candidates and grades.
The cost reduction does not hide the benchmark's limits: a frozen candidate
bank can become stale, binary grades compress answer quality, and selecting
only mixed rows estimates discrimination conditional on available headroom.
Those limits are named in every report and are why the final live gate remains.
