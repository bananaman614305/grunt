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

## Free tokens are personal

Free tokens are given to each person for their own use, so grunt uses them only for that person's own work.
grunt holds at most one account per person per service, in that person's name.
Trusty Squire runs on the person's machine and holds one Google sign-in, so a second account per service is not possible.
Setup tells the person that Squire will sign them up for free services, and why, before it asks for that sign-in.
grunt never farms accounts, rotates identities, or evades a provider's identity checks.
It does not serve industrial or bulk workloads.

## The owner curates the source list

The registry lists the adapters that offer free tokens, with a tier and a fixed weight for each.
A weight is the chance that an adapter is picked for a new task.
Stable adapters share 0.8 of the weight and experimental adapters share 0.2.
grunt opens with two stable adapters, Freebuff and OpenCode, at 0.5 each.
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
Provider keys stay in the person's vault, and grunt receives scoped, revocable grants instead.
No key, token or device secret appears in logs, terminal output or config.
grunt reuses logins the person already holds and never reads or rewrites another tool's login files.

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
