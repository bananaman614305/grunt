# ADR-006: The default roster is popular-and-cheap, and it is data

Status: accepted, 2026-09-17

## Context

`DEFAULT_ROSTER` in `packages/core/src/types.ts` shipped as four Anthropic
model ids written by hand when the repo was scaffolded: Haiku and Gemini
Flash on `fast`, Sonnet on `mid`, Opus on `frontier`. Nothing about that list
was measured, and two things about it were wrong.

**It priced the product out of its own market.** Opus and Fable cost $25 to
$50 per million output tokens. Nobody reaches for OpenRouter to buy those —
they are bought on a subscription, and the agent running on that subscription
is the one *calling* Milo, not the one Milo calls. Milo's intended shape is a
pair: a frontier planner the user already pays for, orchestrating, and Milo
underneath it routing the implementation sub-tasks to something cheap. A
default roster whose `frontier` tier is Opus inverts that: the expensive model
gets called twice.

**It was prose, not data.** The list lived in a TypeScript literal, the docs
repeated it in five places by hand, and nothing recorded why any entry was
there or when it was last true. Model prices and popularity move weekly.

## Decision

### The roster is a generated data file

`packages/core/src/router/roster-default.json` holds the table with its
provenance: per model an id, input and output price per million tokens, weekly
usage rank, weekly token count, context length and max output; per file a
collection date, the two sources the numbers came from, the band rules, and
the ceiling above which nothing is ever chosen.

`packages/core/src/router/roster-default.ts` loads it and derives:

- `DEFAULT_ROSTER: Roster` — the ids alone. **The `Roster` type is
  unchanged**, so the router, the config schema and every existing caller see
  exactly what they saw before.
- `DEFAULT_ROSTER_INFO: RosterInfo` — the whole record, for the surfaces that
  disclose it.
- `DEFAULT_SMALL_OUTPUT_MODELS` — every entry whose `maxOutputTokens` is below
  `SMALL_OUTPUT_BELOW_TOKENS` (60,000), which is what `resolveModel` skips
  when `long_output >= 0.7`. That list used to be an empty array with a
  comment asking operators to maintain it; it is now read off the same data
  that says what each model can do.

`types.ts` re-exports all of it, so `import { DEFAULT_ROSTER } from
"@milo/core"` is unchanged at every call site.

### The rule

Applied by `packages/evals/scripts/roster-refresh.ts` against OpenRouter's
public model catalogue and the weekly usage ranking for the programming
category:

1. Fold the ranking onto current ids: a dated build counts as its undated id,
   and `:free`, `:batch`, `:contributor` and the other data-sharing plan
   variants are dropped rather than counted as models of their own.
2. Require a catalogue entry, tool support, and a readable price.
3. Reject anything at or above **$5 per million output tokens**.
4. Take the first ten survivors in usage order.
5. Tier by output price: fast at most $0.35/M, mid at most $1.50/M, frontier
   at most $5/M.
6. Order each tier by usage rank, except that a model capping output below
   60,000 tokens sorts last, since the long-output rule skips it and it must
   therefore never be a tier's default.

Shipped as version `2026-09-17`: fast is deepseek-v4-flash, glm-5.3-flash,
mimo-v2.5, hy3; mid is gpt-5.6-luna, deepseek-v4.1-flash; frontier is glm-5.3,
gemini-3.8-flash, hy4-preview, nemotron-3-ultra.

### It is disclosed, not buried

A router that picks models on the user's behalf has to say which ones.

- `GET /v1/roster` (bearer-gated) — the running roster with prices, ranks,
  provenance, which tier each posture favors, and both override paths.
- `GET /` — `roster.version`, the ids per tier, and a one-line `rosterNote` in
  JSON; the HTML page renders the three tiers with output prices.
- `GET /v1/models` — `milo/auto`'s description names the roster version.
- `/setup.md` and `skills/milo/SKILL.md` — the full table, plus an instruction
  to tell the user about it once while configuring.
- `milo roster` — the same table at the terminal, with the source of each row.

### It is refreshed weekly

`.github/workflows/roster-refresh.yml` runs the script every Monday and opens
a pull request when the output moves. It never commits to `main`: a roster
change alters what every unconfigured deployment spends, and that deserves a
human looking at a diff.

## Consequences

- Every deployment that never configured a roster changes model on upgrade.
  The tier *names* and the routing policy are untouched; only the ids behind
  them move, and every one of them is cheaper than what it replaces.
- Tests that hard-coded the old Anthropic ids now either assert the new
  defaults or use an explicit test roster.
- `resolveJsonModule` is on repo-wide and `packages/core`'s tsconfig includes
  the one JSON file it imports, so `tsc -b` emits it next to the compiled
  module.
- The ranking is scraped, not read from an API, because OpenRouter publishes
  no usage API. The scrape is tolerant and, when it finds nothing, the script
  falls back to the committed snapshot in `packages/evals/scripts/popular.json`
  and says so rather than shipping a roster built on nothing.
- The selection rule is a pure function with its own unit tests over a
  recorded catalogue fixture; no test touches the network.
