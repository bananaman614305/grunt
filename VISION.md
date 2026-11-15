# Vision

**grunt** ([grunt.run](https://grunt.run)): Free agent for everyone.

`grunt` exists so that a person who cannot pay for intelligence still gets an agent that does serious work.
It serves the knowledge worker who budgets for food and rent before any AI plan, and who falls further behind those who can pay.
grunt is a local model endpoint that the person's harness, such as Pi, calls like any other model.
Behind that endpoint, grunt turns free tokens scattered across siloed quotas and hard-to-reach harnesses into one model that keeps answering.
In Pi, the person sees one agent that keeps working; grunt is the free engine underneath it.
It owns exactly one thing: sourcing free tokens and routing each task to a source that can finish it.

## Free is the product, not a tier

grunt is MIT licensed and free to use.
A default install spends no money and no paid allowance.
Every source that can cost money or plan quota is off until the person names it.
grunt never buys credits, never upgrades a plan, and never switches to a paid model on its own.
When a free source carries a hidden price, such as prompt retention or terms risk, grunt says so in plain words.
Setup asks once for the nine data-sharing policies of Freebuff, OpenCode, Kilo, Token Harbor, Runcrate, APInex, Mistral Vibe Free, Pollinations and BeatAPI together, and remembers the approved policies.
Declining skips those sources and continues with Zro and LiveKit, subject to their free-account checks; changed policies require approval again before signup or routing. LiveKit documents zero retention and no training for inference, so it adds no sharing policy.

## Free tokens are personal

Free tokens are given to each person for their own use, so grunt uses them only for that person's own work.
grunt holds at most one account per person per service, in that person's name.
Trusty Squire runs on the person's machine and holds one Google sign-in, so a second account per service is not possible.
Setup tells the person that Squire will sign them up for free services, and why, before it asks for that sign-in.
grunt never farms accounts, rotates identities, or evades a provider's identity checks.
It does not serve industrial or bulk workloads.

## The owner curates the source list

The registry lists the adapters that offer free tokens, with a tier and a fixed weight for each.
The following pool describes the held 0.6.6 draft; the published 0.6.5 package still has nine sources. Freebuff's provider-policy review and supported scope remain unresolved after a relaying-policy refusal, and no DeepSeek pin has shipped.
A weight is the chance that an adapter is picked for a new task.
Stable adapters share 0.8 of the weight and experimental adapters share 0.2.
The bundled starting pool has four stable adapters: Freebuff and OpenCode at 0.192 each, Kilo at 0.256 and Zro at 0.16.
Kilo selects the anonymous free `particle-ai/particle-1:free` route, a distinct model post-trained from DeepSeek V4.1 Flash with a listed one-million-token context. It supports native function calls and ongoing rate-limited access without one-time credits. Its catalog permits training, so the changed Kilo policy requires approval again before setup or routing. Kilo Auto Free is no longer the default.
Seven experimental sources share 0.2 equally, about 0.0285714 each: Token Harbor, Runcrate, APInex, Mistral Vibe Free, LiveKit, Pollinations and BeatAPI. Each joins after its required data-sharing approval and free-account checks. LiveKit uses the free Build plan's included inference allowance with a hard stop, no card and no paid fallback. Pollinations requires a hard zero-budget Quest-only key, a positive unused Quest balance and the fixed vetted community model; BeatAPI uses only its free model without spending welcome credit.
Cloudflare Qwen is excluded from this pool by the owner's choice; NVIDIA remains optional while its account verification is unvetted.
New sources enter by pull request, are tested, and reach people only when the owner publishes the registry.
The registry can only select adapters that grunt already has code for; it cannot add code.
The daemon pulls the registry once a day and keeps the last good copy when the gateway is down.

## One adapter per task, hand off at the wall

Each new user turn starts a task, and the daemon binds it to one adapter, drawn at random by weight.
Adapters that cannot handle the task's modality are filtered out before the draw.
The task stays on that adapter until it returns a 429, fails past a set tolerance, or loses its login.
grunt does not count usage ahead of time; it lets the adapter hit its limit, then switches.
The spent adapter is barred until its limit clears.
The next adapter gets the original task, the edits so far and the last output, and continues instead of restarting.
Each failure carries a typed reason, so the next adapter and the person both know why.
A timeout after possible filesystem work stops instead of replaying that work.
Caller cancellation stops the whole chain.

## Work stays on the person's machine

The daemon serves the model endpoint on localhost and binds loopback only.
The harness keeps the agent loop, tools and conversation; grunt answers its model calls.
Adapters act with the person's own filesystem permissions.
The gateway serves the published registry; it never receives prompts, files or keys.
API-provider keys stay in the person's vault, and grunt receives scoped, revocable grants instead. Native CLIs keep their credentials in their own private storage; LiveKit signs ten-minute inference-only tokens for grunt to hold in memory.
No key, token or device secret appears in logs, terminal output or harness config.
grunt reuses logins the person already holds. Official native CLIs manage their own login files; grunt does not copy their credentials.

## One command to a working agent

`npx usegrunt` installs dependencies, the daemon and the starting adapters, and points Pi at grunt.
The package and the command are both `usegrunt`; "grunt" is the brand only, because the `grunt` command already belongs to the JavaScript task runner.
Other harnesses that accept a custom model endpoint, such as Claude Code and opencode, can use grunt the same way.
Setup checks each adapter is installed and signed in, and fixes what it can.
Setup reports success only after a real task travels through the installed daemon.
Human verification hands off to a browser and resumes in the same session.
One refused provider drops out; the rest still install.

## Scope

grunt is not a harness, a model host, a credit reseller, or a billing service.
It does not compete with frontier models on benchmarks; it competes on cost to the person, which is zero.
It is not an industrial-scale inference pool.
It does not route to Google models, OpenRouter, or unvetted aggregators.
Every change ships with a reproduction or demonstration that runs offline against fakes, plus live proof where accounts allow.

A change aligns when it adds a tested free source through the curated registry, keeps a task moving through a new limit or failure, removes a setup step, or makes a cost visible.
A change should be resisted when it makes a default install spend money, sends prompts or keys off the machine, creates more than one account per person per service, serves bulk workloads, or exposes a secret.
