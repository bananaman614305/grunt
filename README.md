<h1 align="center">grunt</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/usegrunt"><img alt="npm version" src="https://img.shields.io/npm/v/usegrunt"></a>
  <a href="https://www.npmjs.com/package/usegrunt"><img alt="node" src="https://img.shields.io/node/v/usegrunt"></a>
  <a href="https://www.npmjs.com/package/usegrunt"><img alt="downloads" src="https://img.shields.io/npm/dm/usegrunt"></a>
</p>

<p align="center"><strong>Free AI inference, pooled on your machine.</strong></p>

```bash
npx usegrunt
```

usegrunt installs grunt on this machine. It pools free AI quota and serves it as a local model endpoint. Your coding harness keeps the agent loop, tools and parallelism; grunt supplies the free model.

## Use it with a harness

Recommended: Claude Code, Codex and OpenCode. Each has native subagents, and
they run through grunt in parallel. Setup writes a grunt-owned file for each one
it finds, and you opt a session in by launching with it:

```bash
claude --settings ~/.claude/grunt.settings.json --model grunt
codex --profile grunt
OPENCODE_CONFIG=~/.config/opencode/grunt.opencode.json opencode
```

Setup prints the launch line for each tool it connected, using your real paths
(`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `XDG_CONFIG_HOME`), and `usegrunt status`
repeats them. Launch any of them without those options and nothing changes: your own
settings, defaults and models are never edited. Claude Code works without a
paid subscription when it points at grunt, and an exported `ANTHROPIC_API_KEY`
is ignored there, so your real key is never sent to grunt. Codex runs with `web_search`
disabled, because grunt returns 400 for hosted tools.

Pi stays supported as a single-agent harness (`pi --provider grunt --model grunt`);
it has no subagents, so it has no parallelism. See the
[harness reference](docs/reference.md#claude-code) for each file's contents and
[parallel work](#parallel-work) for how subagents are routed.

Use Node 22 or 24 LTS on Linux with systemd or macOS with launchd. Setup needs npm and tar; browser sign-in also needs a working browser/display path, especially on a headless server. Mistral Vibe needs `uv` or Python 3.12 or later.

Setup plays the miner animation, connects your coding tools,
shows one live table of tools and sources, and ends with `Ready`. Setup accepts
current data-sharing policies automatically. Once a verified route answers through
model `grunt`, setup leaves remaining signups to the daemon after finishing local
configuration and Squire bootstrap. See the [setup flow](docs/reference.md#free-api-and-account-setup)
for verification and background acquisition limits. Grunt is added as an extra
named model; existing defaults stay intact.
Sources that cannot finish signup or pass a test request are skipped while working
sources remain usable. Rerun setup to retry them.

Free sources are enabled by default, including services that may retain prompts,
allow staff review, or use prompts for training. Provider disclosures remain in
`src/local/data-sharing.ts` and the reference documentation.

Grunt also shares [route health counts](docs/router.md#4-route-feedback) with
the registry by default to improve routing. The daily fleet review uses hourly
counts of user attempts, failures and slow successes by route and release.
Set `GRUNT_FLEET_REPORTING=0` in the daemon environment to disable fleet uploads.
Prompts, responses, paths and command output stay out of these reports.

`npx usegrunt add <provider-or-base-URL>` adds a provider. https://grunt.run.
`grunt-local` is the local-daemon entry point. Older command names remain supported
for installed users; see the compatibility section in the reference.

Reopen the dashboard in a separate terminal:

```bash
npx usegrunt status --watch
# One snapshot, suitable for scripts:
npx usegrunt status --json
# An older installation on a custom port:
npx usegrunt status --watch --port 8792
```

The dashboard uses green for verified replies, cyan for requests in progress,
blue for setup, yellow for approvals or limits, and red for failures. Arrow keys
select a source, Enter shows details, `d` toggles disabled sources, and `q` closes
the view without stopping the daemon. The watch view remains interactive while
setup runs in another terminal.
Status refreshes use cached observations and never send test prompts. Model
labels describe registry configuration, not an attestation of the latest reply.
Unobserved sources and unreported credit balances are shown honestly. Narrow
terminals hide model/timing columns, `NO_COLOR` removes color, and piped output
prints a single plain snapshot. New setup remembers the installed port;
`--port` overrides `GRUNT_PORT`, the saved port, and the default 8788.

## Parallel work

Grunt runs no workers of its own. Parallelism belongs to the harness: the native
subagents of Claude Code, Codex and OpenCode send ordinary model requests that
Grunt routes. Each subagent is its own task and stays on one free source unless
that source fails, so parallel subagents spread across your sources. Your
orchestrator keeps its source when a subagent finishes.

Parallel subagents use free quota faster. The remedy is more sources, which the
scout keeps adding, not throttling. Pi has no subagents and runs one session at
a time; Pi background jobs, checkpoints and Grunt's subworkers were removed (see
the [reference](docs/reference.md#parallel-work)).

Local routing performance and failure backoff persist across runtime restarts.

Operators can also configure a private execution host for required release
checks, a builder-recorded review bound to the exact commit, exact tested-tree merging and verified GitHub
Pages publication. Its read-only channel manifest
is explicit launch configuration; credentials and signing authority stay outside
the coding interface. See [execution efficiency](docs/efficiency.md).

`usegrunt efficiency metrics` reads durable hourly runtime measurements without
probing providers. Host verification timings distinguish
execution from waiting and reuse. Offline fixed-workload, fallback-replay and
metadata benchmarks compare trusted local checkouts with correctness checks and
failures included. See [measurement commands and limits](docs/efficiency.md#measure-changes-offline)
and the [read-only passive collector](docs/passive-efficiency.md). The
[round-three results](docs/efficiency-round3-results.md) report measured savings
and the limits of the controlled experiments.

The [private owner console](docs/reference.md#private-owner-admin) opens on
Grunt's current work, legacy subworker activity from older daemons and per-source daily, weekly and lifetime usage.
Separate views show request and fallback traces, maintenance and scout progress.
Google login permits explicitly configured, verified owner email addresses.
The [Fly preview](https://milo-gateway.fly.dev/admin/) is available while custom
API DNS is pending. See the [deployment runbook](docs/admin-deployment.md).

Regular installations keep diagnostics local. An operator can explicitly enable
the [outbound owner collector](docs/admin-collector.md) with private configuration
and `node dist/admin/collector.js`. It uploads allowlisted metadata, never prompts,
replies, code, credentials or raw provider errors. Normal `npx usegrunt` onboarding
does not enroll a user's machine in the owner console.

Daily upkeep uses a separate persistent queue. It checks one configured curated
or explicitly installed opt-in source at a time, then waits 60–90 seconds after
that check finishes. Sibling runtimes sharing the same private configuration
coordinate that queue and preserve each other's results. A recent
successful reply counts toward the daily check. Otherwise the queue sends one
bounded hello directly to that provider, with normal consent and free-access
guards. Free-Pi checks use metadata, avoiding a new coding-session
trace. They are recorded as metadata evidence rather than a fresh reply.
The queue defers checks during user requests, setup and cooldowns. Maintenance
does not install tools, create accounts or open sign-in flows. Separately, the
daemon uses the registry to acquire recommended routes with current consent. See the
[router guide](docs/router.md) for acquisition triggers, limits, refresh timing and automatic
pool updates. The dashboard's source details show the last check, its outcome
and the next due time. See the [setup flow](docs/reference.md#free-api-and-account-setup)
for first-time onboarding.

Maintenance starts automatically with the installed daemon in 0.6.9 and later.
Existing users update that daemon with:

```bash
npx usegrunt update
```

The update command fetches the latest official release and replaces the saved
runtime while preserving accounts, source choices, ports and maintenance state.
It keeps the existing service configuration and restores the old runtime if the
new one fails its startup check. It does not repeat setup or account sign-in.
If an older locally installed CLI does not recognize `update`, use
`npx usegrunt@latest update` once.

Installing a newer CLI alone does not replace an older background runtime. The
queue runs while the machine and daemon are running and resumes overdue work
after downtime; users do not need to schedule a separate daily command.

[Reference](https://github.com/bananaman614305/grunt/blob/main/docs/reference.md) · [Vision](https://github.com/bananaman614305/grunt/blob/main/VISION.md) · [Changelog](https://github.com/bananaman614305/grunt/blob/main/CHANGELOG.md) · [Project instructions](https://github.com/bananaman614305/grunt/blob/main/CLAUDE.md).

To cut a manual npm release, merge the version bump and changelog, then open
[publish usegrunt](https://github.com/bananaman614305/grunt/actions/workflows/publish.yml),
select **Run workflow** on `main` and enter the version from `package.json`.
The workflow tests, builds, publishes and verifies the package. Repository
collaborators with write access can run it. **Verify only** checks GitHub's npm
authentication and previews the package without publishing it.

In the npm package settings, the trusted publisher must allow `npm publish`
for `bananaman614305/grunt` and `publish.yml`. npm expires new configurations
that have yet to complete a successful publish after two days.

Maintainers can use the [provider scouting guide](https://github.com/bananaman614305/grunt/blob/main/ops/provider-scout/README.md) for Chad's every-four-hours search job. It researches recurring free offers, uses Squire for eligible signups and, when release is enabled, requires two independent reviews, sandboxed checks and trusted exact-provider hello/tool probes before merging and publishing a new npm release. Human authentication and approval blockers remain pending. New users receive released additions through `npx usegrunt`; existing installations use `npx usegrunt update`. Scouting is separate from user maintenance and is not installed on users' machines.

Setup automatically records current source policies, including material terms, without a data-sharing prompt. `GRUNT_SETUP_NO_DATA_SHARING=1` keeps sources with explicit or material policies off. Supported providers can reuse the person's Google or GitHub identity and may still require their own verification. `usegrunt add <provider>` remains available for supported providers. Runcrate needs a GitHub account at least 30 days old. Mistral uses its native Vibe Free coding allowance, not ordinary API credit. NVIDIA stays optional while account verification is unvetted; Cloudflare Qwen is excluded by choice. Kilo model selection follows the [Kilo reference](docs/reference.md#kilo-free-models). Repeat setup preserves eligible previously connected API sources.

The same curated pool is offered to every installation. Anonymous Reflection
Beam and 100milionseek are included in standard onboarding. 100milionseek pins
DeepSeek V4.1 Flash Free and checks its permanent 100-million-token daily
allowance, resetting at midnight UTC; its qualified input limit is the approved
198,000-token exception. Free-Pi can sell coding-session traces; setup records its policy automatically.
It requires a reviewed-public-context attestation on
every request; ordinary Pi requests do not supply it. See the
[provider reference](docs/reference.md#curated-sources-and-explicit-selections)
and [Free-Pi's restrictions](docs/providers/freepi.md). Antseed remains an
[explicit experimental installation](docs/antseed-vikey-provisioning.md), with
large-input qualification still incomplete.

Nous uses `qwen/qwen4-max:free` on the Nous Portal Free plan. See the [Nous setup reference](docs/reference.md#temporary-free-sources) for its Hermes device login.

Kenari uses `ernie-5-5-flash-preview:free`. See the [provider setup reference](docs/reference.md#temporary-free-sources) for its dedicated Squire key and verification. You can also connect it with `npx usegrunt add kenari`. [Kenari free-model limits](https://kenari.id/en/docs/free-models)

Numes uses `z-ai/glm-5.3-flash:free` and a dedicated Squire key with a $0 spending cap. Grunt checks the cap before each request and verifies the model and charge in each reply. Free capacity can vary. Use `npx usegrunt add numes` to connect it separately or resume setup. [Numes free routes](https://numes.ai/docs/models#free-models)

CrowLLM is an optional source connected with `npx usegrunt add crowllm`. Squire reuses a vaulted key named Grunt Free. The route pins `glm-5.3-flash:free` and verifies zero pricing before every request. It skips paid models and account welcome credit. Free capacity and request limits are unpublished. Context capacity and a live tool response remain unverified, so CrowLLM is outside default onboarding. [CrowLLM free model](https://crowllm.com/models/glm-5.3-flash:free)

Darus Gateway uses the pinned `darus/deepseek-v4.1-flash-1017-FREE` route. Its Free tier advertises 10 million provider-metered tokens daily, resetting at 00:00 UTC. Each request verifies the free catalog entry, current daily allowance and Protect Balance setting, so exhaustion cannot continue through the wallet. See the [Darus reference](docs/reference.md#darus-daily-free-source).

Aperture uses the pinned `baidu/ernie-5.5-flash-preview:free` route on a verified Free account, with fresh zero-price catalog checks before dispatch. Its published allowance is 200 requests/day and 20/minute, with the daily allowance resetting at 00:00 UTC. See the [Aperture reference](docs/reference.md#aperture-daily-free-source).

Fikra and Openference are included in automatic Squire onboarding for their temporary free DeepSeek V4.1 Flash offers. See the [temporary-source reference](docs/reference.md#temporary-free-sources) for promotion windows and verification checks.


Gödel Machines uses a dedicated Free Key for `deepseek/deepseek-v4.1-flash`. Grunt setup connects it through Squire. Only local model requests with `X-Grunt-Context: public` can use the route, including when their model is `grunt`. Set this header only when the entire payload, including system instructions, conversation history, source code, and tool results, is approved for retention, staff review, and training and has no secrets, confidential business information, or other people’s personal data. Ordinary harness sessions omit the header. The free allowance is 600,000 uncached input and 150,000 output tokens per day, renewing at midnight UTC. [Gödel free-tier terms](https://inference.goedelmachines.com/legal#free-tier)

LiveKit adds DeepSeek V4.1 Flash through its free Build plan, using one free project and the official CLI's browser login. The documented included inference allowance is $2.50 per calendar month with a hard stop and no card. Keep the account on Build. LiveKit documents [zero data retention and no training for inference](https://docs.livekit.io/agents/models/inference/), so it needs no sharing approval. The route passed short-prompt, tool-call and 210,077-token context checks through Grunt.

The additions in 0.6.6 include BeatAPI, Pollinations and Perch. BeatAPI's ongoing free DeepSeek route permits one successful request per minute and leaves its separate $2 welcome credit untouched. Pollinations' fixed community GLM route needs a numeric zero-budget, Quest-only key and a positive unused Quest balance; the zero-priced route does not spend its one-time first-key reward. Perch uses active Starter access with 20,000 Perch Tokens per month, the optional Data Program off, and both memory switches off. Native CLI output limits are local checks and cannot hard-cap upstream generation; keep Perch on Starter. See the reference for model-attestation and billing limits.

Within OpenCode, new conversations rotate across DeepSeek V4.1 Flash Free,
GLM 5.3 Flash Free and Big Pickle. Follow-ups keep their model. See the
[OpenCode reference](docs/reference.md#opencode-app-driver) for model-level quota
failover and shared free-limit handling. Grunt does not purchase credits.

See the [setup reference](docs/reference.md#free-api-and-account-setup) for Zro, Token Harbor and Runcrate saved-key reuse and Zro's free-account requirements. Token Harbor uses its explicit `:free` model ID. Runcrate requires no paid balance, no card and automatic top-ups off; Mistral Vibe keeps pay-as-you-go off. Setup saves current provider data policies in a private receipt. Background setup never prompts, and signup and routing require the current receipt where required.

Freebuff and APInex are retired from all grunt routing in 0.6.6. Freebuff's native application is preserved; its saved source selection and legacy fallback no longer enable routing, and no port-8789 bridge starts. APInex changed its recurring daily entitlement to require a $5 top-up; grunt makes no purchase, and a one-time Telegram reward is excluded. Old sharing receipts cannot reactivate either source.

Kilo can try other verified free models when its preferred model is rate-limited. See the [Kilo reference](docs/reference.md#kilo-free-models) for model selection, anonymous limits and data-sharing terms.

API-provider keys stay in Squire. Anonymous Kilo access uses no credential; its verification rules are in the [Kilo reference](docs/reference.md#kilo-free-models).
