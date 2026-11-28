# Grunt reference

Grunt uses `usegrunt`, the `grunt` model/provider ID, `GRUNT_*` settings and
`~/.config/grunt` for new installations.

## Compatibility with existing installations

Use `usegrunt` for setup and updates, `grunt` as the local model, and
`GRUNT_*` for environment settings. Setup and update migrate an earlier managed
daemon to the Grunt service identity and keep its private configuration directory.

## Continuous integration and static site

The public repository runs CI on standard GitHub-hosted Ubuntu runners. The
workflow runs lint, tests, build and the operator's offline verification suites.
It refuses to run while the repository is private and does not upload artifacts
or use Actions caches. Static site deployment and npm publication remain separate
from CI; their workflows are not enabled by turning CI on.

`site/` is served directly on Cloudflare Pages (`https://grunt.run`), including
`site/registry.json` (the published form of `registry/adapters.json`) and a `200`
rewrite from `/v1/registry` to `/registry.json`. There is no Grunt gateway
server, SQLite admin backend, custom web dashboard, Jev, billing, roster
service, worker tooling or monorepo.

## Use grunt as your harness's model

Run the separate local daemon on Linux with systemd, macOS with launchd, or
Windows with Task Scheduler. Use an up-to-date Node 22 or 24 LTS for the setup
wizard. Squire also needs a usable browser/display path. A headless remote
server may need display helpers such as Xvfb/noVNC. Missing prerequisites are
reported for repair. See the [signup verification rules](#free-api-and-account-setup).
Mistral Vibe separately needs `uv` or Python 3.12+.
Setup installs the vetted adapters. Supported account flows use Trusty Squire,
and Nous uses Hermes's device login.

```sh
pnpm install --frozen-lockfile
pnpm build
node dist/local/main.js setup
# Published package: npx usegrunt setup; installed bin: usegrunt.
# Anonymous Kilo free models only, after current sharing approval:
# GRUNT_SOURCES=kilo node dist/local/main.js
```

It binds only `127.0.0.1:8788`. `GRUNT_PORT` changes the port. It provides
`GET /v1/models`, `GET /v1/status`, Chat Completions, Anthropic Messages, and OpenAI Responses,
including SSE. Choose model `grunt` for automatic source selection, or a source
id such as `kilo`. Keep this endpoint on your own machine.

The local chat, messages and responses endpoints accept the request header
`X-Grunt-Context: public`. It enables eligible Gödel Machines and Free-Pi requests through
model `grunt` or their explicit source IDs, subject to each source's consent and
request restrictions. Setup automatically records Free-Pi’s current trace-sale policy.
Set it only when the full text and tool
payload can be retained, reviewed by staff and used for training, and contains
no secrets, confidential business information or other people’s personal data.

An image in a conversation (a user turn, a tool result such as a Read of a PNG, or
older history) no longer ends the conversation: no free source takes images, so the
local API replaces each image with a short text note and routes the request as text,
unless an eligible adapter lists image input
([details](router.md#2-score-back-off-retirement)).

Automatic selection (`grunt`) sends requests containing function tools
only to sources that return tool calls to the caller's harness. Native API
sources forward function definitions; validated JSON bridges return correlated
calls for the caller's harness to execute. Native sources are drawn first and a
JSON bridge (Mistral Vibe, Perch, Pollinations) only when none is eligible, see
[native tool sources first](router.md#2-score-back-off-retirement). A bridge tells the
model that every listed tool can be called in this reply, several at once, and that
the caller's harness runs them. It names no particular harness, and its call ids
keep their opaque `pi_` prefix. OpenCode runs its own delegate tools
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
error rather than silently losing context. A request on automatic selection
that carries a non-function tool (such as Codex's hosted `web_search`) fails at
once with HTTP 400 `invalid_request_error` naming the tool type. No source is
tried and none enters cooldown; disable the hosted tool in the client.

### Parallel work

Grunt provides no parallelism of its own; the harness does. Claude Code, Codex
and OpenCode run native subagents, and with the grunt files from setup (see the
[Claude Code](#claude-code), [Codex](#codex) and [opencode](#opencode) sections)
each subagent's model calls arrive as ordinary requests. Pi has no subagents.

- **Each subagent is its own task.** A task is keyed by the working directory
  and the user turns it holds, and a subagent starts from its own prompt, so
  Grunt draws a source for it by weight like any new task. Parallel subagents
  therefore spread across sources and run concurrently.
- **Stickiness.** A subagent stays on its source for its whole run, including
  tool results and retries, and moves, with a handoff, only when that source
  returns a 429, fails past tolerance or loses its login. Managed pools always
  route by weight and stay sticky. A source with no registry entry, such as
  explicitly enabled Codex, is a last resort: it runs only when named as a model
  or after every routed source fails.
- **Notifications.** Codex reports a finished subagent to its orchestrator as a
  `<subagent_notification>` user message and Claude Code as a
  `<task-notification>`. A message holding only such notices is not a new turn,
  so the orchestrator keeps its task and source (0.9.12 and later). The model
  still sees the notice; real text in the same message still starts a new task.
- **Quota.** Parallel subagents draw on free quota faster than one session, and
  each source's limits are unchanged. Grunt does not throttle them. The answer
  is more sources: the scout keeps adding them, and `npx usegrunt add` adds one.
  A source that hits its limit is barred until it clears and its tasks continue
  on the next source.
- **Hosted tools.** A request that carries a hosted tool such as Codex's
  `web_search` gets HTTP 400, so keep those tools disabled in the grunt profile.

### Subworkers (removed)

Grunt no longer provides its own parallelism: the proposal and tool-using
subworkers, the `/v1/workers/*` routes, `usegrunt workers ...`, the
`grunt_delegate`, `grunt_spawn`, `grunt_coordinate` and `grunt_worker_*` tools
and the Pi `--grunt-agent-workers` flag are gone. Claude Code, Codex and
OpenCode have native subagents, and they work through Grunt like any other
agent loop: each subagent's model calls are ordinary requests that Grunt routes
(a harness's own subagent notices keep the parent task on its source). Pi has no
equivalent, so Pi users no longer get parallel workers.

Compatibility for installed clients: every `/v1/workers` route answers HTTP 410
`{"ok":false,"code":"unavailable","error":{"type":"removed",...}}`, `usegrunt
workers ...` prints a removal notice and exits 1, and the Pi extension still
loads from `dist/local/worker-pi.js` and ignores `--grunt-agent-workers` and
`--grunt-worker-port`. `/v1/status` no longer includes `workers`. Artifacts a
retired daemon retained under `worker-retention/` and `workers/` in the config
directory are no longer managed or applied by Grunt; inspect or delete them by hand.

### Background jobs, checkpoints and Pi release tools (removed)

Grunt no longer provides Pi background command jobs or execution checkpoints:
the `grunt_job_*`, `grunt_checkpoint_*`, `grunt_verify_release*` and
`grunt_release_*` Pi tools, `usegrunt jobs ...` and the `GRUNT_JOBS_STATE_DIR` and
`GRUNT_CHECKPOINT_STATE_DIR` settings are gone. Pi is no longer a parallel or
agentic platform for Grunt. Claude Code, Codex and OpenCode have their own
background tasks and subagents, and they work through Grunt as ordinary routed
requests.

Compatibility for installed launch commands: the Pi extension at
`dist/local/execution-pi.js` (and `dist/local/worker-pi.js`) still loads and
accepts and ignores `--grunt-agent-workers`, `--grunt-worker-port`,
`--grunt-background-jobs`, `--grunt-checkpoints` and `--grunt-publication`, so an old
launch line does not fail; it registers no tools. `usegrunt jobs ...` prints a
removal notice and exits 1. State left under `~/.cache/grunt/jobs` and
`~/.cache/grunt/checkpoints` is no longer read; delete it by hand.

The operator-owned execution host (`usegrunt execution-host`) for required release
checks and publication, and its read-only channel manifest, are kept. It no longer
runs a reviewer: the builder records its own review of the exact verified commit
and tree with the new `review-record` channel request; see
[execution efficiency](efficiency.md).

### Source dashboard

`usegrunt status` prints one cached pool snapshot. `usegrunt status --watch`
opens a live terminal view; `--json` prints a single structured snapshot.
A plain snapshot ends with the same launch line for each coding tool that is
installed and has its grunt file. These commands read the local daemon's `GET /v1/status`; they do not start
the daemon or run provider health checks. A status read after setup releases
its session can trigger [background acquisition](router.md#3-slow-loop-hot-add-and-scout-mapping),
whose signup driver may consume inference.
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
running. `a` gives foreground-setup guidance. Narrow panes omit model and
timing columns. `NO_COLOR` disables color; labels and symbols still describe
every state. Piped output and dumb terminals print one snapshot without cursor
control sequences. `--watch --json` is rejected rather than emitting a mixed
interactive stream.

Port selection is `--port`, then `GRUNT_PORT`, then the private numeric
`installed-port.json` saved by successful setup, then 8788. Existing installations
on a custom port can pass `--port` until setup records it. For example, Chad uses
`usegrunt status --watch --port 8792`. Invalid saved configuration fails safely.

Setup uses a separate live table; see the [setup flow](#free-api-and-account-setup).
Run `usegrunt status --watch` separately to open the dashboard. Closing setup before
completion pauses unfinished signups; verified daemon routes remain usable.

`/v1/status` uses the same loopback Host/Origin restrictions as inference and
`Cache-Control: no-store`. Its version-1 JSON contains the snapshot timestamp,
top-level `poolState` (`idle`, `working`, `switching`, `transient_error`,
`provider_exhausted`, `globally_exhausted`) and `pool` summary, active call
count, and per-source observations including safe failure codes, `failureCause`,
HTTP status, last success/timing, and finite retry timestamps when known.
`checkedAgoSeconds` is the age of the last admission or reply evidence;
`routable` is true whenever the source is eligible to receive a request
(`ready`, `available`, or `answering`), while `probeFresh` is true only when
the cached admission check is still within the 30-second freshness window.
Neither field guarantees dispatch. Observations reset
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
| GET | `/v1/diagnostics/events` | Oldest-first events. Supports `after` cursor, `source`, `requestId` and `limit` (1–500). Pass `details=1` to include eligibility, failure detection, accepted output and validated account availability. |
| GET | `/v1/diagnostics/summary` | Request/attempt and reported-usage totals, unknown-usage counts, storage health and stream identity; optional `since` timestamp in milliseconds. |
| GET | `/v1/diagnostics/metrics` | Durable hourly aggregates independent of raw-event retention; optional `since`/`until` Unix milliseconds, aligned window, histograms, limits and ingestion/coverage health. |
| GET | `/v1/diagnostics/traces/:id` | Retained events correlated to one request ID. |

These endpoints retain the daemon's loopback Host/Origin checks and return
`Cache-Control: no-store`. Replacing the database creates a new stream identity.

`usegrunt efficiency metrics` reads the hourly endpoint. Its histogram percentiles
are bounds, and its whole-hour buckets are not exact arbitrary-window totals.
See [measurement commands and coverage limits](efficiency.md#retain-a-usable-beforeafter-baseline).
Older runtimes need activation of the updated package to expose this endpoint;
the [separate passive collector](passive-efficiency.md) can preserve their existing
events without a restart.

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

A successful `attempt.finish` can also carry content-free ending metadata, readable
per attempt from the events and trace routes: `finishReason` (the provider's
finish_reason mapped to `stop`, `length`, `tool_calls`, `content_filter`,
`function_call` or `other`; an unrecognised value is recorded as `other`, never as
the provider's text), `hadToolCalls` (whether the reply carried parsed tool calls)
and `reasoningTokens` (only when the provider reports it). Adapters that do not
report an ending record none. These fields stay in the local journal and are
never sent in telemetry. A reply from
Kilo, Reflection Beam or any adapter that reports an ending, whose finish_reason
says `tool_calls` or `function_call` but which holds no parsed call, is an invalid
sample (`response_tools`): the task continues on another source after a brief
cooldown. Kilo and Reflection Beam also ask once more first. A legitimate
text-only `stop` reply is unchanged, and reply text is never parsed or altered.

Openference reply diagnostics distinguish `stream_read` (transport read),
`stream_format` (invalid SSE framing), `stream_incomplete` (missing completion)
and `stream_cleanup` (reader cleanup). JSON, model, content and tool validation
retain their own fixed reasons without retaining stream contents or exception text. A reader-cancellation
cleanup failure does not discard an otherwise accepted reply or replace its original failure;
provider cooldowns, cancellation and fallback behavior remain unchanged.

Chat Completions clients requesting `stream_options.include_usage: true` receive
a final SSE usage chunk before `[DONE]`. It carries measured input/output totals
when both are reported and `null` when complete usage is unknown. Other chunk
usage fields are `null`; no inferred token count is substituted. Diagnostics
separate trusted client and worker actors where recorded, without backfilling
actor identities for older events.

### Daily maintenance

Daily maintenance is independent of registry downloads and onboarding. A private,
atomic `maintenance.json` retains each configured provider's last attempt,
completed check, safe outcome and next due time. One check runs at a time. After
it settles, the queue waits 60 seconds plus 0–30 seconds of random jitter before
starting another. Restarting does not replay the whole batch or bypass the quiet
gap. In-flight checks reserve a bounded startup window in case the daemon exits
before saving their result. Shutdown aborts its owned check and waits for actual
cleanup before releasing the queue.

Runtimes sharing a private configuration directory coordinate with a separate
`maintenance-lock.db` SQLite transaction, not the diagnostics database. A busy
sibling defers rather than overlapping checks; a process exit releases its lock.
The owner reloads current state before saving, retains other runtimes' provider
entries and preserves the shared quiet gap. Installed curated sources and
explicitly installed opt-ins are covered; disabled and custom sources are skipped.
The owner maintenance rollout is documented in the private operator repository.

A successful reply within the past 24 hours satisfies a check if no newer error
or cooldown has invalidated that evidence. Otherwise maintenance makes one
exact-source hello request with a 1,024-token output cap and a private empty
working directory. Normal sharing, free-model, plan and billing guards still
apply. A different provider cannot answer that probe through failover. Checks
consume free inference allowance when a fresh reply is needed; the output cap
does not cap native CLI input/context overhead.

Free-Pi's idle check uses its metadata-only health check, without creating a session
trace. Its idle check still requires current source-specific consent.
The maintenance result records `metadata` evidence, which does not establish a
fresh generated reply or clear an inference cooldown. A recent successful user
reply still satisfies its daily check as `reply` evidence.

Foreground-owned sources, current user requests and routing cooldowns defer the
check. An update pauses the queue while existing routes remain usable until the
runtime is ready to replace. Deferred work retries later without being counted
as healthy; provider retry delays are honored. A source that needs sign-in is reported for foreground
setup. Maintenance does not invoke provisioning, install tools, create accounts,
invalidate authentication receipts or launch browser repair. The setup wizard
has a [separate setup flow](#free-api-and-account-setup). Source details and `--json`
expose cached maintenance timing/outcome/evidence without starting new checks.
Each source's optional `maintenance` object contains `nextCheckAt` and, when
known, `lastAttemptAt`, `lastCheckedAt`, `outcome`, `evidence` and a safe `code`.
Timestamps are milliseconds since the Unix epoch.

The queue starts automatically in every installed daemon running 0.6.9 or later;
it is per user and uses that user's configured providers, consent and accounts.
No separate cron job is required. New setup installs it with the daemon.
Existing users run `npx usegrunt update` to replace their saved background
runtime. The updater resolves the latest official npm release itself, verifies
the package integrity, stages the daemon, then
replaces the managed runtime and restarts the existing service. It preserves
service configuration, custom ports and sources, account grants, consent,
native authentication and `maintenance.json`. It does not invoke the signup
wizard. If startup verification fails, it restores the previous runtime. A
stopped Linux service or Windows task remains stopped. On macOS, the existing launch agent must
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
Perch, Nous, Kenari, Numes, Gödel Machines, Darus, Aperture, Fikra,
Openference, Reflection Beam, 100milionseek and Free-Pi in the
experimental tier. Fikra and Openference are temporary offers with expiry guards.
Free-account eligibility still applies. Setup automatically records Free-Pi’s material policy. Free-Pi still requires
reviewed public context on every request.

The wizard enables free sources by default and connects the selected coding
tool. It installs the persistent daemon once before provider jobs.
Providers still being prepared are excluded from normal routing and bulk
availability probes.

The default wizard runs provider jobs one at a time; the legacy setup path can
run up to six concurrently. When a setup job reports a provider
available, setup checks that exact provider with a real request through the
installed daemon; up to three reply checks run at once. A correctly attributed
reply is required to verify a route. While that check runs,
the provider stays out of automatic routing; an explicit request for its source
ID can run the verification probe. Later routes join the same daemon without a
restart. Each tool and source gets one status row in the setup table.

Squire bootstrap is lazy and shared: account-dependent jobs reuse one connection
and one pending sign-in, while eligible anonymous Kilo or OpenCode access can
become usable before bootstrap starts. Their anonymous setup attempts are
prioritized rather than queued behind waiting account jobs. With a coding
harness, setup checks anonymous Kilo, then anonymous OpenCode, before any signup.
No cold-installation timing is promised: npm downloads, native packages and
browser/display prerequisites all affect it.

The default wizard stops foreground provider jobs once one route is verified
and a smoke test passes: one real completion through model `grunt`, routed by
the daemon as your own requests
are. It then finishes the selected coding-tool configuration and bootstraps
Squire for remaining account signups before returning. A bootstrap failure is
reported; those account signups still need a working Squire connection.
It prints `N ready; M more continue in the background (usegrunt status)`,
one plain `→ <tool> on grunt: <launch command>` line for each coding tool it
connected, and `Ready`, and returns. Rows it did not reach show `background`. Setup then
releases its session, and, when background acquisition is enabled, the daemon
starts its existing
[route acquisition pass](router.md#1-greedy-first-pass-driver-cap) for the
remaining signups; `usegrunt status` shows the route being signed up as
connecting. If a verified route never passes the smoke test, setup tries the
other providers and then fails. If none was verified, setup fails. For a
foreground daemon, run `usegrunt serve`.

Jobs that use Squire share one connection, cached credential metadata and reusable
grants. Up to three provider browser operations can run concurrently.
Interactive installers take turns owning the terminal; while the setup table
is live it reads keys in raw mode and ignores them (arrow keys no longer print
`^[OA` into it), and Ctrl+C still stops setup. Provider verification remains individual, and
Squire has no batch-grant API. Shared credentials do not create shared provider
accounts or bypass a provider's verification. Reusing one Google or GitHub
identity does not remove each provider's own sign-in and security requirements.

#### Local Grunt vault and direct HTTPS

Grunt can also store provider API keys locally in `vault.json` inside `configRoot()`
(`0700` directory, `0600` file, `O_NOFOLLOW`/`O_NONBLOCK`, owner UID check, atomic
temp-file writes) so adapters call each provider's pinned HTTPS origin directly from
the user's machine without routing prompts, source code or tool results through
`trusty-squire-api.fly.dev`.

- Manage stored keys with `usegrunt vault set <provider>` (reads the key from stdin
  or a hidden prompt, never from command arguments), `usegrunt vault list [--json]`
  (metadata only, never prints keys), `usegrunt vault export <provider>` (explicitly
  opts into Trusty Squire passkey export), and `usegrunt vault remove <provider>`.
- Environment overrides use `GRUNT_VAULT_<PROVIDER>_KEY` (for example
  `GRUNT_VAULT_BEATAPI_KEY`). Every local vault key and env override is strictly
  pinned to that provider's allowlisted HTTPS origin(s); optional
  `GRUNT_VAULT_<PROVIDER>_ORIGIN` values outside the allowlist are rejected.
- Trusty Squire remains the browser signup engine. In `@trusty-squire/mcp`,
  `operate_extract` writes captured keys directly into Squire's vault without
  returning plaintext, and raw key export (`fetch_credential`) requires an explicit
  human passkey approval. Default silent `npx usegrunt setup` never calls
  `fetch_credential` or blocks on passkey approval: it uses existing verified local
  vault keys or env overrides when present and Squire egress grants otherwise.
  Passkey-gated export into `vault.json` is strictly opt-in via
  `usegrunt vault export <provider>` (or explicit `exportToVault: true`).
- BeatAPI, Pollinations, Runcrate and Zro bind their free-account verification
  receipts to a SHA-256 fingerprint of the verified credential and never copy raw
  direct keys into provider receipt files. Direct Runcrate local-vault keys are
  verified against Runcrate's vault-pinned billing origin
  (`https://www.runcrate.ai/api/v1/billing/balance`, `auto-recharge`, and
  `payment-methods`, per Runcrate's OpenAPI 3.1 `ApiKeyAuth` spec) plus
  `https://api.runcrate.ai/v1/models` before writing a receipt; unverified vault
  keys are never certified and setup falls back cleanly to Squire. Squire-backed
  Runcrate egress grants (initial or refreshed) verify those same billing
  endpoints through Trusty Squire's `use_credential` proxy without exporting or
  forwarding the raw key, plus `/v1/models` on the egress grant, before writing
  a receipt or probing inference.
  Removing a key with `usegrunt vault remove <provider>` immediately revokes direct
  access, and replacing a key invalidates the prior vault receipt until fresh
  verification succeeds. Existing and refreshed Squire egress grants remain supported
  as a backwards-compatible fallback, and no key or token enters diagnostics, logs,
  terminal output or harness configs.

Setup helpers can cancel one provider without stopping other jobs or the shared
broker. A pending initial browser operation may finish before its owned tab can
be closed; cancelled providers do not continue.

Setup offers the coding tools it finds on PATH before provider jobs start
(an installed Pi is preselected; non-interactive runs connect an installed Pi
only). The default wizard configures its selected harness while preparing a
signup driver or after the smoke test passes; the legacy path applies its
choices after the first verified provider reply. If no
coding tool was initially installed, setup can offer newly available tools after
the provider batch finishes. Declining all tools that were already detected does
not trigger another picker. Each choice adds a
named **grunt** option and keeps your default model and provider:
Pi gets a `grunt` provider in `models.json`; Codex gets its own
`$CODEX_HOME/grunt.config.toml` for `codex --profile grunt` (`config.toml` is
not edited); OpenCode gets a `grunt` provider in `opencode.json` (pick it with
`/models`; an `opencode.jsonc` file is left alone) and a separate
`grunt.opencode.json`; Claude Code gets its own `grunt.settings.json` in
`$CLAUDE_CONFIG_DIR` (default `~/.claude`) and `settings.json` is not edited. A changed file is
first copied to `<file>.grunt-backup-<time>`. Each tool is reported connected
only after it answers one real request through grunt. Your defaults never
change; the grunt-owned files are how you opt a session, and its native
subagents, into grunt (see the harness sections below).

OpenCode first tries its free model without an account and requests sign-in only
if that model requires it. Kilo verifies its anonymous free model route
without a sharing question; it needs no account, API key or signup.
Squire handles supported verification automatically. A signup that requires the
person is skipped without a browser handoff or confirmation question.
Dropped signups include Squire's question, confidence and reason when available.
Provider refusals include Squire's refusal reason; stopped pages with no controls
also include the page's own message. These details are redacted before reporting;
secret-describing fragments may be omitted. Statuses clipped in the setup table
are printed in full below the final table.
Runcrate reports the actual setup failure instead of assuming a GitHub-age issue.
An uncertain result with a captured key proceeds to a local test request;
missing or failing access is skipped. Existing accounts are reused; no extra
Google accounts are created.

Zro, Token Harbor and Runcrate setup tries matching vaulted keys, newest entries
first, with one chat request per grant until one answers, without opening the
provider site. Failed candidates do not prevent trying the remaining keys;
cancellation stops selection. If none answers, Squire opens the site only when
no key is saved or all candidates were rejected with HTTP 401 or 403. An
inconclusive failure, such as a timeout or quota error, stops setup instead of
provisioning access. In the browser, Squire captures an existing key where the
site shows one and creates a key only otherwise. After capture, setup repeats
the vault selection. A newly written grant that does not answer is removed.

Zro setup prefers Google login through Squire. In the browser, Squire confirms
the Free plan, no paid subscription or purchased usage-pack balance, and no
saved payment method. The private `zro.json` file records the setup; repeat
setup can reuse a grant that still answers. Zro uses the same model ID for free
and paid access, so an external account upgrade can change billing; grunt never
upgrades the account.

Setup enables the free sources by default, including sources that may retain,
review or train on prompts. It records current provider policies in a private
receipt for the existing runtime guards without prompting, including material
terms such as Free-Pi’s trace sale, in interactive and unattended setup. Setup
refreshes changed policies and also records OpenCode’s policy for the CLI signup
driver when the registry omits its route. The daemon also renews, at start, any
saved approval whose provider policy has since changed, so an update does not
turn a route off, and logs `Data sharing on: ...` for the renewed providers.
The [route acquisition pass](router.md#1-greedy-first-pass-driver-cap) also records
current policies for candidate providers that have never been approved, including
explicit and material policies, before attempting setup. A receipt write failure
skips candidates that require sharing approval without stopping the pass.
`GRUNT_SETUP_NO_DATA_SHARING=1` keeps
sources with explicit or material policies off and revokes their saved receipts. Retired Freebuff and APInex records do not authorize routing.
Daily maintenance does not provision accounts; rerun setup to retry a skipped
source. Provider-specific data policies remain documented below and in
`src/local/data-sharing.ts`.

For Aperture, CrowLLM, Darus, Gödel, Kenari, 100milionseek, Numes, Fikra and
Openference, multiple matching vault entries are tried in order. Setup saves the
first grant that passes the provider's free-access check; a failed candidate
does not prevent checking the next, while cancellation stops selection.


Token Harbor uses `deepseek-v4.1-flash:free`; its weekly allowance is shared across its free models.

<a id="kilo-free-models"></a>

Kilo initially prefers `particle-ai/particle-1:free`, a distinct model
post-trained from DeepSeek V4.1 Flash, with a listed 1M-token context and native
function calls. It calls the public `https://ai-gateway.kilo.ai/api/v1` endpoint
without an account or API key. Before inference, grunt checks that the exact
catalog entry is free, has at least 200K context and supports tools and output
limits. It accepts only that exact returned model with zero reported inference
cost and valid correlated function calls. A fallback model cannot pass as Particle.
When a model returns HTTP 429, a server error (HTTP 5xx) or a reply naming a
different model, the Kilo source tries another verified free model from the
same live catalog: exact `:free` models and `reflection/beam-free` are eligible.
A timeout or any other failure does not move on. The initial order is Particle,
then Reflection Beam, then the rest in catalog order. Router aliases
such as `kilo-auto/free` and `openrouter/free` are never used. For a request
with function tools the rotation leaves out models with evidence against agentic
tool work: today only `liquid/lfm-3-1.7b:free`, a 1.73B-parameter model with an
8192-token output cap whose own model card advises against agentic coding. The
other nine free models stay, and text-only requests and the model list used for
availability checks are unchanged. If a tool request would have no model left the
whole rotation is used (`KILO_NOT_FOR_TOOL_WORK` in `src/local/kilo.ts`). The model that
answered last is tried first on the next request. When every listed model fails
this way, Kilo reports quota with the earliest reported refill only if every model
returned 429; otherwise it reports the last non-quota failure. The pool moves to
its next route. The separate Reflection Beam
route keeps its one model.
The [documented anonymous limit](https://kilo.ai/docs/gateway/models-and-providers)
is 200 requests per hour per IP, subject to upstream capacity. This is ongoing
rate-limited zero-cost access rather than a one-time credit balance.

Prompts, code and tool results pass through Kilo and the upstream serving the
selected model. Free models may train on prompts; retention, staff review and
training practices vary by upstream and are not established. Do not submit
personal or confidential data. The current Kilo policy in
`src/local/data-sharing.ts` covers every free model the source may rotate to.
It is an explicit policy: setup and the daemon accept it by default without a
prompt, and `GRUNT_SETUP_NO_DATA_SHARING=1` keeps Kilo off.
The receipt and renewal rules are described in
[free API and account setup](#free-api-and-account-setup).

CrowLLM is available as an optional local source through `npx usegrunt add crowllm`.
It is outside the default registry while context capacity and live tools remain
unverified. Setup reuses the person's Squire key and verifies the exact
`glm-5.3-flash:free` entry in CrowLLM's pricing API. Each dispatch checks token
validity and requires zero input, output and per-request price. A missing,
changed or unavailable price blocks inference. The source uses normal Grunt
cooldowns and fallback. The account's welcome credit is separate from this route.

### IFM K2 Horizon experimental source

IFM (MBZUAI's Institute of Foundation Models) serves `IFM/K2-Horizon-375B-A23B` at `https://api.ifm.ai/v1`, an
OpenAI-compatible API. Grunt ships an adapter for it as a local opt-in, not a registry entry: nothing enrolls it, it has
the same low routing weight as the other opt-in sources (0.01), and naming it (`npx usegrunt add ifm` or `GRUNT_OPT_IN_SOURCES=ifm`) is the only way to select it. Setup never
signs up. You create the account and one key yourself, store it in Trusty Squire as service `ifm`, label `Grunt Free`,
host `api.ifm.ai`, and Grunt connects it through a scoped grant.

What is established and what is not, as of November 25, 2026:

- Documented by IFM: a 524,288-token context, 10 million prompt plus completion tokens per key per day resetting at
  00:00 UTC, HTTP 429 with `Retry-After` past the cap, OpenAI-style function tools, and `reasoning_content` that must be
  replayed on later turns.
- Observed with a key the owner supplied, through the adapter and a Squire egress grant: a 200 reply with the exact
  model, a native tool call, a tool loop that accepted replayed reasoning, a needle plus tool call retrieved at 145,396
  prompt tokens (6.3 s wall) and a needle retrieved at 205,019 prompt tokens (10.5 s wall). Both large requests were
  routed to Cerebras. That clears the 200,000-token floor for the Cerebras route only: requests are also served by
  Nebius and AWS, and nothing above 4K tokens was sent to them, so a request routed there may behave differently.
  524,288 is IFM's catalog figure, not a tested claim.
- Unverified: price and whether the key stays free (IFM's docs never say; its platform and legal pages sit behind human
  verification and Grunt does not bypass it), terms for coding-agent use, retention, staff review and training. The only
  linked privacy policy covers MBZUAI website data. Live rate-limit headers disagree with the documentation: every route
  reports a request guard of 2 with a 1 s reset and a 30M-token counter that fell by about the tokens used (the
  documentation says 10M a day and calls it informational); only Cerebras-routed replies add -day, -hour and -minute
  counters (34.56B tokens a day), which describe that host's account, not this key, and are ignored. Reasoning counts
  against the output budget: a 6,000-token budget on a small coding task was spent entirely on reasoning and returned an
  empty length-limited reply, while the same task finished in 813 tokens on a retry, so give coding turns a generous budget.
- Quality is unproven. IFM's own Terminal-Bench 2.1 score for this model (70.2, or 66.9 after its reward-hacking audit)
  is below the vendor figures for DeepSeek V4.1 Flash and GLM 5.3 Flash, and no independent coding result was found.

The data-sharing policy uses material approval and says all of the above. It is marked manual: naming the source in
`usegrunt add ifm` does not record it, and neither does the setup default or a daily renewal. You approve the current
text yourself with `GRUNT_APPROVE_DATA_SHARING=ifm npx usegrunt add ifm`, and a changed policy needs that again. Until
then the adapter sends nothing, and approval for another source never carries over. Grunt sends only the exact model, spaces request starts to the observed guard of two per second (it queues the
rest briefly; untested above two in flight), passes your
output budget through without a cap of its own, stops on HTTP 402 or any reported charge, reads `Retry-After` and the
documented daily counter on 429 (a bare 429 gets a 30-second local back-off, not an inferred reset), reports a reply cut off by its budget as length-limited, and
replays each reply's reasoning verbatim on the matching assistant turn from process memory. History that another
source produced has no remembered reasoning, and IFM's gateway answers HTTP 422 to an assistant turn that has text and
no thinking field (checked on synthetic requests: a tool-call turn with empty text passes, a plain text turn fails, and
the refusal comes before any host is chosen). Every assistant turn therefore carries `reasoning_content`, the empty
string when nothing is remembered, which IFM documents as valid. Replies are streamed (`stream` with usage) purely for liveness and returned whole: a reasoning-heavy reply can think for
minutes and take about a minute at 125 tokens a second on one host (another host answered 15,561 tokens in 18 s), so a
non-streamed call was cut by the pool's 60-second first-output deadline. Each reasoning, answer or tool-call delta now
keeps the first-output (120 s) and idle (60 s) deadlines satisfied, and an answer that is only reasoning is a failed
sample. The reply must carry the exact model on every chunk, a finish reason, a closing marker and usage with no
charge. HTTP 400, 413 and 422 are request-shape refusals, not
provider health: no cooldown or retirement, and the task moves to another source. Tool schemas whose `required` names
the host's template cannot find in `properties` (for example when `allOf` supplies them) are sent without those names;
the model's calls are still checked against the original schema.

### Darus daily free source

Owner qualification on November 20, 2026 passed an attributed Grunt reply, a native function call and a cold request with 201,095 input tokens. This measures usable input on the tested route; its maximum context is not published.

Squire reuses an existing scoped Darus key or signs up one ordinary Free account.
The adapter pins `darus/deepseek-v4.1-flash-1017-FREE` and checks both the live
free-model catalog and `/v1/tpd` before every dispatch. The Free tier advertises
10 million provider-metered TPD tokens daily, 25 requests/minute and one
concurrent request. Its reset is 07:00 WIB, or 00:00 UTC. These are provider
accounting units, not a promise about physical model tokens or live capacity.

`Simpan Saldo` / Protect Balance must remain on. Grunt refuses missing, changed
or inconsistent entitlement metadata, checks a conservative remaining request
budget, and waits until the next UTC reset after daily exhaustion. It never
claims check-in or referral rewards, changes to a paid model, or continues
through a wallet. Unexpected model identity or a model-failover response header
is rejected. Retention, training and review guarantees remain unknown; see
`src/local/data-sharing.ts` for the source-specific disclosure. Grunt requests complete JSON responses,
as in the provider’s OpenAI SDK quickstart, with native function calls and usage.

[Darus API documentation](https://gateway.darusalfatah.id/dokumentasi).

### Aperture daily free source

Owner qualification on November 20, 2026 passed an attributed Grunt reply, a native function call and a cold request with 201,076 input tokens. The provider publishes request quotas, not a fixed daily token budget.

Aperture is pinned to `baidu/ernie-5.5-flash-preview:free`. Squire reuses the
user's scoped key or completes one ordinary Free account signup with sealed
email/password inputs. After login, the ordinary Dashboard control on
`/chat.html` exposes the key for direct vault capture. Squire must complete
any verification requested by the account.

Before every request Grunt verifies `valid: true` and `plan: free` at `/auth/me`,
then checks the exact model at `/api/v1/models` for zero prompt, completion and
other published prices, adequate context, tools and no expiry. It sends native
JSON function definitions to `/api/v1/chat/completions` and rejects a different
response model or malformed/truncated function arguments. There is no paid model
or BYOK fallback. Account and model metadata are bounded and never logged as
raw response bodies.

The published Free limits are 200 requests/day and 20/minute, resetting at
00:00 UTC. The named `daily_quota_exceeded` error uses an explicit reported
reset when present, otherwise the documented UTC cadence. Generic or upstream
429s retain their explicit retry signals and do not imply daily exhaustion.
Token-per-minute and concurrency limits are unpublished. Content passes through
Aperture, OpenRouter and the selected model provider; upstream retention,
review and training guarantees are unverified. The source-specific policy
belongs to Aperture independently of Kenari, which offers the same checkpoint.
See [Aperture's API documentation](https://www.aperture-ai.run/developers/docs.html)
and [privacy policy](https://www.aperture-ai.run/privacy.html).

## Temporary free sources

Fikra and Openference are included in automatic onboarding through Squire.
They passed real Grunt text replies, native function calls and cold-context tests
with 201,098 and 201,139 input tokens respectively. These are temporary free
promotions, admitted for their current windows rather than promised as recurring
allowances. `npx usegrunt add fikra` or `npx usegrunt add openference` can also
resume their setup on an existing installation.

Squire reuses service-scoped credentials named **Grunt Free**, including its
normal provider-domain host defaults. Grunt only sends requests to the fixed
API host or its Squire proxy. Setup records source-specific data-sharing approval,
uses configured verification tools, and skips the provider if an approval cannot
be completed. It never adds billing, paid plans or top-ups. Model restrictions,
when offered, should allow only the exact free alias; paid BYOK stays off.
See the [router guide](router.md#1-greedy-first-pass-driver-cap) for background
account acquisition controls. Grant files have mode 0600.

| Source | Exact model | Expiry and checks |
| --- | --- | --- |
| Fikra | `deepseek-v4-1-flash-economy-free` | Zero input/output price, at least 204,096 catalog context, a fresh active gate, and remaining shared dollar/token budgets before dispatch. The earlier live expiry wins; the gate reported November 23 UTC on November 20 despite the page saying November 25. A hard November 25 cutoff prevents extensions without review. Setup saves a grant only after this live check passes. |
| Openference | `DeepSeek-V4.1-Flash-1017-Free` | Exact free flag, zero prompt/output/cache prices and quota multiplier, native tools, at least 204,096 catalog context, and expiry after December 31, 2026 UTC. Upstream SSE supplies usage and native tool fragments. |

Fikra advertises 1,000 requests/minute and 100,000/day with no token cap on the
free alias; its shared promotion can close earlier. Openference does not publish
the numeric daily allowance. Its 429 reset metadata enters normal cooldown
tracking. Both use ordinary Grunt failover, including for intermittent upstream
errors observed during Openference qualification. Neither retries a paid model.

Openference's Free account is on-demand only. The exact free aliases never
consume subscription allowances or paid credits. This uses the on-demand path
required by its unattended-workload terms, at verified zero catalog rates,
with Grunt's own client identity. Subscription quotas and paid BYOK are not used.
Automatic selection and staggered maintenance can use both routes
while their guards pass.

Primary sources: [Fikra free offer](https://fikraapi.co.ke/free-deepseek-api),
[Fikra live gate](https://fikraapi.co.ke/free-deepseek-api/status.json),
[Openference free offer](https://openference.com/free-ai-api), and
[Openference terms](https://openference.com/terms-of-service).

The additional experimental routes have these requirements:

| Source | Selected route | Free-account requirements and allowance |
| --- | --- | --- |
| Runcrate | `deepseek-ai/DeepSeek-V4.1-Flash` | GitHub login with an account at least 30 days old; no paid balance, payment method or automatic top-ups. Its recurring weekly allowance is not quantified. |
| Mistral Vibe Free | Native CLI alias `zai-glm-5-3-flash`, wire model `zai-glm-5-3-flash-vibe-free` | Free plan with a $10 monthly Vibe Code allowance; no card, purchased credits or pay-as-you-go. This is native coding allowance, not ordinary Mistral API credit. |
| LiveKit | `deepseek-ai/deepseek-v4.1-flash` | Build plan at $0 per month, no card, and one free project. The documented $2.50 monthly included inference allowance resets at the start of each calendar month and has a hard stop; no paid fallback. |
| BeatAPI | `deepseek-v4.1-flash-free` | Personal Google login through Squire; no paid funds, card, subscription or automatic recharge. One successful request per minute. The ordinary one-time $2 welcome credit is separate from this continuous free route and is not spent by it. No numeric daily or token-per-minute limit is promised. |
| Pollinations | `community/morriszdweck/glm-5.3-flash-free` | Google login through Squire, a hard numeric zero-budget key with Quest Pollen Only enabled, usage-only account permissions, and a positive unused Quest balance. No paid funds or billing. Community availability is best effort, with no promised daily quota or fixed reset. |
| Perch | Native `deepseek-flash-starter` | Active Starter plan with 20,000 Perch Tokens per month and no surprise overages. Optional Starter Data Program, Use memory and Learn new memories must all be off. Keep the account on Starter. |
| Nous | `qwen/qwen4-max:free` | Nous Portal Free plan and one Hermes device approval. Checks that the Free plan and zero-priced model are still available before sending an inference request. |
| Kenari | `ernie-5-5-flash-preview:free` | Free Google sign-in through Squire. Kenari lists 50 successful free-model requests per day and five requests per minute for new accounts. Limits are per account and can change. [Kenari free-model limits](https://kenari.id/en/docs/free-models) |
| Numes | `deepseek/deepseek-v4.1-flash:free`, `z-ai/glm-5.3-flash:free` | Free Google sign-in through Squire and a dedicated inference key with a $0 spending cap. Free capacity can vary, with no guaranteed fixed allowance. [Numes free routes](https://numes.ai/docs/models#free-models) |
| Gödel Machines | `deepseek/deepseek-v4.1-flash` | Current sharing approval and a dedicated Free Key through Squire. Grunt verifies the key's Free tier before inference. The free allowance is 600,000 uncached input tokens and 150,000 output tokens per day, renewing at midnight UTC. [Gödel free-tier terms](https://inference.goedelmachines.com/legal#free-tier) |

For Nous, setup records its current data policy automatically. Squire handles
the Hermes device login without displaying its link or code. If it cannot
complete approval, Nous is skipped. A fresh login requires foreground setup;
background acquisition can only reuse a valid Hermes profile.
Grunt uses an installed official Hermes
Agent or installs a pinned Hermes copy in its private configuration directory
using Git and uv.
Hermes keeps and refreshes its own OAuth credentials in a dedicated profile.
Grunt connects to the official subscription proxy over a private local socket.
Use `npx usegrunt add nous` to connect Nous separately or repeat device approval.
`GRUNT_HERMES_ROOT` selects an existing official Hermes installation by absolute
path. Grunt skips Nous if it cannot confirm the Free plan, zero paid balances,
and zero prices for the pinned model.

For Kenari, setup records data sharing automatically. Squire handles supported
verification; see the [signup verification rules](#free-api-and-account-setup).
Squire reuses the dedicated Grunt Free
key scoped to `kenari.id`, or creates one when needed. Use
`npx usegrunt add kenari` to connect it separately or resume setup. Grunt
checks that the exact ERNIE route is still free and supports native tool calls.
When that route is rate-limited, automatic routing can continue on another
free source.

For Numes, setup records data sharing automatically. Let Squire
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
Verification receipts expire after 30 days. Failed BeatAPI setup preserves its
earlier receipt until fresh verification succeeds. Neither setup displays or
stores a plaintext provider key in grunt's files, harness configuration or logs.

Perch uses the pinned official `perchai-cli` `2.4.132`, a private native login and
the active Starter plan. A placeholder Starter label before activation is
insufficient; setup uses the ordinary free activation flow when needed. The
allowance is 20,000 Perch Tokens per month, in provider plan units, with no surprise
overages. Setup verifies the optional Starter Data Program is off and turns off
both Use memory and Learn new memories through official CLI settings, without
deleting saved notes. A 30-day receipt is bound to the native account identity;
routing freshly verifies that identity and both memory settings. A failed setup
preserves the earlier receipt; it does not bypass these routing checks. Keep Starter
active with the Data Program and both memory switches off.

The Perch backend pins `deepseek-flash-starter`, the official
`DeepSeek V4.1 Flash 1017 (Starter)` option and its corresponding DeepSeek model
identifier. These are aliases for the same provider-selected route, rather than
independent physical-model attestation. Each request uses a private, checked
context and a validated JSON tool bridge; native actions are denied. Owned
PTY/process cleanup runs on completion, cancellation and timeout. Perch
is a backend source: Pi, Codex, OpenCode and Claude Code remain the frontend choices.
Existing installations can run `usegrunt add perch` to
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
[Perch](https://www.perchai.app/privacy#starter-data-program)
processes task and tool context for service delivery, security, debugging and
metering even with the optional Data Program off. Retention, review limits and
zero-retention coverage have not been independently verified. Setup enables both by default and records their current policies.

NVIDIA remains an optional integration and is not in the bundled default pool while account verification is unvetted. Cloudflare Qwen is excluded from the pool by the owner's choice.

Before making changes, setup checks Node and the user service manager.
A missing prerequisite prints its install or repair step and stops.
Coding harnesses such as Pi are optional; setup can install the service before
you install a harness.

Vault reuse and browser capture follow the
[signup verification rules](#free-api-and-account-setup).
An incomplete or refused service is reported while other service jobs finish.
Zro, Token Harbor and Runcrate keep private grants in `zro.json`,
`tokenharbor.json` and `runcrate.json` and call
`/v1/chat/completions` directly. Their upstream keys stay in Squire, scoped to
`zro.moonmath.ai`, `tokenharbor.ai` and `api.runcrate.ai`.
Kenari keeps a private Squire grant in `kenari.json`. Its upstream key stays in
Squire with `kenari.id` as its first allowed host; additional hosts are accepted.
NVIDIA keeps its optional grant in the private `nvidia.json` file and calls the grant's
`/v1/chat/completions` endpoint directly. Its upstream key stays in Squire,
scoped to `integrate.api.nvidia.com`; no other backend can answer its requests.
API-provider keys stay in Squire; no provider reveal approval is requested.
Mistral Vibe, LiveKit, Perch and Nous use native clients that own their
local credential exchanges and storage.
Use `usegrunt add <provider>` to set up a supported provider. For example,
`usegrunt add kilo` checks the [anonymous Kilo free-model catalog](#kilo-free-models)
after current approval without creating an account or capturing a provider key.

If a provider answers a saved key with HTTP 403, or says the account is banned,
setup stops for that provider instead of signing up again. It records the refusal
in `refused-providers/<provider>.json` in Grunt's configuration directory, and the daemon
stops routing to that source. Setup starts no new signup for it until you run
`usegrunt add <provider> --force`, which clears the refusal and retries.

When the first account-dependent job needs Squire and no session exists, setup
runs Squire's own connect installer with the OpenCode target. Parallel jobs share
that pending bootstrap rather than starting duplicate installers. Its supported
child-only `OPENCODE_CONFIG` override points to the private
`squire-opencode.json` in Grunt's configuration directory, separating bootstrap
configuration from the user's coding-tool config and provider grant file. Squire manages
login and its broker service. An existing
session with an unavailable broker reports the connection error for repair.
Setup does not pair with Beeline or create agents or Rooms.

Grunt state lives under `GRUNT_CONFIG_DIR`, otherwise `$XDG_CONFIG_HOME/grunt`
or `~/.config/grunt` on Linux and macOS, and `%LOCALAPPDATA%\grunt` on Windows.
Upgrades keep existing managed state at
its original path. Keep the selected directory across service restarts.

Setup offers the bundled pool and records enabled providers in
`installed-sources.json`. It copies the daemon and registry to a runtime
outside the npx cache. On Linux, the `grunt.service` user unit
restarts after a crash. Setup attempts to enable lingering so the service starts
at boot and survives logout. If that fails, run `loginctl enable-linger` as the
installing user. On macOS, the `ai.grunt.service` LaunchAgent starts at login
and restarts after a crash. On Windows, a limited Scheduled Task starts the
daemon in the installing user's session at sign-in. When setup or update replaces an older service
identity, it carries forward the effective port and Linux unit overrides.

In the ready-first flow, providers join the installed runtime as their checks
finish. Setup preserves other Pi providers. `PI_CODING_AGENT_DIR` selects a
nondefault Pi agent directory.

`GRUNT_SQUIRE_HOME` and `GRUNT_SQUIRE_XDG_CONFIG_HOME` select an existing Squire
home without relocating grunt state. `GRUNT_SETUP_NO_HUMAN=1` stops before Squire
onboarding if its own sign-in would need the person.

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
The final 0.6.6 runtime on Chad returned correctly attributed replies through all
eleven automatic sources and rejected both retired source IDs. A subsequent
restart kept all eleven available without changing the saved access receipts or
opening verification handoffs. The release passed 954 local tests, lint,
TypeScript checks and a clean build; public GitHub Actions CI repeats the checks.
Ordinary npm releases remain manual; the authorized operator scout
can merge and publish qualified provider additions through its guarded pipeline.
The scouting guide lives in the private operator repository. Public CI runs
the validation workflow; publication workflows remain separately
controlled.

Kilo uses the direct [Particle free-model route](#kilo-free-models).
Particle was post-trained from DeepSeek V4.1 Flash. The standard DeepSeek V4.1
Flash and its 1017 variant were listed as paid in Kilo's catalogs during the
release checks. See [Kilo's free-model guidance](https://kilo.ai/docs/getting-started/using-kilo-for-free).

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
is exhausted. OpenCode's shared per-IP free-limit signal stops the request
immediately and cools down every model in the pool until its reported reset
(or one minute when no reset is reported). The pool does not provide independent
credit balances. CLI signup driver selection and failure handling follow the
[router rules](router.md#1-greedy-first-pass-driver-cap).

`GRUNT_OPENCODE_MODEL` overrides the pool with one explicit model.
Use a currently free model from your OpenCode catalog; grunt does not buy credits
or switch to paid models automatically. `GRUNT_OPENCODE_URL` optionally connects an existing
numeric loopback server. If it uses HTTP Basic auth, set
`OPENCODE_SERVER_USERNAME` and `OPENCODE_SERVER_PASSWORD` in grunt's environment.
Avoid configuring that OpenCode server to call grunt, which would create a loop.
See the [server API](https://opencode.ai/v1/docs/server/).

[OpenCode's free models](https://opencode.ai/docs/zen) may be free only for a
limited time, and some retain prompts for training. See the
[Kilo reference](#kilo-free-models) for its free-model data-sharing terms.
Do not send confidential data through these free routes.

### opencode

Tested with opencode 1.19.5 (Grunt's `opencode` source above is a different
thing: it drives OpenCode as a worker). Setup adds this provider to your
`opencode.json` without touching your default `model`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "grunt": {
      "name": "grunt",
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "http://127.0.0.1:8788/v1", "apiKey": "local" },
      "models": { "grunt": { "name": "grunt", "tool_call": true, "limit": { "context": 128000, "output": 8192 } } }
    }
  }
}
```

`tool_call` is required for agentic use. Pick it with `/models`, or run
`opencode -m grunt/grunt`. To use grunt for the whole session including
subagents, add the model lines below, or let setup's `grunt.opencode.json`
(next to your `opencode.json`) do it per launch:

```json
{ "model": "grunt/grunt", "small_model": "grunt/grunt" }
```

```sh
OPENCODE_CONFIG=~/.config/opencode/grunt.opencode.json opencode
```

OpenCode merges that file over your normal configuration, so the defaults
return when you launch without it. Subagents started with the `task` tool
inherit the session model, and `small_model` covers titles and summaries.
A project `opencode.json` still overrides both. The [provider docs for this config format](https://docs.dev.opencode.ai/docs/providers/)
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
        "contextWindow": 65536, "maxTokens": 65536
      }]
    }
  }
}
```

Run `pi --provider grunt --model grunt`. Pi stays supported as a single-agent
harness: it has no native subagents and Grunt no longer adds workers, so it runs
one session at a time (see [parallel work](#parallel-work)). See [pi's model configuration](https://pi.dev/docs/latest/models-configuration).

The managed Pi profile uses a 65,536-token working context to compact conversation
history earlier and reduce repeated input. This local setting does not reduce a
provider's native context capacity or change the provider qualification floor.
Setup and update refresh the output budget on Grunt-managed profiles. Update
matches the daemon's loopback endpoint. The working-context migration still
targets the former 128,000 setting and preserves user-adjusted contexts. For an explicit managed setup/update,
`GRUNT_WORKING_CONTEXT_TOKENS` accepts integers from 65,536 to 200,000.

### Claude Code

Tested with Claude Code 2.1.331. Setup writes `~/.claude/grunt.settings.json`
(or under `$CLAUDE_CONFIG_DIR`), which Claude Code layers over your own settings
when you pass `--settings`; your `settings.json` is never edited:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8788",
    "ANTHROPIC_AUTH_TOKEN": "local",
    "ANTHROPIC_API_KEY": "",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "grunt",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "grunt",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "grunt",
    "CLAUDE_CODE_SUBAGENT_MODEL": "grunt"
  }
}
```

```sh
claude --settings ~/.claude/grunt.settings.json --model grunt
```

The four model variables make every alias a subagent might request (`sonnet`,
`haiku`, `opus`, or an agent's own setting) resolve to `grunt`, so the `Agent`
tool's subagents run on grunt. Without them a subagent asks for a Claude model
grunt does not serve. Launch without `--settings` and Claude Code is unchanged.
The same variables work exported in your shell (also `unset ANTHROPIC_API_KEY`).

If your shell exports `ANTHROPIC_API_KEY`, Claude Code does not prefer it over
`ANTHROPIC_AUTH_TOKEN`; it sends both, so your real key would arrive at grunt as
`x-api-key` beside `Authorization: Bearer local`, and an interactive session
asks whether to use the key. The empty `ANTHROPIC_API_KEY` in the profile
overrides the shell and any value in your own `settings.json`, so only the
placeholder token is sent and the prompt does not appear (checked against
Claude Code 2.1.331). Setup rewrites an older profile to add it. Grunt never
reads `Authorization` or `x-api-key` on `/v1/messages`, so a key that did
arrive would not be forwarded, stored or logged. The placeholder token satisfies
the client; the loopback daemon does not require a provider credential. Claude Code
prints a harmless `[claude-code:unrecognized_model]` warning for the custom model.
See [Claude Code gateway configuration](https://code.claude.com/docs/en/llm-gateway).

### Codex

Tested with Codex 0.170.0. Setup writes `$CODEX_HOME/grunt.config.toml` (default
`~/.codex`); your `config.toml` is not edited. Run `codex --profile grunt`:

```toml
model = "grunt"
model_provider = "grunt"
web_search = "disabled"

[model_providers.grunt]
name = "grunt"
base_url = "http://127.0.0.1:8788/v1"
wire_api = "responses"
```

`web_search = "disabled"` is required: Codex's hosted `web_search` tool is not
supported through grunt, and the daemon rejects a request that includes it with
400. Codex's native subagents (`spawn_agent` and its companions) are on by
default and inherit the session's model, so the profile puts them on grunt too.
Codex resends the full history each turn (no `previous_response_id`). `codex exec`
needs stdin redirected, for example `</dev/null`. The same lines work in your
user `config.toml` if you want grunt as the default. See the
[official configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

### Codex source

Codex is opt-in. With the official `codex` CLI already signed in using ChatGPT,
set `GRUNT_SOURCES=codex,opencode,kilo` to enable it first. Enabling it
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
Kilo, Zro, Token Harbor, Runcrate, LiveKit, BeatAPI, Nous, Kenari, Numes,
Gödel Machines, Darus, Aperture, Fikra, Openference, Reflection Beam,
100milionseek and Free-Pi forward function tool definitions and return
tool calls for the harness to execute.
Mistral Vibe uses a validated
text bridge for harness tool calls while its native tools remain disabled.
Pollinations and Perch also use validated JSON tool bridges for their fixed routes. Providers
with data-sharing policies require current approval before they can be selected.
LiveKit's [inference data-retention policy](https://docs.livekit.io/agents/models/inference/)
states zero retention and no training by LiveKit or its underlying providers on
all plans; it does not add a policy to the existing approval group.
Each new user turn starts a task keyed by the canonical
working directory and user history. Tool results, retries and harness subagent
completion notices (`<subagent_notification>` from Codex, `<task-notification>`
from Claude Code) keep the same adapter; the model still sees the notice, but a
message holding only notices is not a new turn. No usage counters switch it ahead of quota exhaustion.

Source admission uses bounded concurrent availability probes with a five-second
default deadline. Zro instead makes a real chat request with a thirty-second
deadline, because its models endpoint still answers for paused keys. Admission
cancellation also cancels that request. Eligibility caches last thirty seconds
for positive observations, five for negative observations.
A warm eligible source can dispatch without waiting for unrelated slow probes.
These cached observations do not authorize billing or data sharing: the selected
adapter still performs its current consent, account, model and free-access checks
before sending a request. Public status and maintenance preserve their own
observation semantics; a cached eligibility check is not a generated reply.

Every bundled free route and optional free route has a quota policy in
`src/local/quota-policy.ts`. Local `/v1/status` publishes it as `quotaPolicy`,
with scope for any documented numeric limits. Runcrate publishes a Monday refill, Perch a UTC calendar
month, LiveKit a calendar month and separate sliding minute limits, and Zro a
daily refill. Published cadences without an exact matching runtime exhaustion
signal are descriptive. A generic 429 can also mean congestion or a short
throttle.

A quota error switches immediately and bars that adapter until its reported
retry time, with a one-hour fallback when the adapter has no stronger evidence.
Token Harbor's account allowance API supplies the current window start and
reset. Grunt uses that reset when the weekly free allowance is exhausted, and
checks the allowance again at the reset before routing. Short request limits
still use the provider's Retry-After. Kenari uses its
documented midnight reset when the response identifies daily exhaustion and
omits Retry-After. Nous and Vikey also consume documented reset metadata.
In registry routing, other upstream failures, timeouts and provider refusals
switch immediately under the [router back-off and retirement policy](router.md#2-score-back-off-retirement).
Caller cancellation stops the chain.
When no eligible adapter remains, the API distinguishes short transient waits
from hard global exhaustion: if a route will recover within 60 seconds (or
`IMAGE_WAIT_SECONDS` for an image request), the API returns HTTP 429 with
`Retry-After` and `X-Grunt-Pool-State: transient_error`; otherwise it fails
fast with HTTP 402, `x-should-retry: false`, no `Retry-After`,
`X-Grunt-Pool-State: globally_exhausted`, and `error.code: "globally_exhausted"`
so coding harnesses stop spinning and show the cause to the user. Agent
adapters return final text, so streaming headers are sent after completion;
quota and exhaustion failures retain their HTTP status.

On handoff, the next adapter receives the original task, working-tree status,
the diff against a task-start `git stash create` checkpoint, the previous
adapter's last four KB of output, and an instruction to continue without
restarting. The checkpoint creates no branch commit or stash entry. Outside a
git repository, only task text and output are sent. If the next adapter is
Gödel Machines, it receives the approved request payload without generated
handoff context.

The static registry is maintained in `registry/adapters.json`. Its published
form goes to `site/registry.json` (and the npm package's `dist/registry/adapters.json`):
an adapter whose `expires` day has passed is left out, and the rest of its tier is
scaled to keep the tier weight. `tsx src/registry.ts registry/adapters.json --publish site/registry.json`
writes it. Cloudflare Pages serves it directly at
`https://grunt.run/registry.json` (with `/v1/registry` rewritten to
`/registry.json` as HTTP `200`). A shipped adapter id, an entry whose `install`
is `declarative:openai` (with a strictly validated `declarative`
OpenAI-compatible config), or an entry whose `install` is `npm:<package>`, goes
in `adapters`; any other id goes in a top-level `candidates` list of providers
awaiting an adapter, which every client ignores. Declarative entries carry
public HTTPS origins only (never IP literals, loopback, link-local, or private
hosts, with public resolved IP enforcement at connection time), pinned free
models, signup URLs and hints, required `expires` cutoffs, zero-price
verification settings, and versioned data-sharing disclosures, so running
daemons hot-add and route new ephemeral free API promos on the next sync
without a code release (see [router](router.md#3-slow-loop-hot-add-and-scout-mapping)).
`validateRegistry` checks the entire document. Stable weights total (0.8) and
experimental weights total (0.2) when both tiers are present. Unknown adapter
identifiers are ignored locally and cannot install new code.
`registry/adapters.json` is the list bundled with each release, and daemons send
[usage telemetry](router.md#4-usage-telemetry) directly to US PostHog.

The daemon synchronizes on startup and on the
[router loop schedule](router.md#3-slow-loop-hot-add-and-scout-mapping) with
If-None-Match. It tries `https://grunt.run/registry.json` first and falls back
to `https://raw.githubusercontent.com/bananaman614305/grunt/main/registry/adapters.json`
if that default endpoint is unreachable, invalid or older than the retained
registry. An explicit `GRUNT_REGISTRY_URL` is used on its own. It writes the
valid registry and ETag atomically in a private `registry.json` in its existing
config directory. A fetch or cache failure keeps the last good list, falling back
to the packaged list on a fresh install.
The bundled publication is the minimum revision: older cached or remote lists
cannot hide providers shipped with that package. An existing publication
timestamp is immutable; changed entries require a strictly newer `published`
timestamp, including revocations. Identical same-time data may refresh the ETag.
Each sync triggers the [route acquisition pass](router.md#1-greedy-first-pass-driver-cap).
Access checks run independently through [daily maintenance](#daily-maintenance).
The foreground wizard still installs providers
with up to six concurrent jobs and a shared Squire connection. During that setup, a private session
lease owns all providers selected for that session, including providers already
verified. Daily maintenance defers those providers. Pending
providers are also excluded from normal routing and bulk availability checks.
Heartbeat expiry and owner-process liveness prevent a crashed setup console
from leaving a permanent exclusion; normal cleanup removes only that session's
lease. This foreground gate is separate from routine background preparation;
background checks do not themselves block an already-bound healthy route.
Removing a registry entry disables it without uninstalling its files. `GRUNT_CONFIG_DIR` and
`GRUNT_PORT` select the current config directory and port. `GRUNT_REGISTRY_URL` overrides the registry sync endpoint for local development.

An explicit `GRUNT_SOURCES` list that includes Codex keeps its configured order.
Codex requires opt-in and is outside the curated registry. When an existing
automatic pool includes Codex, the routed sources retain weighted, sticky
routing. Select model `codex` to use it directly. Model `grunt` tries it after
every routed source fails.

### Retired sources

Freebuff and APInex cannot be selected or routed through grunt in 0.6.6. Saved
source selections and environment values are filtered, old consent receipts do
not reactivate them. The person's native Freebuff application and account
are preserved. The prior DeepSeek-selection experiment received an explicit
relaying-policy refusal; no pin shipped.

APInex changed its recurring 25-million-unit daily entitlement to require a $5
top-up. Grunt does not make that purchase; a one-time Telegram reward does not
qualify as ongoing free access. Historical Freebuff bridge experiments and their
limitations remain in [the recorded evidence](../proof/freebuff-json-bridge.md),
not as supported routing instructions for this release.

## Curated sources and explicit selections

The same curated registry applies to every Grunt installation. Reflection Beam
is included in ordinary onboarding. It uses Kilo's anonymous
`reflection/beam-free` route without an account key, with its own current
data-sharing receipt. Grunt checks the exact free catalog entry before inference
and requires zero-cost usage on replies. An unavailable source is skipped while
other sources continue. Adding a source never shares another user's account or
grants access to paid quota.

`millionseek` connects [100milionseek](https://100milionseek.top) through Squire
and pins `deepseek-v4.1-flash-free`. The adapter verifies the permanent combined
100-million-token daily entitlement independently of temporary bonuses, with a
00:00 UTC reset and five concurrent sessions. Its live qualification passed a
Grunt-attributed hello, native function call and exactly 198,000 input tokens;
that input limit is the approved exception to the ordinary 200,000-token floor.
Use `npx usegrunt add millionseek` to connect it separately. Signup pauses and
rate limits are honored; Grunt does not redeem reset vouchers or create accounts
to bypass limits. The relay's stated privacy protections do not establish its
unnamed upstream's retention or training practices.

The provider is often congested (time to first token p50 about 11 s, p95 about
48 s), so the adapter requests a streamed reply, with `stream_options.include_usage`,
purely for liveness; Grunt still returns one whole reply. First output must arrive
within 90 seconds and the stream may then stay silent for at most 45 seconds
(headers, role-only events and keepalive comments are not output); a stalled
request fails over early, a slow but steady one is left alone. The whole call is
bounded at 5 minutes. A stream without a usage block is accepted with unknown
token counts, a usage block is checked as before, and a provider that answers
with a single JSON body is parsed as before. The `/api/status` and `/v1/models`
entitlement check is reused for 60 seconds and discarded by any failed
completion. Slow upstream failures (HTTP 502, 503, 504 or 524, a connection
reset, a cut stream, or a missed output deadline) bench the route for 30
minutes, doubling per consecutive one to 2 hours; a success resets the count and
a provider Retry-After wins. Retirement is unchanged.

`freepi` pins `deepseek-v4.1-flash` and verifies the observed upstream model.
Use `npx usegrunt add freepi` for its GitHub device signup; setup automatically
records the current material trace-sale policy. Every inference additionally requires
`X-Grunt-Context: public`; handoff and image requests are excluded.
Ordinary Pi sessions do not add that header. All spendable wallets must be zero
before and after inference, and the exact current free offer must remain valid.
Synthetic qualification passed tools, 201,074 input tokens and actual Grunt
attribution; it did not authorize submitting game or private-project content.
See the [Free-Pi guide](providers/freepi.md) for account-dependent allowances,
trace-sale terms and the limits of non-atomic wallet checks.

Standard setup records a private `automatic-pool.json` receipt anchored to the
managed service's existing source list. An ordinary update migrates a verified
managed installation only when its private setup manifest matches that list.
The daemon then considers newly curated sources even when the service file still
contains an older list. Explicitly added supported sources are retained in a
separate selection list. Those additions do not promote an experimental source into the curated registry.
Provider signup and current provider-specific consent
remain required; this receipt records source selection, not account access.
Manual daemons and explicit source overrides that differ from the anchor keep
their selected list. Malformed, shared, unowned or symlinked receipts never
expand it.

Antseed Vikey remains an explicit experimental source while usable long-input
qualification is incomplete. `npx usegrunt add antseed-vikey` installs its pinned
private buyer on Linux x64 with glibc, Node22/24 and user systemd; unsupported
platforms skip it while other sources remain usable. Existing different buyer
units and occupied ports are preserved. See [buyer provisioning](antseed-vikey-provisioning.md).
`GRUNT_OPT_IN_SOURCES=antseed-vikey` also remains supported for a daemon whose
buyer and provider-specific approval are already present.

- `antseed-vikey` uses a dedicated Antseed buyer listening on loopback port
  8381 by default. Set `GRUNT_ANTSEED_VIKEY_PORT` for a different local port.
  Run the buyer with settlement and automatic sweeps disabled, zero input
  and output price caps, and the Vikey seller pinned. Grunt checks the seller's
  live zero-price offer and verifies its attribution and pricing on replies.
  Seller rolling token limits can reject long prompts despite the advertised
  context window.
