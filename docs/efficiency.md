# Execution efficiency

These capabilities belong to the local Grunt runtime and apply to any configured
project. Project instructions and the coding interface still determine what work
is authorized. Grunt chooses tasks and providers through its existing interfaces.

## Coordinate independent work

`usegrunt workers connect pi --agentic` prints a launch command enabling scoped
workers, background jobs and checkpoints. `grunt_coordinate` accepts a main task
and up to eight task declarations, with disjoint owned paths and dependencies.
Dispatch admits at most two independent workers when local status metadata leaves
capacity for the main agent. It neither probes providers nor resets quotas.

The main agent continues its own task, collects completed batches through
`grunt_worker_result`, inspects artifacts and explicitly integrates their changes.
Dependencies remain deferred until integration and a new plan. Failed, cancelled
or unresolved batches are never replayed automatically. Completed summaries remain
usable after the shared batch cache evicts their detailed results.

## Retain routing observations

The daemon keeps bounded reliability, latency and failure-cost observations in a
private `routing-history.db` alongside its local configuration. Text/tool and
interactive/background workloads have separate observations. Performance history
expires after six hours. Identical unhinted transient failures extend adaptive
backoff from the existing delay up to two hours. Explicit provider reset hints and
quota deadlines retain their own timing, including across sibling runtime writes.

History never grants access or marks a source ready. Fresh free-access, consent,
billing and eligibility checks still run. If this optional store cannot open, the
daemon uses current-session observations and emits a fixed advisory message.

## Reuse scoped verification

Add `verification: {mode: "scoped", checkId: "unit", artifactPaths: ["dist"]}`
to a normal `grunt_job_start` command to bind its result to the command, timeout,
environment, Git HEAD, tracked/nonignored untracked contents and named artifacts.
An identical active job is deduplicated; successful unchanged results can be
reused for fifteen minutes, including after restart. Changed inputs, expired
results, failures and interruptions require a new run.

Long browser/mobile/e2e checks use managed jobs so the main agent can continue
independent work. Scoped job receipts do not authorize a release. Required release
checks run through the separately configured host authority below.

## Resume focused context

`--grunt-checkpoints` enables `grunt_checkpoint_write`, `grunt_checkpoint_read`
and `grunt_checkpoint_resume`. Save the original requirements, concise completed
claims, pending job/worker/artifact IDs and the next action. Writes use revision
checks; the harness binds the project/session and computes file hashes.

On resumption, discover saved task IDs, revalidate selected files and reconcile
pending results before rerunning work. Handoffs include only selected facts and
excerpts within a bounded budget, while retaining every saved requirement.
Credential paths are excluded. Checkpoint content is advisory task data; it never
replaces instructions or supplies test/review authority.

## Configure a trusted publication host

Publication is an operator opt-in. The private host policy selects the project,
repository, branch prefix/base, Pages branch, static artifact directory, required
check IDs, fixed check commands, independent review paths and merge/deploy
permissions. It also pins Git configuration and an isolated sandbox argv template.
Keep the policy and authority directory outside the project and all worker mounts.

The worker receives only a read-only JSON channel manifest:

```json
{"version":1,"projectRoot":"/absolute/project","channelDirectory":"/private/worker-channels"}
```

The trusted launcher sets `GRUNT_EXECUTION_CHANNEL_FILE` to that manifest and
enables `--grunt-background-jobs --grunt-publication`. Manifest paths refer to
the worker namespace; the host policy uses the corresponding host paths.
Publication tools are absent without both the flag and configured channel.
No checks, reviews or GitHub operations run merely because the service starts.

Run the configured host with `usegrunt execution-host serve --config
/absolute/private-policy.json`; `tick` consumes one bounded batch and `status`
reads its private health metadata. Configure holds and the service lifecycle to
follow the coding worker's deliberate pauses. A stale process lease can be
recovered without replaying interrupted checks.

Grunt queues each configured check with
`grunt_verify_release({planId, checkId})`, continues independent work and collects
the result with `grunt_verify_release_result({id})`. The host runs only its fixed
command in a private isolated snapshot. It signs successful unchanged results and
rejects missing artifacts, changed inputs, interruptions and model-written claims.

After committing a clean candidate, Grunt requests
`grunt_release_prepare({head, branch, title, body, verificationIds})`, then uses
`grunt_release_advance({id})` and `grunt_release_status({id})`. The durable queue
requires an actual separate read-only Grunt reviewer and matching authenticated
receipts. It merges the exact tested tree using a non-force compare-and-swap
update, uploads the verified static artifact bytes and confirms the exact Pages
build commit. New base work or changed evidence blocks publication. Private and
executable GitHub configuration paths are excluded from static uploads.

Signing keys and GitHub credentials remain host-only. Worker-visible status is
advisory; authority is rechecked privately at every release gate. Unresolved
checks/reviews must be addressed before a new publication attempt. A configured
publication path does not grant permission to skip checks or claim deployment
before its verified build completes.
