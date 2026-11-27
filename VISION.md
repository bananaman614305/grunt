# Vision

**grunt** ([grunt.run](https://grunt.run)): Free agent for everyone.

`grunt` exists so that a person who cannot pay for intelligence still gets an agent that does serious work.
It serves the knowledge worker who budgets for food and rent before any AI plan, and who falls further behind those who can pay.
grunt is a local model endpoint that the person's harness calls like any other model.
Behind that endpoint, grunt turns free tokens scattered across siloed quotas and hard-to-reach harnesses into one model that keeps answering.
The harness owns the agent loop, the tools and any parallelism; grunt is the free engine underneath it.
It owns exactly one thing: sourcing free tokens and routing each task to a source that can finish it.

## Free is the product, not a tier

grunt is MIT licensed and free to use.
A default install spends no money and no paid allowance.
Every source that can cost money or plan quota is off until the person names it.
grunt never buys credits, never upgrades a plan, and never switches to a paid model on its own.
When a free source carries a hidden price, such as prompt retention or terms risk, grunt says so in plain words.
See the [setup reference](docs/reference.md#free-api-and-account-setup) for policy receipts and the data-sharing opt-out. Public-only providers also require review of each full request. LiveKit documents zero retention and no training for inference, so it adds no sharing policy.

## Free tokens are personal

Free tokens are given to each person for their own use, so grunt uses them only for that person's own work.
grunt holds at most one account per person per service, in that person's name.
Trusty Squire runs on the person's machine and holds one Google sign-in, so a second account per service is not possible.
Setup tells the person that Squire will sign them up for free services, and why, before it asks for that sign-in.
grunt never farms accounts, rotates identities, or evades a provider's identity checks.
It does not serve industrial or bulk workloads.

## The owner curates the source list

The registry lists the adapters that offer free tokens, with a tier and a base weight for each.
The 0.8.2 curated registry has 22 sources, subject to individual signup, consent and request eligibility. The same registry is offered to every installation. Freebuff and APInex are retired from grunt routing; the person's native Freebuff application is preserved.
A weight sets the adapter's base chance in the [routing draw](docs/router.md#2-score-back-off-retirement).
Stable adapters share 0.8 of the weight and experimental adapters share 0.2.
The bundled starting pool has three stable adapters in relative proportions 6:8:5: OpenCode at about 0.252632, Kilo at about 0.336842 and Zro at about 0.210526.
Kilo's model selection and data-sharing terms are documented in the [Kilo reference](docs/reference.md#kilo-free-models).
Eighteen experimental sources share the remaining 0.2 equally. Each joins after its required data-sharing approval and free-account checks; see the [current provider reference](docs/reference.md#curated-sources-and-explicit-selections). LiveKit uses the free Build plan's included inference allowance with a hard stop, no card and no paid fallback. Pollinations requires a hard zero-budget Quest-only key, a positive unused Quest balance and the fixed vetted community model; BeatAPI uses only its free model without spending welcome credit. Perch requires active Starter access with optional data sharing and both memory switches off. Native local output checks do not hard-cap upstream generation or allowance use.
Cloudflare Qwen is excluded from this pool by the owner's choice; NVIDIA remains optional while its account verification is unvetted.
Adapters ship through tested releases. Live source-list updates follow the
[registry publication contract](docs/reference.md#sources-and-app-sessions).
The registry can only select adapters that grunt already has code for; it cannot add code.
The daemon refreshes the registry on the [router loop schedule](docs/router.md#3-slow-loop-hot-add-and-scout-mapping) and keeps the last good copy when the gateway is down.

## One adapter per task, hand off at the wall

Each new user turn starts a task, and the daemon binds it to one adapter, drawn at random by weight.
Managed pools always draw by weight and stay sticky; a source with no registry entry, such as explicitly enabled Codex, is a last resort.
Adapters that cannot handle the task's modality are filtered out before the draw.
The task stays on that adapter until it returns a 429, fails past a set tolerance, or loses its login.
grunt does not count usage ahead of time; it lets the adapter hit its limit, then switches.
The spent adapter is barred until its limit clears.
The next adapter gets the original task, the edits so far and the last output, and continues instead of restarting.
Each failure carries a typed reason, so the next adapter and the person both know why.
A timeout after possible filesystem work stops instead of replaying that work.
Caller cancellation stops the whole chain.
A harness that runs subagents sends each as its own task, so parallel subagents spread across sources.
The orchestrator keeps its own source when a subagent finishes.
Parallel work spends free quota faster; the answer is more sources, which the scout adds, and not throttling.

## Work stays on the person's machine

The daemon serves the model endpoint on localhost and binds loopback only.
The harness keeps the agent loop, tools and conversation; grunt answers its model calls.
Adapters act with the person's own filesystem permissions.
Registry clients never send inference payloads to the gateway. Their
[route feedback](docs/router.md#4-route-feedback) contains only health metadata.
API-provider keys stay on the person's machine: either in Grunt's private mode-0600 local vault (with adapters calling each provider's pinned HTTPS origin directly, without routing prompts, source code or tool results through a central egress proxy) or through backwards-compatible scoped, revocable Trusty Squire grants. Trusty Squire still automates browser signups and API key capture. Native CLIs keep their credentials in their own private storage; LiveKit signs ten-minute inference-only tokens for grunt to hold in memory.
No key, token or device secret appears in logs, terminal output or harness config.
grunt reuses logins the person already holds. Official native CLIs manage their own login files; grunt does not copy their credentials.

## One command to a working endpoint

`npx usegrunt` installs dependencies, the daemon and the starting adapters, and writes opt-in files for the harnesses it finds.
The package and the command are both `usegrunt`; "grunt" is the brand only, because the `grunt` command already belongs to the JavaScript task runner.
The recommended harnesses are Claude Code, Codex and OpenCode.
Their native subagents work through grunt, so parallel work needs nothing from grunt but more sources.
Claude Code works without a paid subscription when it points at grunt.
Pi stays supported as a single-agent harness with no parallelism.
Each harness gets its own grunt file and is launched with it on purpose; the person's own defaults are never edited.
Setup checks each adapter is installed and signed in, and fixes what it can.
Setup reports success only after a real task travels through the installed daemon.
Human verification hands off to a browser and resumes in the same session.
One refused provider drops out; the rest still install.

## Scope

grunt is not a harness, an agent loop, a model host, a credit reseller, or a billing service.
It runs no workers, background jobs or checkpoints of its own.
It does not compete with frontier models on benchmarks; it competes on cost to the person, which is zero.
It is not an industrial-scale inference pool.
It does not select Google models, add a paid OpenRouter source, or admit unvetted aggregators. A vetted free provider may use its own upstream processors, disclosed during setup.
Every change ships with a reproduction or demonstration that runs offline against fakes, plus live proof where accounts allow.

A change aligns when it adds a tested free source through the curated registry, keeps a task moving through a new limit or failure, removes a setup step, or makes a cost visible.
A change should be resisted when it makes a default install spend money, sends prompts or keys off the machine, creates more than one account per person per service, serves bulk workloads, or exposes a secret.
