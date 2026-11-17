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

usegrunt installs grunt on this machine. It pools free AI quota and serves one local agent.

Use Node 22 or 24 LTS on Linux with systemd or macOS with launchd. Setup needs npm and tar; browser sign-in also needs a working browser/display path, especially on a headless server. Mistral Vibe needs `uv` or Python 3.12 or later.

Daemon restarts reuse saved connections. Background verification preserves them on
temporary failures and asks for foreground setup when human verification is needed.

`npx usegrunt add [provider-or-base-URL]` adds a provider; omit the argument to paste a URL. https://grunt.run. `grunt-local` is the local-daemon entry point. Older command names remain supported for installed users; see the compatibility section in the reference.

The curated pool has eleven sources: OpenCode, Kilo, Zro, Token Harbor, Runcrate, Mistral Vibe Free, LiveKit, Pollinations, BeatAPI, Clixad and Perch. Pi is optional.

In 0.6.7, setup starts the persistent daemon before provider jobs and checks each provider as it finishes. The first verified reply makes grunt ready; setup then applies your coding-tool choices while the remaining jobs continue. Eligible anonymous Kilo and OpenCode routes can work while account-dependent providers wait for Squire sign-in. Up to six provider jobs, three browser operations and three reply checks can run concurrently; readiness does not wait for the whole pool.

The original `npx usegrunt` terminal shows a live source dashboard after the first verified reply, while remaining signups continue. It yields to browser confirmations and resumes afterward. Use a connected coding tool in another terminal while it works. Closing the console pauses unfinished signups; verified daemon routes keep running, and rerunning setup resumes the rest. Partial provider failures are reported without failing an installation that has at least one verified route. Perch remains in the default pool, but its human verification does not have to finish before another route becomes usable. Setup duration depends on downloads, prerequisites and verification; no cold-start time is promised.

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

The separate [private owner console](docs/reference.md#private-owner-admin) is
designed for `https://grunt.run/admin/`. It shows retained request and fallback
traces, safe HTTP/CLI failure details, reported token usage, maintenance and scout
progress, and installation freshness. Google login permits only explicitly
configured, verified owner email addresses. Viewing it sends no test prompts.
Public deployment and live Google-login verification are still pending; see the
[deployment prerequisites](docs/admin-deployment.md).

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

Maintainers can use the [provider scouting guide](https://github.com/bananaman614305/grunt/blob/main/ops/provider-scout/README.md) for Chad's 09:00/21:00 Eastern search job. It researches recurring free offers, uses Squire for eligible signups and, when release is enabled, requires two independent reviews, sandboxed checks and trusted exact-provider hello/tool probes before merging and publishing a new npm release. Human authentication and approval blockers remain pending. New users receive released additions through `npx usegrunt`; existing installations use `npx usegrunt update`. Scouting is separate from user maintenance and is not installed on users' machines.

In 0.6.6, one grouped data-sharing approval covers nine active providers. Setup reuses the person's Google or GitHub identity; each provider can still require its own verification. `usegrunt add <provider>` remains available for supported providers. Runcrate needs a GitHub account at least 30 days old. Mistral uses its native Vibe Free coding allowance, not ordinary API credit. NVIDIA stays optional while account verification is unvetted; Cloudflare Qwen is excluded by choice. The default `kilo` source selects `particle-ai/particle-1:free`. Repeat setup preserves eligible previously connected API sources.

LiveKit adds DeepSeek V4.1 Flash through its free Build plan, using one free project and the official CLI's browser login. The documented included inference allowance is $2.50 per calendar month with a hard stop and no card. Keep the account on Build. LiveKit documents [zero data retention and no training for inference](https://docs.livekit.io/agents/models/inference/), so it needs no sharing approval. The route passed short-prompt, tool-call and 210,077-token context checks through Grunt.

The four additions in 0.6.6 are BeatAPI, Pollinations, Clixad and Perch. BeatAPI's ongoing free DeepSeek route permits one successful request per minute and leaves its separate $2 welcome credit untouched. Pollinations' fixed community GLM route needs a numeric zero-budget, Quest-only key and a positive unused Quest balance; the zero-priced route does not spend its one-time first-key reward. Clixad uses its native free GLM route with a zero wallet balance. Perch uses active Starter access with 20,000 Perch Tokens per month, the optional Data Program off, and both memory switches off. Native CLI output limits are local checks and cannot hard-cap upstream generation; keep Clixad's wallet at zero and Perch on Starter. See the reference for model-attestation and billing limits.

Within OpenCode, new conversations rotate across DeepSeek V4.1 Flash Free,
GLM 5.3 Flash Free and Big Pickle. Follow-ups keep their model, and quota errors
try another free model. These models may share provider limits; the pool does
not create extra credit balances or purchase credits.

Zro setup confirms the Free plan, no purchased usage balance and no payment method before connecting it. Keep that account free: Zro uses the same model ID on its paid plans, so changing the account outside grunt can change billing. Token Harbor uses its explicit `:free` model ID. Runcrate requires no paid balance, no card and automatic top-ups off; Mistral Vibe keeps pay-as-you-go off. Setup shows provider-specific data-sharing disclosures together and remembers approved policy versions in a private receipt. Declining or cancelling skips those providers and continues with Zro and LiveKit, subject to their free-account checks. Changed or newly added policies require another grouped approval. Background setup never prompts, and both signup and routing require the current receipt where required.

Freebuff and APInex are retired from all grunt routing in 0.6.6. Freebuff's native application is preserved; its saved source selection and legacy fallback no longer enable routing, and no port-8789 bridge starts. APInex changed its recurring daily entitlement to require a $5 top-up; grunt makes no purchase, and a one-time Telegram reward is excluded. Old sharing receipts cannot reactivate either source.

Kilo Particle 1 is post-trained from DeepSeek V4.1 Flash; it is a distinct model with a listed one-million-token context. Its free route requires no account or API key and supports native function calls. Anonymous access is limited to 200 requests per hour per IP and upstream capacity; it uses no one-time credits. The catalog permits training on prompts, so the changed Kilo disclosure requires fresh grouped approval. Standard DeepSeek routes remain paid; Auto Free is a changing pool and is no longer the default in 0.6.6.

API-provider keys stay in Squire. The anonymous Kilo Particle route uses no credential; grunt verifies the exact model and zero reported cost before accepting its answer.
