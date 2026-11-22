# Execution efficiency

These capabilities belong to the local Grunt runtime and apply to any configured
project. Project instructions and the coding interface still determine what work
is authorized. Grunt chooses tasks and providers through its existing interfaces.

## Coordinate independent work

`usegrunt workers connect pi --agentic` prints a launch command enabling scoped
workers, background jobs and checkpoints. `grunt_coordinate` accepts a main task
and up to eight task declarations, with disjoint owned paths for independent work
and explicit dependencies for work that must wait.
Dispatch admits at most two independent workers when local status metadata leaves
capacity for the main agent. It neither probes providers nor resets quotas.

For example, declare ownership before dispatching through Pi's tools:

```js
grunt_coordinate({operation: "plan", main: {
  task: "Update the usage guide", ownedPaths: ["docs/usage.md"]
}, tasks: [{id: "empty-state", task: "Implement the empty-state component",
  activity: "implementation", ownedPaths: ["src/empty-state.ts"]}]})
grunt_coordinate({operation: "dispatch"})
grunt_coordinate({operation: "status"})
```

`plan` records work; only `dispatch` starts it. An empty `tasks` list is valid
when no independent work exists. Coordination plans belong to the current Pi
session/project. Plans and completed summaries survive frontend restart when
the coding interface restores the same Pi session identity and canonical project.
They are stored in private `~/.cache/grunt/coordination` state; the trusted launch
setting `GRUNT_COORDINATION_STATE_DIR` can select another absolute directory outside
the project. Without a stable session identity, a new launch starts a separate plan.

The main agent continues its own task, collects completed batches through
`grunt_worker_result`, inspects artifacts and explicitly integrates their changes.
Dependencies remain deferred until integration and a new plan. Failed, cancelled
or unresolved batches are never replayed automatically. Completed summaries remain
usable after the shared batch cache evicts their detailed results.

Restored running batches whose live results cannot be recovered become unresolved.
Grunt must inspect their retained IDs and artifacts before explicitly replanning.
Dispatch records its intent before starting a batch, so an interrupted or concurrent
frontend cannot silently repeat it. Saved summaries are advisory context, not proof
of integration, passing checks or independent review.

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

Grunt-owned OpenCode servers shut down after five idle minutes and restart on
demand. On POSIX, cleanup also terminates descendants in the server's owned process
group; Windows cleanup targets the owned server process. Descendants that detach
into separate process groups remain outside this cleanup. Active requests and
externally supplied server URLs are excluded. Deliberate idle recycling retains
native session identifiers and model cooldowns while preparing the replacement
process afresh. This bounds
idle resource retention; it does not prevent memory growth during an active native
request or disable inherited user MCP configuration.

## Reuse scoped verification

Add `verification: {mode: "scoped", checkId: "unit", artifactPaths: ["dist"]}`
to a normal `grunt_job_start` command to bind its result to the command, timeout,
environment, Git HEAD, tracked/nonignored untracked contents and named artifacts.
An identical active job is deduplicated; successful unchanged results can be
reused for fifteen minutes in the same session, including after restart. Changed
inputs, expired results, failures and interruptions require a new run.

```js
grunt_job_start({command: "pnpm test", category: "test", timeoutSeconds: 900,
  verification: {mode: "scoped", checkId: "unit", artifactPaths: ["dist"]}})
// Continue independent work, then collect the returned job ID:
grunt_job_result({id: "returned-job-id"})
```

Ignored files are outside the input snapshot unless included as named artifacts;
external services are not captured. If those inputs change, use a new `checkId`
to force a fresh scoped check.

Long browser/mobile/e2e checks use managed jobs so the main agent can continue
independent work. Scoped job receipts do not authorize a release. Required release
checks run through the separately configured host authority below.

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

```bash
usegrunt efficiency metrics --port 8792
usegrunt efficiency metrics --port 8792 --since 1795363200000 --until 1795366800000
```

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

### Attribute time to actual work

Background jobs emit correlated setup, queue, capture, tool and collection spans.
Host verification emits setup, queue, capture, tool and verification spans;
checkpoint tools distinguish write, read and resume operations. Scoped verification
marks fresh execution, reused results and deduplicated active work separately.
Tool duration includes helper startup; unmanaged foreground tools and the supervisor's
checkpoint lifecycle remain outside these spans. These observations never include commands, output, file paths, prompts or checkpoint
content, and an observer failure cannot change execution or verification authority.

Pi observations are stored privately under the jobs state directory's `efficiency`
subdirectory. Host verification observations use the host state directory's
`efficiency` subdirectory. Their stores are lazy and drained after work settles at
shutdown. They are separate from daemon request metrics; the passive collector may
read each database into separately identified state. No public worker command can
declare that a feature has been independently verified.

The internal `createWorkTimingObserver`/`measureWorkTiming` API can record explicit
task boundaries when a trusted task owner has an actual acceptance result. A
successful request, returned tool call, checkpoint write or completed job is not
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

## Resume focused context

`--grunt-checkpoints` enables `grunt_checkpoint_write`, `grunt_checkpoint_read`
and `grunt_checkpoint_resume`. Save the original requirements, concise completed
claims, pending job/worker/artifact IDs and the next action. Writes use revision
checks; the harness binds the project/session and computes file hashes.

For example, create a task at revision zero, then discover it and select context:

```js
grunt_checkpoint_write({taskId: "empty-state", expectedRevision: 0,
  goal: "Add an empty state", requirements: ["Keep keyboard navigation usable"],
  facts: [{id: "entry", text: "The component lives in src/empty-state.ts"}],
  files: ["src/empty-state.ts"], nextAction: "Inspect the completed worker artifact"})
grunt_checkpoint_read({})
grunt_checkpoint_resume({taskId: "empty-state", factIds: ["entry"],
  files: [{path: "src/empty-state.ts", startLine: 1, lineCount: 60}]})
```

Use the current revision returned by `grunt_checkpoint_read({taskId})` for later
writes. State defaults to `~/.cache/grunt/checkpoints`; the trusted launch setting
`GRUNT_CHECKPOINT_STATE_DIR` selects another absolute private directory.
Discovery is limited to the same project and Pi session identity.

On resumption, discover saved task IDs, revalidate saved files and reconcile
pending results before rerunning work. Handoffs include only selected facts and
excerpts within a bounded budget, while retaining every saved requirement.
The default context budget is 32 KiB; `maxContextBytes` accepts 1–64 KiB.
Credential paths are excluded. Checkpoint content is advisory task data; it never
replaces instructions or supplies test/review authority.

## Configure a trusted publication host

Publication is an operator opt-in. The private host policy selects the project,
repository, branch prefix/base, Pages branch, static artifact directory, required
check IDs, fixed check commands, independent review paths and merge/deploy
permissions. It also pins Git configuration and an isolated sandbox argv template.
Keep the policy and authority directory outside the project and all worker mounts.
An existing `core.hooksPath=/dev/null` is accepted; custom hooks and included
Git configuration remain rejected.

The host currently requires Linux, `/usr/bin/bwrap`, `/usr/bin/git`,
`/usr/bin/gh`, host-side GitHub authentication and a running local Grunt daemon
at the policy's `workerPort` for independent review. Use an ordinary Git checkout
with a real `.git/config`; linked worktrees are unsupported. GitHub Pages must
already use the configured Pages branch at its root.

The JSON policy has `version: 1` and these fields:

| Field | Required value |
| --- | --- |
| `projectRoot`, `stateDirectory`, `channelDirectory` | Canonical absolute, separate directories; none may contain another. |
| `workerPort` | Local Grunt daemon port, from 1024 to 65535. |
| `gitConfigSha256` | SHA-256 of the approved project's `.git/config` bytes. |
| `plans` | Release plans with `version: 1`, `id`, `mode: "release"` and fixed `checks` containing `id`, `command`, optional `timeoutSeconds` and `artifactPaths`. Check IDs must be unique across plans. |
| `sandboxArgv` | Operator-defined `/usr/bin/bwrap` argument array with `--unshare-all`, `--die-with-parent`, `--new-session`, `--clearenv` and exactly one `--bind $WORKSPACE $PROJECT`. `$WORKSPACE`, `$PROJECT` and `$COMMAND` substitutions must each occupy a whole argument. Include the required runtime/dependencies through permitted read-only mounts. |
| `publication` | `version: 1`, matching `projectRoot`, `repository` (`owner/repo`), `base`, slash-terminated `headPrefix`, `requiredChecks`, `reviewPaths`, `artifactDirectory`, `pagesBranch`, `allowMerge` and `allowDeploy`. |
| `holdFiles` | Optional list of absolute paths; the existence of any one prevents admission of new host work. |

Every check's `artifactPaths` must be exactly `[publication.artifactDirectory]`,
and all `requiredChecks` must exist in the plans. Build the static artifact before
requesting verification; checks must leave the input snapshot and artifact bytes
unchanged. Store policy/manifest files with owner-only permissions and private
directories with mode `0700`. The host rejects symlinks and changed or
execution-sensitive Git configuration.

The worker receives only a read-only JSON channel manifest:

```json
{"version":1,"projectRoot":"/absolute/project","channelDirectory":"/private/worker-channels"}
```

The trusted launcher sets `GRUNT_EXECUTION_CHANNEL_FILE` to that manifest and
enables `--grunt-background-jobs --grunt-publication`. Manifest paths refer to
the worker namespace; the host policy uses the corresponding host paths.
Publication tools are absent without both the flag and configured channel.
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

Grunt queues each configured check with
`grunt_verify_release({planId, checkId})`, continues independent work and collects
the result with `grunt_verify_release_result({id})`. The host runs only its fixed
command in a private isolated snapshot. It signs successful unchanged results and
rejects missing artifacts, changed inputs, interruptions and model-written claims.

Commit a clean candidate before requesting the required checks. After collecting
their IDs, Grunt requests
`grunt_release_prepare({head, branch, title, body, verificationIds})`, then uses
`grunt_release_advance({id})` and `grunt_release_status({id})`. Each advance request
queues one stage; the host does not advance the whole release automatically.
Status reads do not advance work. The durable queue requires an actual separate
read-only Grunt reviewer and matching authenticated
receipts. It merges the exact tested tree using a non-force compare-and-swap
update, uploads the verified static artifact bytes and confirms the exact Pages
build commit. New base work or changed evidence blocks publication. Private and
executable GitHub configuration paths are excluded from static uploads.

Signing keys and GitHub credentials remain host-only. Worker-visible status is
advisory; authority is rechecked privately at every release gate. Unresolved
checks/reviews must be addressed before a new publication attempt. A configured
publication path does not grant permission to skip checks or claim deployment
before its verified build completes.
