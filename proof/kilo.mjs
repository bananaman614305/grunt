// Run after building Grunt and the pinned FreeLLMAPI checkout. Supply backend
// egress grants as one JSON line on stdin; never supply provider keys.
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { FreeLLMAdmin, setupProviders } from '../dist/local/setup.js';
import { ROUTER_ADMIN_EMAIL } from '../dist/local/native-router.js';
import { FreeLLMAPI } from '../dist/local/freellmapi.js';
import { createLocalApp } from '../dist/local/api.js';
import { Sources } from '../dist/local/source.js';

const input = createInterface({ input: process.stdin });
const grants = await new Promise(resolve => input.once('line', line => resolve(JSON.parse(line))));
input.close();
const upstream = name => import(pathToFileURL(`${process.argv[2]}/server/dist/${name}.js`).href);
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex');
process.env.PROVIDER_TIMEOUT_CUSTOM = '600000';
// The proof uses an isolated in-memory router, with no background discovery.
const { initDb, getDb } = await upstream('db/index');
const { applyDeclarativeConfig } = await upstream('services/declarative-config');
const { createApp } = await upstream('app');
const stdout = process.stdout.write.bind(process.stdout);
const originalLog = line => stdout(`${line}\n`);
// The upstream initial migration writes its generated API key directly.
process.stdout.write = () => true;
console.log = console.info = console.warn = console.error = () => {};
initDb(':memory:');
const password = randomBytes(32).toString('hex');
applyDeclarativeConfig({ admin: { email: ROUTER_ADMIN_EMAIL, password } });
const server = createApp().listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
try {
  const admin = new FreeLLMAdmin(url);
  await admin.login(password);
  await setupProviders({ credentials: {
    list: async () => Object.keys(grants).map(service => ({ service, reference: service, field_names: ['value'] })),
    grant: async reference => grants[reference]
  }, runs: { start: async () => { throw new Error('Unexpected signup'); }, get: async () => { throw new Error('Unexpected signup'); } } }, admin, { providers: [], notify: () => {} });
  await admin.configureChain();
  const key = await admin.key();
  const chain = await admin.call('/fallback', undefined, 'GET');
  for (const provider of ['kilo'].filter(name => grants[name])) {
    // Isolate each provider to prove its completion cannot be another source.
    await admin.call('/fallback', chain.map(row => ({ modelDbId: row.modelDbId, enabled: row.keyLabel === `Grunt ${provider} (Squire)`, priority: row.priority })), 'PUT');
    const app = createLocalApp(new Sources([new FreeLLMAPI({ url: `${url}/v1`, key })]));
    const start = performance.now();
    const response = await app.request('http://127.0.0.1:8788/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'freellmapi', messages: [{ role: 'user', content: 'Reply only OK.' }], max_tokens: 256, stream: false }) });
    const body = await response.json();
    originalLog(JSON.stringify({ provider, status: response.status, latencyMs: Math.round(performance.now() - start) }));
    if (response.status !== 200 || !body.choices?.[0]?.message?.content) process.exitCode = 1;
  }
} catch (error) {
  // Never serialize request details, grants, or upstream response bodies.
  originalLog(JSON.stringify({ status: 'failed', stage: String(error.message).replace(/https?:\/\/\S+/g, '[endpoint]').slice(0, 180) }));
  process.exitCode = 1;
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  getDb().close();
}
