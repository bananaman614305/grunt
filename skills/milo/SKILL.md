---
name: milo
description: Use when setting up or using Milo, the local router that sends OpenAI-compatible requests to the user's own logged-in codex and claude CLIs, when checking how much of each subscription is left, or when explaining a Milo routing decision from its x-milo-* headers.
---

# Milo

Milo runs on the user's own machine and routes OpenAI-compatible chat
requests across the subscriptions they already pay for, by driving the
official `codex` (ChatGPT plan) and `claude` (Claude plan) CLIs. It never
touches their logins: it only starts those CLIs as child processes.

## Set it up

1. Check the CLIs are installed and logged in: `codex --version`,
   `claude --version`. Logging in is the user's job (`codex login`, `claude`
   then `/login`); never handle their credentials yourself.
2. From the Milo checkout: `pnpm install && pnpm build`, then
   `node packages/cli/dist/cli.js serve`. It listens on `127.0.0.1:8787` and
   needs no API key.
3. Point the client at it: `OPENAI_BASE_URL=http://127.0.0.1:8787/v1`,
   any non-empty `OPENAI_API_KEY`, `model: "milo/auto"`.

## Models

- `milo/auto`: Milo picks the subscription.
- `milo/codex`, `milo/claude`: that subscription only, no failover.
- `codex/<model>`, `claude/<model>`: that subscription and model.

`tools` and `n > 1` are refused with 400.

## Reading a decision

Every response carries:

- `x-milo-backend`: the subscription that answered.
- `x-milo-reason`: one sentence: the task's preferred subscription and the
  capacity that confirmed or overrode it.
- `x-milo-task-type`, `x-milo-difficulty`, `x-milo-classifier` (`jev` or
  `heuristic`).
- `x-milo-capacity`: percent left per subscription at decision time.
- `x-milo-failover`: present only when a subscription refused first, e.g.
  `claude:rate_limited`.

## How much is left

`milo usage` (or `GET /v1/usage`) shows used and left percent, the window,
the reset time, and the source: `cli` (reported by the CLI), `estimated`
(Milo's own calls and refusals only) or `unknown`. Claude's numbers update
with each Claude answer; Codex's are read on demand at no cost.
