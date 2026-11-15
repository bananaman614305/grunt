// Live hello proof through Grunt's API using its packaged OpenCode adapter.
// Usage: node proof/opencode-model-pool.mjs [package-root]
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(process.argv[2] || '.');
const load = name => import(pathToFileURL(join(root, 'dist', `${name}.js`)).href);
const { OpenCode, DEFAULT_OPENCODE_MODELS } = await load('local/opencode');
const { Sources } = await load('local/source');
const { createLocalApp } = await load('local/api');
const cwd = await mkdtemp(join(tmpdir(), 'grunt-opencode-pool-'));
const requests = [];
const source = new OpenCode({ timeout: 60000, fetcher: async (url, init) => {
  const message = String(url).endsWith('/message') && init?.method === 'POST';
  const sent = message ? JSON.parse(init.body) : undefined;
  const response = await fetch(url, init);
  if (message && response.ok) {
    const reply = await response.clone().json();
    requests.push({ requested: sent.model.modelID, model: reply.info?.modelID,
      provider: reply.info?.providerID, finish: reply.info?.finish,
      session: new URL(String(url)).pathname.split('/')[2] });
  }
  return response;
} });
const sources = new Sources([source]);
const app = createLocalApp(sources);
const results = [];
const started = Date.now();
try {
  for (let i = 0; i < DEFAULT_OPENCODE_MODELS.length; i++) {
    const prompt = `Hello check ${i + 1}: say hello in one short sentence. Do not use tools, run commands, or edit files.`;
    const response = await app.request('http://127.0.0.1:8788/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'opencode', cwd, max_tokens: 64,
        messages: [{ role: 'user', content: prompt }], tools: [] })
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-grunt-source'), 'opencode');
    const metadata = requests.at(-1);
    assert.equal(metadata.model, DEFAULT_OPENCODE_MODELS[i]);
    assert.equal(metadata.requested, metadata.model);
    assert.equal(metadata.provider, 'opencode');
    assert(body.choices[0].message.content);
    results.push({ model: metadata.model, status: response.status,
      source: response.headers.get('x-grunt-source'), reply: body.choices[0].message.content });
    console.log(JSON.stringify(results.at(-1)));
  }
  const proof = { passed: true, checkedAt: new Date().toISOString(),
    elapsedMs: Date.now() - started, results, persistentSettingsChanged: false };
  await mkdir('.local-proof', { recursive: true });
  await writeFile('.local-proof/opencode-model-pool.json', JSON.stringify(proof, null, 2));
} finally { await sources.close(); }
