# Live upgrade of the Amazing Adventure host

Operator-only. Installs a **published** usegrunt release into the two managed runtime trees (`~/.config/milo/runtime`, the primary
daemon on 8792, and `~/.local/lib/usegrunt-adventure/runtime`, the owner pool on 8793) by a *planned maintenance pause*, with one
command:

```sh
git pull                                              # a checkout at or after the release commit
python3 ops/live-upgrade/upgrade.py --version 0.10.1
```

Run it from the owner's shell on the host. Use `--check` first if you want everything except the live start (see below).

The pause is the standard path. The earlier "wait for one natural moment when everything is idle" approach almost never fires under
the Claude Code builder (verification chains on the execution host, a busy pool that keeps deferring every maintenance check, Squire
keep-alive connections that live about 70 s, status polls landing in a frozen daemon's accept queue). The pause makes those
conditions true on purpose, for about two minutes, between cycles.

## What the command does

1. **Attempt directory.** A fresh private `runtime-upgrade-<version>-<stamp>/` under the workspace
   (`usegrunt-upgrades` under the XDG state directory, `~/.local/state` by default, or `--workspace` / `GRUNT_UPGRADE_WORKSPACE`). The previous version is read from the
   installed runtimes (both must agree); `--version` must be newer. Nothing is edited by hand.
2. **Release check.** The publish run on `main` for that version is found with `gh` (the commit whose `package.json` carries the
   version). The npm tarball, the CI artifact of that run and a clean `pnpm install --frozen-lockfile && pnpm build && npm pack` of
   that commit must be byte-identical, and every packaged file must equal the clean build's file. No removed-feature module and no
   Clixad file may be packaged.
3. **Prepare and seal.** The production helpers (everything here except tests and the three tooling files `upgrade.py`, `attempt.py`,
   `release_pins.py`) are copied into the attempt directory with `attempt.json` (the version pair) and `source-expectations.json`
   (the candidate's eligible, consent-deferred and retired provider sources, derived from the candidate itself). The public registry
   is pinned, both installed trees are hashed, and everything is sealed in `seal.json`. Launch refuses any later change.
4. **Tests.** This directory's tests run against the candidate build (about 15 s). `--skip-tests` skips them.
5. **Rehearsal.** In a private copy, the sealed helpers stage the archive and run the read-only preflight (startup gate and
   source-transition proof against the live pools) and the runner-contract check. A source check inside the startup window is only
   noted: the controller waits it out.
6. **Launch.** The controller `pause-and-activate.py` starts as the transient unit `grunt-runtime-upgrade-<version>-<stamp>`:
   - brings the live registry cache (`~/.config/milo/registry.json`) to the pinned public registry itself when it differs (see *Registry cache* below), re-verifies the installed trees, stages, runs the preflight again;
   - waits for the running cycle to end by itself (at most 3600 s), then freezes **only the supervisor** at that checkpoint and
     quiets the activity publisher (SIGSTOP of the same pinned process) and the overnight watcher timer;
   - settles, bounded to 1500 s, until for 20 s together: supervisor frozen at a checkpoint and no hold; both pools idle; execution
     host idle; no source check due within 420 s; no open managed TCP transport;
   - runs `activate.activate` on that frozen supervisor (every checkpoint, idle and host proof is re-run; hold, daemon admission,
     SQLite backup, atomic swap of both runtimes, owner files, restart, held startup checks, release), then resumes everything;
   - observes the first cycle (working on the Claude harness, model replies rising) and runs `verify_success.py`.

Everything up to step 5 is read-only on the live host. `--check` stops before step 6 and prints the exact `systemd-run` command.

## Follow and verify

```sh
python3 ops/live-upgrade/upgrade.py status            # latest attempt; --version V, --attempt DIR, --json
python3 ops/live-upgrade/upgrade.py verify            # read-only success verification of the latest attempt
journalctl --user -u grunt-runtime-upgrade-0.10.1-<stamp>
```

`verify` checks both runtime trees against the public pins, dependency digests, protected files, owner files, unit fingerprints,
memory/CPU policy and the passive observer; that the hold and the temporary restart/consent guards are gone; that the three daemons
were restarted after the transaction began; and that both pools report an integer status schema (`/v1/status` `version` is the
status schema number, **not** the package version) without the removed `workers` key.

## Outcomes

| exit | meaning | what to do |
|---|---|---|
| 0 | activated, first cycle verified (`release-state.json`: `activated_and_first_cycle_verified`) | done |
| 3 | clean give-up, nothing mutated, builder resumed (`pause-outcome.json`) | read `outcome`/`failure`; run the same command again (a new attempt directory) |
| 4 | someone else changed the frozen state (hold appeared, supervisor resumed, unit down); only our own freeze was undone | inspect before anything else |
| 1 | failed after mutation began, or activated but the first cycle was not confirmed | `activation-receipt.json`, `pause-verification.json` |

`upgrade.py` itself exits 0 after launching, or 2 when a precondition refused (nothing live was changed by it). A
`pause-restore-warning.json` means the upgrade succeeded but a passive poller was not restored: start
`grunt-adventure-overnight-watch.timer` / `kill -CONT` the activity publisher.

Guarantees kept from the earlier runbooks: the controller never interrupts a cycle on its own; the supervisor, publisher and watcher
are always resumed (a `finally` plus an independent watchdog unit `grunt-pause-watchdog-<pid>` that resumes them if the controller is
killed or wedged, and leaves state alone once a hold or startup marker exists); an existing hold or deliberate pause is preserved
(the hold file is created exclusively and only the file we created is removed); a failure before the new units start restores the
runtimes, owner files and SQLite families; there is **no** automatic rollback after startup (see below).

## Ending a long cycle (`--end-cycle`, owner-authorized)

Cycles normally last 10-15 minutes but can run for hours. With `--end-cycle` the controller, once it is waiting for the checkpoint,
sends one SIGTERM to the worker's process group for a cycle at least `--end-cycle-min-age` seconds old (default 120; the owner accepts interrupting cycles). The supervisor
records a failed cycle, waits about 60 s and reports `waiting_for_free_pool`, which is a usable checkpoint. The worker must be the
supervisor's own child and its own process-group leader, with identity pinned by start ticks; no SIGKILL, no other signal. The
authorization is written into `controller-config.json`. Never pass the flag without the owner's explicit say-so.

## Owner files (`--payload DIR`)

Optional. A release may need owner-side files replaced together with the runtimes: the 8793 launcher `free-pool.mjs`, the builder's
`claude/worker-brief.md` and `claude/bin/grunt-release` (`claude/assets.json` is derived from the live manifest). Put the new files
in `DIR` under those names. They are backed up beside the originals (`<name>.before-<version>-<stamp>`), installed after the runtimes
and restored with them on a pre-start failure. The stage refuses a payload that mentions removed subworker features, a stale assets
manifest, or a launcher importing a runtime module the new package lacks. Without `--payload` the owner files are left alone, and the
live launcher is still checked against the new package's modules.

## When something is wrong

- **Registry cache**: the controller does not wait for the daemon's own refresh (00, 06, 12 and 18 UTC). Before staging and before any pause
  it makes `~/.config/milo/registry.json` equal the public registry pinned at preparation, so the protected-file digests and the
  registry-cache transition proof are computed against the new bytes. The write is done by the installed runtime's own `RegistrySync`
  (`registry_refresh.mjs`: its validator, its newer-publication-only rule, its canonical `{registry, etag}` shape, its atomic
  temp-file rename, mode 0600) fed the pinned body and ETag, so a later normal refresh of the same publication writes the same bytes.
  The running daemons keep the registry in memory and read the file only at startup, so the write changes no routing; the restart
  inside the activation loads it. The previous bytes stay in `registry-cache-before-refresh.json`, and `registry-refresh.json` (copied into
  the activation receipt as `registryCacheRefresh`) records what happened. Nothing is written when the cache already holds the pinned
  publication. If the cache does not hold it right after the write (the daemon refreshed meanwhile) or the runtime refuses the write, the
  public registry is fetched once more and the write retried once; a second failure is a clean give-up (exit 3, `registry_cache_not_current`,
  nothing staged or paused; the cache is left as the runtime wrote it, never rolled back over someone else's newer write). A cache that
  is newer than the public registry is refused, never downgraded. The cache is not reverted by a pre-start activation failure: it is
  generated data that the daemon would write itself at its next refresh.
- **Provider scout** (09:00 and 21:00 America/New_York, up to ~45 min) imports the runtime this upgrade swaps. `upgrade.py` warns
  when a scout start falls inside the window; prefer launching right after one ends.
- **Provider-source set**: the gate pins the candidate's eligible set and the live pools must serve exactly it (apart from the
  retired Clixad tombstone and the owner's `freellmapi` advertisement on 8792). A release that adds or removes a source fails the
  rehearsal (nothing is paused); review it and extend `source_transition.py` before upgrading.
- **After `startup-attempted.json` or `work-may-resume.json`**: no automatic rollback, by design. If the receipt has
  `promptRootRecoveryRequired` or `operatorRecoveryRequiredByMs` (earliest possible maintenance minus 60 s), act before that time.
  Manual rollback only while the hold is still present: stop the execution host, supervisor, primary daemon and collector units;
  rename each `runtime` to `runtime.failed-<version>-<stamp>` and `runtime.before-<version>-<stamp>` back to `runtime`
  (`~/.config/milo` and `~/.local/lib/usegrunt-adventure`); put back the owner `.before-*` files if a payload was installed;
  restore the SQLite families from `sqlite-families-before/` (`sqlite_families.restore`); re-seed `captured-cooldowns.json` with
  `seed-routing-history.mjs`; keep the consent drop-in until the old process is up, then remove it; remove the hold; start the
  units. After work resumed, fix forward unless there is evidence of harm. There is no Pi revert: 0.10.0 removed it.
- Never call `/v1/models` or completions on 8792/8793 while checking; `status` only reads `/v1/status`.

## Host-specific by design

Paths, the managed Node binary, unit names, ports 8792/8793 and the owner layout are constants of this host (`stage.py`,
`activate.py`). Moving the owner layout means editing those and re-running the tests.

## Tests

```sh
pnpm build                                            # the candidate runtime the fixtures load; default GRUNT_UPGRADE_TEST_RUNTIME is this checkout
umask 022; python3 -W error::ResourceWarning -m unittest discover -s ops/live-upgrade -p 'test_*.py'
```

Fixtures use synthetic `/proc` trees, fake clocks, temp directories and fake `gh`/`git`/`npm`/`systemctl`; no test signals or
starts anything real. `GRUNT_UPGRADE_TEST_NODE` overrides the Node binary. See [shared maintenance](../adventure-execution/MAINTENANCE.md)
for the scheduler the upgrade must preserve.

| file | role |
|---|---|
| `upgrade.py`, `attempt.py`, `release_pins.py` | the entry point and its tooling (run from the repository, never sealed into an attempt) |
| `pause-and-activate.py`, `maintenance_pause.py`, `end_cycle.py` | the controller, the pause and the watchdog, the optional cycle end |
| `activate.py`, `checkpoint_gate.py`, `daemon_admission.py`, `startup_gate*.{py,mjs}`, `source_transition.py`, `registry_cache*`, `quota_store.py`, `sqlite_families.py`, `host_metadata.py`, `collector_guard.py`, `acquisition_guard.py`, `release_proof.py`, `rollout_*.py`, `seed-routing-history.mjs` | the reviewed transaction and its proofs |
| `stage.py`, `preflight.py`, `preparation.py`, `registry_refresh.{py,mjs}`, `verify_success.py`, `check_runtime_contract.mjs` | staging, read-only preflight, bringing the registry cache current, success verification, runner contract |
