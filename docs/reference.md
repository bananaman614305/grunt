Compatibility: the `milo` and `milo-local` commands remain aliases for this release.
Existing `MILO_*` variables, `milo` model/provider IDs, config paths, MCP names,
and infrastructure names remain supported.

Chat with grunt. Hand it a bigger job, keep talking while it works, and get the
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

grunt answers quick questions and uses `dispatch`, `status`, `cancel`, and
`remember` for longer work and durable preferences. Each message uses one front
model turn, with a retry on a second model only for transient failure. A worker
receives a self-contained brief and saved notes, never the raw conversation.
Workers have no tools or live web access. There are at most three active workers,
with at most two per person. Jobs are capped at 4,096 output tokens; front replies
at 1,024. Cancel aborts a request. Queued or running jobs fail after a restart.

On completion or failure, grunt makes a front-model call for a short proactive
update. The full result lives on the job. If that summary call fails, a plain
grunt update still tells you the job's outcome. SSE streams carry assistant
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
it with `curl -X POST http://127.0.0.1:18789/release`; grunt proactively posts its
summary and attaches the full plan. This adapter never calls OpenRouter.

## Deploy

The Docker image contains only the compiled app, page and production dependencies.
GitHub Actions is disabled at the owner's request. Run build and smoke checks
locally and deploy the tested image manually to Fly app `milo-gateway` in `iad`
using authorized app-scoped access. Do not enable or dispatch workflows.
The `milo_data` volume mounts at `/data`. Keep a single Fly machine for SQLite.

The current gateway registry release uses two persisted Machine file overlays,
`/app/dist/registry.js` and `/app/dist/registry/adapters.json`, on the existing
`dc5e3347e62c112f9f757709d3155eabad25d5e7` image. The next full image deployment
must include the updated registry validator and remove these two overlays from
the Machine configuration, or they can mask newer files in that image. Publish
the on-volume registry separately after validating the deployed code.

This replaces the former OpenAI-compatible gateway. The old `/v1/*` routes are
removed. There is no Jev, billing, roster service, worker tooling or monorepo.

## Use grunt as your harness's model

Run the separate local daemon on your own machine (Linux with systemd or macOS
with launchd). Use Node 22 or 24 LTS for the setup wizard; npm and tar must be
available. Squire also needs a usable browser/display path. A headless remote
server may need display helpers such as Xvfb/noVNC or a reachable browser
handoff. Missing prerequisites are reported for repair; provider verification
can still require a person. Mistral Vibe separately needs `uv` or Python 3.12+.
Setup installs the vetted adapters and connects accounts through Trusty Squire:

```sh
pnpm install --frozen-lockfile
pnpm build
node dist/local/main.js setup
# Published package: npx usegrunt setup; installed bin: usegrunt.
# Anonymous Kilo Particle only, after current sharing approval:
# MILO_SOURCES=kilo node dist/local/main.js
```

It binds only `127.0.0.1:8788`. `MILO_PORT` changes the port. It provides
`GET /v1/models`, `GET /v1/status`, Chat Completions, Anthropic Messages, and OpenAI Responses,
including SSE. Choose model `milo` for automatic source selection, or a source
id such as `kilo`. This process is separate from the Fly server and Docker
entry point. Keep this endpoint on your own machine.

Requests containing function tools follow the same source selection and fallback
rules as other requests. Native API sources forward function definitions;
validated JSON bridges return correlated calls for the caller's harness to
execute. OpenCode runs its own delegate tools and returns final text. grunt
extracts cwd from harness context (including environment
blocks), accepts an explicit absolute `cwd`, and otherwise uses the daemon's
working directory. It logs the chosen directory. Check it before asking for edits.
Text and function-tool turns are translated across APIs. Native Responses tools
require a compatible delegate; ordinary Chat Completions sources accept function
tools. Unsupported tools and media blocks return an
error rather than silently losing context.

### Source dashboard

`usegrunt status` prints one cached pool snapshot. `usegrunt status --watch`
opens a live terminal view; `--json` prints a single structured snapshot.
These commands only read the local daemon's `GET /v1/status`; they do not start
the daemon, run provider health checks, install services or consume inference.
An older daemon without that endpoint needs a runtime update through setup.
`usegrunt --help` prints command usage without starting the daemon.

The watch view uses green for a source with an observed successful reply, cyan
for an active request, blue for connecting/verifying, yellow for a required
approval or rate limit, red for an error, and gray for unavailable, disabled or
unobserved sources. Available credentials alone do not count as a verified
reply. Concurrent source requests have individual activity counts. A failed or
stale status fetch replaces the healthy banner with an explicit offline state.
Last-reply timing measures the latest successful source call, not a live speed
test. Retry times describe a reported delay or Grunt's routing cooldown, not a
guaranteed upstream quota reset. Registry model labels describe configuration;
they do not attest to a provider's physical model. Balances are not invented.

Arrow keys select a source, Enter toggles its details, `d` shows or hides
disabled sources, and `q`/Ctrl-C exits the watch view while the daemon keeps
running. `a` gives foreground-setup guidance; a separate watch terminal cannot
approve another setup process's verification. Narrow panes omit model and
timing columns. `NO_COLOR` disables color; labels and symbols still describe
every state. Piped output and dumb terminals print one snapshot without cursor
control sequences. `--watch --json` is rejected rather than emitting a mixed
interactive stream.

Port selection is `--port`, then `MILO_PORT`, then the private numeric
`installed-port.json` saved by successful setup, then 8788. Existing installations
on a custom port can pass `--port` until setup records it. For example, Chad uses
`usegrunt status --watch --port 8792`. Invalid saved configuration fails safely.

After its first successful route and coding-tool configuration, interactive
setup displays a passive live dashboard. The terminal ownership queue suspends
it around interactive installers and Squire confirmations, which retain their
normal full verification instructions. Only provider IDs are shared with the
status view: browser capability links, requested goals, credentials, prompts,
responses and working directories are excluded from status metadata. Approvals
remain per provider, with existing grouped confirmations unchanged. Once all
jobs settle, setup prints the normal summary, then releases its Squire client
and setup lease before opening the keyboard-driven watch view. Noninteractive
setup exits normally. Closing setup before completion pauses unfinished signups; closing
the final watch view only closes the view.

`/v1/status` uses the same loopback Host/Origin restrictions as inference and
`Cache-Control: no-store`. Its version-1 JSON contains the snapshot timestamp,
active call count and per-source observations, including safe failure codes,
last success/timing and finite retry timestamps when known. Observations reset
when the daemon restarts, then rebuild from normal runtime activity.

### Free API and account setup

The eleven-source pool is unchanged from 0.6.6. Version 0.6.7 starts routing as
soon as the first provider is verified, while remaining signups continue.

`npx usegrunt` (or `npx usegrunt setup`) starts the terminal wizard. In a wide
interactive terminal it opens with a short animation (any key skips it; CI,
pipes and narrow terminals get a one-line title). After checking prerequisites,
setup pulls the free service list from the grunt registry, falling back to the
saved or bundled list and saying so. The bundled
vetted pool contains OpenCode, Kilo and Zro in the stable tier, plus
Token Harbor, Runcrate, Mistral Vibe Free, LiveKit, Pollinations, BeatAPI, Clixad and Perch
in the experimental tier.
Provider approval and free-account eligibility still apply.

The wizard gathers the grouped sharing approval and coding-tool choices before
starting provider jobs, so the tool picker does not compete with browser
approvals for terminal input. It installs the persistent daemon once for the
setup session, before connecting providers. Providers still being prepared are
excluded from normal routing and bulk availability probes.

Up to six provider jobs run concurrently. When a setup job reports a provider
available, setup checks that exact provider with a real request through the
installed daemon; up to three reply checks run at once. A correctly attributed
reply is required to verify a route. While that check runs,
the provider stays out of automatic routing; an explicit request for its source
ID can run the verification probe. The first verified reply announces that grunt
is ready and applies the preselected coding-tool
configuration. Other provider jobs and checks continue, and later routes join
the same daemon without a restart. Each provider still gets its own PASS/FAIL
line and final summary row.

Squire bootstrap is lazy and shared: account-dependent jobs reuse one connection
and one pending sign-in, while eligible anonymous Kilo or OpenCode access can
become usable before that sign-in finishes. Their anonymous setup attempts are
prioritized rather than queued behind waiting account jobs. A provider's human
handoff does not hold up verification or use of other ready routes. Perch stays in the default
pool; its initial human verification can remain unfinished while another source
serves requests. No cold-installation timing is promised: npm downloads, native
packages, browser/display prerequisites and human verification all affect it.

The original setup terminal remains the approval console until provider jobs
and their checks settle. Open a connected coding tool in another terminal to use
the ready daemon meanwhile. Closing the console pauses unfinished signups;
already verified daemon routes keep working. Rerun `npx usegrunt setup` to resume.
On normal completion, failed providers are listed with repair guidance, but the
command succeeds if at least one provider was verified. If none was verified,
setup fails. For a foreground daemon, run `usegrunt serve`.

The jobs share one Squire connection, cached credential metadata and reusable
grants. Up to three provider browser operations can run concurrently. Browser
handoffs arriving together share a confirmation prompt; later
handoffs queue while other jobs continue. Interactive installers and confirmations
take turns owning the terminal. Provider verification remains individual, and
Squire has no batch-grant API. Grouped prompts do not create shared provider
accounts or bypass a provider's verification. Reusing one Google or GitHub
identity does not remove each provider's own sign-in and security requirements.

Setup helpers can cancel one provider without stopping other jobs or the shared
broker. A pending initial browser operation may finish before its owned tab can
be closed; cancelled providers do not continue or open another handoff.

Setup offers the coding tools it finds on PATH before provider jobs start
(an installed Pi is preselected; non-interactive runs connect an installed Pi
only). It applies those choices after the first verified provider reply. If no
coding tool was initially installed, setup can offer newly available tools after
the provider batch finishes. Declining all tools that were already detected does
not trigger another picker. Each choice adds a
named **grunt** option and keeps your default model and provider:
Pi gets a `grunt` provider in `models.json`; Codex gets its own
`$CODEX_HOME/grunt.config.toml` for `codex --profile grunt` (`config.toml` is
not edited); OpenCode gets a `grunt` provider in `opencode.json` (pick it with
`/models`; an `opencode.jsonc` file is left alone); Claude Code needs no file
and is started with the printed `ANTHROPIC_BASE_URL` command. A changed file is
first copied to `<file>.grunt-backup-<time>`. Each tool is reported connected
only after it answers one real request through grunt.

OpenCode first tries its free model without an account and requests sign-in only
if that model requires it. Kilo verifies its anonymous Particle 1 free route
after the required sharing approval; it needs no account, API key or signup.
Captcha, passkey and email verification for other providers show a browser
handoff and wait for the user to resume. Existing accounts are reused; no extra
Google accounts are created.

Zro setup prefers Google login through Squire. Before connecting a new local grant, Squire confirms the Free plan, no paid subscription or purchased usage-pack balance, and no saved payment method. Existing vaulted keys are reused after that check. The private `zro.json` file records the check; repeat setup can reuse a healthy confirmed grant. Zro uses the same model ID for free and paid access, so an external account upgrade can change billing; grunt never upgrades the account.

The foreground wizard groups the nine active disclosures for OpenCode (including Big Pickle), Kilo, Token Harbor, Runcrate, Mistral Vibe Free, Pollinations, BeatAPI, Clixad and Perch into one approval. A private local receipt records approved policy versions. Retired Freebuff and APInex records do not authorize routing. Declining or cancelling skips the active sharing providers while eligible Zro and LiveKit setup continues. LiveKit documents zero retention and no training for inference, so it adds no policy to this group. Changed or new policies require another grouped approval. Background setup never prompts; signup and routing require current approval where applicable. Daily background provisioning runs at midnight UTC; unresolved verification leaves that source unavailable while other services continue.

Token Harbor uses `deepseek-v4.1-flash:free`; its weekly allowance is shared across its free models.

Kilo's default in 0.6.6 is `particle-ai/particle-1:free`, a distinct model
post-trained from DeepSeek V4.1 Flash, with a listed 1M-token context and native
function calls. It calls the public `https://ai-gateway.kilo.ai/api/v1` endpoint
without an account or API key. Before inference, grunt checks that the exact
catalog entry is free, has at least 200K context and supports tools and output
limits. It accepts only that exact returned model with zero reported inference
cost and valid correlated function calls. A fallback model cannot pass as Particle.
The [documented anonymous limit](https://kilo.ai/docs/gateway/models-and-providers)
is 200 requests per hour per IP, subject to upstream capacity. This is ongoing
rate-limited zero-cost access rather than a one-time credit balance.

The catalog permits training on Particle prompts. Retention and staff-review
guarantees are unestablished. The Kilo consent policy is now
`2026-11-15-particle`; an earlier Auto Free approval does not authorize this
route. Setup asks for the changed disclosure in the existing grouped approval,
and background routing leaves Kilo unavailable until the current policy is approved.

The additional experimental routes have these requirements:

| Source | Selected route | Free-account requirements and allowance |
| --- | --- | --- |
| Runcrate | `deepseek-ai/DeepSeek-V4.1-Flash` | GitHub login with an account at least 30 days old; no paid balance, payment method or automatic top-ups. Its recurring weekly allowance is not quantified. |
| Mistral Vibe Free | Native CLI alias `zai-glm-5-3-flash`, wire model `zai-glm-5-3-flash-vibe-free` | Free plan with a $10 monthly Vibe Code allowance; no card, purchased credits or pay-as-you-go. This is native coding allowance, not ordinary Mistral API credit. |
| LiveKit | `deepseek-ai/deepseek-v4.1-flash` | Build plan at $0 per month, no card, and one free project. The documented $2.50 monthly included inference allowance resets at the start of each calendar month and has a hard stop; no paid fallback. |
| BeatAPI | `deepseek-v4.1-flash-free` | Personal Google login through Squire; no paid funds, card, subscription or automatic recharge. One successful request per minute. The ordinary one-time $2 welcome credit is separate from this continuous free route and is not spent by it. No numeric daily or token-per-minute limit is promised. |
| Pollinations | `community/morriszdweck/glm-5.3-flash-free` | Google login through Squire, a hard numeric zero-budget key with Quest Pollen Only enabled, usage-only account permissions, and a positive unused Quest balance. No paid funds or billing. Community availability is best effort, with no promised daily quota or fixed reset. |
| Clixad | Native `glm-5.3-flash` | Existing or ordinary free GitHub account pairing, positive free allowance and a wallet balance of exactly zero. No deposit or paid credits. Model selection and native free/zero-charge metadata are checked. |
| Perch | Native `deepseek-flash-starter` | Active Starter plan with 20,000 Perch Tokens per month and no surprise overages. Optional Starter Data Program, Use memory and Learn new memories must all be off. Keep the account on Starter. |

Runcrate keys are captured into Squire. Setup stops if an account
fails the free-account checks; it does not remove billing, switch identities or
buy credits. Mistral setup installs
the pinned native Vibe CLI (`3.1.2`) privately and uses its own browser pairing, credential storage
and isolated configuration under grunt's `mistral-vibe` directory. It needs
`uv` or Python 3.12 or later. A general `MISTRAL_API_KEY` from the shell cannot
replace that native login. Its free-plan receipt expires after 30 days and setup
rechecks it. These checks record account state; keep billing disabled afterward.

LiveKit setup uses the personal Google identity already connected to Squire and
reuses or creates one owned free `grunt-free` project. It automatically installs
the official `lk` CLI version `2.19.4` under grunt's private `livekit` directory,
with pinned archive checksums for Linux and macOS on x64 or arm64. Squire completes
the ordinary CLI browser pairing; no rooms or agent hosting are needed.
`usegrunt add livekit` runs the same setup for an existing installation.

The official CLI retains its credentials in `~/.livekit/cli-config.yaml` with
mode `0600`, in a private directory. Grunt checks file metadata without reading
the native API secrets or requesting a raw vault secret. Each request uses the
verified project's explicit selector and an empty project configuration in a
private working directory. The CLI creates a ten-minute inference-only JWT that
stays in backend memory. Requests go only to
`https://agent-gateway.livekit.cloud/v1` with the fixed DeepSeek model; quota
exhaustion can hand off to another eligible free source, never a paid fallback.

LiveKit's private `livekit/free-build.json` receipt records the verified Build
project and billing state for up to 30 days. Missing or expired verification
requires a fresh browser check through setup. The observed dashboard showed Build,
a $0 next invoice and no payment method, but did not expose remaining inference
credit. The $2.50 figure is the documented monthly allowance, not a measured
remaining balance. Keep the account on Build: an external billing upgrade can
invalidate the free-account assumptions recorded by setup.

BeatAPI setup uses the person's existing Google account through Squire and
restricts the Grunt-owned key to free models. The selected DeepSeek route sends
native function definitions and correlated tool results. Nonbillable account
metadata is checked before and after inference: settled credits must remain
zero and the wallet balance must match the verified zero or signup-credit
baseline. A changed balance stops routing for repair with `usegrunt add beatapi`.
After each successful request, the source cools down for one minute; grunt can
immediately use another eligible free source. Its observed 210,081-token input
took about 121 seconds, so the long-context proof is not a speed guarantee.

Pollinations setup captures a Grunt-owned key directly into Squire with a budget
of exactly numeric `0`; blank or unlimited budgets are rejected. Quest Pollen
Only must be enabled, with only the `usage` account permission. An individual
model allowlist is used when the normal dashboard offers it; runtime always
pins the one vetted community route. The source rechecks key validity and expiry,
budget, permissions, balance and the route's zero-price catalog entry before
inference. An explicit one-candidate request prevents provider fallback, and
the response must identify both the requested community route and
`poe/GLM-5.3-Flash-T`. Function calls use a validated JSON bridge with correlated
tool results; the upstream route does not receive native function definitions.

The ordinary first-key reward of 0.25 Quest Pollen supplies the positive balance
required for access. The zero-priced community route leaves it unused; it does
not require ongoing earning or purchases while that balance remains positive.
Under the current terms, the wallet expires after twelve consecutive months of
inactivity, with API requests or sign-in resetting the clock. This is a one-time
reward supporting a currently free route, not a recurring credit grant or a
permanent availability guarantee. A depleted or expired allowance leaves the
source unavailable. Rerun `usegrunt add pollinations` to repair access through
the ordinary signup flow.

Grunt stores these sources' private Squire egress grants and verification receipts
in `beatapi.json` and `pollinations.json`; their provider keys stay in Squire.
Verification receipts expire after 30 days. Neither setup displays or
stores a plaintext provider key in grunt's files, harness configuration or logs.

Clixad uses the official Node CLI `0.0.1-beta.51`, installed privately with pinned
package integrity, and its ordinary GitHub device login with read-only identity
and email scopes. The native CLI owns `~/.clixad/config.json`; grunt checks private
file metadata without reading auth contents. Its `ask` command dispatches the
pinned `glm-5.3-flash` model through a validated JSON tool bridge. Native actions
are blocked and each request gets a private working directory. The documented
headless sponsor opt-out is used; grunt does not submit ratings, offers or feedback.

Clixad requires wallet balance zero, positive free allowance and native metadata
showing `free: true`, zero charged credits and balance zero. Explicit setup and
user calls check the native wallet; that command can claim the ordinary daily
streak bonus. Idle availability checks use only local metadata and the public
catalog, and never call the wallet or streak endpoints. Grunt checks wallet state
before and after user inference. There is no atomic free-only switch: an external
deposit during a request can defeat a pre-request zero-wallet check before the
post-check rejects the answer. Keep that account unfunded. The native SSE omits
the served model; the wire pin and official aggregate usage ledger support the
route selection, without independent physical-model attestation.

Perch uses the pinned official `perchai-cli` `2.4.132`, a private native login and
the active Starter plan. A placeholder Starter label before activation is
insufficient; setup uses the ordinary free activation flow when needed. The
allowance is 20,000 Perch Tokens per month, in provider plan units, with no surprise
overages. Setup verifies the optional Starter Data Program is off and turns off
both Use memory and Learn new memories through official CLI settings, without
deleting saved notes. A 30-day receipt is bound to the native account identity;
routing freshly verifies that identity and both memory settings. Keep Starter
active with the Data Program and both memory switches off.

The Perch backend pins `deepseek-flash-starter`, the official
`DeepSeek V4.1 Flash 1017 (Starter)` option and its corresponding DeepSeek model
identifier. These are aliases for the same provider-selected route, rather than
independent physical-model attestation. Each request uses a private, checked
context and a validated JSON tool bridge; native actions are denied. Owned
PTY/process cleanup runs on completion, cancellation and timeout. Clixad and Perch
are backend sources: Pi, Codex, OpenCode and Claude Code remain the frontend choices.
Existing installations can run `usegrunt add clixad` or `usegrunt add perch` to
perform the same signup, current sharing approval and native eligibility checks.

Both native backends validate returned output and reported usage against a local
budget of at most 4,096 tokens, with bounded output bytes and a process lifetime
of at most 175 seconds. Neither CLI offers a hard upstream output-token cap:
generation and free-allowance use can exceed that local acceptance budget before
grunt rejects a completion.

The grouped disclosure includes each provider's data policy. Token Harbor permits
retention, staff review and upstream training. Runcrate's upstream retention and
training guarantees are unestablished. Free Mistral Vibe prompts and code may be used
for improvement, with no established zero-retention guarantee.
For [BeatAPI](https://beatapi.io/privacy-policy), prompts may be retained for
operations and processed upstream. It states private content is not used for
training without separate notice and consent where required; upstream guarantees
remain unestablished. [Pollinations](https://pollinations.ai/privacy) sends context
through its OSAII community operator and Poe/Together processing, whose retention,
staff review and training guarantees are unestablished. Both require the current
grouped approval before signup or runtime routing.
[Clixad](https://clixad.io/privacy.html) sends prompts, code and tool results through
Clixad, OpenRouter and model providers. It records usage metadata and says content
is stored when an answer is rated. It excludes training/public-dataset endpoints
but does not require zero upstream retention. [Perch](https://www.perchai.app/privacy#starter-data-program)
processes task and tool context for service delivery, security, debugging and
metering even with the optional Data Program off. Retention, review limits and
zero-retention coverage have not been independently verified. Both require the
current grouped sharing approval.

NVIDIA remains an optional integration and is not in the bundled default pool while account verification is unvetted. Its direct Squire grant never uses the FreeLLMAPI fallback chain. Cloudflare Qwen is excluded from the pool by the owner's choice.

Before making changes, setup checks Node, npm, tar and the user service
manager. A missing prerequisite prints its install or repair step and stops.
Coding harnesses such as Pi are optional; setup can install the service before
you install a harness.

Existing vault API keys are reused. Missing keys are created through Squire's
browser and captured directly into its vault. Human verification opens a browser
handoff, including email confirmation, and signup resumes in that same session.
An incomplete or refused service is reported while other service jobs finish.
grunt calls `grant_app_access` and sends only the grant's base URL and bearer
token to FreeLLMAPI's custom-provider endpoint for those API providers.
Zro, Token Harbor and Runcrate keep private grants in `zro.json`,
`tokenharbor.json` and `runcrate.json` and call
`/v1/chat/completions` directly. Their upstream keys stay in Squire, scoped to
`zro.moonmath.ai`, `tokenharbor.ai` and `api.runcrate.ai`.
NVIDIA keeps its optional grant in the private `nvidia.json` file and calls the grant's
`/v1/chat/completions` endpoint directly. Its upstream key stays in Squire,
scoped to `integrate.api.nvidia.com`; no other backend can answer its requests.
API-provider keys stay in Squire; no provider reveal approval is requested.
Mistral Vibe, LiveKit, Clixad and Perch's native CLIs own their separate local credential
exchanges and storage.
Groq uses its `/openai/v1` API path beneath the Squire grant root. Setup discovers
currently available chat models through that grant before registering one.
`usegrunt add groq` or `usegrunt add cerebras` connects another provider through
the same flow, then restarts grunt with the API sources enabled. `usegrunt add kilo`
checks the anonymous Particle free route after current approval; it does not
create an account or capture a provider key.

When the first account-dependent job needs Squire and no session exists, setup
runs Squire's own connect installer with the OpenCode target. Parallel jobs share
that pending bootstrap rather than starting duplicate installers. Its supported
child-only `OPENCODE_CONFIG` override points to the private
`squire-opencode.json` in Grunt's configuration directory, separating bootstrap
configuration from the user's coding-tool config and provider grant file. Squire manages
login and its broker service. An existing
session with an unavailable broker reports the connection error for repair.
Setup does not pair with Beeline or create agents or Rooms.

grunt state lives under `$MILO_CONFIG_DIR`, otherwise `$XDG_CONFIG_HOME/milo` or
`~/.config/milo`. Keep this directory across service restarts. Local router login
and encryption material are generated once and stored with mode `0600`.
FreeLLMAPI encrypts the grant tokens in its backend database. Neither tokens nor
provider keys appear in Pi's config or terminal output. Never share backend state.
Existing routers with keys are preserved if their local admin state is missing.

Fresh setup offers the bundled OpenCode, Kilo, Zro, Token Harbor, Runcrate,
Mistral Vibe Free, LiveKit, Pollinations, BeatAPI, Clixad and Perch pool, enabling providers only after their
required data-sharing approval.
It also preserves an existing `freellmapi` route from an earlier
API-provider setup. Service installs save their selected sources in
`installed-sources.json` under grunt's config directory so later installs retain
them. The daemon loads the saved router login at startup and retries if the
router is temporarily unavailable. Setup keeps a runtime outside the npx cache,
so cache cleanup does not remove the service. In the ready-first flow, providers
join this installed runtime as their checks finish; the wizard does not reinstall
or restart it for each provider. Pi's other providers are preserved.
`PI_CODING_AGENT_DIR` selects a nondefault Pi agent directory.

Named API-provider setup can install the pinned FreeLLMAPI Node server
as a separate background service; Docker is not required. Linux uses systemd user
units; macOS uses launchd (macOS remains untested). The router data and private login live under grunt's
config directory. `MILO_FREELLMAPI_URL` chooses its numeric loopback address and
is saved in grunt's service configuration. The router's database is created under
umask `0077`. `MILO_ROUTER_RUNTIME=docker` retains the older Docker installer for
existing installations and offline regression checks.
The default Kilo Particle source calls the public gateway directly and does not
need this separate router service.

`MILO_SQUIRE_HOME` and `MILO_SQUIRE_XDG_CONFIG_HOME` select an existing Squire
home without relocating grunt state. `MILO_SETUP_NO_HUMAN=1` stops before Squire
onboarding or browser handoff if human verification would be needed.

The installed command is `usegrunt`. In 0.6.6, production adapters passed real
Grunt prompt, function-tool,
correlated-result and large-context checks: BeatAPI at 210,090 input tokens,
Pollinations at 210,223 without fallback, Kilo Particle at 210,165 anonymously
with zero reported cost, and Clixad at 210,321 with free/zero-charge metadata and
zero account balance before and after. Perch's actual production source passed
all four probes, including a context with 226,316 input tokens and 101 output
tokens. Its 153 focused source/helper tests and independent review passed.
After these probes, Starter showed 19,726 of 20,000 PT remaining, with the Data
Program and both memory switches off; this is an observed account snapshot,
not a promised remaining balance for another user.
The packaged Clixad setup helper installed its pinned private CLI, reused existing
native authentication, passed the background probe and returned a production
hello with 252 input and 63 output tokens. The reviewed Kilo candidate was also
verified on Chad at port 8792. These checks do not claim a separate blank-machine
onboarding run.
Perch's packaged onboarding required operator assistance in the browser. The
official native Google pairing, matching identity and memory-off checks completed;
this does not establish unattended fresh signup. Later account views disagreed
on the included quota. Grunt records the vetted 20,000 PT recurring floor and does
not promise the larger displayed amount or count signup bonuses as recurring.
When Squire cannot choose a control and explicitly offers goal completion, setup
shows the full requested goal and asks for a default-No confirmation that every
condition was personally verified. Only that confirmation can resume the same
owned session with the offered completion choice. Captcha completion alone cannot
attest to plan or privacy conditions; background setup never makes that choice.
The final 0.6.6 runtime on Chad returned correctly attributed replies through all
eleven automatic sources and rejected both retired source IDs. A subsequent
restart kept all eleven available without changing the saved access receipts or
opening verification handoffs. The release passed 954 local tests, lint,
TypeScript checks and a clean build; GitHub Actions remains disabled.
Publish npm and the gateway registry manually; do not dispatch GitHub Actions. Gateway changes
update the two existing file overlays described under Deploy, not the image.

Explicit legacy FreeLLMAPI installations send calls to `http://127.0.0.1:3001/v1`, including
provider failover. There is no direct OpenRouter free API route. An already
configured install can provide `MILO_FREELLMAPI_KEY` in its process environment;
`MILO_FREELLMAPI_URL` accepts numeric HTTP loopback addresses only. The completion
cap is (4096) tokens. Select `freellmapi` for a previously configured legacy
chain; select `kilo` for the direct Particle 1 free source. Grunt-owned backend
rows require current sharing approval; custom backend rows retain their own flags
and priorities. Legacy requests reconcile owned rows from the existing private
admin file before forwarding and fail closed if that state cannot be checked.
The 0.6.6 migration retires Grunt-owned Auto, Nemotron and other non-Particle
rows labeled `Kilo Free` or `Milo kilo (Squire)`, even when an older approval
exists. With current Particle-specific consent and a verified catalog entry,
the runtime guard can add Particle to an existing Grunt-owned backend key using
backend-held credentials. It preserves a previously disabled Particle row and
its priority, and leaves user custom keys, rows,
flags and priorities untouched. This guard creates no account, provider key or
router service. Fresh legacy bootstrap also uses only Particle for Kilo; it does
not restore Auto or Nemotron fallback. Metadata-only migration was verified on
Chad: owned Auto/Nemotron rows are disabled and owned Particle rows are enabled.
Version 0.6.5 used Auto Free by default and a Nemotron-first legacy
chain. Auto Free is no longer the default in 0.6.6, and its changing pool does not
guarantee DeepSeek. Particle is specifically post-trained from DeepSeek V4.1 Flash;
it is not the standard DeepSeek model.
On November 15, 2026, both official model catalogs
([API gateway](https://api.kilo.ai/api/gateway/models),
[AI gateway](https://ai-gateway.kilo.ai/api/v1/models)) listed the standard
DeepSeek V4.1 Flash and its 1017 variant as paid, at $0.30 per million input
tokens and $1.20 per million output tokens, with no free standard DeepSeek ID.
The separately listed free Particle route does not make either standard route free.
See [Kilo's free-model guidance](https://kilo.ai/docs/getting-started/using-kilo-for-free).
Grunt-owned Freebuff fallback rows are disabled, and the port-8789 bridge no
longer starts. Fresh Kilo Particle setup needs no legacy router. FreeLLMAPI
continues priority routing for eligible configured providers; custom user rows
retain their own flags and priorities.

FreeLLMAPI's signed catalog handles model and quota updates. Free installations
receive its delayed monthly snapshot; live catalog access is a separate upstream
premium option. Check the local dashboard when provider availability changes.
FreeLLMAPI is single-user software for personal experimentation; keep it bound
to loopback. See its [installation guide](https://github.com/tashfeenahmed/freellmapi/blob/main/docs/en/install/01-install.md).

### OpenCode app driver

Select `opencode` as the grunt model. grunt starts `opencode serve` on a loopback
port, using your normal OS home and existing OpenCode login. It sends only the
latest user message, word for word, through the session API, with no caller
system prompt or tool definitions. Follow-ups with their user-message history
reuse the same session; the mapping lasts until grunt exits. OpenCode runs its
own tools and returns final text. It uses no tmux.

An OpenCode worker started by grunt checks for grunt's saved authentication
configuration when that worker first starts. Account setup can therefore finish
after the daemon starts and become usable without restarting the daemon. This
does not change a separately supplied OpenCode server or promise that an already
running worker reloads changed credentials.

Before prompting a worker it starts itself, grunt disconnects inherited MCP
integrations in that worker's working-directory instance. Large optional tool
catalogs can otherwise fill the model context and cause repeated compaction.
OpenCode's built-in coding tools and automatic compaction remain enabled;
your configuration files and saved login are preserved. Trusty Squire still
handles provider signup separately during setup. A server supplied through
`MILO_OPENCODE_URL` keeps its own MCP connections.

New conversations rotate across `deepseek-v4.1-flash-free`,
`glm-5.3-flash-free` and `big-pickle`. Follow-ups stay with their successful
model and session. A model that returns a quota error cools down while another
pool member is tried; the other Grunt sources remain available when the pool
is exhausted. Providers may share quotas across models, so this does not imply
three independent credit balances.

`MILO_OPENCODE_MODEL` overrides the pool with one explicit model.
Use a currently free model from your OpenCode catalog; grunt does not buy credits
or switch to paid models automatically. `MILO_OPENCODE_URL` optionally connects an existing
numeric loopback server. If it uses HTTP Basic auth, set
`OPENCODE_SERVER_USERNAME` and `OPENCODE_SERVER_PASSWORD` in grunt's environment.
Avoid configuring that OpenCode server to call grunt, which would create a loop.
See the [server API](https://opencode.ai/v1/docs/server/).

[OpenCode's free models](https://opencode.ai/docs/zen) may be free only for a
limited time, and some retain prompts for training. Kilo's Particle free catalog
permits training on prompts, with unestablished retention and staff-review
guarantees; [Kilo's free-model guidance](https://kilo.ai/docs/getting-started/using-kilo-for-free)
also describes its free access. Do not send confidential data through these free routes.

### opencode

For opencode 1.18.31, save this as `opencode.json` in your project:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "milo/milo",
  "provider": {
    "milo": {
      "name": "grunt",
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "http://127.0.0.1:8788/v1", "apiKey": "local" },
      "models": { "milo": { "name": "grunt" } }
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
        "id": "milo", "name": "grunt", "reasoning": false, "input": ["text"],
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
name = "grunt"
base_url = "http://127.0.0.1:8788/v1"
wire_api = "responses"
```

Run `codex`. See the [official configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

### Codex source

Codex is opt-in. With the official `codex` CLI already signed in using ChatGPT,
set `MILO_SOURCES=codex,freellmapi,opencode,kilo` to enable it first. Enabling it
spends your Codex plan allowance, including the weekly limit. Without
`MILO_SOURCES`, grunt uses the bundled free pool and current data-sharing
approvals; it never launches Codex. With Codex enabled, select model `codex` to use only Codex.
API-key logins do not enable this source. Missing or signed-out Codex is omitted
from `/v1/models`; grunt continues through the free chain on usage limits.

grunt spawns `codex exec --json --sandbox workspace-write` in the request's working
directory. Codex can use its tools and edit files there. grunt never reads or
copies Codex login files, changes its config, or signs you in. Set
`MILO_CODEX_MODEL` to override your Codex default. Only the latest user text is
sent; follow-ups resume the saved thread, keyed by working directory and user
history. Session mappings last until grunt exits. Avoid pointing the delegated
Codex default back at grunt, which would create a routing loop.

### Sources and app sessions

The bundled registry has three stable adapters in relative proportions 6:8:5:
OpenCode at `0.25263157894736843`, Kilo at `0.3368421052631579`, and Zro at
`0.21052631578947367`. Stable weights total 0.8. Eight experimental sources have
weight 0.025 each: Token Harbor, Runcrate, Mistral Vibe Free, LiveKit, Pollinations,
BeatAPI, Clixad and Perch. Their weights total 0.2. All eleven accept text rather than images.
Kilo, Zro, Token Harbor, Runcrate, LiveKit and BeatAPI forward function tool definitions
and return tool calls for the harness to execute. Mistral Vibe uses a validated
text bridge for harness tool calls while its native tools remain disabled.
Pollinations, Clixad and Perch also use validated JSON tool bridges for their fixed routes. Providers
with data-sharing policies require current approval before they can be selected.
LiveKit's [inference data-retention policy](https://docs.livekit.io/agents/models/inference/)
states zero retention and no training by LiveKit or its underlying providers on
all plans; it does not add a policy to the existing approval group.
Pi remains the harness. Each new user turn starts a task keyed by the canonical
working directory and user history. Tool results and retries keep the same
adapter. No usage counters switch it ahead of quota exhaustion.

A quota error switches immediately and bars that adapter until Retry-After,
or one hour. In registry routing, other upstream failures, timeouts and provider
refusals switch immediately and bar the adapter for fifteen minutes. A missing
installation or expired login bars it until a successful health check. Caller
cancellation stops the chain.
When no eligible adapter remains, the API returns HTTP 429 and, when known,
the earliest Retry-After. Agent adapters return final text, so streaming headers
are sent after completion; quota failures retain their HTTP status.

On handoff, the next adapter receives the original task, working-tree status,
the diff against a task-start `git stash create` checkpoint, the previous
adapter's last four KB of output, and an instruction to continue without
restarting. The checkpoint creates no branch commit or stash entry. Outside a
git repository, only task text and output are sent.

The owner curates `registry/adapters.json` and publishes it manually using
authorized Fly access. Validate the registry, upload it atomically to the
gateway volume, and check `GET /v1/registry`; GitHub Actions must remain disabled.
Ordinary code deployments do not publish registry edits.
Before the first valid registry is published the endpoint returns HTTP 503. Published data
survives deploys and has an ETag. Stable weights total (0.8) and experimental
weights total (0.2) when both tiers are present. Unknown adapter identifiers
are ignored locally and cannot install new code.

The daemon synchronizes on startup and at midnight UTC with
If-None-Match. It tries `https://api.grunt.run/v1/registry` first and falls back
to `https://milo-gateway.fly.dev/v1/registry` if that default endpoint is
unreachable. An explicit `GRUNT_REGISTRY_URL` is used on its own. It writes the valid registry and ETag atomically in a private
`registry.json` in its existing config directory. A gateway or cache failure
keeps the last good list, falling back to the packaged list on a fresh install.
Known adapters are installed and checked during sync with up to six concurrent
jobs and a shared Squire connection. During foreground setup, a private session
lease owns all providers selected for that session, including providers already
verified. The daemon skips duplicate signup work for those providers. Pending
providers are also excluded from normal routing and bulk availability checks.
Heartbeat expiry and owner-process liveness prevent a crashed setup console
from leaving a permanent exclusion; normal cleanup removes only that session's
lease. This foreground gate is separate from routine background preparation;
background checks do not themselves block an already-bound healthy route.
Removing a registry entry disables it without uninstalling its files. The legacy `MILO_CONFIG_DIR` and
`MILO_PORT` settings remain supported. `GRUNT_REGISTRY_URL` overrides the sync
endpoint for local development.

Explicit `MILO_SOURCES` configurations containing legacy sources such as Dots,
Codex or FreeLLMAPI retain their existing ordered behavior. They are outside the
launch registry. Codex still requires explicit opt-in. The Fly personal-agent
API remains separate from this local daemon.

### Retired sources

Freebuff and APInex cannot be selected or routed through grunt in 0.6.6. Saved
source selections and environment values are filtered, old consent receipts do
not reactivate them, Grunt-owned Freebuff backend rows are disabled, and no
port-8789 bridge starts. The person's native Freebuff application and account
are preserved. The prior DeepSeek-selection experiment received an explicit
relaying-policy refusal; no pin shipped.

APInex changed its recurring 25-million-unit daily entitlement to require a $5
top-up. Grunt does not make that purchase; a one-time Telegram reward does not
qualify as ongoing free access. Historical Freebuff bridge experiments and their
limitations remain in [the recorded evidence](../proof/freebuff-json-bridge.md),
not as supported routing instructions for this release.

### Dots through the grunt connector (optional)

With grunt running on your computer, tell your dot:

> Join grunt: api.grunt.run/join

Choose **Allow** when ChatGPT opens grunt's connection page. It sends your browser to the local daemon, redeems a single-use ticket, and returns to ChatGPT. No command or typed code is needed. The dot receives server instructions to subscribe to `milo.request` automatically and return answers with `milo_submit_reply`.

Dots is off by default. Start grunt with an explicit source order that includes it:

```sh
MILO_SOURCES=dots,freellmapi,opencode,kilo usegrunt serve
```

The normal join flow targets the default daemon port (`8788`). The OAuth authorize URL can specify `milo_port` when the daemon runs on another port. If grunt cannot be reached, or you approve on a phone, return to the Allow page and choose **Connect another computer**. Run the displayed fallback command, `usegrunt dots link <code>`, on the computer running grunt, then choose **Continue to ChatGPT** on that page. Codes and tickets are private, single-use, and expire within ten minutes. The fallback command reuses the same device secret as automatic pairing.

Select model `dots` for the dot only. Model `milo` moves to the next source when the device is not paired, no live subscription exists, the dot reports an actual quota refusal, or no reply arrives before `MILO_DOTS_TIMEOUT_MS` (default `300000`, five minutes). Caller cancellation stops the chain. Without pairing, dots is absent from `/v1/models`. Without `dots` in `MILO_SOURCES`, normal requests and the local pairing route make no gateway calls. Replies that merely discuss usage limits are returned normally.

grunt stores its generated device secret in `dots.json` under `MILO_CONFIG_DIR`, otherwise `$XDG_CONFIG_HOME/milo` or `~/.config/milo`, with mode `0600`, and reuses it for later authorizations. It is a grunt relay secret, never an OpenAI token; do not share that file. Local pairing requires a navigation from the configured gateway and a ticket that gateway confirms was approved. It refuses arbitrary origins, return URLs, unapproved tickets, reused tickets and expired tickets.

The public relay runs on `milo-gateway` at api.grunt.run. `/join` is the canonical OAuth MCP endpoint; `/mcp` is an alias. `MILO_DOTS_URL` overrides the relay origin for tests (HTTP only on loopback). Pair using that override: grunt will not forward an existing device secret to another origin. The gateway's `MILO_PUBLIC_URL` defaults to `https://api.grunt.run` and controls OAuth metadata. Deployment is manual; GitHub Actions remains disabled.

The relay sends a signed event containing only a request ID and fixed summary. The dot reads the conversation with `milo_get_request`, then calls `milo_submit_reply(requestId, text)` or `milo_fail_request(requestId, reason)` (`quota` or `upstream`). Follow-ups carry earlier user and assistant turns. Prompt text is removed from SQLite when answered or expired; replies remain only until local acknowledgment or expiry. Text is never written to application logs. The relay temporarily stores conversation text and the dot receives it, so send only content you intend to share.

MCP Events is experimental. The live test checks whether the dot follows the server instructions and subscribes by itself. If it does not, say: “Subscribe to grunt's milo.request event, answer each request in chat, and send the answer back with milo_submit_reply.” Record the exact error if ChatGPT rejects a subscription. You can ask the dot manually to read a queued request while its subscription remains live. Whether event-triggered dot work counts against plan limits must be checked live; do not assume it is free. Every prompt asks for a chat answer without starting Codex or Work tasks, but this cannot guarantee the dot's behavior or usage accounting. Replies are text only; they cannot edit the local working directory or return local tool calls.

Disconnecting the connector revokes the grant and stops subscriptions when ChatGPT invokes the revocation endpoint. Otherwise subscriptions expire within a day; grunt cannot detect ChatGPT-only removal immediately.

References: [OpenAI MCP Events](https://developers.openai.com/plugins/build/mcp-events), [ChatGPT plugin connections](https://developers.openai.com/plugins/deploy/connect-chatgpt), and [dots availability and delegated tasks](https://learn.chatgpt.com/docs/dots).
