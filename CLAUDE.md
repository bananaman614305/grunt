# Grunt

One TypeScript Node CLI and local inference router. Read README.md and docs/reference.md for setup and behavior.

- `src/local/main.ts`: CLI and local daemon entry point (`usegrunt`, `grunt-local`).
- `registry/adapters.json`, `site/registry.json`, and `site/v2/registry.json`: static adapter registry served on GitHub Pages (`grunt.run`). `site/registry.json` is the legacy v1-compatible form without ended offers or `declarative:app` entries (`tsx src/registry.ts registry/adapters.json --publish-v1 site/registry.json`) so older daemons (`<= 0.10.21`) keep syncing; `site/v2/registry.json` is the full published form without ended offers (`tsx src/registry.ts registry/adapters.json --publish site/v2/registry.json`).

Run `pnpm lint`, `pnpm test`, and `pnpm build`. Use Node 22 or later.

The operator-only provider scout, live upgrade, activity feed and Amazing Adventure maintenance tools
live in a separate private operator repository, not in this repo.
The [harness fixture notes](src/local/fixtures/README.md) describe recorded inputs.

CI runs in GitHub Actions only while this repository is public. Use the standard
Ubuntu GitHub-hosted runner; never enable larger paid runners or artifact/cache
uploads for this workflow. Keep the public-visibility job guard. Once the repository
is public, require the exact-head `test` check from `.github/workflows/ci.yml`
before merging. Run local checks while preparing the visibility transition.
Publication workflows have separate enablement and credentials.

The local daemon (`grunt-local`) and its loopback `/v1/*` harness routes run on
the user's machine. Anonymous usage counts go directly to US PostHog
(`docs/router.md#4-usage-telemetry`); there is no Grunt gateway server or custom
admin console in this repository. Never expose the inference daemon publicly,
log raw provider errors, or persist prompts, responses, OAuth codes or
credentials.
