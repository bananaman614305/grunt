# Changelog

## [Unreleased]

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
