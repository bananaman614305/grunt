# Milo

One TypeScript Node app. Read README.md and docs/reference.md for setup and behavior.

- `src/agent.ts`: Milo front agent, tools and in-process worker pool.
- `src/router.ts`: one whitelist utility picker; never use a Google model.
- `src/store.ts`: SQLite messages, tasks, notes and calls.
- `src/openrouter.ts`: small fetch client; no automatic retries.
- `src/index.ts`: Hono routes and authenticated SSE.
- `src/chat.html`: self-contained chat page.
- `src/server.ts`: process entry point.

Run `pnpm lint`, `pnpm test`, and `pnpm build`. Use Node 22 or later.
Tests use a fake OpenRouter and never need a real key or network.

The operator-only discovery/release pipeline lives in `ops/provider-scout`;
see its [guide](ops/provider-scout/README.md). Verify it with
`python3 -m unittest discover -s ops/provider-scout -p 'test_*.py'` and
`node --test ops/provider-scout/test_probe.mjs ops/provider-scout/test_provision.mjs`. These fixtures use synthetic
providers and local servers, not external provider accounts or publishing.
The [harness fixture notes](src/local/fixtures/README.md) describe recorded inputs.

GitHub Actions is disabled for this project at the owner's request. Run checks
locally; do not enable or dispatch GitHub Actions workflows.

Keys arrive in a Bearer header. Hash them for identity. Never write keys or
upstream error payloads to the database, logs, source or test fixtures. Synthetic
keys are permitted in offline tests. Workers get a brief and notes, never raw chat.
Cap completion tokens. Dispatch must return before worker work completes.

Do not restore the former gateway, billing, Jev, CLI or monorepo. Git history
preserves them; the app now serves `/chat`, `/agent/*`, and `/health` only.

The approved local daemon is the exception: `milo-local`, its `/v1/*` harness
routes, and its configured gateway forwarder are supported. Gateway completions
default to a cap of 4096 tokens when the harness omits its limit.
