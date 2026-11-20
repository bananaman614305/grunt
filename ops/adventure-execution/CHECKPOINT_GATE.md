# Activation checkpoint gate

`activate.py` is a library for the reviewed activation operation. Importing it
does not signal anything; it has no command-line activation path. It never
changes a file, starts inference, tests the game or restarts a service.

Validate the complete staged plan and every original/next hash before acquiring
the gate. Include runtime dependencies, owner files, the staged managed profile
and publisher files in the same reviewed transaction. The caller remains
responsible for exact-byte backups, rollback and post-start verification.

```python
gate = CheckpointGate(
    status_path="/home/alan/.local/state/usegrunt-adventure/status.json",
    supervisor_pid=read_adventure_service_main_pid,
    expected_backend_script="/home/alan/.local/lib/usegrunt-adventure/free-pool.mjs",
    expected_node="/home/alan/projects/hermes/service/data/node/bin/node",
)
with gate.acquire(timeout_seconds=3600) as frozen:
    # Revalidate the staged transaction and original hashes here.
    frozen.terminate_before_stop()  # SIGTERM, then SIGCONT, in that order.
    # Stop only the two named Grunt runtime units, then run the reviewed
    # transactional replacement and its rollback. No game-file mutations.
```

The gate waits in one-second increments for `checkpoint` or
`waiting_for_free_pool` with an explicit null `workerPid`. An idle HTTP pool is
insufficient: Pi may be executing a long foreground command between requests.
At a candidate checkpoint it freezes **only** the supervisor MainPID, using a
Linux pidfd and checked process start ticks to avoid signaling a reused PID.
Already paused supervisors are left untouched.

While frozen, the supervisor must have exactly one child: the known Node binary
running the exact free-pool launcher. No Pi, bubblewrap or other foreground child
may remain. The gate then rechecks the owner status, both fixed loopback pool
statuses and children. Both pools must report zero active requests and empty
active/queued worker arrays. A spawn race or changed observation resumes the
supervisor and retries within the bounded deadline. Cancellation and unexpected
exceptions also attempt to resume it; a resume failure is surfaced explicitly.

Use the context manager or an equivalent `finally` so exceptions cannot silently
leave the supervisor frozen. To stop after admission, queue SIGTERM **before**
SIGCONT with `terminate_before_stop()`, then stop the same service. Its existing
signal handler sets its STOP flag before the continuation loop can start another
cycle. Do not resume first and request termination later.

The gate prevents the supervisor from starting another game cycle during the
cutover. It does not install a general admission lock on external callers to the
primary daemon; avoid other operator requests during the short admitted cutover
and retain the activation operation's immediate in-operation idle check. Normal
health probes are read-only. A separate earlier/background idle check must never
be treated as authorization to mutate the live runtime.
