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
   <tier> tier by the request"`. This path needs no backend, so it answers
   even while the circuit breaker is open.
2. **Sticky hit.** If the conversation's fingerprint is already pinned *at
   this user-turn count* (see "Stickiness" below), the pinned decision is
   reused, with a fresh decision id and `sticky: true`. On a miss in the
   in-process cache, the `StickyStore` is consulted if one is configured.
3. **Coalesce.** If an identical ask — same fingerprint, same user-turn
   count — is already waiting on Jev, this request joins it rather than
   making a second call.
4. **Ask Jev.** Otherwise the router makes one call to Jev's
   `/v1/systemone` endpoint, applies the policy table to the answer, and
   resolves a model from the roster. The result gets pinned to the
   fingerprint for future turns.

If the Jev call fails or exceeds its budget, `route` **throws**
`RoutingUnavailableError` and the gateway answers 503. There is no fallback
tier — see "When routing fails".

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
the decision log, for `milo explain`, and as the rule used when an answer
carries no distribution.

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

`packages/core/src/router/policy.ts` decides on numbers read off the
difficulty distribution rather than on the expected score:

- **`P3`** — probability mass on level 3 ("hard").
- **`P2 + P3`** — mass on level 2 or above ("substantial or more").
- **`P1 + P2 + P3`** — mass on level 1 or above ("routine or more").

Under balanced posture, with the thresholds from the policy profile:

1. the fast gate's mass `< fastBelowMass` → **fast**.
2. Otherwise `P3 >= frontierHardMass` **or** `P2 + P3 >= frontierUpperMass` → **frontier**.
3. Otherwise → **mid**.

The fast gate reads `P1 + P2 + P3` or `P2 + P3`, per the profile's
`fastMassFromLevel`. Jev's is `1`, because Jev puts real mid-difficulty work on
level 1 — its expected-mid examples average P0 0.17 / P1 0.62 / P2 0.18 /
P3 0.03 — so gating on `P2 + P3` waved most of that work through to `fast`
(ADR-002 revision 3). The frontier gates always read `P3` and `P2 + P3`,
whichever level the fast gate starts from.

Then the cap: a `task_type` of `classify` or `chat` is pulled back to **mid**
whenever step 2 landed it on `frontier` and `P3 < cappedFrontierHardMass`.
This keeps a cheap-to-answer task shape (a label, small talk) off the frontier
tier unless the signal is genuinely confident the work is hard.

### The profile

The thresholds describe how a scorer spreads its probability mass, not the
routing question, so they are fitted from an eval run and do not transfer
between scorers. Jev is the only decision backend (ADR-002 revision 3), so
there is one profile — `JEV_PROFILE` in `policy.ts`:

| fast gate | fast below | frontier `P3` | frontier `P2+P3` | cap lifts at `P3` |
|---|---|---|---|---|
| level 1+ | 0.35 | 0.05 | 0.65 | 0.25 |

It is fitted and validated on the first live Jev run: a replay of the 120
committed fixtures scores **81.7%** overall (band 0 96.3%, band 1 60.0%,
band 2 84.8%, band 3 92.0%) with task-type accuracy 90.8% and every example
scored. The fast/mid boundary is where the remaining error is — 13
fast-labeled examples are predicted `mid`.

`chooseTier(signals, posture, profile = JEV_PROFILE)` still takes a
`PolicyProfile`, so a tuning or cross-validation run can try a candidate
threshold set without editing `policy.ts`, and `RouterOptions.profile` passes
one through. Nothing dispatches on the backend's reported model name any more;
`signals.jevModel` is recorded and nothing else. Milo asks `jev-latest` only —
`jev-preview`'s calibration changes without notice, and a profile fitted
against one scorer does not describe another.

### Posture

Posture adjusts the rule at both ends rather than replacing it:

| posture | effect |
|---|---|
| `low` | the fast threshold raised to at least **0.10**, and the outcome capped at **mid** — the frontier conditions are never evaluated |
| `balanced` | the profile as written |
| `quality` | both frontier thresholds **−0.10**, floored at **0.02** (hard) and **0.10** (upper), and anything not fast goes to frontier once `P2 + P3 >= 0.40` |

`low` posture never returns `frontier`, however much mass sits on level 3.
That is the promise a caller makes when they pick it, and it is the same
ceiling policy v1 had. Jev's fast bar is already 0.35, well above `low`'s
floor, so `low` does not move it. The `quality` floors exist so a reason
sentence always quotes a threshold worth reading: without them Jev's 0.05 hard
threshold would go negative and every `quality` reason would say "at or above
-0.05". The `classify`/`chat` cap is not moved by posture.

### When there is no distribution

When `difficultyLevels` is empty — an older fixture, or an answer that carries
no per-level distribution — the v1 expected-score rule runs instead. This is
not a routing fallback (routing has none); it is how an answer without a
distribution is still read:

| difficulty | needs_reasoning | low | balanced | quality |
|---|---|---|---|---|
| < 1.0 | any | fast | fast | fast |
| 1.0–2.0 | < 0.5 | fast | mid | frontier* |
| 1.0–2.0 | ≥ 0.5 | mid | mid | frontier* |
| ≥ 2.0 | any | mid | frontier | frontier |

*`quality` posture always routes to frontier once `difficulty >= 1.0`. Every
cell is then subject to the v1 cap: pull back to `mid` if the cell says
`frontier` and `difficulty < 2.5`. Without this rule an answer that reported
no distribution would look "certainly trivial" and every such request would
land on `fast`.

### The reason sentence

The router's one-sentence `reason` cites the masses that decided it, e.g.
`"debug task, P(hard) 0.10 at or above 0.05 with balanced posture routes to
frontier; chose z-ai/glm-5.3"`, or with the cap applied,
`"...routes to frontier, but a classify task caps at mid below P(hard) 0.25"`.
When the fast gate decided it, the sentence names the level it read —
`"P(level 1+) 0.20 below 0.35 ..."`. On the expected-score path it cites the
score the way v1 did.

Changing any threshold in this file bumps `POLICY_VERSION` (currently
`"v2"`) and needs an eval run on `packages/evals/data/routing.jsonl` before
shipping: the target is 85% (ADR-002), and CI gates at 0.80.

## Roster resolution

### Which roster

A tier means nothing without a table to look it up in, and since ADR-008 one
deployment can be running several. The gateway resolves one per request in
`packages/gateway/src/routes/shared.ts` (`resolveRoster`) and hands it to the
router on the `RouteRequest`:

1. the roster stored against this caller's key hash, if there is one;
2. the deployment's `roster` from `milo.config.json`;
3. `DEFAULT_ROSTER`.

The first that exists wins whole. `Router`'s constructor roster is the
fallback for a caller that passes none — `packages/evals`, and any direct use
of core — so nothing outside the gateway had to change.

Two consequences worth stating: `milo.candidates` filters *within* the table
that won rather than adding a fourth level, and the conversation fingerprint
is scoped to the caller's key hash (`fingerprint(messages, scope)`), because a
sticky decision shared between two keys could otherwise serve one of them a
model that is not on their roster at all.

A user's list is tiered by `tierByPrice`
(`packages/core/src/router/roster-from-models.ts`) on the same output-price
bands as the default roster, in the order they gave, with small-output and
tool-less models sorted last so neither is ever a tier's default. The one rule
that does not carry over is `excludedAbove`: it exists to stop Milo picking a
$5-and-up model for someone who never asked, and a user who names Opus asked.

### Which model

`packages/core/src/router/roster.ts` turns a tier into a concrete OpenRouter
model id: the first entry in that tier's list that is not excluded by a
`candidates` restriction or by the small-output exclusion. When
`long_output >= 0.7`, every model in `DEFAULT_SMALL_OUTPUT_MODELS` is
skipped — that list is not maintained by hand, it is every default-roster
entry whose `maxOutputTokens` is below `SMALL_OUTPUT_BELOW_TOKENS` (60,000),
both read off the roster data. An operator running a custom roster with a
short-output model in it passes `smallOutputModels` per call. If nothing in
the target tier is eligible, the search widens to the next tier up, then
down, in that order — the router would rather overpay than fail to answer.
Only a roster with nothing eligible anywhere throws, and the small-output
exclusion is absolute: Milo will fail the request rather than return a
truncated answer.

### The default roster

`DEFAULT_ROSTER` (`packages/core/src/types.ts`, re-exported from
`packages/core/src/router/roster-default.ts`) is the ids of
`packages/core/src/router/roster-default.json`, which is data with its
provenance attached — prices, weekly usage ranks, band rules, collection
dates. `DEFAULT_ROSTER_INFO` is the whole record, and it is what `GET
/v1/roster`, the root page, `/setup.md`, the skill and `milo roster` print, so
no surface can describe a roster the router is not running.

Version `2026-09-17`, collected from OpenRouter's weekly usage ranking for the
programming category (week ending 2026-09-16) and its public model catalogue:

| Tier | Model | In $/M | Out $/M | Usage rank | Weekly tokens |
|---|---|---|---|---|---|
| fast | `deepseek/deepseek-v4-flash` | 0.07 | 0.14 | 2 | 15.4T |
| fast | `z-ai/glm-5.3-flash` | 0.09 | 0.30 | 4 | 11.3T |
| fast | `xiaomi/mimo-v2.5` | 0.14 | 0.28 | 6 | 7.8T |
| fast | `tencent/hy3` | 0.0825 | 0.33 | 7 | 4.5T |
| mid | `openai/gpt-5.6-luna` | 0.20 | 1.20 | 1 | 17.3T |
| mid | `deepseek/deepseek-v4.1-flash` | 0.15 | 0.60 | 5 | 10.3T |
| frontier | `z-ai/glm-5.3` | 1.40 | 4.40 | 9 | 2.5T |
| frontier | `google/gemini-3.8-flash` | 0.75 | 3.75 | 10 | 2.2T |
| frontier | `tencent/hy4-preview` | 0.834 | 2.501 | 3 | 12.0T |
| frontier | `nvidia/nemotron-3-ultra-550b-a55b` | 0.625 | 3.125 | 8 | 3.5T |

The rule that produced it, and that
`packages/evals/scripts/roster-refresh.ts` re-applies every week:

1. Fold the ranking onto current ids — a dated build counts as its undated
   id, and `:free`, `:batch`, `:contributor` and the other data-sharing plan
   variants are dropped rather than counted as models of their own.
2. Require a catalogue entry, tool support, and a readable price.
3. Reject anything at or above **$5 per million output tokens**
   (`excludedAbove`). This is what keeps Fable, Opus, Astra and Sonnet out:
   Milo's intended caller is a frontier agent on a subscription handing its
   sub-tasks down, so the router's job is the cheap half of that pair.
4. Take the first ten survivors in usage order; their `usageRank` is their
   position in that list.
5. Tier by output price: fast at most $0.35/M, mid at most $1.50/M, frontier
   at most $5/M.
6. Order each tier by usage rank, except that a model capping output below
   60,000 tokens sorts last — the long-output rule skips it, so it must never
   be a tier's default. `nvidia/nemotron-3-ultra-550b-a55b` (32,768) is the
   one today, which is why rank 8 sits last on the frontier tier while
   `tencent/hy4-preview` (64,000), rank 3, leads it.

Because step 6 can only demote and never promote, the first entry of every
tier is always a model that can produce a long answer — so a `long_output`
request changes which model answers only when the tier default is itself
excluded by `candidates`.

Users override the whole thing per key with `PUT /v1/roster`
(`docs/api/gateway.md`), per deployment in `milo.config.json`
(`docs/config.md`), or per request with `milo.candidates`; an id Milo does not
ship is reported as `source: "config"` (or `"user"`) by `GET /v1/roster` with
no price, because Milo does not know what somebody else's choice costs without
spending a call to find out — `PUT` has just spent one, so its answer does
carry the prices.

## Stickiness

A conversation fingerprint — SHA-256 of the whitespace-normalized system
prompt plus the whitespace-normalized first user message
(`packages/core/src/router/fingerprint.ts`) — pins a decision for **30
minutes** (`ROUTER_LIMITS.stickyTtlMs`, currently `30 * 60 * 1000` ms, and
settable per router with `RouterOptions.stickyTtlMs`). Only the first user
message counts, so every later turn of the same sub-agent task lands on the
same key even as the conversation grows.

The gateway mixes the caller's key hash into that digest (`fingerprint`'s
optional `scope`), so two users who send the same conversation get their own
decisions. Before per-key rosters that only meant a shared Jev call; now it
would mean one user being served a model from another user's roster. The
digest keeps its shape, so the decision log and the
`/v1/decisions?fingerprint=` filter are unaffected.

### A sticky hit is qualified by the user-turn count

An entry also records `userTurns` — how many `user` messages the decision was
made for — and is reused **only** when the request's count matches.

- A **tool-result continuation** adds `assistant` and `tool` messages but no
  `user` message. The count is unchanged, the pinned decision applies, and the
  model stays put. This is what stickiness is for: switching models mid
  tool-loop breaks tool-call continuity and throws away the provider's prompt
  cache.
- A **new user turn** moves the count. That is a different question in an old
  conversation, and it may be far harder or far easier than what was routed
  before. The router calls Jev again with the full recent context and replaces
  the entry. Without this, "now make the whole module concurrency-safe" was
  served the tier chosen for "rename res to rows", for up to half an hour.

### The store

The in-process cache (an `STICKY_MAX_ENTRIES`-bounded, LRU-evicted map) is the
fast path. `RouterOptions.stickyStore` backs it with a `StickyStore`
(`packages/core/src/router/sticky-store.ts`): the router consults the store on
a memory miss and writes through on every write, so a redeploy or a second
instance does not re-ask Jev for every live conversation. `DecisionLog`
implements `StickyStore` over a `sticky` table, so the gateway can pass the log
as the store. A store that is unavailable is reported through `onError` and
otherwise ignored — it costs one extra Jev call, never a failed request.

### Coalescing

Two requests that arrive together with the same fingerprint *and* the same
user-turn count share one Jev call. Each caller gets its own decision id, so
the log keeps one row per request and the gateway can attach each request's
upstream outcome to its own row; the callers that joined an existing call are
marked `sticky: true`, and every one of them carries the `jevRequestId` of the
single call that answered. The log is then honest about both what was served
and what was spent.

## When routing fails

Each Jev call runs under a hard total budget, `ROUTER_LIMITS.jevTimeoutMs`,
defaulting to **3,000 ms** (configurable via `GatewayOptions.jevTimeoutMs` /
`milo serve`'s gateway construction). The budget covers the client's retries
and backoff, not just one HTTP attempt. The router races the Jev call against
its own timer in addition to passing an `AbortSignal`, so it returns within
budget even if the client-level abort is ignored.

### There is no fallback tier

Any failure — timeout, network error, a non-2xx HTTP response, or an answer
that does not parse into `RouteSignals` (wrong shape, an out-of-range score, an
unrecognized task type) — makes `Router.route` **throw**
`RoutingUnavailableError`. It never returns a guessed decision, and nothing is
written to the decision log, because no decision was made.

The error carries:

| field | meaning |
|---|---|
| `cause_` | `timeout`, `network`, `http`, `validation`, `rate_limited`, or `breaker_open` |
| `status` | the upstream HTTP status, for an `http` or `rate_limited` cause |
| `requestId` | Jev's request id, when the response carried one |
| `retryAfterMs` | what the server's `Retry-After` asked for, or the breaker's remaining cooldown |

The message names the class of failure and never the upstream error text, so
no key material or provider detail can reach a response header or the decision
log (ADR-003). The gateway turns it into a 503, or a 429 for `rate_limited`.

Milo used to answer `mid` here and mark the decision degraded. That reads as
robustness and is not: a caller who sent `milo/auto` asked to be routed, and a
silent `mid` is a wrong answer at Sonnet prices that looks exactly like a right
one. See ADR-002 revision 3.

A request that names a model explicitly is unaffected — it never needed a
routing answer and is forwarded to OpenRouter untouched. A request that sets
`milo.tier` is unaffected too: it skips Jev entirely.

### Retries

The Jev client (`packages/core/src/jev/client.ts`) retries network errors and
the statuses that mean "not now" — **429**, **503**, **529** — with
exponential backoff and **full jitter**: attempt *n* waits a uniform random
delay in `[0, 200ms * 2^n)`, up to 3 retries. Equal delays would have every
client that was mid-request retry in lockstep and reproduce the herd on each
round; full jitter spreads them across the window. No other 4xx is retried —
those are verdicts on the request, and will not change.

A `Retry-After` header wins over the computed backoff, in both its forms
(delay-seconds and an HTTP date). The client will not start an attempt it
cannot finish inside the caller's budget, and will not sleep past the
deadline.

### The circuit breaker

Three consecutive **transport** failures — `network`, `timeout`, or an HTTP
5xx — open the breaker for **30 seconds**. While it is open, `route` fails
immediately with `breaker_open` and the remaining cooldown as `retryAfterMs`,
rather than making every caller spend the full budget rediscovering the
outage. After the cooldown it half-opens and lets exactly one request through
to probe: that probe closes the breaker if it reaches Jev, and re-opens it for
another full cooldown if it does not.

A `validation` failure or a 4xx does **not** count toward opening it. Jev
answered; the problem is the question or the request, and taking routing down
for thirty seconds over one malformed prompt would be its own outage.
`Router.breakerState()` reports the current state for a health endpoint.

Sticky hits and forced tiers are still served while the breaker is open —
neither needs a backend.

## What `milo explain` shows

`milo explain <decision-id>` (`docs/cli.md`) prints the decision id, the
chosen model and tier, the one-sentence reason, and then either a signals
block — task type, difficulty with its confidence, the per-level difficulty
distribution as a small bar chart, `needs_reasoning`, `long_output`, the Jev
request id, the Jev model name, and Jev's latency. A forced-tier decision has
no signals block, because it never asked Jev. The bar chart is what backs up
the reason sentence, since policy v2 decides on those masses; an answer that
reported none prints `Difficulty levels: not reported`. It also shows whether
the decision was sticky, the recorded upstream outcome (status, latency, token
counts, cost when OpenRouter reported them), the policy version, and the
creation timestamp. `--json` prints the raw `DecisionRecord` instead.

A request that could not be routed has no decision to explain: it never
reached the log.

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
same recorded signals, replayed against Jev under the fitted profile, score
band 1 at 60.0% and band 2 at 84.8%, 81.7% overall.
`packages/evals/src/report.ts` still prints the band-2 label share in its
"Policy ceiling note" section, now as a measure of how much of the ceiling the
distribution lifts. Band 1 remains the weak spot: the fast/mid boundary is
where the labels lean hardest on `needs_reasoning`, and the masses only
partly recover it.
