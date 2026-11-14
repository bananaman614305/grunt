// Live packaged-runtime proof. Reuses the user's Squire account and installed
// free services; refuses human signup so this never creates extra accounts.
// Usage: node proof/vetted-onboarding.mjs /absolute/path/to/installed/usegrunt
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const root = resolve(process.argv[2] || '.');
const load = name => import(pathToFileURL(`${root}/dist/${name}.js`).href);
const { bundledRegistry } = await load('registry');
const { setupFallbacks } = await load('local/fallback-setup');
const { configDir, command } = await load('local/wizard');
const { configure } = await load('local/main');
const { createLocalApp } = await load('local/api');
const ids = bundledRegistry.adapters.map(a => a.id);
assert.deepEqual(ids, ['freebuff', 'opencode', 'kilo']);
process.env.MILO_SETUP_NO_HUMAN = '1';
const start = performance.now();
const setup = await setupFallbacks({ directory: configDir(), run: command, adapters: ids,
  notify: line => console.log(line) });
assert.deepEqual(setup.unavailable, []);
console.log(JSON.stringify({ stage: 'packaged-setup', adapters: ids, elapsedMs: Math.round(performance.now() - start), passed: true }));
const env = { ...process.env };
delete env.MILO_SOURCES;
const sources = configure(env);
assert.deepEqual(sources.sources.map(source => source.id), ids);
const app = createLocalApp(sources);
try {
  for (const type of ['text', 'tools']) {
    const started = performance.now();
    const body = { model: 'kilo', max_tokens: 256,
      messages: [{ role: 'user', content: type === 'text' ? 'Reply only KILO_PACKAGED_OK.' : 'Call report_ready with value KILO_TOOL_OK. Do not reply with text.' }],
      ...(type === 'tools' ? { tools: [{ type: 'function', function: { name: 'report_ready', description: 'Report readiness', parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } } }] } : {}) };
    const response = await app.request('http://127.0.0.1:8788/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-grunt-source'), 'kilo');
    const message = result.choices[0].message;
    assert(type === 'text' ? message.content.includes('KILO_PACKAGED_OK') : message.tool_calls?.some(call => call.function.name === 'report_ready'));
    console.log(JSON.stringify({ stage: 'packaged-request', type, status: response.status, source: 'kilo', passed: true, latencyMs: Math.round(performance.now() - started) }));
  }
} finally { await sources.close(); }
