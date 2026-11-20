# Owner continuation-runner upgrade

This operator-only staging helper upgrades the existing Adventure runner to use
Grunt's scoped tool workers and session-owned background jobs. It does not touch
game files, run game tests, send model requests, change accounts, restart a
service, or activate staged files. Regular `usegrunt` users get the tools from
the package; this helper is only for the separately installed owner supervisor.

For the coordinated daily provider queue and its separate staging helper, see
[shared maintenance](MAINTENANCE.md). Both installed runtime packages must be
upgraded before activating that owner-helper change.

The baseline contains the reviewed infrastructure hashes from 2026-11-20. If a
file has changed, staging stops before writing anything. Review the new file and
its intended changes before updating that baseline; do not bypass the mismatch.

```sh
python3 ops/adventure-execution/stage.py \
  --owner-root /home/alan/.local/lib/usegrunt-adventure \
  --stage /home/alan/.local/state/usegrunt-adventure/execution-upgrade-STAMP \
  --worker-state /home/alan/.local/state/usegrunt-adventure/worker-runtime
python3 -m unittest discover -s ops/adventure-execution -p 'test_*.py'
```

Use a new absolute staging path. The result has private `original/` backups,
`next/` files and a hash receipt marked `activated: false`. Inspect the diff and
verify the hashes again immediately before activation. All source files and
existing settings remain in place during staging.

The new free-pool launcher uses `createWorkerRuntime`, a dedicated private state
directory and scoped API registration. It keeps the existing vetted source list,
opt-ins, free-only rejection list, loopback binding and port 8793. The primary
daemon remains on 8792. Worker retention directories must be separate between
these two pools.

The supervisor adds the explicit trusted Pi flags `--grunt-agent-workers` and
`--grunt-background-jobs`. Jobs run through Pi's extension execution API; a
permission hook that specifically recognizes only the built-in `bash` tool does
not automatically recognize `grunt_job_start`. Enable this flag only when that
custom execution tool is authorized by the owner or coding interface. Generic
tool-call hooks still apply. Neither flag broadens sandbox mounts or credentials.
The existing game path, Pi session ID, network restriction for worker commands
and protected Git configuration remain in force.

The small `usegrunt` wrapper must be installed alongside the owner supervisor
and mounted read-only at `/opt/adventure/bin/usegrunt`. It exposes only worker
artifact/status commands, using the trusted runtime and Node executable. The
parent Grunt reviews artifacts and applies them through its own normal command
permissions; the daemon never writes the original checkout. Worker artifacts
remain retained until Grunt explicitly discards them. Grunt still owns all game
implementation, testing, review and project decisions.

Background jobs are owned by the current Pi process. The brief requires Grunt to
collect or cancel them before ending a `--print` checkpoint. A process restart
records interruption and does not replay a command. The jobs state is explicitly
`/worker/state/jobs`; the owner feed reads its safe session snapshots.

Activation is a separate reviewed operation:

The staged supervisor supports an operator-owned startup hold at
`/home/alan/.local/state/usegrunt-adventure/execution-upgrade-hold`, outside the
game's writable `/worker/state` mount. Before stopping the old supervisor, the
activation operation must create that marker exclusively and abort if it already
exists. The new supervisor starts its backend, reports `paused` with no worker
PID and waits before its first project cycle. It keeps checking backend health
and honors termination while held. Remove only the marker created by this
activation, **last**, after every runtime, profile, diagnostics and publisher
check succeeds. If a check fails, roll back while no new game cycle has run;
preserve any preexisting operator hold and never remove it as automatic cleanup.

1. Stage and verify the matching public Grunt runtime first. It must contain
   `worker-runtime.js`, the Pi tool registration, job helpers, client-side artifact
   integration and their dependencies. Confirm synthetic worker/job checks pass.
2. Use the deployment helper's **internal** idle gate for both pools. Do not start
   activation while a separate idle check is still running. Preserve the existing
   Pi session ID and abort before mutations if either pool or worker is busy.
3. Stop only the two Grunt runtime services, verify original hashes still match
   the stage receipt, and atomically replace the runtime plus staged owner files.
   Keep the `original/` copies and runtime backups available for rollback.
4. Stage only the approved Adventure Pi profile on port 8793 from its explicit
   200000 working context to 65536. The automatic migration helper deliberately
   skips its custom model name, `Grunt free automatic pool`; verify this exact
   owner profile and change only its `contextWindow` field. Preserve all other
   fields, profiles, settings and the session ID. Do not run global setup.
5. Start the same services and verify both ports, diagnostics and the same saved
   session. Read worker capabilities; commands are available only after the real
   sandbox probe succeeds. Verify the wrapper is mounted and both trusted flags
   are present without starting game work or sending forced inference.
6. Install the reviewed owner activity/uptime publisher update and restart only
   its publisher service after the compatible backend is healthy. Let Grunt
   choose and perform its own next work; observe safe worker/job status naturally.

If activation fails, stop the affected Grunt services, restore the exact prior
owner files and both runtime backups, restore only the saved managed Pi profile
if it was migrated, and start the original services. Keep stage/activation
receipts and any worker artifacts. Do not alter game files or replay interrupted
jobs as part of recovery.
