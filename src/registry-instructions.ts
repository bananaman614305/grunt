import { ADAPTER_FIELDS, ADAPTER_RULES, CANDIDATE_FIELDS, CANDIDATE_RULES, CANDIDATES_MAX, DECLARATIVE_FIELDS, DECLARATIVE_OPENAI_INSTALL, DECLARATIVE_RULES, HINTS_MAX, TIER_TOTALS, installers } from './registry.js';
import type { Registry } from './registry.js';
import type { Scores } from './registry-store.js';
import { ENTRY_MAX_BYTES } from './registry-write.js';

const ADAPTER_REQUIRED = new Set(['id', 'kind', 'tier', 'weight', 'modalities', 'install']);
const DECLARATIVE_REQUIRED = new Set(['baseUrl', 'apiPath', 'zeroPriceCheck', 'disclosure', 'policyVersion', 'policyUrl']);
const CANDIDATE_REQUIRED = new Set(['id', 'signup', 'hints']);
// Published with the page; the instructions test writes it through the same PUT.
export const EXAMPLE_CANDIDATE = {
  id: 'example-free-api',
  signup: 'https://example.com/signup',
  hints: "On /signup press 'Continue with Google' and choose the Squire-connected Google account. On /dashboard/keys press 'Create key', type grunt in 'Name' and press 'Create'. The key is shown once: press its 'Copy' button so it is stored, then finish. Never press 'Upgrade' or add a card.",
  name: 'Example free API',
  models: ['deepseek-v4.1-flash'],
  docs: 'https://example.com/docs',
  notes: 'Free tier: 1M tokens per day. Prompts may be used for training.'
};
export const EXAMPLE_DECLARATIVE_ADAPTER = {
  id: 'example-promo',
  kind: 'model',
  tier: 'experimental',
  weight: 0.01,
  modalities: ['text'],
  install: DECLARATIVE_OPENAI_INSTALL,
  model: 'deepseek-v4.1-flash:free',
  signup: 'https://example.com/signup',
  hints: "On /signup press 'Continue with Google' and choose the Squire-connected Google account. On /keys press 'Create key', type grunt in 'Name', press 'Create', then press 'Copy' so it is stored.",
  expires: '2026-12-31',
  declarative: {
    baseUrl: 'https://api.example.com',
    apiPath: '/v1/chat/completions',
    modelsEndpoint: '/v1/models',
    zeroPriceCheck: 'models_catalog',
    disclosure: 'Prompts and tool context pass through Example API and its upstream inference provider. Retention and training policies are unverified.',
    policyVersion: '2026-11-25',
    policyUrl: 'https://example.com/privacy',
    name: 'Example Promo Free'
  }
};
const list = (ids: string[]) => ids.length ? ids.map(id => `\`${id}\``).join(', ') : 'none';
const table = (fields: readonly string[], rules: Record<string, string>, required: ReadonlySet<string>) => [
  '| Field | Required | Rule |', '|---|---|---|',
  ...fields.map(field => `| \`${field}\` | ${required.has(field) ? 'yes' : field === 'hints' ? 'with `signup`' : 'no'} | ${rules[field]!.replaceAll('|', '\\|')} |`)
].join('\n');

// The agent guide, rendered per request from the validator's constants and live data.
export function registryInstructions(options: { registry: Registry; scores: Scores; base: string; repo: string; commit?: string; now: number }) {
  const { registry, scores, base, repo } = options;
  const shipped = Object.keys(installers);
  const score = (id: string) => scores.scores[id];
  const worklist = {
    noHints: registry.adapters.filter(adapter => adapter.signup && !adapter.hints).map(adapter => adapter.id),
    lowSignup: registry.adapters.filter(adapter => (score(adapter.id)?.signup_attempts ?? 0) >= 3 && score(adapter.id)!.signup_rate < 0.3).map(adapter => adapter.id),
    dead: registry.adapters.filter(adapter => score(adapter.id)?.state === 'dead').map(adapter => adapter.id),
    candidates: (registry.candidates ?? []).map(candidate => candidate.id),
    expired: registry.adapters.filter(adapter => adapter.expires && options.now >= Date.parse(adapter.expires) + 24 * 60 * 60 * 1000).map(adapter => adapter.id)
  };
  return `# Grunt registry: how to add to it

Server build: ${options.commit ?? 'unknown'}. Live publication: \`${registry.published}\`. Generated: ${new Date(options.now).toISOString()}.

The registry is the list of free AI providers Grunt routes to, with page-by-page signup hints for each. This page is generated from the server's own validator on every request, so it matches what the server accepts now.

## Who can write

Any GitHub account with push access to \`${repo}\`. Send that account's own GitHub token as \`Authorization: Bearer <token>\`: \`gh auth token\` for a person, or a personal access token from a bot's secret store. The server only reads \`/user\` and the repository's permissions with it, so it needs no write scope, and it is never stored. Never put the token in a prompt, a log, a commit or a file.

## Endpoints

- \`GET ${base}/v1/registry\`: the live registry (\`adapters\`, plus \`candidates\` once any exist).
- \`GET ${base}/v1/registry/scores\`: a 0–100 liveliness score per adapter from local router feedback, with \`state\`, \`signup_rate\` and sample counts.
- \`PUT ${base}/v1/registry/entries/{id}\`: add or replace one entry (JSON, at most ${ENTRY_MAX_BYTES / 1024} KB).
- \`DELETE ${base}/v1/registry/entries/{id}\`: remove one entry.
- \`POST ${base}/v1/registry/feedback\`: daily route counts from Grunt routers. Agents do not send this.
- \`GET ${base}/v1/registry/instructions\`: this page.
- \`PUT ${base}/v1/registry/reverts/{write}\`: restore the whole document saved before that write; requires the same GitHub authorization and no request body.

\`\`\`sh
curl -s ${base}/v1/registry > registry.json
curl -s ${base}/v1/registry/scores
curl -s -X PUT ${base}/v1/registry/entries/example-free-api -H "Authorization: Bearer $GITHUB_TOKEN" -H 'Content-Type: application/json' --data @entry.json
curl -s -X DELETE ${base}/v1/registry/entries/example-free-api -H "Authorization: Bearer $GITHUB_TOKEN"
\`\`\`

## How a write works

- A PUT replaces the whole entry. Read the registry, change the entry, and send it back.
- An id that Grunt ships an adapter for, an entry whose \`install\` is \`${DECLARATIVE_OPENAI_INSTALL}\`, or an entry whose \`install\` is \`npm:<package>\`, goes in \`adapters\`. Any other id goes in \`candidates\`, the providers waiting for an adapter. An id lives in one list only. The registry accepts at most ${CANDIDATES_MAX} candidates.
- Shipped adapter ids: ${list(shipped)}.
- On an adapter update, an omitted \`weight\` keeps the old one. Each tier is then rescaled so stable weights total ${TIER_TOTALS.stable} and experimental weights total ${TIER_TOTALS.experimental}.
- An entry with a \`signup\` must carry \`hints\`.
- Each accepted write publishes at once under a new \`published\` time, so an entry and its hints go live together. Routers pick it up within 6 hours.
- The response is \`{"published", "etag", "placed", "write"}\`, with \`placed\` set to \`adapters\`, \`candidates\` or \`registry\` for a revert. It also includes \`write\`, the history row number.
- History stores whole registry documents before and after each write. Revert with \`PUT /v1/registry/reverts/{write}\` using that response number. This restores every entry and weight exactly, with a newer \`published\`, and records another write. It replaces intervening edits too; read the live registry before reverting.

## Adapter fields

${table(ADAPTER_FIELDS, ADAPTER_RULES, ADAPTER_REQUIRED)}

## Declarative adapter fields (\`declarative\`)

For ephemeral OpenAI-compatible free API promos that need no custom TypeScript adapter, set \`install\` to \`${DECLARATIVE_OPENAI_INSTALL}\`, \`kind\` to \`model\`, \`modalities\` to \`["text"]\`, and provide \`model\`, \`signup\`, \`hints\`, and \`declarative\`:

${table(DECLARATIVE_FIELDS, DECLARATIVE_RULES, DECLARATIVE_REQUIRED)}

## Candidate fields

${table(CANDIDATE_FIELDS, CANDIDATE_RULES, CANDIDATE_REQUIRED)}

## Writing good hints

- Write page by page, in order: the page path, the visible control label in quotes, and the value to type.
- Use only Grunt-supplied values: \`grunt\` for names, \`free\` for plans, and the Squire email. Say "a new password" where a password is needed; never write one.
- Name the controls never to press, such as revoke, rotate, upgrade or billing.
- Never ask for a card, a payment, a paid plan or a second account.
- Keep hints under ${HINTS_MAX} characters. Grunt appends its own safety rules after them, and drops hints that would push its signup goal past 4000 characters.

## Today's worklist

- Signup without hints: ${list(worklist.noHints)}.
- Signup success below 30% over at least 3 attempts (rewrite the hints): ${list(worklist.lowSignup)}.
- Dead in router feedback (check it, then set \`status\` to \`expiring\` or \`inactive\`, or fix the hints): ${list(worklist.dead)}.
- Candidates waiting for an adapter: ${list(worklist.candidates)}.
- Past \`expires\`: ${list(worklist.expired)}.

Before adding a provider, check that its id and signup host are not already in \`adapters\` or \`candidates\`.

## Errors

- \`400\`: the body is not a JSON object, or its \`id\` differs from the path.
- \`401\`: missing or invalid GitHub token. Stop; the credential is wrong.
- \`403\`: the token's account cannot push to \`${repo}\`. Stop.
- \`404\`: DELETE of an id that is not listed.
- \`413\`: the body is too large.
- \`422\`: \`{"errors": [{"field", "rule"}]}\`. The rule text is the rule column above; fix that field and retry once.
- \`502\`: GitHub is unavailable or rate limited (including upstream 403 rate-limit responses); retry later. The server does not retry GitHub requests.

## Example PUT body

Example only: do not send it.

\`\`\`json
${JSON.stringify(EXAMPLE_CANDIDATE, null, 2)}
\`\`\`

### Example declarative adapter PUT body

Example only: do not send it.

\`\`\`json
${JSON.stringify(EXAMPLE_DECLARATIVE_ADAPTER, null, 2)}
\`\`\`
`;
}
