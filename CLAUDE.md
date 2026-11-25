# Grunt

One TypeScript Node app. Read README.md and docs/reference.md for setup and behavior.

- `src/server.ts`: process entry point.

Run `pnpm lint`, `pnpm test`, and `pnpm build`. Use Node 22 or later.

The operator-only discovery/release pipeline lives in `ops/provider-scout`;
see its [guide](ops/provider-scout/README.md). Verify it with
`python3 -m unittest discover -s ops/provider-scout -p 'test_*.py'` and
`node --test ops/provider-scout/test_probe.mjs ops/provider-scout/test_provision.mjs`. These fixtures use synthetic
providers and local servers, not external provider accounts or publishing.
The operator-only live upgrade of the Amazing Adventure host lives in `ops/live-upgrade`; see its
[runbook](ops/live-upgrade/README.md). `python3 ops/live-upgrade/upgrade.py --version X.Y.Z` verifies the published
release, prepares a sealed attempt and starts the planned-pause upgrade. Build first, then verify the helpers with
`python3 -W error::ResourceWarning -m unittest discover -s ops/live-upgrade -p 'test_*.py'`; fixtures are synthetic and
never signal or start anything.
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
