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

usegrunt installs grunt on this machine. It pools free AI quota and serves local coding agents.

Use Node 22 or 24 LTS on Linux with systemd or macOS with launchd. Setup needs npm and tar; browser sign-in also needs a working browser/display path, especially on a headless server. Mistral Vibe needs `uv` or Python 3.12 or later.

Setup plays the miner animation, connects every supported coding tool it finds,
shows one live table of tools and sources, and ends with `Ready`. It asks no
questions. Grunt is added as an extra named model; existing defaults stay intact.
Sources that cannot finish signup or pass a test request are skipped while working
sources remain usable. Rerun setup to retry them.

Free sources are enabled by default, including services that may retain prompts,
allow staff review, or use prompts for training. Provider disclosures remain in
`src/local/data-sharing.ts` and the reference documentation.

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
the view without stopping the daemon. During unfinished setup the view is
passive so Squire owns the keyboard; those keys become available after setup.
Status refreshes use cached observations and never send test prompts. Model
labels describe registry configuration, not an attestation of the latest reply.
Unobserved sources and unreported credit balances are shown honestly. Narrow
terminals hide model/timing columns, `NO_COLOR` removes color, and piped output
prints a single plain snapshot. New setup remembers the installed port;
`--port` overrides `GRUNT_PORT`, the saved port, and the default 8788.

### Delegate to Grunt subworkers

Your coding agent can give Grunt up to two independent tasks at a time.
Subworkers return findings or proposed edits for the main agent to review and
apply. They work from the task and context you send.

```bash
npx usegrunt workers connect pi
npx usegrunt workers status
```

Use `opencode`, `codex`, or `claude` in place of `pi` for those interfaces,
or run tasks from any terminal with
[`usegrunt workers run`](docs/reference.md#subworkers). Installations with an
older daemon need `npx usegrunt update` after a release with subworkers.

The [private owner console](docs/reference.md#private-owner-admin) opens on
Grunt's current work, subworker activity and per-source daily, weekly and lifetime usage.
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
source at a time, then waits 60–90 seconds after that check finishes. A recent
successful reply counts toward the daily check. Otherwise the queue sends one
bounded hello directly to that provider, with normal consent and free-access
guards. Idle Clixad checks use read-only metadata to avoid automatic wallet or
streak claims; they are recorded as metadata evidence rather than a fresh reply.
The queue defers checks during user requests, setup and cooldowns. Maintenance
does not install tools, create accounts or open sign-in flows. When a request finds no source that can answer, the daemon separately starts one background recovery that adds vetted providers whose data-sharing approval is already recorded (saved Squire access first, then signup); it never runs without that approval. The dashboard's
source details show the last check, its outcome and the next due time. Registry
downloads still refresh independently, and first-time onboarding stays parallel.

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

Maintainers can use the [provider scouting guide](https://github.com/bananaman614305/grunt/blob/main/ops/provider-scout/README.md) for Chad's 09:00/21:00 Eastern search job. It researches recurring free offers, uses Squire for eligible signups and, when release is enabled, requires two independent reviews, sandboxed checks and trusted exact-provider hello/tool probes before merging and publishing a new npm release. Human authentication and approval blockers remain pending. New users receive released additions through `npx usegrunt`; existing installations use `npx usegrunt update`. Scouting is separate from user maintenance and is not installed on users' machines.

Setup groups any required data-sharing approvals into one prompt. Supported providers can reuse the person's Google or GitHub identity and may still require their own verification. `usegrunt add <provider>` remains available for supported providers. Runcrate needs a GitHub account at least 30 days old. Mistral uses its native Vibe Free coding allowance, not ordinary API credit. NVIDIA stays optional while account verification is unvetted; Cloudflare Qwen is excluded by choice. The default `kilo` source selects `particle-ai/particle-1:free`. Repeat setup preserves eligible previously connected API sources.

Nous uses `qwen/qwen4-max:free` on the Nous Portal Free plan. After the grouped consent prompt, open the Hermes device link and approve inference. Other sources can start serving requests while you finish that step.

Kenari uses `ernie-5-5-flash-preview:free`. After grouped data-sharing approval, Squire connects a dedicated Grunt Free key scoped to `kenari.id` and hands off to you if Kenari requires browser verification. You can also connect it with `npx usegrunt add kenari`. [Kenari free-model limits](https://kenari.id/en/docs/free-models)

Numes uses `z-ai/glm-5.3-flash:free` and a dedicated Squire key with a $0 spending cap. Grunt checks the cap before each request and verifies the model and charge in each reply. Free capacity can vary. Use `npx usegrunt add numes` to connect it separately or resume setup. [Numes free routes](https://numes.ai/docs/models#free-models)

CrowLLM is an optional source connected with `npx usegrunt add crowllm`. Squire reuses a vaulted key named Grunt Free. The route pins `glm-5.3-flash:free` and verifies zero pricing before every request. It skips paid models and account welcome credit. Free capacity and request limits are unpublished. Context capacity and a live tool response remain unverified, so CrowLLM is outside default onboarding. [CrowLLM free model](https://crowllm.com/models/glm-5.3-flash:free)

Fikra and Openference are included in automatic Squire onboarding for their temporary free DeepSeek V4.1 Flash offers. Both passed live Grunt reply, native-tool and 200K-input checks. Every request verifies the exact free alias and zero pricing; Fikra also checks its live shared-budget gate. Closed promotions stop routing without paid fallback, and Fikra signup does not start when its gate is closed. See the [temporary-source reference](docs/reference.md#temporary-free-sources).


Gödel Machines uses a dedicated Free Key for `deepseek/deepseek-v4.1-flash`. Grunt setup connects it through Squire. Only local model requests with `X-Grunt-Context: public` can use the route, including when their model is `grunt`. Set this header only when the entire payload, including system instructions, conversation history, source code, and tool results, is approved for retention, staff review, and training and has no secrets, confidential business information, or other people’s personal data. Ordinary Pi and subworker sessions omit the header. The free allowance is 600,000 uncached input and 150,000 output tokens per day, renewing at midnight UTC. [Gödel free-tier terms](https://inference.goedelmachines.com/legal#free-tier)

LiveKit adds DeepSeek V4.1 Flash through its free Build plan, using one free project and the official CLI's browser login. The documented included inference allowance is $2.50 per calendar month with a hard stop and no card. Keep the account on Build. LiveKit documents [zero data retention and no training for inference](https://docs.livekit.io/agents/models/inference/), so it needs no sharing approval. The route passed short-prompt, tool-call and 210,077-token context checks through Grunt.

The four additions in 0.6.6 are BeatAPI, Pollinations, Clixad and Perch. BeatAPI's ongoing free DeepSeek route permits one successful request per minute and leaves its separate $2 welcome credit untouched. Pollinations' fixed community GLM route needs a numeric zero-budget, Quest-only key and a positive unused Quest balance; the zero-priced route does not spend its one-time first-key reward. Clixad uses its native free GLM route with a zero wallet balance. Perch uses active Starter access with 20,000 Perch Tokens per month, the optional Data Program off, and both memory switches off. Native CLI output limits are local checks and cannot hard-cap upstream generation; keep Clixad's wallet at zero and Perch on Starter. See the reference for model-attestation and billing limits.

Within OpenCode, new conversations rotate across DeepSeek V4.1 Flash Free,
GLM 5.3 Flash Free and Big Pickle. Follow-ups keep their model, and quota errors
try another free model. These models may share provider limits; the pool does
not create extra credit balances or purchase credits.

Zro setup confirms the Free plan, no purchased usage balance and no payment method before connecting it. Keep that account free: Zro uses the same model ID on its paid plans, so changing the account outside grunt can change billing. Token Harbor uses its explicit `:free` model ID. Runcrate requires no paid balance, no card and automatic top-ups off; Mistral Vibe keeps pay-as-you-go off. Setup saves current provider data policies in a private receipt. Background setup never prompts, and signup and routing require the current receipt where required.

Freebuff and APInex are retired from all grunt routing in 0.6.6. Freebuff's native application is preserved; its saved source selection and legacy fallback no longer enable routing, and no port-8789 bridge starts. APInex changed its recurring daily entitlement to require a $5 top-up; grunt makes no purchase, and a one-time Telegram reward is excluded. Old sharing receipts cannot reactivate either source.

Kilo Particle 1 is post-trained from DeepSeek V4.1 Flash; it is a distinct model with a listed one-million-token context. Its free route requires no account or API key and supports native function calls. Anonymous access is limited to 200 requests per hour per IP and upstream capacity; it uses no one-time credits. The catalog permits training on prompts, and setup enables it by default. Standard DeepSeek routes remain paid; Auto Free is a changing pool and is no longer the default in 0.6.6.

API-provider keys stay in Squire. The anonymous Kilo Particle route uses no credential; grunt verifies the exact model and zero reported cost before accepting its answer.
