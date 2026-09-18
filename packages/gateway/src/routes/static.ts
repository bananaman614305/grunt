/**
 * Agent-facing static routes -- no auth, so an agent (or a bare `curl`) can
 * read them before it has an OpenRouter key.
 *
 * `GET /setup.md`  -- the "set me up with Milo" instructions for an agent.
 * `GET /llms.txt`  -- the llms.txt convention, pointing at `/setup.md`.
 * `GET /skill.md`  -- the repository skill (`skills/milo/SKILL.md`) served
 * over HTTP so `curl` works without cloning the repo. Read once at module
 * load from the file itself -- there is exactly one copy of this text, so it
 * cannot drift from what `skills/milo/SKILL.md` says.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Context, Hono } from "hono";
import { DEFAULT_ROSTER_INFO, ROSTER_NOTE, TIERS } from "@milo/core";

/**
 * `packages/gateway/{src,dist}/routes/static.{ts,js}` sit at the same depth
 * under the repo root either way, so one relative path resolves whether this
 * module runs from source (tests) or from the compiled `dist/` the Docker
 * image ships (which copies `skills/` alongside `packages/`, see the
 * Dockerfile).
 *
 * Read lazily, on the first `/skill.md` request, rather than at import time:
 * `@milo/gateway` is imported by every CLI command, including ones that
 * never serve HTTP (`milo explain`, `milo roster`, `--help`), and those
 * should not fail just because they happen to run somewhere `skills/` was
 * not copied alongside `dist/`.
 */
const SKILL_MD_PATH = fileURLToPath(new URL("../../../../skills/milo/SKILL.md", import.meta.url));
let cachedSkillMd: string | undefined;
function skillMd(): string {
  cachedSkillMd ??= readFileSync(SKILL_MD_PATH, "utf8");
  return cachedSkillMd;
}

/** Tokens per week as the docs print them: `15.4T`. */
function tokens(count: number): string {
  return `${(count / 1e12).toFixed(1)}T`;
}

/**
 * The default roster as a Markdown table, generated from the same JSON the
 * router reads. Written out rather than hand-maintained so `/setup.md` cannot
 * describe a roster the gateway is not running.
 */
export function rosterTable(): string {
  const rows = TIERS.flatMap((tier) =>
    DEFAULT_ROSTER_INFO.tiers[tier].map(
      (m) =>
        `| ${tier} | \`${m.id}\` | ${m.inputUsdPerM} | ${m.outputUsdPerM} | ${m.usageRank} | ${tokens(m.weeklyTokens)} |`,
    ),
  );
  return [
    "| Tier | Model | In $/M | Out $/M | Usage rank | Weekly tokens |",
    "|---|---|---|---|---|---|",
    ...rows,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// begin: per-key roster onboarding (ADR-008)
// ---------------------------------------------------------------------------

/**
 * The first section of `/setup.md`, and the reason the rest of it works: ask
 * the user which models they want before writing any config.
 *
 * Kept as its own function, spliced into `setupMd` at one call site, so this
 * text can be edited (or moved) without touching the rest of the page.
 */
export function askBeforeConfiguringSection(base: string): string {
  return `## Ask before configuring

**Ask these two questions first, before you write any config or set any
environment variable:**

1. *Which OpenRouter models do you already use?*
2. *Which should Milo choose from?*

Most people who reach Milo came from OpenRouter and already have models they
like. Milo's job is to route between *their* models, not to talk them into
someone else's list. Ask, then configure.

Ask both questions before anything else; storing the answer needs the user's
OpenRouter key, so make the call below as soon as you have it (step 1).

### If they name models

Store the list against their key with one call. Use the user's own OpenRouter
key -- this is the same key everything else here uses:

\`\`\`sh
curl -sS -X PUT ${base}/v1/roster \\
  -H "Authorization: Bearer \${OPENROUTER_API_KEY}" \\
  -H "content-type: application/json" \\
  -d '{"models":["deepseek/deepseek-v4-flash","openai/gpt-5.6-luna","anthropic/claude-opus-5"]}'
\`\`\`

The body is exactly this shape -- a flat list of OpenRouter model ids, in the
user's own order of preference:

\`\`\`json
{
  "models": [
    "deepseek/deepseek-v4-flash",
    "openai/gpt-5.6-luna",
    "anthropic/claude-opus-5"
  ]
}
\`\`\`

Milo tiers them by output price using the same bands as the default roster
(fast at most $${DEFAULT_ROSTER_INFO.bands.fast.maxOutputUsdPerM}/M, mid at most
$${DEFAULT_ROSTER_INFO.bands.mid.maxOutputUsdPerM}/M, frontier at most
$${DEFAULT_ROSTER_INFO.bands.frontier.maxOutputUsdPerM}/M), keeps the user's order inside each tier, and
sorts a model that cannot hold a long answer last. A premium model the user
named -- Opus, Fable, Astra, Sonnet -- is kept and placed on \`frontier\`: the
$${DEFAULT_ROSTER_INFO.excludedAbove}/M ceiling only stops Milo choosing such a model on its own.

If the user wants to place models by hand instead, send tiers:

\`\`\`json
{
  "tiers": {
    "fast": ["deepseek/deepseek-v4-flash"],
    "mid": ["openai/gpt-5.6-luna"],
    "frontier": ["anthropic/claude-opus-5"]
  }
}
\`\`\`

An id OpenRouter does not have comes back as a \`400\` naming it; fix the id
and send the call again. On success the response carries the resulting roster,
with each model's price and the tier it landed in, and a \`table\` field with
the same thing as Markdown. **Show that table to the user once**, then carry
on with the setup steps below.

### If they say "just pick"

Use the default roster. Show them the top-ten table in "What Milo picks by
default" below, once, and carry on. Nothing needs storing.

### What Milo keeps

Only a SHA-256 hash of the key, as the row's own name -- never the key, and
nothing else about the user (ADR-003). \`GET ${base}/v1/roster\` with the same
key returns what is stored, and:

\`\`\`sh
curl -sS -X DELETE ${base}/v1/roster \\
  -H "Authorization: Bearer \${OPENROUTER_API_KEY}"
\`\`\`

removes it, putting that key back on the default roster.

`;
}

// ---------------------------------------------------------------------------
// end: per-key roster onboarding
// ---------------------------------------------------------------------------

/** The request's own scheme and host, honoring a TLS-terminating proxy. */
function origin(c: Context): string {
  const url = new URL(c.req.url);
  const proto = c.req.header("x-forwarded-proto");
  if (proto === "https" || proto === "http") url.protocol = `${proto}:`;
  return `${url.protocol}//${url.host}`;
}

function setupMd(base: string): string {
  return `# Setting up Milo

Milo is OpenRouter with an actual routing mechanism: send one OpenRouter key
and \`model: "milo/auto"\`, and a small decision model picks the right tier
(fast, mid, or frontier) for each request from the task's type and
difficulty. This page is written for an agent that was told "set me up with
Milo" -- follow it in order.

${askBeforeConfiguringSection(base)}## What Milo is for

Milo is built for a two-model setup. A frontier agent the user already pays
for on a subscription -- Opus, Fable, Sol, whatever they run -- plans the work
and orchestrates it. The implementation sub-tasks it hands off go through
Milo, which routes each one to a model that is cheap and popular on
OpenRouter. The good planner stays; what stops is paying frontier prices for
the hundred small edits, tests and lookups underneath it. If you are that
planning agent, keep planning where you are and point the sub-tasks here.

## 1. Get an OpenRouter key from the user

Milo needs the *user's* OpenRouter key. Never invent one, reuse a key from
another provider, or fabricate a placeholder and continue as if it worked.

- If the user already gave you a key in this conversation, use it.
- If your harness exposes a credential vault or secret store, check there
  first (e.g. a stored "OpenRouter" credential) before asking the user to
  paste it into chat again.
- Otherwise, ask the user for their OpenRouter key before doing anything else.

Milo only checks that the key is bearer-shaped; it never validates it against
OpenRouter and never stores it (see \`docs/api/gateway.md\`).

## 2. Configure the client

Base URLs below are this Milo instance's own address (\`${base}\`). If you are
looking at a copy of this file fetched from a different deployment, use that
deployment's own address instead -- everything here is generated from the
request that fetched it.

### OpenAI-SDK-style tools

Base URL is \`${base}/v1\`; API key is the OpenRouter key; model is
\`milo/auto\`.

**Python**

\`\`\`python
from openai import OpenAI

client = OpenAI(base_url="${base}/v1", api_key="sk-or-...")
resp = client.chat.completions.create(
    model="milo/auto",
    messages=[{"role": "user", "content": "..."}],
)
\`\`\`

**TypeScript**

\`\`\`ts
import OpenAI from "openai";

const client = new OpenAI({ baseURL: "${base}/v1", apiKey: "sk-or-..." });
const resp = await client.chat.completions.create({
  model: "milo/auto",
  messages: [{ role: "user", content: "..." }],
});
\`\`\`

### Claude Code

Three environment variables and \`--model\`, no \`/v1\` on the base URL (Claude
Code appends its own path):

\`\`\`sh
export ANTHROPIC_BASE_URL="${base}"
export ANTHROPIC_AUTH_TOKEN="<the user's OpenRouter key>"
export ANTHROPIC_API_KEY=""
claude --model milo/auto
\`\`\`

Or committed as project-scoped settings in \`.claude/settings.json\` (put the
key in \`.claude/settings.local.json\` instead if this file is checked in):

\`\`\`json
{
  "env": {
    "ANTHROPIC_BASE_URL": "${base}",
    "ANTHROPIC_AUTH_TOKEN": "<the user's OpenRouter key>",
    "ANTHROPIC_API_KEY": ""
  },
  "model": "milo/auto"
}
\`\`\`

Claude Code prints a harmless \`model: milo/auto is not in the model catalog\`
warning at startup -- this is expected and safe to ignore.

### Generic OpenAI-compatible tools

Cursor, Continue, Codex CLI, Aider, and similar tools all take the same three
fields:

| Field | Value |
|---|---|
| Base URL | \`${base}/v1\` |
| API key | the user's OpenRouter key |
| Model | \`milo/auto\` |

<!-- Codex: begin -->
### Codex CLI

Codex is the exception: it needs a custom provider in \`~/.codex/config.toml\`
rather than three plain settings, and since Codex 0.154 the only supported
wire protocol is the Responses API, which Milo serves at \`POST /v1/responses\`.

\`\`\`toml
model_provider = "milo"
model = "milo/auto"

[model_providers.milo]
name = "Milo"
base_url = "${base}/v1"
env_key = "OPENROUTER_API_KEY"
wire_api = "responses"
\`\`\`

\`env_key\` names the environment variable Codex reads the key from:

\`\`\`sh
export OPENROUTER_API_KEY="<the user's OpenRouter key>"
codex --model milo/auto
\`\`\`

Or for one session, with no file to edit:

\`\`\`sh
codex -c model_provider=milo \\
      -c 'model_providers.milo={name="Milo",base_url="${base}/v1",env_key="OPENROUTER_API_KEY",wire_api="responses"}' \\
      --model milo/auto
\`\`\`

Codex does not show response headers, so read a decision back from
\`${base}/v1/decisions/<id>\` (step 4) instead.
<!-- Codex: end -->

## 3. Verify it works

\`\`\`sh
curl -sS ${base}/healthz
\`\`\`

Then send one request and read the headers back:

\`\`\`sh
curl -sS -D - -o /dev/null ${base}/v1/chat/completions \\
  -H "Authorization: Bearer \${OPENROUTER_API_KEY}" \\
  -H "content-type: application/json" \\
  -d '{"model":"milo/auto","messages":[{"role":"user","content":"hi"}]}'
\`\`\`

A routed response carries six \`x-milo-*\` headers: \`x-milo-decision-id\`,
\`x-milo-model\`, \`x-milo-tier\`, \`x-milo-task-type\`, \`x-milo-difficulty\`, and
\`x-milo-sticky\`.

## 4. Read a decision

\`\`\`sh
curl -sS ${base}/v1/decisions/<x-milo-decision-id> \\
  -H "Authorization: Bearer \${OPENROUTER_API_KEY}"
\`\`\`

Returns the full decision record: signals, tier, model, and a human-readable
\`reason\` string explaining the choice.

## 5. Steer routing with the \`milo\` field

A chat completions body can include a top-level \`milo\` field, stripped
before the request reaches OpenRouter:

\`\`\`json
{
  "model": "milo/auto",
  "messages": [{ "role": "user", "content": "..." }],
  "milo": { "posture": "low", "candidates": ["deepseek/deepseek-v4-flash"], "tier": "fast" }
}
\`\`\`

- \`posture\` -- \`"low"\`, \`"balanced"\` (default), or \`"quality"\`. Shifts the
  policy table toward cheaper or more capable tiers.
- \`candidates\` -- restricts the roster to these model ids for this request.
- \`tier\` -- forces \`"fast"\`, \`"mid"\`, or \`"frontier"\` directly, skipping
  classification entirely.

Sending any model id other than \`"milo/auto"\` passes the request straight
through to OpenRouter, unrouted -- no classification call, no decision, no
\`x-milo-*\` headers.

## 6. What Milo picks by default

**Tell the user this once, while you are configuring Milo.** They have handed
the model choice to a router; they should know what it will choose before the
first bill, not after.

Default roster \`${DEFAULT_ROSTER_INFO.version}\`:

${rosterTable()}

\`nvidia/nemotron-3-ultra-550b-a55b\` caps output at 32,768 tokens, below the
${DEFAULT_ROSTER_INFO.smallOutputBelowTokens} floor, so it sorts last in its tier and is skipped
outright whenever a long answer is expected; \`google/gemini-3.8-flash\` (65,536) stays eligible.

**How this list was made.** Collected ${DEFAULT_ROSTER_INFO.version} from
${DEFAULT_ROSTER_INFO.source.usage} and ${DEFAULT_ROSTER_INFO.source.pricing}. Take the
${DEFAULT_ROSTER_INFO.topModels} most-used models after folding dated builds into their current
id and dropping \`:free\`, \`:batch\` and the other data-sharing plan variants,
a pre-release build (an id ending \`-preview\`, \`-beta\`, \`-alpha\` or \`-rc\`),
anything that cannot call a tool, and anything at or above
$${DEFAULT_ROSTER_INFO.excludedAbove} per million output tokens. Tier them by output price:
fast at most $${DEFAULT_ROSTER_INFO.bands.fast.maxOutputUsdPerM}/M, mid at most
$${DEFAULT_ROSTER_INFO.bands.mid.maxOutputUsdPerM}/M, frontier at most
$${DEFAULT_ROSTER_INFO.bands.frontier.maxOutputUsdPerM}/M. The roster is regenerated from
OpenRouter's rankings every week, so this table moves as the rankings do.

${ROSTER_NOTE}

**Choosing your own models.** Milo never locks the user into this list.

- Per request (\`milo.candidates\`): \`"milo": { "candidates": ["anthropic/claude-opus-5"] }\`
  restricts that one request to the ids you name. Any OpenRouter id works,
  premium models included.
- Per deployment: set \`roster\` in \`milo.config.json\` with your own ids per
  tier and restart \`milo serve\`. For example, to put Opus on the frontier
  tier and leave the rest of the defaults alone:

\`\`\`json
{
  "roster": {
    "fast": ["deepseek/deepseek-v4-flash", "z-ai/glm-5.3-flash"],
    "mid": ["openai/gpt-5.6-luna", "deepseek/deepseek-v4.1-flash"],
    "frontier": ["anthropic/claude-opus-5", "z-ai/glm-5.3"]
  }
}
\`\`\`

\`GET ${base}/v1/roster\` (with the OpenRouter key) returns the running roster
with every price, usage rank and provenance field, plus which tier each
posture favors.

## More

The repository skill at \`${base}/skill.md\` has the same setup steps plus
guidance for an agent whose own work is itself routed through Milo (when to
set \`posture: "low"\` vs. \`"quality"\`, when to force a tier, how to cite a
decision id). Full route reference: \`${base}/llms.txt\`.
`;
}

function llmsTxt(base: string): string {
  return `# Milo

> OpenRouter with an actual routing mechanism: point an OpenAI-compatible
> client at Milo with your own OpenRouter key and model "milo/auto", and a
> policy engine picks the right tier for each request from the task's type
> and difficulty.

- [Agent setup guide](${base}/setup.md): step-by-step instructions for configuring a client, Claude Code, or another agent to route through Milo.
- [Health check](${base}/healthz): liveness probe, no auth required.
- [Source](https://github.com/bananaman614305/milo): repository, API reference, and architecture decisions.
`;
}

export function registerStaticRoutes(app: Hono): void {
  app.get("/setup.md", (c) =>
    c.text(setupMd(origin(c)), 200, { "content-type": "text/markdown; charset=utf-8" }),
  );
  app.get("/llms.txt", (c) =>
    c.text(llmsTxt(origin(c)), 200, { "content-type": "text/plain; charset=utf-8" }),
  );
  app.get("/skill.md", (c) => c.text(skillMd(), 200, { "content-type": "text/markdown; charset=utf-8" }));
}
