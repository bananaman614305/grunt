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

## Policy v1

`packages/core/src/router/policy.ts` maps `difficulty`, `needs_reasoning`,
and the request's cost posture to a tier, read as an ordered decision tree
(not an unordered table — later branches only apply once earlier ones do
not):

1. `difficulty < 1.0` → **fast**, regardless of posture or `needs_reasoning`.
2. Otherwise, if `posture === "quality"` → **frontier**.
3. Otherwise, if `difficulty >= 2.0` → **frontier** under `balanced`/`quality` posture, **mid** under `low` posture.
4. Otherwise (`1.0 <= difficulty < 2.0`): if `needs_reasoning >= 0.5` → **mid**.
5. Otherwise (`1.0 <= difficulty < 2.0` and `needs_reasoning < 0.5`): **mid** under `balanced`/`quality` posture, **fast** under `low` posture.

Then a cap is applied: a `task_type` of `classify` or `chat` is pulled back
down to **mid** if the tree above landed it on `frontier` and `difficulty <
2.5`. This keeps a cheap-to-answer task shape (a label, small talk) off the
frontier tier just because the posture was expensive.

Equivalent as a table (posture columns; `difficulty` bands are
`[0, 1.0)`, `[1.0, 2.0)`, `[2.0, 3]`):

| difficulty | needs_reasoning | low | balanced | quality |
|---|---|---|---|---|
| < 1.0 | any | fast | fast | fast |
| 1.0–2.0 | < 0.5 | fast | mid | frontier* |
| 1.0–2.0 | ≥ 0.5 | mid | mid | frontier* |
| ≥ 2.0 | any | mid | frontier | frontier |

*`quality` posture always routes to frontier once `difficulty >= 1.0`,
regardless of `needs_reasoning` — that is what "quality" posture means.
Every cell in this table is then subject to the `classify`/`chat` cap: pull
back to `mid` if the cell says `frontier` and `difficulty < 2.5`.

The router's one-sentence `reason` cites the exact numbers that decided it,
e.g. `"debug task, difficulty 2.40 with balanced posture routes to
frontier; chose anthropic/claude-opus-5"`, or with the cap applied,
`"...routes to frontier, but a classify task caps at mid below difficulty
2.50"`.

Changing any threshold in this file bumps `POLICY_VERSION` (currently
`"v1"`) and needs an eval run showing at least 85% agreement on
`packages/evals/data/routing.jsonl` before shipping (ADR-002).

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
block — task type, difficulty with its confidence, `needs_reasoning`,
`long_output`, the Jev request id, the Jev model name, and Jev's latency —
or, for a degraded decision, `Signals: unavailable (degraded fallback, no
Jev call recorded)`. It also shows whether the decision was sticky, whether
it was degraded, the recorded upstream outcome (status, latency, token
counts, cost when OpenRouter reported them), the policy version, and the
creation timestamp. `--json` prints the raw `DecisionRecord` instead.

## Known divergence: labels vs. policy v1 at low-reasoning bands

The labeled eval set (`packages/evals/data/README.md`) labels
`expected_tier_balanced` per discrete difficulty **band** (an integer 0–3,
the Jev score itself) using a rule that leans on `needs_reasoning` at the
middle bands: band 1 is labeled `fast` when little reasoning is needed
(`mid` otherwise), and band 2 is labeled `mid` when little reasoning is
needed (`frontier` otherwise).

Policy v1, read at `posture: "balanced"` — the posture the labels assume —
does not actually use `needs_reasoning` to distinguish those outcomes at
either band, even though the code branches on it:

- **Band 1** (`1.0 <= difficulty < 2.0`): the code's `reasoning >=
  REASONING_THRESHOLD` branch returns `mid`, and its "else" branch returns
  `posture === "low" ? "fast" : "mid"` — under `balanced` that is also
  `mid`. Both branches land on `mid`, so a low-reasoning band-1 example the
  eval set expects at `fast` gets routed to `mid` by policy v1 regardless of
  the reasoning signal.
- **Band 2 and above** (`difficulty >= 2.0`): the code's branch is
  `posture === "low" ? "mid" : "frontier"`, which never reads
  `needs_reasoning` at all. A low-reasoning band-2 example the eval set
  expects at `mid` gets routed to `frontier` under balanced posture.

`needs_reasoning` only changes the outcome under `posture: "low"` at band 1
(`fast` vs. `mid`) — it has no effect on any balanced-posture decision at
band 1 or band 2, which is exactly where the eval set's labels rely on it
most. `packages/evals/src/report.ts` surfaces the band-2 half of this as a
"known divergence between the labels and the table" in its "Policy ceiling
note" section, measured but not treated as a defect. A policy v2 is planned
once a live eval run (`pnpm eval --mode live`) exists to show whether
`needs_reasoning` should move the balanced-posture boundary at these bands.
