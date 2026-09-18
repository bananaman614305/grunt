# ADR-012: Milo as a compute controller over one model family

Status: accepted as an experiment, 2026-09-18. Extends ADR-002/010/011;
does not yet change the shipped default (ADR-006 roster remains until the
benchmark gate below is passed).

## Context

Three full live benchmark runs showed price does not predict quality in the
sub-$5 band Milo routes across: a $2.50 preview lost to a $1.20 model, the
$4.40 frontier default failed 45% of graded tasks and timed out on hard
ones, and the cheapest model in the roster — DeepSeek V4 Flash — matched or
beat the frontier tier when sampled five times with Jev picking the answer
(AUROC 0.87–0.91 against the graders). Meanwhile DeepSeek's Flash models
carry a 1,048,576-token context — the same class as Fable 5.1 at 67–500x
lower list price — and a single-family stack compounds advantages a mixed
roster cannot: shared prompt caches across samples and turns, one provider
strategy, one set of failure modes to learn.

The tier abstraction asked "which brand?"; the evidence says the leverage
is in "how much compute, and how is it checked?".

## Decision

An experimental mode where the roster collapses to the DeepSeek family
(V4 Flash as the branch model, V4.1 Flash as the orchestrator/hard-task
model) and Jev's signals set a **compute budget** instead of a tier:
sample count, model variant, reasoning effort, and verification depth per
request. Every existing mechanism — policy table, decision log, sticky
cache, briefs, sampled execution, disclosure headers — carries over
unchanged; only the policy's output vocabulary grows.

Jev gates arrive in phases, classification only, each failing toward more
compute rather than silent acceptance:

- **Phase 1 (benchmark-first, this ADR):** compute sizing from the routing
  signals; sample ranking (shipped); adaptive N — after the first ranked
  samples, "good enough?" decides stop or draw more.
- **Phase 2:** output grading against the brief's checkable clauses;
  failure typing (wrong format / incomplete / off-task) driving one
  targeted retry; escalation to V4 Pro or more samples on low grade at
  high difficulty.
- **Phase 3 (agentic):** tool-call arbitration across parallel branches;
  context pruning for million-token conversations; loop and consistency
  checks across turns.

## The gate

The gate is segmented (ratified 2026-09-18), because the hard-prompt
ablation showed the mid tier is not a substitute there (23% pass on the
hard 30 versus the controller's 73%): on bands 0-1 the controller must
match the mid arm's cost at equal or better graded quality; on bands 2-3,
where no sub-$5 arm competes, it must beat the frontier-arm quality of
record and stay under the Fable rate-card estimate for its own tokens.
Both must hold on the 120-prompt set and the long-horizon suite. The
Fable comparison stays an estimate by owner decision (2026-09-18): the
same tokens priced at Fable's rate card, as every report already computes,
because a real run spends multiple dollars to refine a number the 67-500x
rate gap already settles. Any public claim therefore says "estimated
against Fable's list price", never "beat Fable". Until the gate passes,
the shipped default stays ADR-006's roster.

## Consequences

Single-vendor concentration: provider variance within DeepSeek is now the
availability story, so the throughput-sorted, price-capped provider
strategy (wave11) is a load-bearing wall. Jev spend per request rises from
one call toward several; at $0.00002 a call this stays under a tenth of a
cent at N=5 with every gate on. The bench grows a composed arm and a
long-horizon suite before any gateway change ships.
