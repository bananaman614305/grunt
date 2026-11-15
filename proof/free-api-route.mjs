// Isolated real HTTP probe. Provider keys remain in Squire; this reads only a
// private backend grant. No changes to the installed daemon or default pool.
// node proof/free-api-route.mjs zro --free-account-confirmed [--large-context]
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { serve } from '@hono/node-server';

const args = process.argv.slice(2), provider = args[0], large = args.includes('--large-context');
const rootFlag = args.indexOf('--package-root');
const root = resolve(rootFlag < 0 ? '.' : args[rootFlag + 1] || '.');
const load = name => import(pathToFileURL(join(root, 'dist', `${name}.js`)).href);
const { FreeApi, FREE_API_PROVIDERS, isDeepSeekV41Model } = await load('local/free-api');
assert(Object.hasOwn(FREE_API_PROVIDERS, provider), 'Choose zro, amd, or tokenharbor');
// Zro uses the same model ID for free and paid accounts. A model pin alone
// cannot establish free eligibility; the signup agent must inspect the account.
assert(provider !== 'zro' || args.includes('--free-account-confirmed'), 'Confirm Zro is on its free plan with no purchased balance, then pass --free-account-confirmed');
const { Sources } = await load('local/source');
const { createLocalApp } = await load('local/api');
const evidence = [];
const source = new FreeApi(provider, { timeout: large ? 300000 : 180000, fetcher: async (url, init) => {
  const requested = JSON.parse(init.body), response = await fetch(url, init);
  const result = response.ok ? await response.clone().json().catch(() => undefined) : undefined;
  // Never serialize grant URLs, tokens, full prompts, or upstream errors.
  const returnedModel = typeof result?.model === 'string' ? result.model : null;
  evidence.push({ requestedModel: requested.model, returnedModel,
    modelIdentityVerified: isDeepSeekV41Model(returnedModel),
    modelIdentityStatus: returnedModel === null ? 'missing' : isDeepSeekV41Model(returnedModel) ? 'verified' : 'mismatch',
    status: response.status, promptTokens: result?.usage?.prompt_tokens,
    completionTokens: result?.usage?.completion_tokens });
  return response;
} });
const sources = new Sources([source]);
let app;
const server = serve({ hostname: '127.0.0.1', port: 0, fetch: request => app.fetch(request) });
if (!server.listening) await once(server, 'listening');
const address = server.address();
assert(address && typeof address !== 'string');
app = createLocalApp(sources, { port: address.port, cwd: process.cwd() });
try {
  const marker = `GRUNT_CONTEXT_${randomBytes(8).toString('hex')}`;
  const content = large
    ? `This is a synthetic context-capacity test. Ignore the filler, and reply with only the final marker.\n${' x'.repeat(210000)}\nFinal marker: ${marker}`
    : 'Say hello in one short sentence.';
  const started = Date.now();
  const response = await fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(large ? 310000 : 190000),
    body: JSON.stringify({ model: provider, max_tokens: 1024,
      messages: [{ role: 'user', content }], tools: [] })
  });
  const result = await response.json();
  const reply = result.choices?.[0]?.message?.content;
  const modelIdentityVerified = evidence.length === 1 && evidence[0]?.modelIdentityVerified === true;
  const proof = { passed: response.status === 200 && response.headers.get('x-grunt-source') === provider
      && evidence.length === 1 && evidence[0]?.requestedModel === FREE_API_PROVIDERS[provider].model
      && modelIdentityVerified
      && typeof reply === 'string' && reply.trim().length > 0
      && (!large || (evidence[0]?.promptTokens >= 200000 && reply.trim() === marker)),
    checkedAt: new Date().toISOString(), provider, largeContext: large, modelIdentityVerified,
    ...(provider === 'zro' ? { operatorConfirmedFreeAccount: true } : {}),
    elapsedMs: Date.now() - started, gruntStatus: response.status,
    answeredBy: response.headers.get('x-grunt-source'), evidence,
    ...(typeof reply === 'string' ? { reply } : {}),
    ...(large ? { requiredInputTokens: 200000, markerMatched: reply?.trim() === marker } : {}) };
  await mkdir(join(root, '.local-proof'), { recursive: true });
  await writeFile(join(root, '.local-proof', `${provider}-${large ? 'context' : 'route'}.json`), JSON.stringify(proof, null, 2));
  console.log(JSON.stringify(proof));
  assert(proof.passed, `${provider} ${large ? 'context' : 'routing'} probe did not pass; see safe proof output`);
} finally {
  await sources.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
