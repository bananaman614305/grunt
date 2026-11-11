# Milo

Chat with Milo. Hand it a bigger job, keep talking while it works, and get the
result back in the same conversation.

One Node process, one SQLite file, a front agent, and a small background pool.
There are no accounts: paste your OpenRouter key at `/chat`. Jobs spend your
OpenRouter credits. The key is saved in your browser; use a trusted device.

## Run

Requires Node 22 and pnpm.

```sh
pnpm install --frozen-lockfile
pnpm build
MILO_DB=file:./milo.db pnpm start
```

Open http://localhost:8787/chat. `pnpm dev` runs the TypeScript source.
`pnpm lint` checks ESLint and TypeScript; `pnpm test` runs the offline suite.

Environment:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8787` | HTTP port |
| `MILO_DB` | `file:/data/milo.db` | Local SQLite file |
| `MILO_CONFIG` | unset | Optional JSON file with `agent.whitelist` |

## Behavior

Milo answers quick questions and uses `dispatch`, `status`, `cancel`, and
`remember` for longer work and durable preferences. Each message uses one front
model turn, with a retry on a second model only for transient failure. A worker
receives a self-contained brief and saved notes, never the raw conversation.
Workers have no tools or live web access. There are at most three active workers,
with at most two per person. Jobs are capped at 4,096 output tokens; front replies
at 1,024. Cancel aborts a request. Queued or running jobs fail after a restart.

On completion or failure, Milo makes a front-model call for a short proactive
update. The full result lives on the job. If that summary call fails, a plain
Milo update still tells you the job's outcome. SSE streams carry assistant
messages and job status changes, with keepalives every fifteen seconds.

The whitelist defaults to DeepSeek v4.1 Flash, GLM 5.3 Flash, GLM 5.3, GPT 5.6
Luna and Claude Opus 5. The front prefers DeepSeek Flash, then GLM Flash. No
`google/` model is permitted, even if configured. Model access and credits must
be available on your OpenRouter key; there is no substitute outside the whitelist.

`pick()` filters context size, whitelist membership and recent rate limits,
then scores `reliability × quality − a × latency − b × expected token cost`.
Chat weights favor speed; code, research and writing favor quality. Price and
quality estimates start as explicit priors; reliability and latency learn from
call history. After a 429, 5xx or timeout, a worker retries once on the next model.
A 429 excludes that model for sixty seconds. Jobs show the chosen model and reason.

To override priors, set `MILO_CONFIG` to a JSON file shaped like:

```json
{
  "agent": {
    "whitelist": [{
      "model": "deepseek/deepseek-v4.1-flash",
      "quality": { "chat": 0.85, "code": 0.85, "research": 0.85, "writing": 0.85 },
      "inputUsdPerM": 0.14, "outputUsdPerM": 0.28,
      "contextLength": 128000, "reliability": 0.98, "latencyMs": 1500
    }]
  }
}
```

Priors are estimates, not a live pricing feed. Use the provider's current prices
when configuring cost weights.

## API

All `/agent/*` routes require `Authorization: Bearer <OpenRouter key>`.
The person's identity is the SHA-256 of the key. The server retains the raw key
only for active chat requests and unfinished jobs; it never stores or logs it.
Chat content, briefs, results and notes persist locally in SQLite.

| Method | Route | Result |
| --- | --- | --- |
| GET | `/` | Redirect to `/chat` |
| GET | `/chat` | Chat page |
| GET | `/health` | Health status |
| POST | `/agent/messages` | `{text}` → `{reply, dispatched}` |
| GET | `/agent/state` | Recent messages, jobs and notes |
| GET | `/agent/events` | Authenticated fetch-streaming SSE: `message`, `task` |
| POST | `/agent/tasks/:id/cancel` | Cancel a job belonging to the caller |

## Offline demonstration

```sh
pnpm build
MILO_DB=file:/tmp/milo-proof.db PORT=8788 node --import ./proof/fake.mjs dist/server.js
```

Open `/chat` on that port and enter any synthetic key. Send “hello”, “remember I
write TypeScript; keep answers short”, “write a one-page launch plan”, then “what
is the capital of France?”. The job stays running while Paris appears. Release
it with `curl -X POST http://127.0.0.1:18789/release`; Milo proactively posts its
summary and attaches the full plan. This adapter never calls OpenRouter.

## Deploy

The Docker image contains only the compiled app, page and production dependencies.
On pushes to main, GitHub builds and smoke-tests the exact image, then deploys
it to Fly app `milo-gateway` in `iad` using the existing `FLY_API_TOKEN` secret.
The `milo_data` volume mounts at `/data`. Keep a single Fly machine for SQLite.

This replaces the former OpenAI-compatible gateway. The old `/v1/*` routes are
removed. There is no Jev, billing, roster service, worker tooling or monorepo.

## Use Milo as your harness's model

Run the separate local daemon on your own machine (Node 22+, Linux or macOS,
`opencode` on PATH, and `tmux` with an existing logged-in `freebuff` for the last fallback):

```sh
pnpm install --frozen-lockfile
pnpm build
node dist/local/main.js setup
# Published package: npx usemilo setup; installed bin: milo.
# Freebuff alone, without API setup: MILO_SOURCES=freebuff node dist/local/main.js
```

It binds only `127.0.0.1:8788`. `MILO_PORT` changes the port. It provides
`GET /v1/models`, Chat Completions, Anthropic Messages, and OpenAI Responses,
including SSE. Choose model `milo` for automatic source selection, or a source
id such as `freebuff`. This process is separate from the Fly server and Docker
entry point. Local callers can invoke Freebuff with your filesystem permissions;
keep this endpoint on your own machine.

Freebuff acts as a delegate: it runs its own tools and can edit files in the
working directory. Your harness receives final text; its own tool loop does not
run for that turn. Milo extracts cwd from harness context (including environment
blocks), accepts an explicit absolute `cwd`, and otherwise uses the daemon's
working directory. It logs the chosen directory. Check it before asking for edits.
Text and function-tool turns are translated across APIs. Native Responses tools
are accepted by the app delegate; the Chat Completions gateway cannot forward
those tools and fails over to the app source. Unsupported media blocks return an
error rather than silently losing context.

### Free API and account setup

`npx usemilo setup` runs a Clack terminal wizard using the same rail and wine accent as
Trusty Squire. It reuses your Squire connection, lets you select Groq or Cerebras,
installs FreeLLMAPI, Freebuff and OpenCode, writes a persistent background service and adds the `milo`
provider to Pi. It sends a real request through that service before printing
“Milo is ready” and exits. Run `pi`, open `/model`, and choose **milo**.
Setup checks Freebuff's local sign-in and completes its CLI pairing through Squire's
browser when needed. If tmux is missing, setup installs it through Homebrew, apt or dnf (sudo may prompt in the terminal).
The Milo service starts the Freebuff loopback bridge. OpenCode's free model must
answer a probe; anonymous access needs no account. If it returns an authentication
error, setup reuses or creates free OpenCode access through Squire and saves only
an app grant in a private OpenCode config. A refusal or failed fallback check
prints a repair step and setup continues with the other routes. The final message
lists any incomplete fallbacks. Rerunning setup keeps Kilo and Freebuff enabled
as the last fallbacks and preserves the enabled state and priority of other backups.
Free routes run their own tools in the working directory with your filesystem
permissions; free model providers may retain prompts.

Before making changes, setup checks Node, npm, Pi, tar and the user service
manager. A missing prerequisite prints its install or repair step and stops.

Existing vault API keys are reused. Missing keys are created through Squire's
browser and captured directly into its vault. Human verification opens a browser
handoff, including email confirmation, and signup resumes in that same session.
Provider refusals stop setup. Milo calls `grant_app_access` and sends only
the grant's base URL and bearer token to FreeLLMAPI's custom-provider endpoint.
Provider keys stay in Squire; no provider reveal approval is requested. Groq
uses its `/openai/v1` API path beneath the Squire grant root. Setup discovers
currently available chat models through that grant before registering one.
`milo add groq` or `milo add cerebras` connects another provider through the same flow.

When no Squire session exists, the wizard runs Squire's own connect installer
with the OpenCode target. Squire manages login and its broker service. An existing
session with an unavailable broker reports the connection error for repair.
Setup does not pair with Beeline or create agents or Rooms.

Milo state lives under `$MILO_CONFIG_DIR`, otherwise `$XDG_CONFIG_HOME/milo` or
`~/.config/milo`. Keep this directory across service restarts. Local router login
and encryption material are generated once and stored with mode `0600`.
FreeLLMAPI encrypts the grant tokens in its backend database. Neither tokens nor
provider keys appear in Pi's config or terminal output. Never share backend state.
Existing routers with keys are preserved if their local admin state is missing.

The service uses FreeLLMAPI first and OpenCode free models as fallback. It loads
the saved router login itself at startup and retries if the router is temporarily
unavailable. Setup keeps a runtime outside the npx cache, so cache cleanup does
not remove the service. Pi's other providers are preserved. `PI_CODING_AGENT_DIR`
selects a nondefault Pi agent directory.

Setup installs the pinned FreeLLMAPI Node server as a separate background service;
Docker is not required. Linux uses systemd user units; macOS uses launchd
(macOS remains untested). The router data and private login live under Milo's
config directory. `MILO_FREELLMAPI_URL` chooses its numeric loopback address and
is saved in Milo's service configuration. The router's database is created under
umask `0077`. `MILO_ROUTER_RUNTIME=docker` retains the older Docker installer for
existing installations and offline regression checks.

`MILO_SQUIRE_HOME` and `MILO_SQUIRE_XDG_CONFIG_HOME` select an existing Squire
home without relocating Milo state. `MILO_SETUP_NO_HUMAN=1` stops before Squire
onboarding or browser handoff if human verification would be needed.

The package is `usemilo` (version `0.4.0`); the installed command remains `milo`.
This change prepares the package for publication after merge; it does not publish.

Free API calls go to `http://127.0.0.1:3001/v1` through FreeLLMAPI, including
provider failover. There is no direct OpenRouter free API route. An already
configured install can provide `MILO_FREELLMAPI_KEY` in its process environment;
`MILO_FREELLMAPI_URL` accepts numeric HTTP loopback addresses only. The completion
cap is (4096) tokens. Select `freellmapi` for the free chain or `kilo` for the
anonymous `kilo-auto/free` model through that same router. Kilo needs no account.
The separate Freebuff bridge listens only on `127.0.0.1:8789` and contains only
the Freebuff source, preventing a routing loop. FreeLLMAPI supports priority
ordering: keyed providers come first, Kilo next, Freebuff last. Setup enables
only those providers in the chain, excluding Google, OpenRouter and unvetted
aggregators.

FreeLLMAPI's signed catalog handles model and quota updates. Free installations
receive its delayed monthly snapshot; live catalog access is a separate upstream
premium option. Check the local dashboard when provider availability changes.
FreeLLMAPI is single-user software for personal experimentation; keep it bound
to loopback. See its [installation guide](https://github.com/tashfeenahmed/freellmapi/blob/main/docs/en/install/01-install.md).

### OpenCode app driver

Select `opencode` as the Milo model. Milo starts `opencode serve` on a loopback
port, using your normal OS home and existing OpenCode login. It sends only the
latest user message, word for word, through the session API, with no caller
system prompt or tool definitions. Follow-ups with their user-message history
reuse the same session; the mapping lasts until Milo exits. OpenCode runs its
own tools and returns final text, as Freebuff does. It uses no tmux.

`MILO_OPENCODE_MODEL` selects the OpenCode free model (default `big-pickle`).
Use a currently free model from your OpenCode catalog; Milo does not buy credits
or switch to paid models. `MILO_OPENCODE_URL` optionally connects an existing
numeric loopback server. If it uses HTTP Basic auth, set
`OPENCODE_SERVER_USERNAME` and `OPENCODE_SERVER_PASSWORD` in Milo's environment.
Avoid configuring that OpenCode server to call Milo, which would create a loop.
See the [server API](https://opencode.ai/v1/docs/server/).

[OpenCode's free models](https://opencode.ai/docs/zen) may be free only for a
limited time, and some retain prompts for training. [Kilo Auto Free](https://kilo.ai/docs/getting-started/using-kilo-for-free)
may route to providers that log prompts and outputs and use them to improve
their services. Do not send confidential data through these free routes.

### opencode

For opencode 1.18.31, save this as `opencode.json` in your project:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "milo/milo",
  "provider": {
    "milo": {
      "name": "Milo",
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "http://127.0.0.1:8788/v1", "apiKey": "local" },
      "models": { "milo": { "name": "Milo" } }
    }
  }
}
```

Then run `opencode -m milo/milo`. The [provider docs for this config format](https://docs.dev.opencode.ai/docs/providers/)
use `provider`, `npm`, and `options`. Newer native configs in the
[current docs](https://opencode.ai/docs/providers/) use `providers`,
`package: "@opencode/ai/providers/openai-compatible"`, and `settings` instead.

### pi

Add this provider to `~/.pi/agent/models.json` (tested with pi 0.99.1):

```json
{
  "providers": {
    "milo": {
      "baseUrl": "http://127.0.0.1:8788/v1",
      "api": "openai-completions",
      "apiKey": "local",
      "models": [{
        "id": "milo", "name": "Milo", "reasoning": false, "input": ["text"],
        "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
        "contextWindow": 128000, "maxTokens": 8192
      }]
    }
  }
}
```

Run `pi --provider milo --model milo`. See [pi's model configuration](https://pi.dev/docs/latest/models-configuration).

### Claude Code

Claude Code 2.1.319 uses the Anthropic endpoint:

```sh
ANTHROPIC_BASE_URL=http://127.0.0.1:8788 \
ANTHROPIC_AUTH_TOKEN=local \
claude --model milo
```

See [Claude Code gateway configuration](https://code.claude.com/docs/en/llm-gateway).
The placeholder token satisfies the client; the loopback daemon does not require
a provider credential. Custom model metadata may produce a context-window warning.

### Codex

Add to your user `config.toml` (Responses API; tested with Codex 0.167.0):

```toml
model = "milo"
model_provider = "milo"

[model_providers.milo]
name = "Milo"
base_url = "http://127.0.0.1:8788/v1"
wire_api = "responses"
```

Run `codex`. See the [official configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

### Codex source

Codex is opt-in. With the official `codex` CLI already signed in using ChatGPT,
set `MILO_SOURCES=codex,freellmapi,opencode,kilo` to enable it first. Enabling it
spends your Codex plan allowance, including the weekly limit. Without
`MILO_SOURCES`, Milo uses only `freellmapi,opencode,kilo` and never launches Codex.
With Codex enabled, select model `codex` to use only Codex.
API-key logins do not enable this source. Missing or signed-out Codex is omitted
from `/v1/models`; Milo continues through the free chain on usage limits.

Milo spawns `codex exec --json --sandbox workspace-write` in the request's working
directory. Codex can use its tools and edit files there. Milo never reads or
copies Codex login files, changes its config, or signs you in. Set
`MILO_CODEX_MODEL` to override your Codex default. Only the latest user text is
sent; follow-ups resume the saved thread, keyed by working directory and user
history. Session mappings last until Milo exits. Avoid pointing the delegated
Codex default back at Milo, which would create a routing loop.

### Sources and app sessions

The default source order is `freellmapi,opencode,kilo`. Set `MILO_SOURCES` to
choose sources in your preferred order; Codex runs only when listed. An explicit
model selects just that source. Freebuff is last inside FreeLLMAPI's chain and
can also be selected directly with `MILO_SOURCES=freebuff`. The former
`MILO_GATEWAY_URL` and `MILO_GATEWAY_KEY` no longer configure the local free API
path. Redirects are refused. The Fly-side API and personal-agent routing remain
separate from this local daemon.

Only the latest user text is pasted into Freebuff, without system/developer prompts, tools, results, or known harness context envelopes. Title, summary, topic and warm-up requests are answered locally; classification and the selected working directory are logged. Side-call detection uses system/developer instructions, including Claude Code's recorded session-naming prompt; an ordinary user request for a summary still reaches the source. Detection remains heuristic.

A conversation is keyed by canonical working directory and a hash of its first user text. Follow-ups resume its saved Freebuff chat using `--continue`; concurrent requests use separate chats. The in-memory mapping lasts until the daemon exits. Each turn runs in a dedicated tmux session. Requests queue
per canonical working directory; `MILO_APP_POOL` defaults to (2) active sessions
per directory. New-chat creation and association are serialized per shared on-disk project
directory, including different working folders with the same basename. Once a
chat is associated with its originating process, its response runs concurrently
with other associated turns; replies and startup logs are read only from that chat. SIGINT/SIGTERM
cancel work and close only Milo's own sessions and server on its private tmux socket.
The private server stays alive between turns so ending the last session cannot
race with launching the next; daemon shutdown waits for launches and closes it explicitly.
`MILO_APP_TIMEOUT_MS` defaults to (600000), including queue time. More sessions
consume your account's free hours faster. Freebuff automation may conflict with
its terms; using your account this way is your choice.

Errors carry `not_installed`, `logged_out`, `quota`, `timeout`, `refused`, or `upstream` in
the harness's error envelope. Missing executables are detected immediately.
Freebuff refusals (`prompt_policy_refused`) in the chat log return a typed `refused` error immediately and permit source failover. Long pastes stored in text attachments are supported.

The driver runs a bounded `freebuff doctor` preflight and reads startup log errors before waiting for a saved user message. A turn that is never persisted fails with a startup error after (10 seconds). Recognized login and exhausted-hours diagnostics return typed errors immediately.
Unrecognized startup failures return a clear upstream error; they do not wait
for the full model-turn timeout. Stable malformed chat data returns an explicit format error.
Authentication, quota, missing-app and upstream availability failures can try the
next configured source. Timeouts stop instead of replaying potentially unfinished
filesystem work. Use `MILO_SOURCES=freebuff` to keep requests on the app path.

The source interface is in `src/local/source.ts`; `Multiplexer` is in
`src/local/multiplexer.ts`. Register another app in local configuration without
changing API handlers. Offline tests replay recorded harness request shapes and
run a fake Freebuff TUI through real tmux; they require tmux but no credentials.

To demonstrate the built daemon offline, run `pnpm build && node src/local/proof.mjs`.
It starts the real local entry point with a temporary fake Freebuff on PATH,
exercises all three APIs with and without SSE, and removes its temporary chats.

To replay chat-ownership races through the built HTTP API, run
`pnpm build && node src/local/ownership-proof.mjs`. This uses a filesystem-writing
multiplexer that delays send completion until both processes have persisted their
chat. It verifies exact cwd/chat ownership, follow-up continuation, and a quota-only
startup log alongside a successful request from another folder named `project`.

### Dots through the Milo connector (optional)

With Milo running on your computer, tell your dot:

> Join Milo: usemilo.dev/join

Choose **Allow** when ChatGPT opens Milo's connection page. It sends your browser to the local daemon, redeems a single-use ticket, and returns to ChatGPT. No command or typed code is needed. The dot receives server instructions to subscribe to `milo.request` automatically and return answers with `milo_submit_reply`.

Dots is off by default. Start Milo with an explicit source order that includes it:

```sh
MILO_SOURCES=dots,freellmapi,opencode,kilo milo
```

The normal join flow targets the default daemon port (`8788`). The OAuth authorize URL can specify `milo_port` when the daemon runs on another port. If Milo cannot be reached, or you approve on a phone, return to the Allow page and choose **Connect another computer**. Run the displayed fallback command, `milo dots link <code>`, on the computer running Milo, then choose **Continue to ChatGPT** on that page. Codes and tickets are private, single-use, and expire within ten minutes. The fallback command reuses the same device secret as automatic pairing.

Select model `dots` for the dot only. Model `milo` moves to the next source when the device is not paired, no live subscription exists, the dot reports an actual quota refusal, or no reply arrives before `MILO_DOTS_TIMEOUT_MS` (default `300000`, five minutes). Caller cancellation stops the chain. Without pairing, dots is absent from `/v1/models`. Without `dots` in `MILO_SOURCES`, normal requests and the local pairing route make no gateway calls. Replies that merely discuss usage limits are returned normally.

Milo stores its generated device secret in `dots.json` under `MILO_CONFIG_DIR`, otherwise `$XDG_CONFIG_HOME/milo` or `~/.config/milo`, with mode `0600`, and reuses it for later authorizations. It is a Milo relay secret, never an OpenAI token; do not share that file. Local pairing requires a navigation from the configured gateway and a ticket that gateway confirms was approved. It refuses arbitrary origins, return URLs, unapproved tickets, reused tickets and expired tickets.

The public relay runs on `milo-gateway` at usemilo.dev. `/join` is the canonical OAuth MCP endpoint; `/mcp` is an alias. `MILO_DOTS_URL` overrides the relay origin for tests (HTTP only on loopback). Pair using that override: Milo will not forward an existing device secret to another origin. The gateway's `MILO_PUBLIC_URL` defaults to `https://usemilo.dev` and controls OAuth metadata. Deployment uses the existing merge-to-main workflow. A bare `join.usemilo.dev` hostname would require DNS and a Fly certificate; no DNS change is included here.

The relay sends a signed event containing only a request ID and fixed summary. The dot reads the conversation with `milo_get_request`, then calls `milo_submit_reply(requestId, text)` or `milo_fail_request(requestId, reason)` (`quota` or `upstream`). Follow-ups carry earlier user and assistant turns. Prompt text is removed from SQLite when answered or expired; replies remain only until local acknowledgment or expiry. Text is never written to application logs. The relay temporarily stores conversation text and the dot receives it, so send only content you intend to share.

MCP Events is experimental. The live test checks whether the dot follows the server instructions and subscribes by itself. If it does not, say: “Subscribe to Milo's milo.request event, answer each request in chat, and send the answer back with milo_submit_reply.” Record the exact error if ChatGPT rejects a subscription. You can ask the dot manually to read a queued request while its subscription remains live. Whether event-triggered dot work counts against plan limits must be checked live; do not assume it is free. Every prompt asks for a chat answer without starting Codex or Work tasks, but this cannot guarantee the dot's behavior or usage accounting. Replies are text only; they cannot edit the local working directory or return local tool calls.

Disconnecting the connector revokes the grant and stops subscriptions when ChatGPT invokes the revocation endpoint. Otherwise subscriptions expire within a day; Milo cannot detect ChatGPT-only removal immediately.

References: [OpenAI MCP Events](https://developers.openai.com/plugins/build/mcp-events), [ChatGPT plugin connections](https://developers.openai.com/plugins/deploy/connect-chatgpt), and [dots availability and delegated tasks](https://learn.chatgpt.com/docs/dots).
