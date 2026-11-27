# Grunt

One TypeScript Node app. Read README.md and docs/reference.md for setup and behavior.

- `src/server.ts`: process entry point.

Run `pnpm lint`, `pnpm test`, and `pnpm build`. Use Node 22 or later.

The operator-only provider scout, live upgrade, activity feed and Amazing Adventure maintenance tools
live in a separate private operator repository, not in this repo.
The [harness fixture notes](src/local/fixtures/README.md) describe recorded inputs.

CI runs in GitHub Actions only while this repository is public. Use the standard
Ubuntu GitHub-hosted runner; never enable larger paid runners or artifact/cache
uploads for this workflow. Keep the public-visibility job guard. Once the repository
is public, require the exact-head `test` check from `.github/workflows/ci.yml`
before merging. Run local checks while preparing the visibility transition.
Deployment and publication workflows have separate enablement and credentials.

The approved local daemon is the exception: `grunt-local`, its `/v1/*` harness
routes, and its configured gateway forwarder are supported. Gateway completions
default to a cap of 4096 tokens when the harness omits its limit.

Owner diagnostics use `src/admin/` and `site/admin/`. Google sign-in must verify
exact explicitly configured owner emails and stay unavailable without its required
configuration. The collector is opt-in and sends only allowlisted metadata. Never
expose the inference daemon publicly, log raw provider errors, or persist prompts,
responses, OAuth codes or credentials.
