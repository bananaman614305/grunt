# Changelog

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
