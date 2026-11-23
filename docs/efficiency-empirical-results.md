# Improvements from observed provider traffic

These changes address three problems found in ordinary Grunt traffic. They do not
change a running daemon until a new build is installed and activated.

## Evidence and limits

A two-hour observation window on 2026-11-22 contained 284 successfully completed
client model requests and 305 finished provider attempts. Seventeen completed
requests included a failed attempt. Eleven failed attempts excluding quota errors
accounted for 887 seconds of summed attempt duration. Pollinations accounted for
355 seconds, Clixad 162 seconds, Millionseek 126 seconds and Numes 126 seconds.
These are time spent in attempts, not measured wall-clock savings: work can overlap,
an alternate provider can also fail, and request workloads differ.

The same window contained 213 BeatAPI account checks returning HTTP 403, plus two
failed account transports without an HTTP status. A greedy offline replay of the
213 observed 403 checks, using their start and finish times and a thirty-second
negative admission interval, retained 99 checks and suppressed 114. Suppressed
transport durations summed to about fifty seconds. This assumes the negative
result would remain unchanged; it is not a live benchmark or a savings forecast.

## Bound repeated negative admission checks

The router already had a short negative admission interval, but model-list and
configured-access/recovery checks could reach `SourceStatus.available` without using
that interval. Repeated observations of an unavailable source therefore caused
serial provider metadata requests despite the router's admission throttle.

Ordinary non-quota negative admission evidence now has a shared thirty-second
interval. Positive metadata does not become cached authority to dispatch: selected adapters still
check current consent, access and free-use restrictions. Explicit health checks
can obtain fresh evidence, and provider quota deadlines remain authoritative.
Quota-specific model-list refreshes retain their existing recovery behavior.
Router admission still bounds repeated quota denials without a future reset;
known reset timestamps invalidate only negative observations made before that reset.

## Preserve Clixad's retirement

Clixad was deliberately removed from the product before these changes. The
observed usage-validation refusals are not addressed by relaxing validation,
increasing token limits or restoring the provider. A retired-source marker closes
the compatibility gap for older configurations and explicit source requests.
Saved source lists must not break startup, and requesting a retired provider must
not silently select another provider or invoke legacy setup.

## Keep performance evidence within its workload

Grunt already records reliability, latency and failed-attempt cost. The gap was
that a new task with too few matching observations could inherit its provider's
aggregate performance across interactive/background and text/tool workloads.
That can favor a provider using evidence from a different kind of request.

When a caller specifies a workload, routing weights now use only observations of
that workload. Until enough matching observations exist, the performance weight
is neutral. Calls without a workload retain their aggregate behavior. Existing
continuation migration requirements, explicit provider choices, native-session
boundaries, dispatch guards and cooldowns remain in force.

## Evaluate the result

Use deterministic offline tests to verify fewer negative checks, retired-source
behavior and routing decisions under mixed workloads, including failed-attempt
cost. The routing cohort replay can compare trusted local source checkouts:

```bash
node --import tsx scripts/routing-replay-benchmark.ts --baseline /trusted/baseline-checkout
```

Its deliberately opposing text/tool costs expose cross-workload selection bias.
The cold-cohort fixture moves from 941/59 draws to neutral 500/500 draws, while
the learned matching-cohort distribution and failure-cost penalty remain intact.
Those synthetic costs do not predict live provider ordering or elapsed-time gains.

After activation, compare equivalent workload and context cohorts using
completed-request latency, attempts per successful request, and failed-attempt
duration. Preserve coverage boundaries and include cancellations and unfinished
work explicitly. More model replies alone do not establish better coding output
or an overall efficiency gain.
