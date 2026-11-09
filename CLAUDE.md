# Milo

One TypeScript Node app. Read README.md for setup and behavior.

- `src/agent.ts`: Milo front agent, tools and in-process worker pool.
- `src/router.ts`: one whitelist utility picker; never use a Google model.
- `src/store.ts`: SQLite messages, tasks, notes and calls.
- `src/openrouter.ts`: small fetch client; no automatic retries.
- `src/index.ts`: Hono routes and authenticated SSE.
- `src/chat.html`: self-contained chat page.
- `src/server.ts`: process entry point.

Run `pnpm lint`, `pnpm test`, and `pnpm build`. Use Node 22 or later.
Tests use a fake OpenRouter and never need a real key or network.

Keys arrive in a Bearer header. Hash them for identity. Never write keys or
upstream error payloads to the database, logs, source or test fixtures. Synthetic
keys are permitted in offline tests. Workers get a brief and notes, never raw chat.
Cap completion tokens. Dispatch must return before worker work completes.

Do not restore the former gateway, billing, Jev, CLI or monorepo. Git history
preserves them; the app now serves `/chat`, `/agent/*`, and `/health` only.
