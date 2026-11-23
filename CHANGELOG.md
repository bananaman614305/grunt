# Changelog

## 0.9.11 — 2026-11-23

- Support verified publication from the exact `release/0.9-reviewed` maintenance branch alongside `main`, retaining stable-version and tested-archive checks.
- Package the existing retired-source receipt compatibility, negative-availability caching and workload-scoped routing evidence fixes on the reviewed maintenance line.

## 0.9.10 — 2026-11-22

- Preserve automatic source discovery when an existing managed receipt still names a retired provider. The receipt stays unchanged and retired providers remain disabled.

## [Unreleased]

## [0.9.9] - 2026-11-22

- Suppress repeated negative non-quota availability checks across routing, model-list and configured-access paths for thirty seconds. Preserve fresh completion guards, explicit recovery and absolute local or persisted quota reset deadlines.
- Keep performance weights within the requested workload until enough matching observations exist, while retaining existing failure-cost penalties and safe continuation boundaries. Add an offline mixed-workload replay.
- Treat removed Clixad selections as retired so older source lists remain usable, explicit requests cannot silently select another provider, and stale setup cannot reprovision it.

## [0.9.8] - 2026-11-23

- Remove Clixad. Its free model spends account credits that come only from surveys, offers or purchases, none of which Grunt does, so setup no longer offers, installs or routes it. The remaining experimental sources share the 0.2 weight equally.
- On Linux, setup enables lingering for the user so the local daemon keeps running after logout and starts at boot, and re-running setup re-enables an existing service. If lingering is refused, setup prints `loginctl enable-linger`.
- Setup stops foreground provider jobs once one route is verified and a real request through model `grunt` answers, then finishes coding-tool configuration and Squire bootstrap. Rows it did not reach show `background`; the daemon's existing route pass opens them once setup releases its session, and `usegrunt status` shows the route being signed up as connecting.
- Setup never hands a browser to the person: no localhost approval links and no "Finished verifying?" prompt. A signup that needs the person is skipped and the next one runs; the signup driver no longer gets `operate_share`.
- Anonymous OpenCode is checked right after anonymous Kilo, before any signup, so its row matches what its free-model check found instead of waiting behind BeatAPI.
- Arrow keys pressed while the setup table is live no longer print `^[OA` into it.
- Pi setup accepts a group-writable `~/.pi/agent` (the umask 002 default), and a Pi configuration refusal names its cause instead of "setup failed".

## [0.9.7] - 2026-11-22

- Preserve hourly runtime measurements beyond raw-event pruning, with explicit coverage, loss counts, latency histogram bounds and trusted runtime-version attribution.
- Measure managed job, checkpoint and host verification stages without recording commands, prompts or output, while distinguishing waiting, reuse and duplicate work.
- Coalesce overlapping BeatAPI and Darus access checks with independent cancellation and fresh subsequent validation; keep BeatAPI post-inference balance checks separate.
- Add reproducible offline workload, fallback-replay and metadata benchmarks with acceptance checks, failure-inclusive throughput, bounded concurrency and implementation fingerprints. Support source-free installed runtime packages.
- Add a separately scheduled read-only efficiency collector for existing runtimes and safe failure-stage diagnostics for Mistral Vibe and Pollinations.

- Remove signup stops that blocked no payment, key change or secret. The fallback operator's calls queue instead of stopping at 24, and it may answer with Squire's fixed answers, type into any observed field except a password, pass its own facts, solve CAPTCHAs, navigate web pages, press keys and sign in with Google or GitHub OAuth. Consent, terms, account, done and phone words no longer block a choice; payment and key-change words still do.
- A provider refusal drops only that provider. CAPTCHA, email-verification and phone mentions, Zro's terms page and an operator timeout no longer end a signup, and background signups drive again instead of dropping. Squire's drive is told to use its own verification tools.
- BeatAPI, CrowLLM, Kenari and Numes accept keys with extra hosts after their API host. The daemon applies setup's default data-sharing approval before acquiring a provider, honoring the GRUNT_SETUP_NO_DATA_SHARING opt-out. Promotional signup no longer pre-checks the promotion window; the live free check still gates the saved grant.
- When several vault keys match Aperture, CrowLLM, Darus, Gödel, Kenari, 100milionseek, Numes, Fikra or Openference, setup uses the first whose grant passes the provider's free check instead of stopping. These providers, plus BeatAPI and Perch, no longer refuse background setup; BeatAPI and Perch keep their earlier receipt after a failed refresh in every mode. Free-Pi, Nous and interactive CLIs still need a foreground terminal.

## [0.9.6] - 2026-11-21

- Detect stalled Openference streams using meaningful content, reasoning and tool-fragment progress, while retaining complete-response validation and existing nonstreaming deadlines.
- Share overlapping Numes and Pollinations access checks with independent caller cancellation and fresh evidence for later dispatches.
- Reclaim idle Grunt-owned OpenCode servers and their owned process groups without interrupting active requests, clearing model cooldowns or recycling external servers.
- Reconsider slow automatic Pi-tool continuations only when repeated recent observations support a substantial improvement after context-transfer costs. Preserve explicit provider choices and native agent sessions.
- Reduce verification overhead with bounded parallel file hashing, within-capture artifact deduplication and one fresh capture per distinct release-plan artifact set.
- Persist private project/session coordination plans and admission intent across frontend restarts, requiring reconciliation of uncertain work before further dispatch.
- Add offline, result-checked runtime and verification benchmarks for matched local comparisons.

## [0.9.5] - 2026-11-21

- When a Kilo model is rate-limited (HTTP 429), returns a server error (5xx) or answers as another model, try Kilo's other free models from its live catalog: Particle-1 first, then Reflection Beam, then the rest in catalog order. An anonymous Kilo model can now drive signups whenever any of them has headroom. Router aliases are never used, the model that answered last goes first, and a timeout still ends the turn without switching. When rotation exhausts the free models, report quota with the earliest refill only if all returned 429; otherwise report the last non-quota failure and hand over to the next route.
- Extend the Kilo data-sharing policy to every free Kilo model. It is now an explicit policy, still accepted by default without a prompt, so `GRUNT_SETUP_NO_DATA_SHARING=1` turns Kilo off.
- Have the daemon renew changed policy approvals at start without prompting, logging `Data sharing on: ...` for the renewed providers, so updating keeps already-approved routes on.
- Clear Kilo quota cooldowns saved by earlier releases once, so rotation can run right after the upgrade. This moves the routing-history database to version 2; 0.9.4 and earlier cannot open it after the upgrade.
- Add optional registry `hints` (synced with the registry) and `capture` (shipped only) fields. Setup places a provider's hints in Squire's drive goal before the safety rules and passes its capture as the drive's `store`, so the drive can store a revealed key without a driver model. Pass a one-time device code to the drive as a supplied value (Free-Pi).

## [0.9.4] - 2026-11-21

- When the routed signup driver has no model, try every OpenCode free model, then Pi's free models, before Squire's drive runs alone. A driver that already acted hands the same signup session to the next one; a timeout fails that signup without switching.
- Block signup buttons that regenerate or roll an existing key.
- Start the signup pass immediately when fewer than two routes stay open and an untried recommended route remains.

## [0.9.3] - 2026-11-21

- Let the OpenCode CLI drive signups when no routed driver has a model, in setup and in the daemon, including mid-signup takeover.
- Accept provider data-sharing policies by default during setup without prompting; `GRUNT_SETUP_NO_DATA_SHARING=1` still opts out.
- Make signup refusals name what is allowed (offered option keys, Grunt-supplied values, refs from the latest observation), and stop blocking providers' own "secret" key controls.

## [0.9.2] - 2026-11-20

- Retry routing-history commits within a bounded wait when a sibling reader holds the database, preserving atomic observations without replaying writes.
- Show restored quota and backoff deadlines for mixed legacy and registry source pools without changing legacy fallback order.
- Allow operators to disable background account acquisition while keeping registry refresh, existing sources and access maintenance active.
- Open routes from the registry in the daemon ([router](docs/router.md)): a background pass after every six-hourly registry sync signs up recommended routes best-first, one at a time, until six are open, with the first open tool-capable route driving the rest. Add adaptive back-off and retirement for repeatedly failing routes. Accept the scout's optional `fit`, `status` and `expires` registry fields, and hot-add newly listed shipped adapters in the automatic pool.
- Let the fallback signup operator type and pass the values Grunt supplies (plan, key or project name, and the Squire-connected email into email fields). After Squire reports a signup complete, answer the operator with a final stop instead of replaying the stale page.
- Fail fast on OpenCode's free usage limit, in both the serve and CLI paths, and cool down the whole OpenCode model pool until its reset. Upgrade the anonymous OpenCode setup operator to the first account route that passes the tool-call probe.

## [0.9.1] - 2026-11-20

- Let the execution host use an existing pinned Git configuration with hooks disabled at `/dev/null`. Continue rejecting custom hooks, included configuration and changed configuration bytes.

## [0.9.0] - 2026-11-20

- Coordinate a main coding agent and two independent workers with explicit ownership, dependency deferral and local capacity awareness. Preserve completed coordination summaries after shared batch eviction.
- Retain private workload-specific routing performance and repeated-failure backoff across restarts while preserving provider reset hints, quota waits and fresh access checks.
- Deduplicate unchanged verification jobs and reuse recent successful scoped results. Keep required release checks in isolated host execution with authenticated receipts bound to exact inputs and artifacts.
- Save private task checkpoints and focused handoffs with requirement retention, revision checks and stale-file detection. Reconcile pending work before repeating it.
- Add an opt-in trusted publication host: independent Grunt review, authenticated checks, exact tested-tree merging and verified GitHub Pages artifacts. Keep signing keys, credentials and release authority outside worker mounts.

## [0.8.4] - 2026-11-20

- Keep Openference's existing stream-validation cooldown while retaining redacted failure-stage diagnostics. Preserve HTTP header status on transport events without activating the router's separate short-cooldown policy for invalid tool replies.

## [0.8.3] - 2026-11-20

- Distinguish Openference stream reads, SSE/JSON format, incomplete replies, tool validation and cleanup in redacted diagnostics. Preserve error codes and successful responses when reader cancellation cleanup fails; display fixed reason labels in admin traces.

## [0.8.2] - 2026-11-20

- Add verified 100milionseek DeepSeek V4.1 Flash to standard Squire setup with a guarded recurring allowance and the approved 198,000-token input exception.
- Offer Free-Pi DeepSeek for explicitly reviewed public requests after affirmative consent to its coding-trace sale terms. Keep maintenance metadata-only and reject paid wallets, unapproved models and unsupported tool histories.
- Make anonymous Reflection Beam part of the ordinary pool, retain explicit provider additions across managed updates, and provide a pinned private Antseed installer for experimental opt-in use.
- Coordinate staggered daily maintenance across sibling runtimes without overwriting another process's results or overlapping provider checks.
- Keep unfinished scout qualification in the queue, preserve owner exclusions and approval holds, and deduplicate provider identities across repeated searches.

## [0.8.1] - 2026-11-20

- Keep owner diagnostics uploading when Grunt skips a source that requires approved public context. Use the same bounded routing-reason vocabulary in the local recorder, collector and admin API while continuing to reject arbitrary text.

## [0.8.0] - 2026-11-20

- Delegate independent implementation to two opt-in tool-using free-pool workers while the main agent continues. Keep edits in private project snapshots, preserve artifacts through quota failures and restarts, and review/apply changes through the parent interface with ownership, conflict and recovery checks.
- Run opt-in background jobs in Pi with bounded output, cancellation, event-driven waits and safe progress snapshots. Keep command approval explicit and interrupt jobs at session shutdown without replaying them.
- Pass reported streaming token counts through to coding interfaces, and reduce managed Pi working context to 65,536 tokens. Migrate only recognized local profiles while preserving custom settings and ports.
- Route from bounded eligibility snapshots and measured provider performance while retaining fresh selected-provider billing, consent and free-access checks.
- Show observed work categories, Adventure subworkers, successful checks and published-build receipts in the owner overview. Preserve unknown history and distinguish client requests from worker requests in diagnostics.
- Add a staged owner-runner upgrade and checkpoint gate that preserve active project work. Worker commands require verified Linux namespace and resource limits; dependency access uses sanitized private copies, and unsupported command environments fail closed.

## [0.7.28] - 2026-11-20

- Distinguish Clixad native-output framing, invalid JSON and caller-envelope failures in diagnostics without exposing reply content, retrying inference or changing acceptance and billing guards.

## [0.7.27] - 2026-11-20

- Keep the shared tool bridge usable when providers reuse a call ID in separate completed turns, including Mistral Vibe. Preserve exact historical results and continue rejecting duplicate pending calls, orphan results and incomplete histories.

## [0.7.26] - 2026-11-20

- Keep Kilo usable after switching providers that reuse tool-call IDs in separate completed turns. Normalize those historical IDs without changing their results, and distinguish tool schema errors from malformed or incomplete tool histories in diagnostics.

## [0.7.25] - 2026-11-20

- Explain local Kilo request-size, body and tool-schema refusals in diagnostic traces, and keep Clixad wallet checks read-only instead of claiming rewards.

- Keep diagnostics recording when two local Grunt processes initialize the shared log together, using a bounded wait for SQLite startup contention.

- Add Aperture's free ERNIE 5.5 Flash Preview route to automatic Squire setup, worker routing and maintenance. Require an authenticated Free account and zero-priced exact model before every request; track daily quotas separately from upstream throttling.

## [0.7.24] - 2026-11-20

- Add Darus Gateway DeepSeek V4.1 Flash 1017 to automatic Squire setup, workers and maintenance. Verify its daily free allowance and Protect Balance before every request, preserve midnight UTC quota resets, and use native non-streamed responses for tools and token accounting.

## [0.7.23] - 2026-11-20

- Add live-qualified Fikra and Openference DeepSeek free routes to automatic Squire onboarding, worker routing and daily maintenance. Keep zero-price and expiry checks, skip closed Fikra signups, and accept Squire's normal provider-domain host defaults when reusing keys.

## [0.7.22] - 2026-11-20

- Add optional Squire setup and pinned free DeepSeek adapters for Fikra and Openference, with price checks, promotion expiry, token accounting and streamed native tools. Keep both outside default onboarding while live account qualification is pending; restrict Openference to explicit interactive tests pending unattended-use permission.

## [0.7.21] - 2026-11-20

- Add optional CrowLLM setup through Squire for the zero-price GLM 5.3 Flash route, with current price checks before inference. Keep it outside default onboarding while live qualification remains incomplete.

## [0.7.20] - 2026-11-19

- Add Gödel Machines DeepSeek V4.1 Flash to automatic setup. Routing verifies the dedicated Free Key before inference and requires an explicit public-context request.

## [0.7.19] - 2026-11-19

- Prefer the verified Numes DeepSeek V4.1 Flash free route when its exact endpoint is available and its data-sharing policy is approved. Use the existing free GLM 5.3 Flash route when DeepSeek is unavailable.

## [0.7.18] - 2026-11-19

### Added

- Include documented free allowances, rate limits and refill schedules for the entire free pool in local status and the owner dashboard.

### Changed

- Learn quota retry timing from Nous and Vikey responses, and show Vikey's advertised seller limits.
- Use Kenari's UTC midnight cutoff for confirmed daily exhaustion without a Retry-After hint. Give verified Numes capacity errors a short backoff.

## [0.7.17] - 2026-11-19

### Fixed

- Let Token Harbor's weekly allowance reset replace an expired short request cooldown when the allowance endpoint had been temporarily unavailable.

## [0.7.16] - 2026-11-19

### Changed

- Use Token Harbor's account allowance dates to schedule retries after free credits run out, and show the current window in owner diagnostics.
- Retry Clixad at midnight UTC when its wallet confirms that the daily free allowance is exhausted.
- Include a retry time when routing first discovers that the free pool is exhausted.

## [0.7.15] - 2026-11-19

### Fixed

- Include explicitly enabled Vikey and Reflection Beam sources and subworker status in the owner dashboard.
- Show Token Harbor's exhausted free allowance as rate limited and update the status when access returns.
- Allow Mistral Vibe to finish after a second assistant history entry while keeping native tools disabled and enforcing the total output budget.

## [0.7.14] - 2026-11-19

### Added

- Add opt-in access to AntSeed Vikey DeepSeek and Reflection Beam with zero-price checks. Both can participate in automatic routing and subworker routing when explicitly enabled.

## [0.7.13] - 2026-11-18

### Added

- Add GLM 5.3 Flash to BeatAPI's free rotation after setup verifies both models. DeepSeek and GLM share one request cooldown and the same zero-charge account checks. Existing DeepSeek-only setups can enable both with `usegrunt add beatapi`.

## [0.7.12] - 2026-11-18

### Changed

- Turn on data sharing for Nous and Kenari by default. Setup no longer asks; it prints one line naming them and the opt-out `GRUNT_SETUP_NO_DATA_SHARING=1`, which also removes their saved consent.
- Fit the setup status table to the terminal width. Below 80 columns it drops the type column and cuts each row to one line, so redraws no longer overwrite each other on phone terminals. Other output is held until the table is final, and setup ends with a short summary.
- Never print the Nous device login link. Squire's browser approves it; if it cannot, the table shows "needs you (Nous login)" and Hermes stops instead of waiting for the code to expire.
- Show waiting for setup sources queued behind a setup worker or the browser limit, waiting (retry) for sources moved to the second pass, and mark the source that drives the other signups as ready · operator.

## [0.7.11] - 2026-11-18

### Added

- Add Numes GLM 5.3 Flash to the automatic free pool. Grunt uses a dedicated Squire key with a zero spending cap, pins the free model with zero price ceilings, and verifies the model and reported charge on each reply.

## [0.7.10] - 2026-11-18

### Added

- Add Kenari's free ERNIE 5.5 Flash to the default provider pool. Grunt uses the exact free route, checks that it still supports native tools, and honors provider quota delays when switching sources. Setup reuses a verified Squire grant or connects the account after grouped data-sharing approval.

## [0.7.9] - 2026-11-18

### Changed

- Choose the setup harness before provider signups, and check anonymous access first. With no usable anonymous model, setup tries a browser-only signup, verifies the new source with a tool call, then switches to the harness.
- Keep provider signups alive when the browser agent reports low confidence. Setup mounts a temporary, restricted Squire MCP server in the selected harness so it can recover the same browser session.
- Preserve existing OpenCode JSONC configuration. Signup MCP configuration is temporary.
- Show short reasons for Claude quota and harness timeout failures.

### Fixed

- Accept required free-signup terms through offered answers or visible buttons and checkboxes, including aliased labels. Paid controls, account switches and optional consent stay blocked.

## [0.7.8] - 2026-11-18

### Added

- Route requests to Nous Portal's free Qwen4 Max model through the official Hermes subscription proxy. Setup groups the data-sharing approval with the other free sources, then shows one device login link. Other providers continue setting up while Nous waits for approval.

### Changed

- Let vetted providers require explicit data-sharing approval in one grouped setup prompt.
- Advance multiple qualified providers through scouting and preserve unfinished candidates for later runs.

### Fixed

- Honor provider retry windows on upstream failures and quota cooldowns observed during maintenance while continuing to fall back within the current request.
- Show safe validation and native stop details for failed Clixad, Kilo, and Mistral Vibe attempts in the owner request trace.

## [0.7.7] - 2026-11-18

### Added

- Delegate up to two tasks alongside the main coding agent using the local Grunt daemon. Connect Pi, OpenCode, Codex or Claude Code, or run jobs directly from the terminal.
- Show active, queued and recent subworkers in the owner overview, and include lifetime usage totals across sources.

## [0.7.6] - 2026-11-17

### Fixed

- Keep the project uptime monitor from marking an active shell tool as stalled while its start event is buffered in the runner log.

## [0.7.5] - 2026-11-17

### Added

- Measure active project work and downtime in the owner overview over the last 24 hours and seven days. Label provider waits and retain measured coverage across publisher restarts.

## [0.7.4] - 2026-11-17

### Added

- Show recent project milestones and Grunt's checkpoint plan beside live work on the owner overview. Timeline entries link to the corresponding pull request and show its review or merge state.

## [0.7.3] - 2026-11-17

### Added

- Open the owner console on Grunt's current work and source status. Show successful replies and reported tokens per source for today and this week, with detailed diagnostics in separate views.

## [0.7.2] - 2026-11-17

### Added

- Follow Amazing Adventure from the owner console or Chad terminal. The feed shows Grunt’s visible progress updates, tool outcomes, current provider, last reply and provider errors.

## [0.7.1] - 2026-11-17

### Fixed

- Sync Fly's latest staged app secrets in the deployment runner before deploying, so Google login and collector credentials staged elsewhere are activated with the image.

## [0.7.0] - 2026-11-17

### Added

- Inspect retained request, fallback and safe HTTP/CLI transport traces in a private owner console designed for `/admin/`. Google login allows only explicitly configured verified owner emails; missing configuration fails closed. Diagnostic reads and exports do not send model prompts. See the [admin reference](docs/reference.md#private-owner-admin) and [deployment prerequisites](docs/admin-deployment.md); production sign-in verification remains pending.
- Keep a bounded private local diagnostics journal with correlated request IDs, observed transport outcomes and reported token usage; missing usage remains unknown. An explicitly enabled outbound owner collector projects sanitized observations, maintenance/scout progress and system metadata without enrolling ordinary installations. See the [collector runbook](docs/admin-collector.md).
- Allow honestly disclosed ordinary retention, training and review in provider scouting under the operator's standing approval. Unknown zero-retention guarantees no longer block integration; end-user source-specific grouped consent remains required.
- Make Grunt the current project, repository, configuration and interface name, with explicit compatibility for existing installations. Restore public-only GitHub Actions CI on standard Ubuntu runners. See the [compatibility guide](docs/reference.md#compatibility-with-existing-installations).

- Run the operator's twice-daily provider scout with guarded Squire signup, isolated checks and live routing probes, two independent reviews, and resumable PR merge/npm publication. Qualified providers reach new installations only after the published package and its default registry are verified. See the [operator guide](ops/provider-scout/README.md).
- Recover sources automatically: when no source can answer a request, the daemon adds vetted providers in the background (saved Squire access first, then signup) for providers whose data-sharing approval is already recorded. One run at a time; the next request finds the new source.

### Fixed

- Accept safe documentation navigation URLs in scouting evidence and isolate malformed candidate rows, preserving valid findings without admitting rejected rows to promotion.
- Keep the bundled provider registry as the minimum revision, so an older remote registry or cache cannot hide providers included in a newer release.
- Send automatic requests that carry function tools only to sources that return tool calls to the harness. OpenCode runs its own tools and returns final text, so it now receives tool-bearing requests only when the caller names `opencode`. A task bound to OpenCode hands off to a tool-capable source once tools appear. When none is usable, grunt returns a clear error instead of a text-only reply. This restores the filter from #45 that #47 removed while only FreeLLMAPI and Gateway supported tools.

## [0.6.10] - 2026-11-15

### Added

- Add `npx usegrunt update` to fetch the latest official release and replace the installed daemon without repeating setup or sign-in. Preserve service configuration, ports, enabled sources and maintenance state, with rollback if startup fails.

### Fixed

- Reject unknown CLI commands instead of treating them as requests to start a daemon. Pause maintenance during an update while existing routes remain available until the runtime is ready to replace.

### Validation

- All 1,159 tests across 64 files passed, along with lint, TypeScript and build. Independent updater review covered rollback, cancellation, old installations, custom service state and configuration preservation.
- Read-only validation accepted Chad's actual managed service configuration without stopping the daemon or making network requests. macOS service behavior is covered by fixtures; its existing launch agent must be running before update.

## [0.6.9] - 2026-11-15

### Added

- Check free sources through a persistent daily maintenance queue, one at a time with a 60–90-second gap after each check finishes. Reuse recent successful replies, defer busy/setup/cooling-down sources, and show last/next checks in dashboard details and JSON.
- Use bounded exact-source reply probes with normal free-access guards, and read-only metadata checks for idle Clixad to avoid automatic wallet or streak claims. Keep maintenance separate from provisioning and parallel first-time onboarding; routine upkeep no longer starts account signup, CLI installation or browser repair.

### Validation

- All 1,126 tests across 63 files passed, along with lint, TypeScript and build. Independent review covered scheduling, restart persistence, cleanup, foreground priority and concurrent observation ordering. A real read-only Clixad check recorded metadata evidence with zero inference calls.
- A staggered live pass received exact-source HTTP 200 replies from all eleven providers with no failures or duplicate prompts. The actual maintenance queue resumed the saved pass for its last four providers and persisted their outcomes; its ordinary completion-to-start gaps stayed within 60–90 seconds. One longer handoff pause was recorded separately.

## [0.6.8] - 2026-11-15

### Added

- Add `usegrunt status`, `status --watch` and `status --json` for cached source activity, verified replies, approval needs and routing cooldowns. The color terminal view supports narrow panes, keyboard details, disabled sources and plain output.
- Show a passive source dashboard during parallel onboarding after the first verified reply. Yield to foreground confirmations, then open the interactive watch view after setup releases its browser client and ownership lease.
- Remember the successfully installed daemon port so the status command can reopen a custom-port installation. Status reads never invoke providers or expose browser handoff links, credentials, prompts or upstream error payloads.

### Validation

- All 1,082 tests across 61 files passed, along with lint, TypeScript checks and a clean build. Independent review found no remaining blockers.
- A real terminal verified all eleven rows, colors, selection, details, resizing, offline state, quit behavior and screen/input restoration. A live Kilo reply moved from unknown through answering to ready; forty cached status reads added no provider calls.

## [0.6.7] - 2026-11-15

### Changed

- Start the local daemon before provider provisioning and make Grunt usable after the first correctly attributed provider reply. Continue the other signups and queued Squire confirmations in the setup terminal; later provider failures do not turn a working installation into a failure.
- Bootstrap Squire lazily so anonymous Kilo and OpenCode access can become usable while account-based providers connect. Choose coding tools before concurrent signups request input, then apply their configuration after the first verified reply.
- Verify at most three providers concurrently without occupying the six provisioning slots. Admit each provider independently without restarting the daemon.

### Fixed

- Coordinate foreground setup and daemon maintenance with short-lived, private setup ownership. Pending providers are excluded from automatic routing and health discovery, and foreground-owned signups are not duplicated by the daemon.
- Discover a Grunt-owned OpenCode configuration created after daemon startup when launching its private CLI server. Preserve inherited configuration for anonymous access when that file does not exist.
- Keep Squire's bootstrap client configuration in Grunt's private directory, so its installer cannot race coding-tool configuration writes. Cancel owned installation commands when setup ownership is lost, and make settled-provider verification one-shot even when preparation metadata remains present.

### Validation

- All 1,026 tests across 57 files passed, along with lint, TypeScript checks and a clean build.
- An isolated live runtime verified anonymous Kilo and returned a correctly attributed automatic-route reply while Perch remained unfinished. The unfinished provider received no health checks or inference. The test did not install Squire or create provider accounts and is not a blank-machine signup benchmark.
- The installed candidate matched all 70 packaged runtime files. Current warm checks passed for ten sources, including a successful bounded Mistral Vibe recheck after an initial failure. Runcrate returned an upstream rate-limit response with a reset delay; its exact quota bucket was not established. No provider account or funding changes were made.

## [0.6.6] - 2026-11-15

### Added

- Connect BeatAPI's `deepseek-v4.1-flash-free` through Squire with a key restricted to free models. Its continuous free route permits one successful request per minute and leaves the separate one-time $2 welcome credit untouched. No numeric daily or token-per-minute allowance is promised.
- Connect Pollinations' `community/morriszdweck/glm-5.3-flash-free` through Squire with a hard zero-budget, Quest-only key and minimal usage permissions. A positive unused Quest balance is required; the one-time first-key reward supplies it and the zero-priced route does not spend it. Grunt pins that single community route, verifies its free-access metadata and model identity, and bridges function calls through validated JSON. Availability is best effort, with no promised daily quota or reset schedule.
- Add Clixad's native free `glm-5.3-flash` route through privately installed CLI `0.0.1-beta.51` and ordinary GitHub device pairing. Require a zero wallet before and after user inference and native free/zero-charge metadata. Idle checks never run the wallet or streak claim. There is no atomic protection against an external deposit during inference, no hard upstream output cap, and no independent physical-model attestation from the native SSE.
- Add Perch's official Starter DeepSeek route through pinned CLI `2.4.132`, with 20,000 Perch Tokens per month and no surprise overages. Require active Starter, optional Data Program off, and both Use memory and Learn new memories off through official settings, without deleting notes. Keep native identity and memory settings verified, use private request context, deny native actions and clean up owned PTYs. Local output limits do not hard-cap upstream generation; the official model aliases are not independent physical-model attestation.

### Changed

- Set the automatic pool to eleven sources. OpenCode, Kilo and Zro share the stable 80% in proportions 6:8:5; eight experimental sources have weight 2.5% each.
- Run up to six setup jobs and three provider browser operations concurrently, sharing one Squire connection and cached metadata. Reuse Google/GitHub identities, ask once for nine active sharing policies and group provider-specific human exceptions; each provider can still require its own security verification. Declining sharing still permits eligible Zro and LiveKit setup.
- When Squire explicitly offers goal completion after navigation uncertainty, allow a grouped, default-No human attestation of the full requested goal before resuming the same session. Generic captcha confirmation, background setup and provider refusals cannot take this path.
- Reuse valid saved connections during restart. Background verification preserves BeatAPI, Pollinations and Perch receipts on transient failure, never falls into interactive setup, and stops before creating repeated Squire handoff links.
- Switch the default Kilo source from Auto Free to `particle-ai/particle-1:free`, a distinct model post-trained from DeepSeek V4.1 Flash with a listed one-million-token context and native function calls. The anonymous route needs no account or API key and allows 200 requests per hour per IP, subject to upstream capacity, without one-time credits. Standard DeepSeek catalog routes remain paid. Kilo's changed Particle-specific training disclosure requires fresh grouped approval.
- Retire Grunt-owned legacy Kilo Auto and Nemotron rows. With current Particle consent, the legacy guard can register Particle against an existing owned key, preserving disabled Particle rows and their priorities and all user custom keys, rows and priorities. Runtime migration creates no account, key or router service. Metadata-only migration was verified on the existing Chad backend.

### Removed

- Disable Freebuff in all grunt routing, filter it from saved source/environment selections, disable owned legacy fallbacks and stop starting the port-8789 bridge. Preserve the person's native application and account. The failed DeepSeek-pin prototype is not shipped.
- Retire APInex after its recurring 25-million-unit daily entitlement changed to require a $5 top-up. No purchase is made, and a one-time Telegram reward is excluded. Historical sharing records for either retired provider cannot re-enable routing.

### Validation

- BeatAPI and Pollinations passed real Grunt prompt, function-tool, correlated-result and large-context proofs without charges: 210,090 and 210,223 input tokens respectively. Kilo Particle passed the same four proofs at 210,165 input tokens with reported cost zero and no account or key; the reviewed candidate is installed on Chad at port 8792.
- Clixad's production source passed all four proofs at 210,321 input tokens, with native free/zero-charge metadata and zero wallet balance before and after. Perch's production source passed all four at 226,316 input tokens and 101 output tokens; 153 focused source/helper tests and independent review passed. After the Perch probes, Starter showed 19,726 of 20,000 PT remaining, with the Data Program and both memory switches off.
- The packaged Clixad setup helper installed the pinned private CLI, reused native authentication, passed the background probe and returned a production hello with 252 input and 63 output tokens. A separate blank-machine onboarding run is not claimed.
- Perch's initial native Google pairing required operator assistance. After verified Starter eligibility, matching identity and memory-off checks, the production helper reused that login, passed its background check and returned a Grunt hello with 16,245 input and 38 output tokens. Conflicting quota views are recorded conservatively; no larger recurring allowance is promised.
- All 954 tests across 51 files passed, along with lint, TypeScript checks and a clean build. Independent final integration review passed, including retired-only upgrades, the manual-attestation boundary and noninteractive restart coverage. Checks used the previous local-only CI policy.
- The final installed package returned real, correctly attributed replies through all eleven providers on Chad at port 8792. Freebuff and APInex requests were rejected. A second restart kept all eleven available, preserved receipt bytes and modification times, and opened no verification handoffs. The gateway's eleven-source registry, ETag behavior and health checks were verified.

## [0.6.5] - 2026-11-15

### Added

- Add LiveKit's DeepSeek V4.1 Flash route to automatic setup and `usegrunt add livekit`. Squire connects the free Build account and one free project, then completes the official CLI's browser pairing.
- Install LiveKit CLI 2.19.4 privately on Linux and macOS, for x64 and arm64, using pinned release checksums. Its credentials stay in the official private CLI configuration; grunt holds only ten-minute inference tokens in memory.
- Restrict LiveKit to the free Build plan's documented $2.50 monthly included inference allowance, which resets at the start of the calendar month and has a hard stop. No card, paid fallback, room or agent hosting is needed. The observed dashboard showed Build, a $0 next invoice and no payment method; it did not expose the remaining inference balance.

### Changed

- Expand the automatic pool from eight to nine sources. Keep stable weights at 80%; Token Harbor, Runcrate, APInex, Mistral Vibe Free and LiveKit now receive 4% each.
- Keep the existing seven grouped data-sharing policies. LiveKit documents [zero retention and no training for inference](https://docs.livekit.io/agents/models/inference/) and adds no sharing approval. Declining the grouped policies still permits eligible Zro and LiveKit setup.

### Validation

- The production LiveKit adapter passed four Grunt proofs: a short prompt, a function-tool call, its correlated result follow-up and a context with 210,077 input tokens. Independent code review and local regression checks passed; a separate blank-machine onboarding run is not claimed.

## [0.6.4] - 2026-11-15

### Added

- Offer Runcrate's free DeepSeek V4.1 Flash route through Squire, subject to a GitHub account at least 30 days old, no paid balance or payment method, and automatic top-ups disabled. Its recurring weekly allowance is not quantified.
- Offer APInex's `free/deepseek-v4.1-flash` route with a personal Gmail Google login, daily check-in and a strict free route that never spends wallet funds. Its observed daily allowance is 25 million weighted units, approximately 8.33 million DeepSeek tokens at weight 3.
- Offer GLM 5.3 Flash through Mistral's native Vibe Free CLI, using its $10 monthly Vibe Code allowance with pay-as-you-go disabled and no payment method. Ordinary Mistral API credit is not used.

### Changed

- Expand the bundled automatic pool from five to eight sources. Keep the stable tier at 80%; Token Harbor, Runcrate, APInex and Mistral Vibe Free share the experimental 20% equally.
- Extend the existing grouped data-sharing approval to the three new sources. Setup still runs up to three service jobs concurrently and preserves previously connected routes.
- Keep Cloudflare Qwen outside the pool by the owner's choice. This release used manual npm and gateway registry publication under the former CI policy. It updated two existing gateway file overlays; a later full image deployment must remove those overlays.

### Validation

- Each new production adapter passed a short prompt, a function-tool call and its result follow-up. All three models also passed contexts larger than 200,000 tokens through Grunt. Signup and recovery paths have local regression coverage; a separate blank-machine onboarding run is not claimed.

## [0.6.3] - 2026-11-14

### Added

- Connect Zro's daily free DeepSeek V4.1 Flash through automatic Squire signup, with a check that the account has no paid plan, purchased balance or payment method.
- Add Token Harbor's weekly free DeepSeek V4.1 Flash route after explicit data-sharing approval.
- Approve Freebuff, OpenCode, Kilo and Token Harbor data-sharing policies together during setup, remember the approved policies and skip providers whose current policy has not been approved.
- Add an optional direct NVIDIA integration, excluded from the default pool while account verification remains unvetted.

### Changed

- Expand the bundled pool to Freebuff, OpenCode, Kilo and Zro, with opt-in Token Harbor. Provider setup continues concurrently and verifies each service separately.
- Rotate new OpenCode conversations across its three free models, keep follow-ups on their selected model and try another free model when quota runs out.

### Fixed

- Preserve previously connected API sources when setup is repeated.
