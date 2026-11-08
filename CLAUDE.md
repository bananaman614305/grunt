# Milo

Milo is a local router over the user's own AI subscriptions. It runs on the user's machine, drives the official `codex` and `claude` CLIs they are already logged into, tracks how much of each plan is left, and sends each OpenAI-compatible `model: "milo/auto"` request to the subscription that suits the task and has capacity, failing over when one is rate-limited. `x-milo-*` headers explain each choice. Read `docs/adr/031-local-subscription-router.md` first; it is binding and replaces the OpenRouter design in `docs/PLAN.md`.

## Layout

- `packages/core` — `subscription/` (CLI backends, usage meter, backend selection, router), Jev client and router (used as the classifier), decision log. No HTTP server.
- `packages/gateway` — Hono server: chat completions (buffered and streamed), models, usage.
- `packages/cli` — `milo serve | usage | replay`, plus the decision-log and eval commands.
- `packages/evals` — labeled routing prompts, the Jev eval runner, and the subscription replay.
- `docs/adr` — one file per decision. Changes to `packages/core/src/types.ts` need an ADR.

## Commands

```
pnpm install
pnpm test          # vitest, fixtures only, no network
pnpm lint          # eslint + tsc -b
pnpm test:e2e      # *.e2e.test.ts
pnpm eval          # eval runner on fixtures; --live is opt-in
MILO_LIVE_CLI=1 pnpm vitest run --config vitest.live.config.ts   # real codex/claude, spends quota
```

## Rules

- TypeScript strict, ESM, NodeNext resolution, `.js` extensions on relative imports.
- Tests live next to code as `*.test.ts`. Network tests are `*.live.test.ts` and are excluded from `pnpm test`.
- Never read, copy, store or forward a Claude or ChatGPT login. Milo only spawns the official CLIs, which use their own logins. No source file outside `docs/` may name their credential files (`no-credential-access.test.ts` enforces this). Never call vendor endpoints with a CLI's token.
- Run the CLIs in a scratch directory with their most restrictive flags (Codex read-only sandbox, Claude Code with no tools) unless an ADR says otherwise.
- Never put a key in source, fixtures, `.env` files, logs, or a commit. The optional Jev key is read from `JEV_API_KEY` only. In development, call Jev through the Squire `use_credential` MCP tool. The decision log stores no message content.
- Jev API: `POST https://api.typesafe.ai/v1/systemone` with `{ model, state, questions }`. Question types `noul`, `choice`, `score`. Spec: `https://api.typesafe.ai/openapi.json`. Model: `jev-latest` only (never `jev-preview`).
- Solo development for now: small, verified changes may be committed and pushed straight to `main`. Use a worktree, branch, and PR for anything risky or multi-step. One task, one branch.
- Report completion only with test output pasted. If a test fails, say so.
- Do not widen a task's scope. If a contract in `types.ts` is wrong for your task, stop and report instead of changing it.
- Commit messages: plain imperative subject, body explains why.
