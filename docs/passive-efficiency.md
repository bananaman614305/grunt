# Preserve live efficiency evidence without restarting Grunt

`scripts/passive-efficiency-collector.py` reads the existing diagnostic database
with SQLite `mode=ro` and `query_only=ON`. It makes no HTTP/provider requests and
never opens the source database for writing. It stores only allowlisted hourly
aggregates, deduplication IDs, a cursor, explicit coverage gaps and release/baseline
markers in a separate private `efficiency.sqlite`. It does not retain prompts,
commands, tool arguments, task strings, paths, response bodies or raw errors.

This collector can run alongside a currently active runtime. Its outputs are
observational; they never change provider selection, backoffs, dispatch or accounts.
Source reads use a short SQLite snapshot; the snapshot is closed before aggregate
processing. An output transaction serializes overlapping invocations, so a repeated
or concurrent tick does not count the same observed event twice.

## Capture and report

Use Python 3.10 or newer with its standard SQLite module. Choose a state directory
outside both the project and the live diagnostic directory. The leaf directory must
be owned by the current user with mode `0700`; the collector creates it if absent.
State databases/sidecars must be regular owner-only files. Symlinked output paths,
symlink ancestors, and symlinked source databases are rejected.

```sh
python3 /trusted/checkout/scripts/passive-efficiency-collector.py \
  --once --database /private/grunt/diagnostics.db \
  --runtime-package /trusted/active-runtime/package.json \
  --state-directory /private/efficiency

python3 /trusted/checkout/scripts/passive-efficiency-collector.py \
  --report --state-directory /private/efficiency
```

A tick reads at most 10,000 retained events by default (`--max-events 1..50000`).
If `backlogRemaining` is true, run another tick or let the next scheduled tick
continue. `processedEvents`, `invalidEvents` and `duplicateEvents` explain that
invocation; `cursor` is committed in the same transaction as the aggregates.
Failures emit only `{"version":1,"error":"collection_failed"}` and exit nonzero;
private paths or database values never enter the error output. A failed transaction
can be retried without advancing the cursor.

The collector has a ten-second SQL/processing deadline, a 250-ms source SQLite
busy timeout and a 500-ms aggregate busy timeout. Inputs are truncated to an 8-KiB
validation budget before decoding. State has a 256-MiB SQLite page limit. Hourly
aggregates and seen IDs expire after 90 days by default (`--retention-days 7..365`),
with hard caps of 100,000 aggregate groups and 500,000 deduplication IDs. Capacity
evictions create explicit coverage-gap records. At most 1,024 gap records, 1,024
stream cursors and 4,096 explicit markers remain. These limits preserve useful
history beyond raw-event pruning without creating an unbounded archive.

## Attribute versions honestly

An event's valid `runtimeVersion` takes precedence. If an old runtime does not
record a version, supplying `--runtime-package` labels only events timestamped at
or after the collector's observation of that package version. Already-retained
history remains `unknown`. The package must identify the independently verified
active runtime; reading a package file alone does not prove what code a process
has loaded. A changed package version starts a new prospective boundary; the
uncertain interval is recorded rather than relabeled retrospectively.

Explicit markers are metadata, not evidence that activation or a baseline run
completed. Record them only after independently verifying the boundary:

```sh
python3 /trusted/checkout/scripts/passive-efficiency-collector.py \
  --mark baseline --version-label 0.9.6 \
  --marker-id 64f0bd8c-3eb8-4826-875a-1e1814110e60 \
  --state-directory /private/efficiency
```

Use `--mark release` for a verified activation boundary and a fresh UUID.
Reusing a UUID with the same kind/version is idempotent; conflicting reuse fails.
Markers never backfill or alter event attribution.

## Interpret the output

Groups distinguish UTC hour, version, kind, actor, provider, event type, outcome,
error class, failure reason, stage, the legacy checkpoint operation recorded by older runtimes and fresh/reused/deduplicated work. Unknown
providers collapse into `other`; other unsupported dimensions collapse into fixed
unknown/none buckets. This is deliberately conservative and does not retain
arbitrary diagnostic labels.

- Successful client request throughput: `type=request.finish`, `kind=user`,
  `actor=client`, `outcome=passed`. Keep failed/cancelled counts and the full elapsed
  denominator. Never mix helper, diagnostic or maintenance traffic into this score.
- Verified task throughput requires explicit `stage=task` lifecycle events and an
  independent acceptance check. A passed request or verification stage does not
  establish a completed coding task.
- Input/output token totals count `attempt.finish` only. Known and unknown event
  counts remain separate; missing token usage is never treated as zero usage.
- Duration histograms use non-cumulative upper bounds in milliseconds:
  `1,5,10,25,50,100,250,500,1000,2500,5000,10000,30000,60000,180000,600000,3600000,+Inf`.
  Percentiles derived from them are bounds, not exact latency percentiles.
- Summed stage/attempt durations may overlap. They do not establish exclusive
  critical-path wall time or recoverable time savings.
- Startup pruning, stream changes, source sequence resets, unobserved sequence
  ranges, invalid skipped events and capacity evictions appear in `coverageGaps`.
  A sequence range may also reflect ignored SQLite insert IDs; it signals uncertain
  completeness, not a precise number of lost requests. First/last partial hours and
  historical unknown versions must not be presented as complete matched windows.
- A saved fingerprint of the cursor event detects a replaced/refilled database
  even if its stream UUID and maximum sequence remain unchanged. Replays reset the
  cursor with an explicit gap, and retained event IDs prevent double counting.
- Deduplication is bounded by retained IDs and an advancing timestamp floor. After
  ID-capacity eviction, events at/before that floor are excluded with explicit
  coverage gaps rather than counted again. Very late events can therefore remain
  uncounted; neither a partial window nor a gap is a zero-throughput baseline.

## Example user timer

Copy the reviewed script to a trusted user-owned location and create the separate
state directory with mode `0700` before enabling this example. Replace all paths;
do not point its writable directory at the live Grunt database or project.

`~/.config/systemd/user/grunt-efficiency-observer.service`:

```ini
[Unit]
Description=Read-only Grunt efficiency evidence observer

[Service]
Type=oneshot
ExecStart=/usr/bin/python3 /trusted/bin/passive-efficiency-collector.py --once --database /private/grunt/diagnostics.db --runtime-package /trusted/active-runtime/package.json --state-directory /private/efficiency
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/private/efficiency
RestrictAddressFamilies=AF_UNIX
IPAddressDeny=any
MemoryMax=192M
CPUQuota=20%
TimeoutStartSec=20s
```

`~/.config/systemd/user/grunt-efficiency-observer.timer`:

```ini
[Unit]
Description=Preserve Grunt efficiency aggregates every minute

[Timer]
OnBootSec=15s
OnCalendar=*-*-* *:*:00
AccuracySec=5s
Persistent=true
Unit=grunt-efficiency-observer.service

[Install]
WantedBy=timers.target
```

Enabling this separate timer does not restart or signal any Grunt runtime, worker,
provider buyer or game service. Check its exit status and backlog/coverage output;
a failed observer is a measurement gap, never a reason to reset provider backoff.

Offline validation:

```sh
python3 -m unittest discover -s scripts -p test_passive_efficiency_collector.py -v
```
