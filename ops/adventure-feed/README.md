# Amazing Adventure activity

On Chad, run `grunt-adventure live` for the terminal feed. It polls the runner's
private Pi session and the read-only status endpoint of the dedicated game pool
on loopback port 8793 every two seconds. That pool handles project requests
without periodic provider health checks. Progress comes from completed, visible
assistant text. The projector filters code fences, inline code, links, paths and common
credential patterns. Tool entries contain the tool's name and outcome.

The owner dashboard at `/admin/#activity` shows the answering provider, the
last successful provider, provider issues and the latest 40 progress or tool
entries. A failed provider that the project pool can retry now carries its
current state along with the last error. Model labels come from the configured
route. Labels matching the receiver's secret filter are omitted while source
identity, status and progress remain visible; a label never disables the feed.
The web view refreshes about every five seconds while visible.

The publisher reads the `Current task` and `Next steps` sections of Grunt's
`GRUNT_STATUS.md` checkpoint. The overview labels the checkpoint with its update
time. It also shows recent milestones from public Amazing Adventure pull request
metadata, cached for four minutes. The dashboard displays the actual draft,
review, merged or closed state and builds links from pull request numbers. The
checkpoint and timeline travel with the private activity snapshot.

The publisher also samples project work every five seconds. Give its service
write access to the private `uptime/` directory under the adventure state root.
The SQLite ledger survives publisher restarts and retains eight days of data.
The browser shows rolling 24-hour and seven-day totals. The legacy work/downtime
columns remain available. Detailed intervals are disjoint: execution and
orchestration, inference, tool/job waits, provider waits, idle/paused, and
blocked/unavailable. Inference includes processing and generation; it is not
all wasted time. Process presence or a fixed sleep is not productive execution.
A quiet recent tool is a wait, and an old silent unmanaged tool remains a stall.
Observed CPU activity is evidence of processing, not of useful game progress.
A model-only interval can become provider wait after that attempt fails.

The percentage uses measured time. Gaps longer than 15 seconds and time before
monitoring remain unmeasured. Existing database intervals migrate without
inventing a detailed category and appear as unclassified measured time. The
monitor checks the running Pi process for quiet shell tools when logs are
buffered. CPU progress among descendants, fresh nested replies, and fresh nested
requests help distinguish execution from long waits.

The activity snapshot also includes the dedicated Adventure pool's sanitized
worker statuses from port 8793. It preserves allowlisted failure codes,
capabilities, mode, turn/tool counters and artifact-availability flags, but never
worker prompts, commands, paths, artifacts or model output. The overview prefers
this pool over the primary daemon's snapshot for the same installation, avoiding
duplicate workers. Missing updates remain visibly stale.

Worker utilization is sampled occupied time divided by the observed capacity of
two subworker slots. Occupancy includes explicitly reported source waits. The
private SQLite ledger retains intervals and deduplicated completion/failure IDs
across restarts; an empty recent list is never treated as historical idle time.
Recording gaps stay outside the denominator. No historical utilization is
backfilled before these observations exist.

For managed jobs, the collector reads only the owner's configured session at
`worker/jobs/sessions/<sessionId>/snapshot.json` below the Adventure state root.
The runner uses `GRUNT_JOBS_STATE_DIR=/worker/state/jobs` inside the sandbox.
Snapshots must be private, bounded, version 1 and no more than 15 seconds old;
the job runner refreshes active snapshots every five seconds. The projection
retains category, state, timestamps, numeric exit and optional Git metadata,
never command/output. Active quiet jobs count as intentional tool waits.
Observed test/build exits are deduplicated by job ID. The distinct revision
count requires a successful exit and the same clean Git HEAD at start and finish.
These are observed check jobs, not proof of semantic correctness or playability.
The owner project collector separately reads actual successful GitHub Pages
deployment statuses tied to revision/time. Every four minutes it requests at
most 20 recent deployment records and two previously unseen/pending status
histories. It caches up to 256 histories. The dashboard labels those published
build/revision counts as observed lower bounds with partial coverage and the
last check time. Errors retain dated cached evidence for at most one hour,
then return unknown. Successful deployment is not proof of playability. No
Actions workflow, game test or deployment is run by this collector.

These metrics require real opt-in execution metadata. Pi must load Grunt's
installed worker extension and be launched with `--grunt-agent-workers` for
scoped workers and `--grunt-background-jobs` for managed jobs; neither ordinary
setup nor a dashboard deploy grants those capabilities. Use
`usegrunt workers connect pi --agentic` for the launch command. The owner's
separate [execution staging runbook](../adventure-execution/README.md) handles
reviewed installation and restart preparation; this collector never starts
workers, applies artifacts, runs checks or develops the game.

Managed jobs belong to the coding session. The agent must collect their outcomes
or cancel them before ending/checkpointing; shutdown cancels active work and
recovery records interruptions without replaying commands. Worker artifacts
remain retained for scoped inspection and explicit caller-side application.
The dashboard receives only their availability flags, not their contents.
For commands and the review/apply/discard workflow, see the
[worker reference](../../docs/reference.md#subworkers) and
[background-job reference](../../docs/reference.md#background-command-jobs).

Updating the npm package alone does not install these operator scripts. For this
owner deployment, install the reviewed `activity.py` and `uptime.py` together in
the existing activity-service directory, preserve its private state directory and
write allowance, and restart only the activity publisher. Existing SQLite history
is migrated in place. Deploy the matching backend projector and admin assets
through the normal Grunt deployment. No game service restart is required.

Chad can run `activity.py upload` as a separate user service. It uses the
existing private collector environment file for the ingestion credential
and approved instance ID. It sends the projected snapshot only to the existing
Fly gateway over HTTPS. The handler serves it to signed-in owners and stores
one snapshot per approved instance in memory for up to two minutes after
the publisher's last update. Recent entries come from the past day of the
local session. The activity feed is separate from request diagnostics and
their exports. Normal Grunt installations opt in explicitly through an owner
operator.

Run projection tests with `python3 -m unittest discover -s ops/adventure-feed`.
