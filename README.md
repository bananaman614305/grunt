# Milo

Milo routes your requests across the AI subscriptions you already pay for.

If you have ChatGPT and Claude plans, you have two frontier models with
usage limits that mostly go unused. Milo runs on your own machine, drives
the official `codex` and `claude` CLIs you are already logged into, shows
how much of each plan is left, and sends each request to the subscription
that suits the task and has room. When one plan is rate-limited, the other
answers.

Milo never touches your logins. It starts the vendors' own CLIs as child
processes under your account; they use their own logins exactly as they do
in your terminal. There is no API key, no hosted service, and nothing to pay
Milo. See [ADR-031](docs/adr/031-local-subscription-router.md).

## Quickstart

You need Node 22+, pnpm, and at least one of:

- [Codex CLI](https://github.com/openai/codex), logged in with your ChatGPT plan (`codex login`)
- [Claude Code](https://docs.claude.com/en/docs/claude-code), logged in with your Claude plan (`claude`, then `/login`)

```
pnpm install && pnpm build
alias milo="node $PWD/packages/cli/dist/cli.js"
milo serve
```

```
milo: listening on http://127.0.0.1:8787 (backends: codex, claude; classifier: local heuristic)
milo:   codex: 98% left (weekly)
milo:   claude: capacity unknown
milo: set OPENAI_BASE_URL=http://127.0.0.1:8787/v1 and use model: "milo/auto"
```

Point any OpenAI-compatible client at it:

```
export OPENAI_BASE_URL=http://127.0.0.1:8787/v1
export OPENAI_API_KEY=unused   # SDKs insist on one; Milo ignores it
```

```python
from openai import OpenAI
client = OpenAI()
r = client.chat.completions.create(model="milo/auto", messages=[{"role": "user", "content": "Why does my asyncio lock deadlock?"}])
```

Streaming works too (`stream: true`, including `stream_options.include_usage`).

## Models

| `model` | What runs |
|---|---|
| `milo/auto` | Milo picks the subscription |
| `milo/codex`, `milo/claude` | That subscription, the CLI's default model, no failover |
| `codex/<model>`, `claude/<model>` | That subscription and model, e.g. `claude/opus`, `claude/sonnet` |

Requests with `tools` or `n > 1` are refused: the CLIs answer in text and do
not call your functions.

## How it picks

1. **Classify the task.** With `JEV_API_KEY` set, Jev classifies it; without
   one (or if Jev fails), a local keyword heuristic does.
2. **Prefer by task.** Edits, features, debugging and ops start on Codex;
   chat, research, docs, review and classification start on Claude.
3. **Adjust by what is left.** A rate-limited plan goes last. A plan under its
   reserve (10% left) yields to one with more. If the other plan has more
   than 30 points more left, the work moves there.
4. **Fail over.** If the chosen plan refuses (rate limit, not logged in, CLI
   error), the other one answers.

Every response says what happened:

```
x-milo-backend: codex
x-milo-reason: chat task prefers claude, but claude is below its 10% reserve; claude 1% left (seven_day), codex 98% left (weekly)
x-milo-task-type: chat
x-milo-classifier: heuristic
x-milo-capacity: codex=98%, claude=1%
x-milo-failover: claude:rate_limited      (only when it happened)
x-milo-decision-id: 01M6YJMHXCAR4JNQ5NCF6VESGG
```

## How much is left

```
milo usage
```

```
subscription     used  left  window     resets                source  status  24h calls  24h limited  24h tokens in/out  7d calls
ChatGPT (codex)  2%    98%   weekly     2026-11-15 00:47 UTC  cli     ok      2          0            28396 / 39         2
Claude (claude)  99%   1%    seven_day  2026-11-09 00:00 UTC  cli     ok      1          0            604 / 73           1
```

- Codex reports its plan limits on request (`codex app-server`), so its
  numbers are always current and cost nothing.
- Claude Code reports its limits with every answer, so its numbers are as
  fresh as Milo's last Claude call, and `unknown` before the first one.
- `estimated` means the CLI has given no number and Milo only knows its own
  calls and refusals.

The same data is at `GET /v1/usage` on a running server
(`milo usage --url http://127.0.0.1:8787`).

## Measuring it

`milo replay --sample <n>` sends a stratified sample of Milo's 120 labeled
routing tasks through a running `milo serve` and reports how many each
subscription served, failures, failovers, latency, tokens, and how much of
each plan the run used. Every task spends real quota, so `--sample` is
required.

## Configuration

`milo.config.json` (all optional; see `milo.config.example.json`):

```json
{
  "port": 8787,
  "hostname": "127.0.0.1",
  "decisionLog": "file:./.milo/decisions.db",
  "subscriptions": {
    "reservePercent": 10,
    "balanceMarginPercent": 30,
    "timeoutMs": 600000,
    "codex": { "enabled": true },
    "claude": { "enabled": true, "model": "sonnet" }
  }
}
```

The gateway has no API key, so keep it on `127.0.0.1`. `milo serve` warns if
you bind it anywhere else.

## Safety

- Codex runs `codex exec --sandbox read-only` and Claude Code runs with every
  tool disabled, both in a scratch directory: they answer, they do not edit
  files or run commands.
- `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` are removed from the CLIs'
  environment, so they spend your subscription, not a pay-per-token key.
- Milo stores counts, timings and limit readings in its SQLite log. It never
  stores prompts, answers, or credentials, and a CI test fails if any source
  file names the CLIs' credential files.

## Development

```
pnpm test        # unit tests, fake CLIs, no network
pnpm lint
MILO_LIVE_CLI=1 pnpm vitest run --config vitest.live.config.ts   # real codex and claude, spends a little quota
```

## Docs

- [ADR-031](docs/adr/031-local-subscription-router.md): the local subscription router, and what was removed.
- [`docs/evals.md`](docs/evals.md): the routing eval set and Jev evals.
- The OpenRouter-era docs (`docs/api/gateway.md`, `docs/routing.md`,
  `docs/config.md`, `docs/cli.md`) describe the hosted version this replaced;
  it is in git history before ADR-031.
