# Changelog

## [0.6.6] - Unreleased (draft, held)

### Added

- Connect BeatAPI's `deepseek-v4.1-flash-free` through Squire with a key restricted to free models. Its continuous free route permits one successful request per minute and leaves the separate one-time $2 welcome credit untouched. No numeric daily or token-per-minute allowance is promised.
- Connect Pollinations' `community/morriszdweck/glm-5.3-flash-free` through Squire with a hard zero-budget, Quest-only key and minimal usage permissions. A positive unused Quest balance is required; the one-time first-key reward supplies it and the zero-priced route does not spend it. Grunt pins that single community route, verifies its free-access metadata and model identity, and bridges function calls through validated JSON. Availability is best effort, with no promised daily quota or reset schedule.

### Changed

- Expand the automatic pool from nine to eleven sources. Keep stable sources at 80%; seven experimental sources share the remaining 20% equally, about 2.857% each.
- Include BeatAPI and Pollinations in the grouped sharing approval, bringing it to nine provider policies. Their upstream retention and training guarantees are unestablished. Declining still permits eligible Zro and LiveKit setup.
- Switch the default Kilo source from Auto Free to `particle-ai/particle-1:free`, a distinct model post-trained from DeepSeek V4.1 Flash with a listed one-million-token context and native function calls. The anonymous route needs no account or API key and allows 200 requests per hour per IP, subject to upstream capacity, without one-time credits. Standard DeepSeek catalog routes remain paid. Kilo's changed Particle-specific training disclosure requires fresh grouped approval.
- Retire Grunt-owned legacy Kilo Auto and Nemotron rows. With current Particle consent, the legacy guard can register Particle against an existing owned key and prioritize its enabled rows before Freebuff, preserving disabled Particle rows and all user custom keys, rows and priorities. Runtime migration creates no account, key or router service. Metadata-only migration was verified on the existing Chad backend.

### Validation status

- BeatAPI and Pollinations passed real Grunt short-prompt, function-tool, correlated-result and large-context proofs without charges: BeatAPI with 210,090 input tokens and Pollinations with 210,223. All 706 local tests, lint, a clean build and independent review passed; a separate blank-machine onboarding run is not claimed.
- The actual production Particle 1 source passed a short prompt, a native function call, its correlated result and a 210,165-input-token context with reported cost zero, without an account or key. The reviewed candidate is installed on Chad at port 8792 and returned a Kilo hello reply. Existing source choices were preserved; BeatAPI and Pollinations are not enabled on that service yet. Public npm and gateway publication remain held.
- Release blocker: native Freebuff DeepSeek selection worked, but the Grunt bridge received an explicit relaying-policy HTTP 403 and a strike. Testing stopped and no pin shipped. Provider-policy review and the supported scope for transparent, human-initiated use of one's own account remain unresolved. The public 0.6.5 package still has nine sources; the eleven-source draft is not released.

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
