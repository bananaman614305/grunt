# Milo

Milo is OpenRouter with an actual routing mechanism. Users bring their OpenRouter key, point an OpenAI-compatible client at Milo, and send `model: "milo/auto"`. Milo holds its own TypeSafe Jev key server-side. Jev classifies the task and its difficulty, a policy table picks the model, the request goes to OpenRouter, and the response comes back with `x-milo-*` headers explaining the choice. Read `docs/PLAN.md` first; "Core contracts" and the ADRs are binding.

## Layout

- `packages/core` — jev client, router (signals, policy, roster, stickiness), decision log. No HTTP server.
- `packages/gateway` — Hono server. Chat completions, models, decisions, generic OpenRouter proxy.
- `packages/cli` — `milo serve | explain | roster | eval`.
- `packages/evals` — labeled routing prompts and the eval runner.
- `docs/adr` — one file per decision. Changes to `packages/core/src/types.ts` need an ADR.

## Commands

```
pnpm install
pnpm test          # vitest, fixtures only, no network
pnpm lint          # eslint + tsc -b
pnpm test:e2e      # *.e2e.test.ts
pnpm eval          # eval runner on fixtures; --live is opt-in
```

## Rules

- TypeScript strict, ESM, NodeNext resolution, `.js` extensions on relative imports.
- Tests live next to code as `*.test.ts`. Network tests are `*.live.test.ts` and are excluded from `pnpm test`.
- Never put a key in source, fixtures, `.env` files, logs, or a commit. The Jev key is Milo's, read from `JEV_API_KEY` in the server env only. In development, call Jev through the Squire `use_credential` MCP tool. User OpenRouter keys are forwarded from the `Authorization` header and never stored. Fixtures are recorded responses with request ids kept and key material stripped. The decision log stores no message content.
- Jev API: `POST https://api.typesafe.ai/v1/systemone` with `{ model, state, questions }`. Question types `noul`, `choice`, `score`. Spec: `https://api.typesafe.ai/openapi.json`. Model: `jev-latest` only (never `jev-preview`).
- OpenRouter API: `https://openrouter.ai/api/v1`. Only the `model` field is rewritten; everything else passes through. Strip the `milo` body field before forwarding.
- Work happens in a git worktree on a branch, never on `main`. One task, one branch, one PR.
- Report completion only with test output pasted. If a test fails, say so.
- Do not widen a task's scope. If a contract in `types.ts` is wrong for your task, stop and report instead of changing it.
- Commit messages: plain imperative subject, body explains why.
