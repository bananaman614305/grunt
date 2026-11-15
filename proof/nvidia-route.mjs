// Requires NVIDIA's key to have been captured in Squire and its grant installed.
// Usage: node proof/nvidia-route.mjs [package-root]
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(process.argv[2] || '.');
const load = name => import(pathToFileURL(join(root, 'dist', `${name}.js`)).href);
const { Nvidia, NVIDIA_DEEPSEEK } = await load('local/nvidia');
const { Sources } = await load('local/source');
const { createLocalApp } = await load('local/api');
const evidence = [];
const source = new Nvidia({ fetcher: async (url, init) => {
  const response = await fetch(url, init);
  if (String(url).endsWith('/v1/chat/completions')) {
    const sent = JSON.parse(init.body);
    const result = response.ok ? await response.clone().json() : undefined;
    // Never serialize the Squire grant URL, bearer token, or upstream errors.
    evidence.push({ path: '/v1/chat/completions', requestedModel: sent.model,
      returnedModel: result?.model, status: response.status });
  }
  return response;
} });
const sources = new Sources([source]);
try {
  const app = createLocalApp(sources);
  const started = Date.now();
  const response = await app.request('http://127.0.0.1:8788/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'nvidia', max_tokens: 1024,
      messages: [{ role: 'user', content: 'Say hello in one short sentence.' }], tools: [] })
  });
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-grunt-source'), 'nvidia');
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].requestedModel, NVIDIA_DEEPSEEK);
  assert(result.choices[0].message.content?.trim());
  const proof = { passed: true, checkedAt: new Date().toISOString(),
    elapsedMs: Date.now() - started, source: 'nvidia', evidence,
    reply: result.choices[0].message.content };
  await mkdir('.local-proof', { recursive: true });
  await writeFile('.local-proof/nvidia-route.json', JSON.stringify(proof, null, 2));
  console.log(JSON.stringify(proof));
} finally { await sources.close(); }
