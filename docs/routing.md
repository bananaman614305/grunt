# How routing works

This describes what `packages/core/src/router` actually does, in plain
language. Where this differs from `docs/PLAN.md`, the code wins; see the
divergence note at the end.

## When routing happens at all

Only `POST /v1/chat/completions` with `"model": "milo/auto"` gets routed.
Any other model id is forwarded to OpenRouter untouched — Milo never gets in
the way of a request that did not ask for it.

## Order of operations

For a routed request, the router (`packages/core/src/router/router.ts`) does
the cheapest thing that answers the question, in this order:

1. **Forced tier.** If the request's `milo.tier` field is set, Jev is
   skipped entirely. The decision is recorded with reason `"forced to the
   <tier> tier by the request"` and `degraded: false`.
2. **Sticky hit.** If the conversation's fingerprint is already pinned (see
   "Stickiness" below), the pinned decision is reused, with a fresh decision
   id and `sticky: true`.
3. **Ask Jev.** Otherwise the router makes one call to Jev's
   `/v1/systemone` endpoint, applies the policy table to the answer, and
   resolves a model from the roster. A clean result gets pinned to the
   fingerprint for future turns.

If step 3's Jev call fails or exceeds its budget, the router degrades to the
`mid` tier instead of raising an error (see "Jev budget and degraded
fallback").

## The four Jev questions

One Jev call per routed conversation asks four questions
(`packages/core/src/router/questions.ts`). All four instructions tell Jev
this is a request sent to an AI coding agent, often a sub-agent inside a
larger orchestration — the criteria are written for that shape, not for
ordinary chat.

### `task_type` (choice)

> This is a request sent to an AI coding agent, often a sub-agent inside a
> larger orchestration. Classify the kind of work it asks for. Judge the
> work requested by the latest user turn; the system prompt, tools, and
> earlier turns are context that describes the agent's role. If the request
> covers several kinds of work, choose the one that dominates the output the
> agent must produce.

The nine choices and their exact criteria:

| Task type | Criteria |
|---|---|
| `chat` | Open conversation with nothing to build or change: a question about an opinion, a greeting, brainstorming, or asking the agent what it thinks or what it just did. |
| `edit` | A bounded change to code or text that already exists: rename a symbol, adjust a config value, apply a described diff, tidy formatting, move a function. |
| `feature` | Build something that does not exist yet: a new module, endpoint, command, test suite, script, or capability, from a description of what it should do. |
| `debug` | Find and fix something that is wrong: a failing test, a stack trace, a flaky job, a wrong result, a regression, or behaviour that does not match the spec. |
| `research` | Gather and synthesize information before acting: read a codebase or docs to explain how something works, compare libraries or approaches, survey prior art, answer a question that needs investigation. |
| `review` | Judge work that already exists: review a diff or pull request, audit for security or correctness, critique a design or a plan, check that an implementation matches its brief. |
| `docs` | Write or revise prose describing a system: README, API reference, changelog, migration guide, code comments, an ADR or design write-up. |
| `ops` | Run or configure the machinery around the code: builds, CI pipelines, deploys, dependency upgrades, database migrations, infrastructure, environment and tooling setup. |
| `classify` | Mechanically label, extract, route, or reformat a given input: pick a category, pull fields out of text, summarize into a fixed shape, decide which sub-agent or tool should handle something. |

### `difficulty` (score, 0–3)

> How hard is this request for a competent AI coding agent? Rate the work
> asked for, not the length of the prompt: a long brief with one mechanical
> instruction is easy, and a short question that asks for an architectural
> decision is hard. Ignore how politely or vaguely it is phrased.

- **0 — Trivial:** a one-line answer or a lookup. Rename a symbol, read a value out of a file, restate something already in the prompt, reformat text, answer a factual question. There is one obvious right answer and no judgment is involved.
- **1 — Routine:** a small self-contained change or a short answer. One or two files, a familiar pattern, an obvious test, or an explanation of well-known material. Judgment is limited to local naming and style.
- **2 — Substantial:** the work spans several files or needs design judgment. Choosing between reasonable approaches, refactoring across modules, writing a non-obvious algorithm, reviewing a real diff, or investigating a bug whose cause is not yet known.
- **3 — Hard:** concurrency, correctness-critical or security-sensitive logic, an architecture other work will depend on, subtle debugging across layers, or deep research in an unfamiliar system. A wrong answer is expensive and easy to miss.

A score answer carries both an expected score (`signals.difficulty`) and the
probability mass on each of the four levels (`signals.difficultyLevels`, in
order 0..3). Policy v2 decides on the masses; the expected score is kept for
the decision log, for `milo explain`, and as the fallback rule when a backend
reports no distribution.

### `needs_reasoning` (noul, 0–1)

> Would answering this well require the agent to work through the problem
> step by step before it can produce the output, rather than writing the
> answer directly?

- **true:** the answer has to be derived — trace state or control flow through code, plan a change across several steps, weigh trade-offs between designs, reason from evidence to a root cause, or satisfy several constraints at once.
- **false:** the answer can be produced directly from what the prompt already states or from ordinary recall — a lookup, a mechanical edit, a formatting or naming change, a restatement, boilerplate, or a familiar single-step task.

### `long_output` (noul, 0–1)

> How long will the agent's reply be? Estimate the size of the output it
> must produce, not the size of the prompt it was given.

- **true:** the reply will likely exceed about 2,000 tokens (roughly 250 lines of code or 1,500 words) — a whole new file or module, several files at once, a full document, an exhaustive review, or a long structured report.
- **false:** the reply will likely stay under about 2,000 tokens — a focused patch, a short explanation, a direct answer, a single function, a handful of edits, or a label.

`long_output` does not feed the tier decision directly; it only affects
which models in the chosen tier are eligible (see "Roster resolution").

## What gets sent to Jev

The `state` payload (`packages/core/src/router/context.ts`) is a compact
view of the conversation, not the raw messages: the system/developer prompt,
up to the last 3 user turns, the most recent assistant turn with text, and
whether tools are present, truncated to fit an 8,000-token budget (a
documented approximation of 4 characters per token). When it does not fit,
context is shed in this order: the latest user turn is reserved first and
kept intact whenever possible, the system prompt is trimmed from the
*middle* (keeping its opening and closing), the most recent assistant turn
is trimmed from the tail, and older user turns are filled newest-first so
the oldest are trimmed and dropped first.

## Policy v2

`packages/core/src/router/policy.ts` decides on two numbers read off the
difficulty distribution rather than on the expected score:

- **`P3`** — probability mass on level 3 ("hard").
- **`P2 + P3`** — mass on level 2 or above ("substantial or more").

Under balanced posture, with the thresholds from the backend's profile:

1. `P2 + P3 < fastBelowMass` → **fast**.
2. Otherwise `P3 >= frontierHardMass` **or** `P2 + P3 >= frontierUpperMass` → **frontier**.
3. Otherwise → **mid**.

Then the cap: a `task_type` of `classify` or `chat` is pulled back to **mid**
whenever step 2 landed it on `frontier` and `P3 < cappedFrontierHardMass`.
This keeps a cheap-to-answer task shape (a label, small talk) off the frontier
tier unless the backend is genuinely confident the work is hard.

### Profiles

The thresholds describe how a decision backend spreads its probability mass,
not the routing question, so they are per backend and are not transferable.
`PROFILES` in `policy.ts`:

| profile | fast below | frontier `P3` | frontier `P2+P3` | cap lifts at `P3` |
|---|---|---|---|---|
| `system-one-open` | 0.05 | 0.10 | 0.65 | 0.30 |
| `jev` *(provisional)* | 0.10 | 0.25 | 0.50 | 0.50 |

The `system-one-open` row is fitted: 83.5% in-sample and 81.8% cross-validated
on the first live eval, against 69.2% for policy v1 on the same signals. Its
bars are low because that backend hedges — a genuinely hard example often
carries only 0.10 to 0.20 of mass on level 3.

The `jev` row is **unvalidated**. Jev has no live run yet (ADR-004), so those
numbers are reasoned from Jev being the better-calibrated scorer — a sharper
distribution needs higher bars, or the open backend's thresholds would fire on
noise. Refit them from a Jev run before trusting them.

The `Router` picks a profile from the model name the backend reported
(`system-one-open/...` means the open replica, anything else means Jev), unless
a `profile` option overrides it. The gateway passes its configured backend kind
through and leaves the option unset for `jev-with-fallback`, where either
backend may answer any given request.

### Posture

Posture adjusts the rule at both ends rather than replacing it:

| posture | effect |
|---|---|
| `low` | the fast threshold raised to at least **0.10**, and the outcome capped at **mid** — the frontier conditions are never evaluated |
| `balanced` | the profile as written |
| `quality` | both frontier thresholds **−0.10**, floored at **0.02** (hard) and **0.10** (upper), and anything not fast goes to frontier once `P2 + P3 >= 0.40` |

`low` posture never returns `frontier`, however much mass sits on level 3.
That is the promise a caller makes when they pick it, and it is the same
ceiling policy v1 had. The `quality` floors exist so a reason sentence always
quotes a threshold worth reading: without them the open profile's 0.10 hard
threshold would drop to 0.00 and every `quality` reason would say "at or above
0.00". The `classify`/`chat` cap is not moved by posture.

### Fallback

When `difficultyLevels` is empty — an older fixture, or a backend that reports
no per-level distribution — the v1 expected-score rule runs instead:

| difficulty | needs_reasoning | low | balanced | quality |
|---|---|---|---|---|
| < 1.0 | any | fast | fast | fast |
| 1.0–2.0 | < 0.5 | fast | mid | frontier* |
| 1.0–2.0 | ≥ 0.5 | mid | mid | frontier* |
| ≥ 2.0 | any | mid | frontier | frontier |

*`quality` posture always routes to frontier once `difficulty >= 1.0`. Every
cell is then subject to the v1 cap: pull back to `mid` if the cell says
`frontier` and `difficulty < 2.5`. Without this fallback a backend that
reported nothing would look "certainly trivial" and every request would land
on `fast`.

### The reason sentence

The router's one-sentence `reason` cites the masses that decided it, e.g.
`"debug task, P(hard) 0.18 at or above 0.10 with balanced posture routes to
frontier; chose anthropic/claude-opus-5"`, or with the cap applied,
`"...routes to frontier, but a classify task caps at mid below P(hard) 0.30"`.
On the fallback path it cites the expected score the way v1 did.

Changing any threshold in this file bumps `POLICY_VERSION` (currently
`"v2"`) and needs an eval run on `packages/evals/data/routing.jsonl` before
shipping: at least 85% for Jev, at least 80% for the open backend (ADR-002
revision 2).

## Roster resolution

`packages/core/src/router/roster.ts` turns a tier into a concrete OpenRouter
model id: the first entry in that tier's list that is not excluded by a
`candidates` restriction or by a small-output exclusion (when
`long_output >= 0.7`, models listed as small-output are skipped — the
default roster's exclusion list is empty, since every default-roster model
has a large max output). If nothing in the target tier is eligible, the
search widens to the next tier up, then down, in that order — the router
would rather overpay than fail to answer. Only a roster with nothing
eligible anywhere throws.

The default roster (`DEFAULT_ROSTER` in `packages/core/src/types.ts`):

| Tier | Models |
|---|---|
| fast | `anthropic/claude-haiku-4.5`, `google/gemini-2.5-flash` |
| mid | `anthropic/claude-sonnet-5` |
| frontier | `anthropic/claude-opus-5` |

Users override this per-deployment in `milo.config.json` (`docs/config.md`)
or per-request with `milo.candidates`.

## Stickiness

A conversation fingerprint — SHA-256 of the whitespace-normalized system
prompt plus the whitespace-normalized first user message
(`packages/core/src/router/fingerprint.ts`) — pins a clean (non-degraded)
decision for **30 minutes** (`ROUTER_LIMITS.stickyTtlMs`, currently
`30 * 60 * 1000` ms). Only the first user message counts, so later turns in
the same sub-agent task keep hitting the same cache entry even as the
conversation grows. A degraded decision is never pinned — the point of
stickiness is to protect a real decision, not to lock a conversation onto
the fallback tier for half an hour. The cache is in-process (an
`STICKY_MAX_ENTRIES`-bounded, LRU-evicted map), so a hosted Milo with
multiple instances can pay one extra Jev call if a conversation's next turn
lands on a cold instance — cheap compared to a shared store.

## Jev budget and degraded fallback

Each Jev call runs under a hard budget, `ROUTER_LIMITS.jevTimeoutMs`,
defaulting to **800 ms** (configurable via `GatewayOptions.jevTimeoutMs` /
`milo serve`'s gateway construction; a cold TLS handshake to
`api.typesafe.ai` alone is roughly 350 ms). The router races the Jev call
against its own timer in addition to passing an `AbortSignal`, so it returns
within budget even if the client-level abort is ignored.

Any failure — timeout, network error, a non-2xx HTTP response, or an answer
that does not parse into `RouteSignals` (wrong shape, an out-of-range
score, an unrecognized task type) — degrades the decision:

- tier is forced to **mid**,
- `signals` is absent from the record,
- `degraded` is `true`,
- `reason` is `"routing signals unavailable (<cause>), fell back to the mid
  tier"`, where `<cause>` is one of `timeout`, `network`, `http`, or
  `validation` — never the raw upstream error text, so no key material or
  provider detail can reach a response header or the decision log.

The router never blocks a request on Jev being unavailable.

## What `milo explain` shows

`milo explain <decision-id>` (`docs/cli.md`) prints the decision id, the
chosen model and tier, the one-sentence reason, and then either a signals
block — task type, difficulty with its confidence, the per-level difficulty
distribution as a small bar chart, `needs_reasoning`, `long_output`, the Jev
request id, the Jev model name, and Jev's latency — or, for a degraded
decision, `Signals: unavailable (degraded fallback, no Jev call recorded)`.
The bar chart is what backs up the reason sentence, since policy v2 decides on
those masses; a backend that reported none prints `Difficulty levels: not
reported by this decision backend`. It also shows whether the decision was sticky, whether
it was degraded, the recorded upstream outcome (status, latency, token
counts, cost when OpenRouter reported them), the policy version, and the
creation timestamp. `--json` prints the raw `DecisionRecord` instead.

## Resolved divergence: labels vs. policy v1 at low-reasoning bands

The labeled eval set (`packages/evals/data/README.md`) labels
`expected_tier_balanced` per discrete difficulty **band** (an integer 0–3)
using a rule that leans on `needs_reasoning` at the middle bands: band 1 is
labeled `fast` when little reasoning is needed (`mid` otherwise), and band 2
is labeled `mid` when little reasoning is needed (`frontier` otherwise).

Policy v1 could not express that. At `posture: "balanced"` both of its band-1
branches returned `mid`, and its band-2 branch never read `needs_reasoning` at
all, so a low-reasoning band-1 example labeled `fast` went to `mid` and a
low-reasoning band-2 example labeled `mid` went to `frontier` — regardless of
the reasoning signal. That put a hard ceiling on agreement exactly where the
labels lean hardest, and the first live eval measured it: band 1 62.9%, band 2
42.4%, 69.2% overall.

Policy v2 resolves it from a different direction. Rather than adding
`needs_reasoning` to the balanced-posture boundary — a composite rule that was
tried and scored *worse* cross-validated (75.8%) — it reads the per-level
probability mass, which already separates those cases: an easy-looking band-2
task carries its mass on level 2, a hard one carries a tail on level 3. The
same recorded signals score band 1 at 71.4% and band 2 at 75.8%, 83.3%
overall. `packages/evals/src/report.ts` still prints the band-2 label share in
its "Policy ceiling note" section, now as a measure of how much of the ceiling
the distribution lifts.
