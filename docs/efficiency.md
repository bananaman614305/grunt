# Execution efficiency

These capabilities belong to the local Grunt runtime and apply to any configured
project. Project instructions and the coding interface still determine what work
is authorized. Grunt chooses tasks and providers through its existing interfaces.

## Coordinate independent work (removed)

Grunt subworkers and `grunt_coordinate` were removed; use your harness's native
subagents. See [removed subworkers](reference.md#subworkers-removed). Pi
background jobs and checkpoints were removed too; see
[their notice](reference.md#background-jobs-checkpoints-and-pi-release-tools-removed).

## Retain routing observations

The daemon keeps bounded reliability, latency and failure-cost observations in a
private `routing-history.db` alongside its local configuration. Text/tool and
interactive/background workloads have separate observations. Performance history
expires after six hours. The [router policy](router.md#2-score-back-off-retirement)
defines failure back-off, retirement and provider reset handling, including
across sibling runtime writes.

History never grants access or marks a source ready. Fresh free-access, consent,
billing and eligibility checks still run. If this optional store cannot open, the
daemon uses current-session observations and emits a fixed advisory message.

New-task performance weights use the requested workload's observations. Fewer than
two matching observations leave the performance weight neutral; interactive/tool
traffic does not inherit a score measured on background/text traffic. Existing
unscoped observation callers can still inspect the aggregate score.

Automatic foreground continuations with Pi function tools can reconsider a sticky
provider at a turn boundary. Migration requires sufficient recent observations of
the same workload, at least equal reliability and registry fit, a substantial
estimated advantage after context-transfer costs, repeated confirmation and a
minimum dwell time. Explicit provider choices and native coding-agent sessions are
not proactively migrated. This uses observed traffic, never additional inference
probes, and every selected adapter still enforces current dispatch guards.

## Avoid stalled streams and repeated metadata reads

Openference already streams its responses. Its adapter now reports meaningful
content, reasoning and tool-fragment progress: the router allows sixty seconds for
first output and sixty seconds between subsequent progress events. Headers,
heartbeats and whitespace do not extend the deadline. The adapter's overall
response deadline and complete-response/tool validation still apply; partial tool
calls are never returned early. Other sources that report only first output keep
their existing behavior. Opaque nonstreaming sources retain their existing response
deadlines because hidden reasoning cannot be distinguished from a stalled request.

Numes and Pollinations share overlapping read-only metadata checks within each
adapter instance. Cancelling one caller does not cancel other waiters. Completed
checks are not cached for later dispatch: a later call reads fresh access evidence,
and consent is checked for each caller. Cancellation and bounded check deadlines
prevent replacement storms when a transport has not finished cleaning up.

Ordinary admission, model-list and configured-access checks share a thirty-second
interval after non-quota negative availability evidence. This suppresses repeated
checks of an unavailable provider without retaining positive authority to spend
or bypassing selected-adapter guards. Explicit health checks can refresh evidence,
and quota reset deadlines remain in force.
Quota-specific model-list checks retain their existing fresh recovery behavior;
router admission still bounds repeated quota checks when no future reset is known.
The [empirical results](efficiency-empirical-results.md) explain the measurements
and limits behind these changes.

Grunt-owned OpenCode servers shut down after five idle minutes and restart on
demand. On POSIX, cleanup also terminates descendants in the server's owned process
group; Windows cleanup targets the owned server process. Descendants that detach
into separate process groups remain outside this cleanup. Active requests and
externally supplied server URLs are excluded. Deliberate idle recycling retains
native session identifiers and model cooldowns while preparing the replacement
process afresh. This bounds
idle resource retention; it does not prevent memory growth during an active native
request or disable inherited user MCP configuration.

## Verification input reads

Verification reads at most four source files concurrently and avoids rereading a
file named both by Git and an artifact root within one capture. Release-plan
validation captures each distinct artifact set once per validation. These are
within-operation optimizations: every later validation rereads current bytes,
retains mutation/symlink checks and authenticates the required receipts.

## Measure changes offline

From a development checkout with dependencies installed, run:

```bash
pnpm benchmark:efficiency --baseline /absolute/baseline-checkout --iterations 7
node --import tsx scripts/verification-benchmark.ts --baseline /absolute/baseline-checkout/src/local/verification.ts
```

The first command verifies the result of repeated synthetic tasks after a simulated
stream stall and reports attempts plus median/tail completion times. It uses
scaled fixture deadlines. The second compares full content capture and validation
of six authenticated synthetic checks sharing an artifact set; baseline/current
digests must match. Both commands run offline without provider or account traffic.
The baseline must be a trusted local checkout with dependencies installed.

These measurements isolate runtime overhead. They do not establish a general
coding-task speedup. For that, compare equivalent tasks and provider conditions,
count only correctly completed and verified work, and include retries, rework,
tokens and memory in the result.

### Retain a usable before/after baseline

New diagnostics stores maintain hourly aggregate counts, duration sums, maxima and
explicit latency histograms independently of the bounded raw event journal.
Aggregates retain up to thirty days, subject to documented row and series limits.
They distinguish runtime version, client requests, helper/worker work, providers,
failure classes and stages. Repeated event IDs are counted once within the retained
deduplication horizon; older events are rejected with a coverage counter rather
than silently counted again. High-cardinality overflow is explicit. Histograms
give ranges, not exact medians or percentiles. Whole-hour query alignment and
coverage boundaries appear in the report; partial windows must not be presented
as precise release comparisons.

The runtime caps history at 50,000 aggregate rows, 256 series per hour (including
overflow) and 200,000 retained event IDs. Inspect `limits`, `ingestionHealth` and
`coverage` before comparing windows: `persistentDroppedEvents` survives restart,
`droppedEvents` also includes pending losses, and `droppedLateEvents` and
`overflowEvents` describe additional coverage limits. `retainedFrom`, `startedAt`
and `deduplicationFloor` bound usable history; missing data is not zero activity.

```bash
usegrunt efficiency metrics
usegrunt efficiency metrics --port 8792
usegrunt efficiency metrics --port 8792 --since 1795363200000 --until 1795366800000
```

Without `--port`, the command uses `GRUNT_PORT` (or the compatibility `MILO_PORT`),
then the saved installed port, then 8788. It defaults to the last 24 hours;
`--since` and `--until` accept Unix milliseconds and cannot request future data.
This only reads local `/v1/diagnostics/metrics`; it never probes providers. Runtime
version is read from the trusted installed package, not a model-supplied field.
An observed version transition records a release marker, not proof that all
in-flight work used the new version. Old data is not backfilled with an invented
version or reconstructed after pruning. Route-skip trace events remain intact;
hourly counters survive their eviction from raw history.

The [passive collector](passive-efficiency.md) can preserve allowlisted summaries
from an existing runtime using a read-only SQLite connection, without installing a
new Grunt version or restarting a worker. It stores its own cursor, coverage gaps,
histograms and markers in separate private state. Use that collector when the raw
journal turns over faster than the intended comparison period.

The new runtime command, aggregates and managed-work spans require the updated
daemon or coding-interface process to be active. Installing a new CLI alone does
not replace a running runtime. The separate passive collector can preserve older
runtime events before that activation; it cannot add spans those events lack.

### Attribute time to actual work

Host verification emits correlated setup, queue, capture, tool and verification
spans, and marks fresh execution, reused results and deduplicated active work
separately. Tool duration includes helper startup; unmanaged foreground tools
remain outside these spans. These observations never include commands, output,
file paths or prompts, and an observer failure cannot change execution or
verification authority. (The Pi background-job and checkpoint spans, including the
checkpoint stage and operation labels, were removed with those features; older
runtimes may still have recorded them.)

Host verification observations use the host state directory's `efficiency`
subdirectory. Their store is lazy and drained after work settles at shutdown. It
is separate from daemon request metrics; the passive collector may read each
database into separately identified state. No public command can declare that a
feature has been independently verified.

The internal `createWorkTimingObserver`/`measureWorkTiming` API can record explicit
task boundaries when a trusted task owner has an actual acceptance result. A
successful request, returned tool call or completed check is not
automatically a verified task. Correlated overlapping stage durations must not be
summed and reported as exclusive wall-clock time. Ordinary tools outside these
managed paths and autonomous feature acceptance remain outside this instrumentation.

### Compare a fixed workload with failures included

```bash
pnpm benchmark:workload --baseline /absolute/trusted-baseline \
  --repetitions 5 --tasks 20 --seed 20261122 --concurrency 1,2,4
pnpm benchmark:efficiency --replay --baseline /absolute/trusted-baseline --iterations 5
pnpm benchmark:metadata --baseline /absolute/trusted-baseline
```

The workload benchmark also runs from a compiled, source-free package:

```bash
node /trusted/candidate/dist/local/workload-benchmark.js \
  --baseline /trusted/built-baseline --repetitions 5 --tasks 20 --concurrency 1,2,4
```

The compiled harness requires a built baseline (`dist/local/source.js`); build a
source-only baseline first, or run the source harness with
`node --import tsx src/local/workload-benchmark.ts`. The source harness can load either format.
Public `usegrunt` and managed `grunt-runtime`/`milo-runtime` packages are accepted.
Git metadata is optional: source-free packages report a null commit and bounded
code fingerprints. Fallback-replay and metadata comparison commands above remain
development-source tools and require trusted source checkouts.

The workload benchmark resets isolated synthetic fixtures, verifies results against
fixed acceptance cases and alternates baseline/candidate order. Incorrect answers
and deadline failures are intentional negative controls. Reports include every task,
batch makespan including failure/cleanup time, verified tasks per elapsed hour,
completion counts, verified-task latency, attempts, synthetic/unknown token usage,
process CPU and sampled RSS. Manifest, code and environment digests identify the
comparison. Paired bootstrap intervals describe timing uncertainty; a few repetitions
are a smoke measurement, not strong statistical evidence. If completion counts differ,
report both outcomes and throughput rather than a speedup claim alone.

Concurrency 1/2/4 belongs only to this offline benchmark. It does not raise live
worker admission, bypass resource budgets, race paid provider requests or change
provider selection. Resource statistics are process-wide; they do not establish
memory isolation or production capacity. No concurrency increase should ship without
representative task correctness and memory-pressure evidence.

Replay exercises meaningful progress, healthy slow responses, native turn limits,
quota fallback, incorrect fast answers, timeouts and cancellation cleanup. Quota
reset hints are recorded separately from time actually spent. Opaque adapters keep
their existing deadlines; skipping protocol repair or cutting hidden reasoning is
not counted as an optimization. Additional Mistral/Pollinations failure categories
help distinguish protocol, model, usage and content rejection without retaining bodies.

Metadata benchmarks compare actual trusted baseline/current adapters with injected
transports and verify unchanged output and completion counts. BeatAPI coalesces
overlapping preflight usage reads while retaining a separate fresh post-inference
balance check. Darus coalesces protected overlapping metadata reads. Calls retain
per-caller consent/grant checks, separate credential identities and independent
cancellation; later calls read fresh evidence. These fixtures can prove reduced
redundant work without demonstrating lower real-provider latency.

For end-to-end coding claims, use equivalent independently checked tasks with the
same acceptance criteria, include failed and timed-out runs in elapsed time, report
task families and provider conditions, and keep a holdout workload. Tokens and CPU
per verified task are efficiency measures alongside throughput, not substitutes for
correctness. Passive production observations corroborate controlled tests; they do
not remove workload and provider confounding on their own.

## Configure a trusted publication host

Publication is an operator opt-in. The private host policy selects the project,
repository, branch prefix/base, Pages branch, static artifact directory, required
check IDs, fixed check commands, the review path list and merge/deploy
permissions. It also pins Git configuration and an isolated sandbox argv template.
Keep the policy and authority directory outside the project and all worker mounts.
An existing `core.hooksPath=/dev/null` is accepted; custom hooks and included
Git configuration remain rejected.

The host currently requires Linux, `/usr/bin/bwrap`, `/usr/bin/git`,
`/usr/bin/gh` and host-side GitHub authentication. The host runs no reviewer:
Grunt reviews its own releases and records the outcome (see below). Use an ordinary Git checkout
with a real `.git/config`; linked worktrees are unsupported. GitHub Pages must
already use the configured Pages branch at its root.

The JSON policy has `version: 1` and these fields:

| Field | Required value |
| --- | --- |
| `projectRoot`, `stateDirectory`, `channelDirectory` | Canonical absolute, separate directories; none may contain another. |
| `workerPort` | Legacy (formerly the subworker port): still required from 1024 to 65535 but unused. |
| `gitConfigSha256` | SHA-256 of the approved project's `.git/config` bytes. |
| `plans` | Release plans with `version: 1`, `id`, `mode: "release"` and fixed `checks` containing `id`, `command`, optional `timeoutSeconds` and `artifactPaths`. Check IDs must be unique across plans. |
| `sandboxArgv` | Operator-defined `/usr/bin/bwrap` argument array with `--unshare-all`, `--die-with-parent`, `--new-session`, `--clearenv` and exactly one `--bind $WORKSPACE $PROJECT`. `$WORKSPACE`, `$PROJECT` and `$COMMAND` substitutions must each occupy a whole argument. Include the required runtime/dependencies through permitted read-only mounts. |
| `publication` | `version: 1`, matching `projectRoot`, `repository` (`owner/repo`), `base`, slash-terminated `headPrefix`, `requiredChecks`, `reviewPaths` (still required, now unused: it named the paths the removed reviewer owned), `artifactDirectory`, `pagesBranch`, `allowMerge`, `allowDeploy` and optionally `maxScreenedCommits` (integer 1 to 100000, default 10000). |
| `holdFiles` | Optional list of absolute paths; the existence of any one prevents admission of new host work. |

Before any release is prepared, reviewed or pushed the host screens the commits
that would newly become public (reachable from the candidate but not from the
pinned base) for private-looking file names: the candidate's whole tree plus
every path added by any new commit, found with one `git log` pass, so a secret
committed and later deleted is still refused. A range of more than
`maxScreenedCommits` commits is refused with the policy field named in the
release status's `lastRequestDetail`. Omitting the field changes nothing about an
existing policy or its digest. The release also needs a named branch checkout
under `headPrefix`; a detached `HEAD` is refused.

Every check's `artifactPaths` must be exactly `[publication.artifactDirectory]`,
and all `requiredChecks` must exist in the plans. Build the static artifact before
requesting verification; checks must leave the input snapshot and artifact bytes
unchanged. Store policy/manifest files with owner-only permissions and private
directories with mode `0700`. The host rejects symlinks and changed or
execution-sensitive Git configuration.

The coding worker receives only a read-only JSON channel manifest:

```json
{"version":1,"projectRoot":"/absolute/project","channelDirectory":"/private/worker-channels"}
```

The trusted launcher sets `GRUNT_EXECUTION_CHANNEL_FILE` to that manifest and
mounts it read-only. Manifest paths refer to the worker namespace; the host policy
uses the corresponding host paths. The worker-side client reads it with
`loadExecutionHostChannels` from `dist/local/efficiency-host.js`, which returns a
verification-broker client and a publication channel over the private file
channel. Grunt no longer ships tools for this protocol (the former
`grunt_verify_release*` and `grunt_release_*`): a harness-native client, such as
a release command run by Claude Code, Codex or OpenCode, is the supported caller.
No checks, reviews or GitHub operations run merely because the service starts.

Run the configured host explicitly:

```bash
usegrunt execution-host serve --config /absolute/private-policy.json
usegrunt execution-host tick --config /absolute/private-policy.json
usegrunt execution-host status --config /absolute/private-policy.json
```

`serve` stays active; `tick` consumes one bounded batch and `status` reads private
health metadata. Holds prevent new work but do not cancel an already running
check or publication stage. Configure holds and the service lifecycle to follow
the coding worker's deliberate pauses. Stopping the host cancels its owned child
process groups. A stale process lease can be recovered without replaying
interrupted checks.

The release client queues each configured check through the verification
channel, continues independent work and collects the result by its ID. The host
runs only its fixed command in a private isolated snapshot. It signs successful
unchanged results and rejects missing artifacts, changed inputs, interruptions and
model-written claims.

Commit a clean candidate before requesting the required checks. After collecting
their IDs, the client requests publication `prepare` with `{head, branch, title,
body, verificationIds}`. A release whose receipts verify waits in `awaiting_review`;
the builder reviews it (for Grunt, with its own Claude Code subagent) and sends
`review-record` with the release `id` and exactly `{id, head, gitTree, verdict,
summary}`: the 40-hex commit and Git tree it reviewed, `verdict` of `approve` or
`changes_requested`, and a summary of 1 to 2000 characters that the builder
chooses. The host records only that summary. It refuses the record unless the
release is still `awaiting_review` with no review, its verification receipts
still authenticate, the project is still the exact verified candidate, the
commit and tree match it and the changed paths pass the private-file screen. An
approval makes the release `ready`; `changes_requested` blocks it with reason
`changes_requested`, and a fix needs a new commit and a new `prepare`. A refused
record leaves the release as it was and answers `review_not_recorded`. Repeating
the identical record is harmless; a second, different verdict is refused.

The host cannot know who reviewed, so the evidence is labelled `source:
"builder"`. It proves the verdict named this exact commit and tree after the
authenticated checks, not that the reviewer was independent of the author. Every
other gate is unchanged. Then the client uses `advance` and `status` with the
request `id`. Each advance request queues one stage; the host does not advance the
whole release automatically (an advance while awaiting review changes nothing).
Status reads do not advance work. The durable queue requires a recorded approving
review and matching authenticated
receipts. It merges the exact tested tree using a non-force compare-and-swap
update, uploads the verified static artifact bytes and confirms the exact Pages
build commit. New base work or changed evidence blocks publication. Private and
executable GitHub configuration paths are excluded from static uploads.

Signing keys and GitHub credentials remain host-only. Worker-visible status is
advisory; authority is rechecked privately at every release gate. Unresolved
checks and requested changes must be addressed before a new publication attempt. A configured
publication path does not grant permission to skip checks or claim deployment
before its verified build completes.
