# Changelog

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
- All 954 tests across 51 files passed, along with lint, TypeScript checks and a clean build. Independent final integration review passed, including retired-only upgrades, the manual-attestation boundary and noninteractive restart coverage. GitHub Actions remains disabled.
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
- Keep Cloudflare Qwen outside the pool by the owner's choice. Continue manual npm and gateway registry publication with GitHub Actions disabled; update the two existing gateway file overlays on the current image. A future matching image deployment must remove those overlays.

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
