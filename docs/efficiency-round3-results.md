# Efficiency measurement round: 2026-11-22

This round adds durable measurement and removes redundant access checks. It does
not establish a general autonomous coding speedup. The comparison baseline is
commit `715b4de9066c07fb669702b21610e7559d09dfd8` (0.9.6), using Node 22.23.2 on
the same Linux host. Provider transports and tasks are synthetic and offline.

## Demonstrated reduction in repeated work

Five alternating baseline/candidate repetitions used eight overlapping callers.
Results and completion POST counts stayed identical in every repetition.

| Fixture | Baseline metadata requests | Candidate metadata requests |
| --- | ---: | ---: |
| BeatAPI availability burst | 8 | 1 |
| Darus availability burst | 16 | 2 |
| BeatAPI availability plus one verified dispatch | 10 | 2 |
| Darus availability plus one verified dispatch | 18 | 2 |

The availability burst uses 87.5% fewer metadata requests for both adapters.
BeatAPI's post-inference balance check remains separate and fresh. These counts
prove less redundant work, not reduced real-provider latency. Millisecond fixture
timings varied between runs and are not a coding-speed claim.

## Measurement overhead

A separate five-pair ingestion comparison recorded 3,000 events per implementation
and repetition: 70% route skips, 10% attempts and 20% request finishes, across twenty
fixture providers. Each 250-event chunk was flushed. Median ingestion decreased
from 467.326 ms to 273.182 ms (1.71 times the event throughput), while also writing
durable hourly aggregates. Batched atomic writes amortize the additional work.

Forced flushing after every event is more expensive: 0.134 to 0.655 ms per event
in three alternating pairs. The runtime's record operation remains asynchronous;
do not interpret the bulk result as universally faster diagnostics. All correctness
counts matched. Both implementations admitted 1,000 and dropped 200 events in an
intentional 1,200-event burst; the candidate preserves its loss count across restart.

## Correctness and controlled experiments

The fixed-workload harness includes small synthetic repository repairs, answer
tasks, incorrect results and deadline failures. It records every task and includes
failure, cancellation and cleanup time in the batch denominator. Baseline and
candidate run in alternating order, with identical manifests and independent
acceptance cases. CPU, sampled process RSS, token uncertainty, implementation
digests and paired uncertainty estimates accompany the results.

The final comparison uses ten pairs at each benchmark-only concurrency cap of
one, two and four: 1,200 task runs. Both sides preserve the same expected outcomes.
The router source itself is unchanged; this is a harness/correctness experiment,
not evidence of a new routing or autonomous coding gain. Timing variation between
repeated sweeps is another reason not to infer a production speedup or raise live
concurrency from these fixtures.

Fallback replay likewise preserves healthy slow progress, timeout handling,
incorrect-result detection, quota hints and cleanup. Opaque provider deadlines,
protocol repair, billing guards, routing and quota policies remain unchanged.

## Live evidence and remaining limits

A separate read-only minute collector can retain existing runtime observations
without restarting an active worker. It records startup history loss explicitly;
historical events without verified version attribution remain unknown. New runtime
instrumentation additionally measures managed jobs, checkpoints and host verification.
Those observations live in separate private databases and do not automatically
declare a feature complete.

The primary future end-to-end score is independently verified tasks per elapsed
hour, with completion rate, failures/timeouts, resource use and rework reported
alongside it. Ordinary foreground tools, task difficulty and external provider
availability still require separate attribution. Whole-hour histogram summaries
give latency bounds and explicit coverage, not exact arbitrary-window percentiles.

Reproduction commands and guardrails are in [execution efficiency](efficiency.md)
and [passive collection](passive-efficiency.md). Detailed machine-readable benchmark,
test and installation receipts are retained privately by the operator; no provider
traffic or production game checks were used for this round.
