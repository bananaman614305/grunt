# Grunt reference

Grunt uses `usegrunt`, the `grunt` model/provider ID, `GRUNT_*` settings and
`~/.config/grunt` for new installations.

## Compatibility with existing installations

The former `milo`/`milo-local` commands, `MILO_*` settings, model and MCP aliases
remain accepted for existing clients. `GRUNT_*` settings take precedence. Existing
private configuration under `~/.config/milo` and an installed `milo.service` are
reused so saved logins, custom ports and consent receipts are preserved. New
installations use Grunt names. These are migration aliases, not current branding.
The already allocated gateway app, volume and database file retain their
resource identifiers in `fly.toml`; changing those without moving the data would
create a separate deployment or database.

Chat with grunt. Hand it a bigger job, keep talking while it works, and get the
result back in the same conversation.

One Node process, one SQLite file, a front agent, and a small background pool.
The `/chat` interface needs no Grunt account: paste your OpenRouter key there.
Jobs spend your OpenRouter credits. The key is saved in your browser; use a
trusted device. The separate private owner console uses Google login.

## Run

Requires Node 22 and pnpm.

```sh
pnpm install --frozen-lockfile
pnpm build
GRUNT_DB=file:./grunt.db pnpm start
```

Open http://localhost:8787/chat. `pnpm dev` runs the TypeScript source.
`pnpm lint` checks ESLint and TypeScript; `pnpm test` runs the offline suite.

Environment:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8787` | HTTP port |
| `GRUNT_DB` | `file:/data/grunt.db` | Local SQLite file |
| `GRUNT_CONFIG` | unset | Optional JSON file with `agent.whitelist` |

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

To override priors, set `GRUNT_CONFIG` to a JSON file shaped like:

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
GRUNT_DB=file:/tmp/grunt-proof.db PORT=8788 node --import ./proof/fake.mjs dist/server.js
```

Open `/chat` on that port and enter any synthetic key. Send “hello”, “remember I
write TypeScript; keep answers short”, “write a one-page launch plan”, then “what
is the capital of France?”. The job stays running while Paris appears. Release
it with `curl -X POST http://127.0.0.1:18789/release`; grunt proactively posts its
summary and attaches the full plan. This adapter never calls OpenRouter.

## Deploy

The Docker image contains the compiled app, chat and admin assets, and production dependencies.
The public repository runs CI on standard GitHub-hosted Ubuntu runners. The
workflow runs lint, tests, build and the operator's offline verification suites.
It refuses to run while the repository is private and does not upload artifacts
or use Actions caches. Production deployment and npm publication remain separate
from CI; their workflows are not enabled by turning CI on.

The existing deployment is selected by `fly.toml` in `iad`, using authorized
app-scoped access. Its existing volume mounts at `/data`; its resource and
database identifiers are retained to preserve data. Keep a single Fly machine
for SQLite.

The current gateway registry release uses two persisted Machine file overlays,
`/app/dist/registry.js` and `/app/dist/registry/adapters.json`, on the existing
`dc5e3347e62c112f9f757709d3155eabad25d5e7` image. The next full image deployment
must include the updated registry validator and remove these two overlays from
the Machine configuration, or they can mask newer files in that image. Publish
the on-volume registry separately after validating the deployed code.

This replaces the former OpenAI-compatible gateway. The old `/v1/*` routes are
removed. There is no Jev, billing, roster service, worker tooling or monorepo.

## Private owner admin

The owner console is designed for `https://grunt.run/admin/`; `/Admin` redirects
to `/admin/`. Its public static shell contains no diagnostic data. Google login
and the private metadata API run on the existing Fly backend, normally at
`https://api.grunt.run`. This is an operator feature for explicitly enrolled
installations, initially Chad, rather than telemetry enabled by ordinary setup.

The [same-origin Fly preview](https://milo-gateway.fly.dev/admin/) supports Google
owner sign-in and receives updates from Chad while custom API DNS is pending.
The overview shows current work, project milestones and Grunt's checkpoint plan,
along with active and unavailable sources and reported usage for today and this
week. Milestones link to the project's pull requests and show their review or
merge state. The browser uses local midnight and the start of
Monday for those periods. Only successful user-facing attempts contribute to
these totals. The table marks incomplete token reporting and keeps reply counts
visible regardless of coverage. Detailed diagnostics remain in their own views.

Work uptime shows how long Grunt was observed doing project work across the
last 24 hours and seven days. The publisher samples the runner and its project
pool every five seconds and counts provider waits, stalls, pauses and time
between work cycles as downtime. The percentage uses measured time, with
missing coverage shown separately.

### Authentication and configuration

Google authorization uses an authorization-code exchange with PKCE, state and
nonce checks, verified Google identity tokens and an exact email allowlist.
`GRUNT_ADMIN_OWNERS` accepts complete verified email addresses, normalized to
lowercase; no default owners or email domains are inferred from account handles.
Missing or malformed authentication configuration returns `503`. The opaque
owner session lasts twelve hours in a Secure, HttpOnly, host-only, SameSite=Lax
cookie scoped to `/admin`. Removing an owner also denies that owner's existing
session.

| Variable | Purpose |
| --- | --- |
| `GRUNT_ADMIN_OWNERS` | Required comma-separated, confirmed full owner email addresses. |
| `GRUNT_ADMIN_GOOGLE_CLIENT_ID` | Dedicated Grunt Google OAuth web client ID. |
| `GRUNT_ADMIN_GOOGLE_CLIENT_SECRET` | Matching backend-only client secret. |
| `GRUNT_ADMIN_SESSION_SECRET` | Independent session secret of at least 32 bytes. |
| `GRUNT_ADMIN_PUBLIC_URL` | Exact HTTPS API origin; defaults to `https://api.grunt.run`. |
| `GRUNT_ADMIN_UI_ORIGIN` | Exact HTTPS browser UI origin; defaults to `https://grunt.run`. |
| `GRUNT_ADMIN_READ_TOKEN` | Optional separate bearer token for diagnostic-agent reads. |
| `GRUNT_ADMIN_INGEST_KEY` | Separate machine credential for collector uploads. |
| `GRUNT_ADMIN_INSTANCES` | Explicit comma-separated installation IDs accepted by ingestion. |

Keep secret values in protected backend or service configuration, never public
HTML, command arguments or source control. Browser reads require the exact UI
origin when UI and API origins differ. For a same-origin Fly preview, explicitly
set both origins to `https://milo-gateway.fly.dev` and register that origin's
`/admin/auth/callback` on the dedicated Google client. An unrelated Pages preview
does not inherit a working cross-site cookie flow. Production uses the exact
`https://api.grunt.run/admin/auth/callback` registration.

### Owner and collector API

| Method | Route | Access and result |
| --- | --- | --- |
| GET | `/admin/auth/google` | Begin Google owner sign-in. |
| GET | `/admin/auth/callback` | Validate sign-in and create an allowed owner's session. |
| POST | `/admin/auth/logout` | Owner session, exact Origin, JSON and CSRF token required. |
| GET | `/admin/api/session` | Browser owner session and logout CSRF token; machine read token cannot use it. |
| GET | `/admin/api/overview` | Installation freshness, request and usage summaries. |
| GET | `/admin/api/source-usage` | Successful replies and reported tokens per source. Pass `today` and `week` as the two period starts in Unix milliseconds and `instanceId` to limit the report. |
| GET | `/admin/api/providers` | Cached source observations and reported usage. |
| GET | `/admin/api/requests` | Retained logical requests; supports `limit` (1–100), `source`, `outcome`, `before` and `instanceId`. |
| GET | `/admin/api/requests/:id` | Request, attempts, routing and safe transport events; select `instanceId` if ambiguous. |
| GET | `/admin/api/runs` | Projected maintenance and scout progress. |
| GET | `/admin/api/export` | Download the same sanitized diagnostics as JSON. |
| POST | `/admin/ingest` | Machine ingestion key and approved installation ID; bounded, validated upload and acknowledgement. |

Private diagnostic reads require an owner session or the optional bearer read
token. That token permits only GET diagnostic API reads, excluding the
browser-session endpoint; it grants no ingestion, logout or mutation rights.
The ingestion key grants uploads only, never reads or browser login. Equal read
and ingestion credentials are rejected. Ingestion requires an explicit allowed
installation ID; these operator credentials are not a per-customer delegation
scheme.

The console is read-only apart from session logout. Refresh and export read
cached observations; neither triggers inference, provider signup, credential
repair, remote shell commands or arbitrary daemon forwarding. Unknown token
counts and absent provider balances remain unknown. Usage totals describe only
reported counts and identify attempts with missing usage; they are not a daily
allowance estimate or billing guarantee.

### Opt-in outbound collection

After building, an operator can run `node dist/admin/collector.js` with the private
configuration in the [collector runbook](admin-collector.md). Collection is
separate from `npx usegrunt` setup and opens no listener. It preserves the daemon's
existing loopback port, Host and Origin protections. Chad remains on `8792`.

The collector normally sends a batch every 25 seconds plus up to five seconds of
jitter, with bounded retries and backoff. It reads cached source status,
persistent diagnostic events, safe maintenance/scout projections and numeric
system information. It accepts only the exact HTTPS ingestion path on the owned
API or existing Fly hostname. Private cursor state advances after acknowledgement;
replayed events are deduplicated. Backend receipt time, rather than a client clock,
determines whether an installation is stale or offline.

The projection excludes prompts, replies, code, working directories, raw errors,
provider response bodies, native stdout/stderr, cookies, credentials, account
metadata, vault references and signed browser links. Model/source labels describe
observed or configured identifiers, not independent physical-model attestation.
Scout evidence is restricted to safe status codes and the current candidate
commit's validated checkpoints; absent or stale proof cannot report a successful
release. No other user's installation is enrolled automatically.

## Use grunt as your harness's model

Run the separate local daemon on your own machine (Linux with systemd or macOS
with launchd). Use Node 22 or 24 LTS for the setup wizard; npm and tar must be
available. Squire also needs a usable browser/display path. A headless remote
server may need display helpers such as Xvfb/noVNC or a reachable browser
handoff. Missing prerequisites are reported for repair; provider verification
can still require a person. Mistral Vibe separately needs `uv` or Python 3.12+.
Setup installs the vetted adapters. Supported account flows use Trusty Squire,
and Nous uses Hermes's device login.

```sh
pnpm install --frozen-lockfile
pnpm build
node dist/local/main.js setup
# Published package: npx usegrunt setup; installed bin: usegrunt.
# Anonymous Kilo Particle only, after current sharing approval:
# GRUNT_SOURCES=kilo node dist/local/main.js
```

It binds only `127.0.0.1:8788`. `GRUNT_PORT` changes the port. It provides
`GET /v1/models`, `GET /v1/status`, Chat Completions, Anthropic Messages, and OpenAI Responses,
including SSE. Choose model `grunt` for automatic source selection, or a source
id such as `kilo`. This process is separate from the Fly server and Docker
entry point. Keep this endpoint on your own machine.

The local chat, messages and responses endpoints accept the request header
`X-Grunt-Context: public`. It enables Gödel Machines for that request through
model `grunt` or source `goedel`. Set it only when the full text and tool
payload can be retained, reviewed by staff and used for training, and contains
no secrets, confidential business information or other people’s personal data.

Automatic selection (`grunt`) sends requests containing function tools
only to sources that return tool calls to the caller's harness. Native API
sources forward function definitions; validated JSON bridges return correlated
calls for the caller's harness to execute. OpenCode runs its own delegate tools
and returns final text, so it receives only requests without function tools,
unless the caller names `opencode` explicitly. A task bound to OpenCode moves,
with a handoff, to a tool-capable source when the harness attaches tools. When
no tool-capable source is usable, grunt returns an error instead of a text-only
answer. grunt
extracts cwd from harness context (including environment
blocks), accepts an explicit absolute `cwd`, and otherwise uses the daemon's
working directory. It logs the chosen directory. Check it before asking for edits.
Text and function-tool turns are translated across APIs. Native Responses tools
require a compatible delegate; ordinary Chat Completions sources accept function
tools. Unsupported tools and media blocks return an
error rather than silently losing context.

### Subworkers

The installed daemon can run two subworker jobs at once while your main agent
coordinates the work. Jobs use the registered free model sources and prefer
separate idle sources. They wait when every eligible source is busy. Grunt
continues to honor provider consent, quotas and retry windows.

```bash
npx usegrunt workers run <<'JSON'
{"tasks":[
  {"activity":"review","task":"Review the pagination logic for edge cases","context":"Paste the relevant code or excerpt here"},
  {"activity":"tests","task":"Propose tests for the empty results state","context":"Paste the related test or API contract here"}
]}
JSON
npx usegrunt workers status
```

The command takes one or two tasks in a batch, with at most 8 KiB of instructions
and 32 KiB of context per task. The results are returned in submission order
with the provider that replied. Provide relevant excerpts and the file or
component each worker should own. Use the optional activity label `review`,
`tests`, `implementation`, or `research` to make it easier to follow in status.
The main agent reviews suggestions and applies edits using its existing tools
and permissions. Subworkers have no filesystem or shell tools. Task text and context go to the configured provider under the
same data-sharing terms as other Grunt requests.

Run `npx usegrunt workers connect <pi|opencode|codex|claude>` for the matching
tool setup. The MCP server for other compatible clients is
`usegrunt workers mcp` over stdio. In Pi and MCP, `grunt_delegate` returns a batch ID
immediately so the main agent can keep working. Retrieve the ordered results
with `grunt_worker_result` or stop the jobs with `grunt_worker_cancel`.
`grunt_worker_status` reads the daemon-wide status. Use `--port <port>` if your
daemon uses a different port from the one saved during setup.

A job has up to five minutes including queue time. If the daemon's 16 waiting
slots are full, callers receive a busy result. Disconnecting cancels outstanding
jobs. Worker status includes the current source and recent outcomes. Only
explicitly enrolled collectors send worker metadata to the owner dashboard.

### Source dashboard

`usegrunt status` prints one cached pool snapshot. `usegrunt status --watch`
opens a live terminal view; `--json` prints a single structured snapshot.
These commands only read the local daemon's `GET /v1/status`; they do not start
the daemon, run provider health checks, install services or consume inference.
An older daemon without that endpoint needs `npx usegrunt update`.
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

Port selection is `--port`, then `GRUNT_PORT`, then the private numeric
`installed-port.json` saved by successful setup, then 8788. Existing installations
on a custom port can pass `--port` until setup records it. For example, Chad uses
`usegrunt status --watch --port 8792`. Invalid saved configuration fails safely.

Setup shows one live table of tools and sources, then `Ready`, and exits.
It asks no questions and does not open the status dashboard. Run
`usegrunt status --watch` separately to open that view. Closing setup before
completion pauses unfinished signups; verified daemon routes remain usable.

`/v1/status` uses the same loopback Host/Origin restrictions as inference and
`Cache-Control: no-store`. Its version-1 JSON contains the snapshot timestamp,
active call count and per-source observations, including safe failure codes,
last success/timing and finite retry timestamps when known. Observations reset
when the daemon restarts, then rebuild from normal runtime activity.

### Persistent local diagnostics

The installed daemon separately retains safe diagnostic events across restarts
in `diagnostics.db` under its private configuration directory. The directory must
be owned and mode `0700`; the database must be owned and mode `0600`. Default
retention is thirty days, bounded to 50,000 events. Storage failure must not block
inference: diagnostic health exposes unavailable storage, queued writes and
dropped events instead of presenting incomplete history as complete.

| Method | Loopback route | Result |
| --- | --- | --- |
| GET | `/v1/diagnostics/events` | Oldest-first events; supports `after` cursor, `source`, `requestId` and `limit` (1–500). |
| GET | `/v1/diagnostics/summary` | Request/attempt and reported-usage totals, unknown-usage counts, storage health and stream identity; optional `since` timestamp in milliseconds. |
| GET | `/v1/diagnostics/traces/:id` | Retained events correlated to one request ID. |

These endpoints retain the daemon's loopback Host/Origin checks and return
`Cache-Control: no-store`. A collector can bind an acknowledged cursor to the
durable stream identity; replacing the database creates a new identity. These
routes are separate from `/admin/api/*` and do not accept owner or ingestion
credentials as a way to bypass loopback protections.

Local inference responses include `X-Grunt-Request-Id`, including rejected JSON
and content-type requests, so failures can be found in the journal. Logical
requests, individual provider attempts and transports have distinct events.
Trace metadata can show chosen source/model IDs, explicit source pinning,
fallbacks/skips, durations, actual observed HTTP status, bounded retry timing,
safe network error codes and available native exit status. Failed attempts can
also include an allowlisted validation or native stop reason. The journal
records no prompt, reply, code, request body, raw provider error, header value
or native output.
Source/model labels do not establish a physical-model attestation. Unknown token
usage stays absent and is counted separately from known zero usage.

### Daily maintenance

Daily maintenance is independent of registry downloads and onboarding. A private,
atomic `maintenance.json` retains each configured provider's last attempt,
completed check, safe outcome and next due time. One check runs at a time. After
it settles, the queue waits 60 seconds plus 0–30 seconds of random jitter before
starting another. Restarting does not replay the whole batch or bypass the quiet
gap. In-flight checks reserve a bounded startup window in case the daemon exits
before saving their result. Shutdown aborts its owned check and waits for actual
cleanup before releasing the queue.

A successful reply within the past 24 hours satisfies a check if no newer error
or cooldown has invalidated that evidence. Otherwise maintenance makes one
exact-source hello request with a 1,024-token output cap and a private empty
working directory. Normal sharing, free-model, plan and billing guards still
apply. A different provider cannot answer that probe through failover. Checks
consume free inference allowance when a fresh reply is needed; the output cap
does not cap native CLI input/context overhead.

Idle Clixad checks use its existing read-only local checks and public free-model
catalog instead of inference. Its native wallet command can claim the ordinary
daily streak bonus and remains reserved for explicit setup and user requests.
The maintenance result records `metadata` evidence, which does not establish a
fresh generated reply or clear an inference cooldown. A recent successful user
reply still satisfies its daily check as `reply` evidence.

Foreground-owned sources, current user requests and routing cooldowns defer the
check. An update pauses the queue while existing routes remain usable until the
runtime is ready to replace. Deferred work retries later without being counted
as healthy; provider retry delays are honored. A source that needs sign-in is reported for foreground
setup. Maintenance does not invoke provisioning, install tools, create accounts,
invalidate authentication receipts or launch browser repair. The setup wizard
retains its separate parallel first-ready flow. Source details and `--json`
expose cached maintenance timing/outcome/evidence without starting new checks.
Each source's optional `maintenance` object contains `nextCheckAt` and, when
known, `lastAttemptAt`, `lastCheckedAt`, `outcome`, `evidence` and a safe `code`.
Timestamps are milliseconds since the Unix epoch.

The queue starts automatically in every installed daemon running 0.6.9 or later;
it is per user and uses that user's configured providers, consent and accounts.
No separate cron job is required. New setup installs it with the daemon.
Existing users run `npx usegrunt update` to replace their saved background
runtime. The updater resolves the latest official npm release itself, verifies
the package integrity, prepares dependencies without install scripts, then
replaces the managed runtime and restarts the existing service. It preserves
service configuration, custom ports and sources, account grants, consent,
native authentication and `maintenance.json`. It does not invoke the signup
wizard. If startup verification fails, it restores the previous runtime. A
stopped Linux service remains stopped. On macOS, the existing launch agent must
be running before update; an unloaded or waiting job is rejected safely rather
than changed while it might restart itself. An older local CLI that lacks the command can
bootstrap with `npx usegrunt@latest update`.
A newer CLI or npm publication alone does not upgrade an older service.
Checks need the machine and daemon to be running; overdue work resumes after
downtime, with normal staggering and deferral rules.

### Free API and account setup

Since version 0.6.7, Grunt starts routing as soon as the first provider is
verified, while remaining signups continue.

`npx usegrunt` (or `npx usegrunt setup`) starts the terminal wizard. In a wide
interactive terminal it opens with a short animation (any key skips it; CI,
pipes and narrow terminals get a one-line title). After checking prerequisites,
setup pulls the free service list from the grunt registry, falling back to the
saved or bundled list silently. The bundled
vetted pool contains OpenCode, Kilo and Zro in the stable tier, plus
Token Harbor, Runcrate, Mistral Vibe Free, LiveKit, Pollinations, BeatAPI,
Clixad, Perch, Nous, Kenari, Numes and Gödel Machines in the experimental tier.
Free-account eligibility still applies.

The wizard enables free sources by default and connects every supported coding
tool it detects. It installs the persistent daemon once before provider jobs.
Providers still being prepared are excluded from normal routing and bulk
availability probes.

Up to six provider jobs run concurrently. When a setup job reports a provider
available, setup checks that exact provider with a real request through the
installed daemon; up to three reply checks run at once. A correctly attributed
reply is required to verify a route. While that check runs,
the provider stays out of automatic routing; an explicit request for its source
ID can run the verification probe. The first verified reply starts coding-tool configuration. Other provider jobs and checks continue, and later routes join
the same daemon without a restart. Each tool and source gets one status row in the setup table.

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

Jobs that use Squire share one connection, cached credential metadata and reusable
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
without a sharing question; it needs no account, API key or signup.
Squire handles supported verification automatically. An uncertain result with a
captured key proceeds to a local test request; missing or failing access is
skipped without a browser handoff or confirmation question. Existing accounts are reused; no extra
Google accounts are created.

Zro setup prefers Google login through Squire. Before connecting a new local grant, Squire confirms the Free plan, no paid subscription or purchased usage-pack balance, and no saved payment method. Existing vaulted keys are reused after that check. The private `zro.json` file records the check; repeat setup can reuse a healthy confirmed grant. Zro uses the same model ID for free and paid access, so an external account upgrade can change billing; grunt never upgrades the account.

Setup enables the free sources by default, including sources that may retain,
review or train on prompts. It records current provider policies in a private
receipt for the existing runtime guards, without printing disclosures or asking
for approval. Retired Freebuff and APInex records do not authorize routing.
Daily maintenance does not provision accounts; rerun setup to retry a skipped
source. Provider-specific data policies remain documented below and in
`src/local/data-sharing.ts`.


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
route. Setup records the current policy without asking, and existing runtime
guards continue checking the receipt.

CrowLLM is available as an optional local source through `npx usegrunt add crowllm`.
It is outside the default registry while context capacity and live tools remain
unverified. Setup reuses the person's Squire key and verifies the exact
`glm-5.3-flash:free` entry in CrowLLM's pricing API. Each dispatch checks token
validity and requires zero input, output and per-request price. A missing,
changed or unavailable price blocks inference. The source uses normal Grunt
cooldowns and fallback. The account's welcome credit is separate from this route.

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
| Nous | `qwen/qwen4-max:free` | Nous Portal Free plan and one Hermes device approval. Checks that the Free plan and zero-priced model are still available before sending an inference request. |
| Kenari | `ernie-5-5-flash-preview:free` | Free Google sign-in through Squire. Kenari lists 50 successful free-model requests per day and five requests per minute for new accounts. Limits are per account and can change. [Kenari free-model limits](https://kenari.id/en/docs/free-models) |
| Numes | `deepseek/deepseek-v4.1-flash:free`, `z-ai/glm-5.3-flash:free` | Free Google sign-in through Squire and a dedicated inference key with a $0 spending cap. Free capacity can vary, with no guaranteed fixed allowance. [Numes free routes](https://numes.ai/docs/models#free-models) |
| Gödel Machines | `deepseek/deepseek-v4.1-flash` | Current sharing approval and a dedicated Free Key through Squire. Grunt verifies the key's Free tier before inference. The free allowance is 600,000 uncached input tokens and 150,000 output tokens per day, renewing at midnight UTC. [Gödel free-tier terms](https://inference.goedelmachines.com/legal#free-tier) |

For Nous, approve its data policy in the grouped setup prompt and open the
Hermes device link on your phone or computer. Sign in or create the Free account
yourself, and approve inference access. Grunt uses an installed official Hermes
Agent or installs a pinned Hermes copy in its private configuration directory
using Git and uv. Other routes can become ready while you approve Nous.
Hermes keeps and refreshes its own OAuth credentials in a dedicated profile.
Grunt connects to the official subscription proxy over a private local socket.
Use `npx usegrunt add nous` to connect Nous separately or repeat device approval.
`GRUNT_HERMES_ROOT` selects an existing official Hermes installation by absolute
path. Grunt skips Nous if it cannot confirm the Free plan, zero paid balances,
and zero prices for the pinned model.

For Kenari, approve data sharing in the grouped setup prompt and complete
browser verification if Kenari asks. Squire reuses the dedicated Grunt Free
key scoped to `kenari.id`, or creates one when needed. Use
`npx usegrunt add kenari` to connect it separately or resume setup. Grunt
checks that the exact ERNIE route is still free and supports native tool calls.
When that route is rate-limited, automatic routing can continue on another
free source.

For Numes, approve data sharing in the grouped setup prompt and let Squire
connect your Google account. Use `npx usegrunt add numes` to connect it separately
or refresh setup to enable the DeepSeek disclosure. Grunt checks the key's $0
cap before each request. It prefers DeepSeek when the approved Amazee endpoint
is listed at zero cost and uses GLM when that endpoint is unavailable. Grunt
checks the returned model and $0 charge. On a rate limit, automatic routing can
continue on another free source.

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

BeatAPI setup uses the person's existing Google or GitHub account through
Squire and restricts the Grunt-owned key to the free DeepSeek V4.1 Flash and
GLM 5.3 Flash routes. Both accept native function definitions and correlated
tool results. With both routes verified, BeatAPI starts with DeepSeek and
alternates models after successful requests. An existing DeepSeek-only
verification still works. Run `npx usegrunt@latest add beatapi` to enable both
when GLM is available on the account.
Grunt checks nonbillable account metadata before and after inference. Settled
credits must remain zero and the wallet balance must match the verified zero or signup-credit
baseline. A changed balance stops routing for repair with `usegrunt add beatapi`.
Both models share one successful request per minute. Grunt can immediately use
another eligible source during BeatAPI's cooldown. Qualification observed
210,081 input tokens on DeepSeek and 201,679 on GLM. A small GLM tool call
took about 86 seconds.

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
perform the same signup and native eligibility checks.

Both native backends validate returned output and reported usage against a local
budget of at most 4,096 tokens, with bounded output bytes and a process lifetime
of at most 175 seconds. Neither CLI offers a hard upstream output-token cap:
generation and free-allowance use can exceed that local acceptance budget before
grunt rejects a completion.

Provider data policies: Token Harbor permits
retention, staff review and upstream training. Runcrate's upstream retention and
training guarantees are unestablished. Free Mistral Vibe prompts and code may be used
for improvement, with no established zero-retention guarantee.
For [BeatAPI](https://beatapi.io/privacy-policy), prompts may be retained for
operations and processed upstream. It states private content is not used for
training without separate notice and consent where required; upstream guarantees
remain unestablished. [Pollinations](https://pollinations.ai/privacy) sends context
through its OSAII community operator and Poe/Together processing, whose retention,
staff review and training guarantees are unestablished. Setup enables both by default and records the current policies.
[Clixad](https://clixad.io/privacy.html) sends prompts, code and tool results through
Clixad, OpenRouter and model providers. It records usage metadata and says content
is stored when an answer is rated. It excludes training/public-dataset endpoints
but does not require zero upstream retention. [Perch](https://www.perchai.app/privacy#starter-data-program)
processes task and tool context for service delivery, security, debugging and
metering even with the optional Data Program off. Retention, review limits and
zero-retention coverage have not been independently verified. Setup enables both by default and records their current policies.

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
Kenari keeps a private Squire grant in `kenari.json`. Its upstream key stays in
Squire with `kenari.id` as its only allowed host.
NVIDIA keeps its optional grant in the private `nvidia.json` file and calls the grant's
`/v1/chat/completions` endpoint directly. Its upstream key stays in Squire,
scoped to `integrate.api.nvidia.com`; no other backend can answer its requests.
API-provider keys stay in Squire; no provider reveal approval is requested.
Mistral Vibe, LiveKit, Clixad, Perch and Nous use native clients that own their
local credential exchanges and storage.
Groq uses its `/openai/v1` API path beneath the Squire grant root. Setup discovers
currently available chat models through that grant before registering one.
`usegrunt add https://host/api/v1` adds an OpenAI-compatible endpoint with a hidden key prompt and discovered model choice. `usegrunt add` prompts for a name or URL.
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

grunt state lives under `$GRUNT_CONFIG_DIR`, otherwise `$XDG_CONFIG_HOME/grunt` or
`~/.config/grunt` for new installs. Without an explicit setting or existing Grunt
directory, the compatibility path described above reuses the existing legacy
directory. Keep the selected directory across service restarts. Local router login
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
config directory. `GRUNT_FREELLMAPI_URL` chooses its numeric loopback address and
is saved in grunt's service configuration. The router's database is created under
umask `0077`. `GRUNT_ROUTER_RUNTIME=docker` retains the older Docker installer for
existing installations and offline regression checks.
The default Kilo Particle source calls the public gateway directly and does not
need this separate router service.

`GRUNT_SQUIRE_HOME` and `GRUNT_SQUIRE_XDG_CONFIG_HOME` select an existing Squire
home without relocating grunt state. `GRUNT_SETUP_NO_HUMAN=1` stops before Squire
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
TypeScript checks and a clean build; public GitHub Actions CI repeats the checks.
Ordinary npm and gateway releases remain manual; the authorized operator scout
can merge and publish qualified provider additions through its guarded pipeline.
See the [provider scouting guide](../ops/provider-scout/README.md). Public CI runs
the validation workflow; deployment/publication workflows remain separately
controlled. Gateway changes update the two existing file overlays described
under Deploy, not the image.

Explicit legacy FreeLLMAPI installations send calls to `http://127.0.0.1:3001/v1`, including
provider failover. There is no direct OpenRouter free API route. An already
configured install can provide `GRUNT_FREELLMAPI_KEY` in its process environment;
`GRUNT_FREELLMAPI_URL` accepts numeric HTTP loopback addresses only. The completion
cap is (4096) tokens. Select `freellmapi` for a previously configured legacy
chain; select `kilo` for the direct Particle 1 free source. Grunt-owned backend
rows require current sharing approval; custom backend rows retain their own flags
and priorities. Legacy requests reconcile owned rows from the existing private
admin file before forwarding and fail closed if that state cannot be checked.
The 0.6.6 migration retires Grunt-owned Auto, Nemotron and other non-Particle
rows labeled `Kilo Free` or `Grunt kilo (Squire)`, even when an older approval
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
`GRUNT_OPENCODE_URL` keeps its own MCP connections.

New conversations rotate across `deepseek-v4.1-flash-free`,
`glm-5.3-flash-free` and `big-pickle`. Follow-ups stay with their successful
model and session. A model that returns a quota error cools down while another
pool member is tried; the other Grunt sources remain available when the pool
is exhausted. Providers may share quotas across models, so this does not imply
three independent credit balances.

`GRUNT_OPENCODE_MODEL` overrides the pool with one explicit model.
Use a currently free model from your OpenCode catalog; grunt does not buy credits
or switch to paid models automatically. `GRUNT_OPENCODE_URL` optionally connects an existing
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
  "model": "grunt/grunt",
  "provider": {
    "grunt": {
      "name": "grunt",
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "http://127.0.0.1:8788/v1", "apiKey": "local" },
      "models": { "grunt": { "name": "grunt" } }
    }
  }
}
```

Then run `opencode -m grunt/grunt`. The [provider docs for this config format](https://docs.dev.opencode.ai/docs/providers/)
use `provider`, `npm`, and `options`. Newer native configs in the
[current docs](https://opencode.ai/docs/providers/) use `providers`,
`package: "@opencode/ai/providers/openai-compatible"`, and `settings` instead.

### pi

Add this provider to `~/.pi/agent/models.json` (tested with pi 0.99.1):

```json
{
  "providers": {
    "grunt": {
      "baseUrl": "http://127.0.0.1:8788/v1",
      "api": "openai-completions",
      "apiKey": "local",
      "models": [{
        "id": "grunt", "name": "grunt", "reasoning": false, "input": ["text"],
        "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
        "contextWindow": 128000, "maxTokens": 8192
      }]
    }
  }
}
```

Run `pi --provider grunt --model grunt`. See [pi's model configuration](https://pi.dev/docs/latest/models-configuration).

### Claude Code

Claude Code 2.1.319 uses the Anthropic endpoint:

```sh
ANTHROPIC_BASE_URL=http://127.0.0.1:8788 \
ANTHROPIC_AUTH_TOKEN=local \
claude --model grunt
```

See [Claude Code gateway configuration](https://code.claude.com/docs/en/llm-gateway).
The placeholder token satisfies the client; the loopback daemon does not require
a provider credential. Custom model metadata may produce a context-window warning.

### Codex

Add to your user `config.toml` (Responses API; tested with Codex 0.167.0):

```toml
model = "grunt"
model_provider = "grunt"

[model_providers.grunt]
name = "grunt"
base_url = "http://127.0.0.1:8788/v1"
wire_api = "responses"
```

Run `codex`. See the [official configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

### Codex source

Codex is opt-in. With the official `codex` CLI already signed in using ChatGPT,
set `GRUNT_SOURCES=codex,freellmapi,opencode,kilo` to enable it first. Enabling it
spends your Codex plan allowance, including the weekly limit. Without
`GRUNT_SOURCES`, grunt uses the bundled free pool and current data-sharing
approvals; it never launches Codex. With Codex enabled, select model `codex` to use only Codex.
API-key logins do not enable this source. Missing or signed-out Codex is omitted
from `/v1/models`; grunt continues through the free chain on usage limits.

grunt spawns `codex exec --json --sandbox workspace-write` in the request's working
directory. Codex can use its tools and edit files there. grunt never reads or
copies Codex login files, changes its config, or signs you in. Set
`GRUNT_CODEX_MODEL` to override your Codex default. Only the latest user text is
sent; follow-ups resume the saved thread, keyed by working directory and user
history. Session mappings last until grunt exits. Avoid pointing the delegated
Codex default back at grunt, which would create a routing loop.

### Sources and app sessions

The bundled registry has three stable adapters in relative proportions 6:8:5:
OpenCode at `0.25263157894736843`, Kilo at `0.3368421052631579`, and Zro at
`0.21052631578947367`. Stable weights total 0.8. Experimental sources share the
remaining 0.2 equally. All bundled adapters accept text input.
Kilo, Zro, Token Harbor, Runcrate, LiveKit, BeatAPI, Nous, Kenari, Numes and
Gödel Machines forward function tool definitions and return tool calls for the harness to execute.
Mistral Vibe uses a validated
text bridge for harness tool calls while its native tools remain disabled.
Pollinations, Clixad and Perch also use validated JSON tool bridges for their fixed routes. Providers
with data-sharing policies require current approval before they can be selected.
LiveKit's [inference data-retention policy](https://docs.livekit.io/agents/models/inference/)
states zero retention and no training by LiveKit or its underlying providers on
all plans; it does not add a policy to the existing approval group.
Pi remains the harness. Each new user turn starts a task keyed by the canonical
working directory and user history. Tool results and retries keep the same
adapter. No usage counters switch it ahead of quota exhaustion.

Every bundled free route and optional free route has a quota policy in
`src/local/quota-policy.ts`. Local `/v1/status` publishes it as `quotaPolicy`,
with scope for any documented numeric limits. The owner dashboard shows the
policy, its source, the current backoff, and any observed account window or
Vikey seller limits. Runcrate publishes a Monday refill, Perch a UTC calendar
month, LiveKit a calendar month and separate sliding minute limits, and Zro a
daily refill. Published cadences without an exact matching runtime exhaustion
signal are descriptive. A generic 429 can also mean congestion or a short
throttle.

A quota error switches immediately and bars that adapter until its reported
retry time, with a one-hour fallback when the adapter has no stronger evidence.
Token Harbor's account allowance API supplies the current window start and
reset. Grunt uses that reset when the weekly free allowance is exhausted, and
checks the allowance again at the reset before routing. Short request limits
still use the provider's Retry-After. Clixad retries at midnight UTC when its
wallet confirms the daily free allowance is exhausted. Kenari uses its
documented midnight reset when the response identifies daily exhaustion and
omits Retry-After. Nous and Vikey also consume documented reset metadata.
In registry routing, other upstream failures, timeouts and provider refusals
switch immediately and bar the adapter for fifteen minutes. A missing installation or expired login
bars it until a successful health check. Caller cancellation stops the chain.
When no eligible adapter remains, the API returns HTTP 429 and, when known,
the earliest Retry-After. Agent adapters return final text, so streaming headers
are sent after completion; quota failures retain their HTTP status.

On handoff, the next adapter receives the original task, working-tree status,
the diff against a task-start `git stash create` checkpoint, the previous
adapter's last four KB of output, and an instruction to continue without
restarting. The checkpoint creates no branch commit or stash entry. Outside a
git repository, only task text and output are sent. If the next adapter is
Gödel Machines, it receives the approved request payload without generated
handoff context.

The owner curates `registry/adapters.json` and publishes it manually using
authorized Fly access. Validate the registry, upload it atomically to the
gateway volume, and check `GET /v1/registry`. CI does not publish the registry.
Ordinary code deployments do not publish registry edits.
Before the first valid registry is published the endpoint returns HTTP 503. Published data
survives deploys and has an ETag. Stable weights total (0.8) and experimental
weights total (0.2) when both tiers are present. Unknown adapter identifiers
are ignored locally and cannot install new code.

The daemon synchronizes on startup and at midnight UTC with
If-None-Match. It tries `https://api.grunt.run/v1/registry` first and falls back
to `https://milo-gateway.fly.dev/v1/registry` if that default endpoint is
unreachable, invalid or older than the retained registry. An explicit
`GRUNT_REGISTRY_URL` is used on its own. It writes the valid registry and ETag atomically in a private
`registry.json` in its existing config directory. A gateway or cache failure
keeps the last good list, falling back to the packaged list on a fresh install.
The bundled publication is the minimum revision: older cached or remote lists
cannot hide providers shipped with that package. An existing publication
timestamp is immutable; changed entries require a strictly newer `published`
timestamp, including revocations. Identical same-time data may refresh the ETag.
Registry sync only refreshes the provider directory. A separate persistent queue
checks configured curated sources one at a time with 60–90-second gaps; it does
not run provisioning helpers. The foreground wizard still installs providers
with up to six concurrent jobs and a shared Squire connection. During that setup, a private session
lease owns all providers selected for that session, including providers already
verified. Daily maintenance defers those providers. Pending
providers are also excluded from normal routing and bulk availability checks.
Heartbeat expiry and owner-process liveness prevent a crashed setup console
from leaving a permanent exclusion; normal cleanup removes only that session's
lease. This foreground gate is separate from routine background preparation;
background checks do not themselves block an already-bound healthy route.
Removing a registry entry disables it without uninstalling its files. `GRUNT_CONFIG_DIR` and
`GRUNT_PORT` select the current config directory and port. `GRUNT_REGISTRY_URL` overrides the sync
endpoint for local development.

Explicit `GRUNT_SOURCES` configurations containing legacy sources such as Dots,
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

Choose **Allow** when ChatGPT opens grunt's connection page. It sends your browser to the local daemon, redeems a single-use ticket, and returns to ChatGPT. No command or typed code is needed. The dot receives server instructions to subscribe to `grunt.request` automatically and return answers with `grunt_submit_reply`.

Dots is off by default. Start grunt with an explicit source order that includes it:

```sh
GRUNT_SOURCES=dots,freellmapi,opencode,kilo usegrunt serve
```

The normal join flow targets the default daemon port (`8788`). The OAuth authorize URL can specify `grunt_port` when the daemon runs on another port. If grunt cannot be reached, or you approve on a phone, return to the Allow page and choose **Connect another computer**. Run the displayed fallback command, `usegrunt dots link <code>`, on the computer running grunt, then choose **Continue to ChatGPT** on that page. Codes and tickets are private, single-use, and expire within ten minutes. The fallback command reuses the same device secret as automatic pairing.

Select model `dots` for the dot only. Model `grunt` moves to the next source when the device is not paired, no live subscription exists, the dot reports an actual quota refusal, or no reply arrives before `GRUNT_DOTS_TIMEOUT_MS` (default `300000`, five minutes). Caller cancellation stops the chain. Without pairing, dots is absent from `/v1/models`. Without `dots` in `GRUNT_SOURCES`, normal requests and the local pairing route make no gateway calls. Replies that merely discuss usage limits are returned normally.

grunt stores its generated device secret in `dots.json` under `GRUNT_CONFIG_DIR`, otherwise `$XDG_CONFIG_HOME/grunt` or `~/.config/grunt`, with mode `0600`, and reuses it for later authorizations. It is a grunt relay secret, never an OpenAI token; do not share that file. Local pairing requires a navigation from the configured gateway and a ticket that gateway confirms was approved. It refuses arbitrary origins, return URLs, unapproved tickets, reused tickets and expired tickets.

The public relay runs at api.grunt.run using the gateway target in `fly.toml`. `/join` is the canonical OAuth MCP endpoint; `/mcp` is an alias. `GRUNT_DOTS_URL` overrides the relay origin for tests (HTTP only on loopback). Pair using that override: grunt will not forward an existing device secret to another origin. The gateway's `GRUNT_PUBLIC_URL` defaults to `https://api.grunt.run` and controls OAuth metadata. Deployment is separate from the public GitHub Actions CI workflow.

The relay sends a signed event containing only a request ID and fixed summary. The dot reads the conversation with `grunt_get_request`, then calls `grunt_submit_reply(requestId, text)` or `grunt_fail_request(requestId, reason)` (`quota` or `upstream`). Follow-ups carry earlier user and assistant turns. Prompt text is removed from SQLite when answered or expired; replies remain only until local acknowledgment or expiry. Text is never written to application logs. The relay temporarily stores conversation text and the dot receives it, so send only content you intend to share.

MCP Events is experimental. The live test checks whether the dot follows the server instructions and subscribes by itself. If it does not, say: “Subscribe to grunt's grunt.request event, answer each request in chat, and send the answer back with grunt_submit_reply.” Record the exact error if ChatGPT rejects a subscription. You can ask the dot manually to read a queued request while its subscription remains live. Whether event-triggered dot work counts against plan limits must be checked live; do not assume it is free. Every prompt asks for a chat answer without starting Codex or Work tasks, but this cannot guarantee the dot's behavior or usage accounting. Replies are text only; they cannot edit the local working directory or return local tool calls.

Disconnecting the connector revokes the grant and stops subscriptions when ChatGPT invokes the revocation endpoint. Otherwise subscriptions expire within a day; grunt cannot detect ChatGPT-only removal immediately.

References: [OpenAI MCP Events](https://developers.openai.com/plugins/build/mcp-events), [ChatGPT plugin connections](https://developers.openai.com/plugins/deploy/connect-chatgpt), and [dots availability and delegated tasks](https://learn.chatgpt.com/docs/dots).

## Optional local sources

Add `antseed-vikey,reflection-beam` to `GRUNT_OPT_IN_SOURCES` for a local daemon
whose provider-specific data-sharing approvals are recorded. Grunt appends
these sources to the configured chain. Each ID can also be selected directly.
The bundled automatic registry does not enroll these sources.

- `antseed-vikey` uses a dedicated Antseed buyer listening on loopback port
  8381 by default. Set `GRUNT_ANTSEED_VIKEY_PORT` for a different local port.
  Run the buyer with settlement and automatic sweeps disabled, zero input
  and output price caps, and the Vikey seller pinned. Grunt checks the seller's
  live zero-price offer and verifies its attribution and pricing on replies.
  Seller rolling token limits can reject long prompts despite the advertised
  context window.
- `reflection-beam` uses Kilo's anonymous `reflection/beam-free` route with
  no account key. Grunt checks the exact free catalog entry before inference
  and requires zero-cost usage on responses.
