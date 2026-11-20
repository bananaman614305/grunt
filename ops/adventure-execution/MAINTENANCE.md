# Shared daily provider maintenance

`createSourceMaintenance` is the runtime integration point. Both the standard
daemon and owner free-pool helper must use it. It includes installed curated
sources and explicitly installed opt-ins, skips disabled/custom sources, honors
current provider consent and foreground setup ownership, and delegates actual
health work to `Sources.check`. It does not provision accounts. That source
check retains its existing active-request, recent-reply and quota guards.

Sibling daemons can share the same private configuration directory. The scheduler
uses a separate `maintenance-lock.db` for a nonblocking SQLite write transaction,
held from loading `maintenance.json` through native check cleanup and saving the
result. This database contains no credentials or history. It never locks the
diagnostics database. Busy siblings retry their scheduler after a minute without
blocking their APIs. The OS releases the transaction if a process crashes.

Each successful owner reloads the latest JSON before changing it, preserves
other runtimes' provider entries, and exposes only its own provider subset in its
status snapshot. A shared 60–90 second quiet gap follows each completed check.
The previous reservation and per-provider cooldown survive a crash. No lock file
is deleted or taken over based on a clock or a reused PID.

## Owner rollout

Upgrade both the standard daemon package and the owner runtime package before
enabling the owner helper's maintenance wiring. Older versions do not acquire
the coordination lock and must not remain active writers alongside the new
scheduler. Preserve `maintenance.json`; do not reset completed checks or quota
timestamps. Use the existing owner checkpoint gate to preserve its saved Pi
session and active work.

`stage_maintenance.py --source /absolute/path/free-pool.mjs --stage /new/path`
prepares an original copy, candidate and SHA-256 receipt without modifying live
files or restarting services. It refuses changed helper anchors. The candidate
adds the shared integration and waits for maintenance shutdown before closing
the sources. Apply it only after reviewing the receipt against the current
helper and installing the matching runtime module.

Verify both runtime status responses expose maintenance entries for their
installed eligible sources. Upcoming schedules should retain prior evidence;
recent successful real requests may satisfy a daily check without a new prompt.
Metadata-only checks must remain labeled metadata rather than verified replies.
