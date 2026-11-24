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

Both installed runtime packages (the standard daemon and the owner runtime) and the
owner's `free-pool.mjs` launcher must run the coordinated scheduler together: older
versions do not acquire the coordination lock and must not remain active writers
alongside the new one. The [live upgrade](../live-upgrade/README.md) replaces both
runtime trees in one transaction, preserves `maintenance.json` (it never resets
completed checks or quota timestamps), checks that every eligible source still has
maintenance coverage after the restart, and refuses to start while a source check is
due inside the startup window. The Pi-era staging helper that patched the launcher
was removed with the other 0.9.x tooling (see git history before 0.10.1).

Verify both runtime status responses expose maintenance entries for their
installed eligible sources. Upcoming schedules should retain prior evidence;
recent successful real requests may satisfy a daily check without a new prompt.
Metadata-only checks must remain labeled metadata rather than verified replies.
