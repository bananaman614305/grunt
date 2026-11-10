// Built-path proof using the real pinned FreeLLMAPI image and offline providers.
// This is a stand-in, not the required live proof on the owner's Squire host.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, copyFile, chmod, rm, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { randomBytes, randomInt } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { freeConfig } from '../../dist/local/freellmapi.js';
import { FreeLLMAdmin, FREELLMAPI_IMAGE } from '../../dist/local/setup.js';

const exec = promisify(execFile);
const port = randomInt(20000, 30000), routerPort = randomInt(30001, 40000);
const dir = await mkdtemp(join(tmpdir(), 'milo-free-proof-'));
const project = join(dir, basename(dir)); await mkdir(project);
const routes = [], prompts = [];
let sessionCount = 0, child;
const provider = createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  const value = body ? JSON.parse(body) : {};
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/session') { sessionCount++; res.end(JSON.stringify({ id: 'proof_session' })); return; }
  if (req.url.startsWith('/session/')) {
    prompts.push(value);
    res.end(JSON.stringify({ info: { role: 'assistant' }, parts: [{ type: 'text', text: prompts.length === 1 ? 'OpenCode bridge works 42' : 'OpenCode follow-up works 42' }] })); return;
  }
  routes.push(req.url);
  const prompt = value.messages?.at(-1)?.content ?? '';
  if (req.url.startsWith('/first/') || prompt.includes('Freebuff')) { res.writeHead(429).end(JSON.stringify({ error: { message: 'offline provider exhausted' } })); return; }
  res.end(JSON.stringify({ id: 'proof', object: 'chat.completion', model: 'kilo-auto/free', choices: [{ index: 0, message: { role: 'assistant', content: 'FreeLLMAPI routed reply 42' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 8, total_tokens: 9 } }));
});
await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
const providerUrl = `http://127.0.0.1:${provider.address().port}`;
const config = freeConfig();
config.customProviders[0].baseUrl = `${providerUrl}/kilo/v1`;
config.customProviders.unshift({ baseUrl: `${providerUrl}/first/v1`, apiKey: 'no-key', label: 'Offline exhausted provider', models: [{ model: 'exhausted-proof', supportsTools: true }] });
config.fallback[0].endpoint = `${providerUrl}/kilo/v1`;
config.fallback.unshift({ platform: 'custom', modelId: 'exhausted-proof', endpoint: `${providerUrl}/first/v1`, priority: 1 });
const password = randomBytes(32).toString('hex'), encryption = randomBytes(32).toString('hex');
const name = `milo-free-proof-${process.pid}`;
try {
  await exec('docker', ['run', '-d', '--name', name, '--network', 'host', '--tmpfs', '/app/server/data:rw', '-e', 'HOST=127.0.0.1', '-e', `PORT=${routerPort}`, '-e', 'ENCRYPTION_KEY', '-e', 'FREEAPI_CONFIG_JSON', FREELLMAPI_IMAGE], {
    timeout: 60000, env: { ...process.env, ENCRYPTION_KEY: encryption, FREEAPI_CONFIG_JSON: JSON.stringify({ admin: { email: 'milo@localhost.local', password }, ...config }) }
  });
  const admin = new FreeLLMAdmin(`http://127.0.0.1:${routerPort}`);
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try { await admin.login(password); ready = true; break; } catch { await delay(500); }
  }
  if (!ready) {
    const status = (await exec('docker', ['inspect', '--format', '{{.State.Status}} {{.State.ExitCode}} {{.State.Error}}', name])).stdout;
    const internal = await exec('docker', ['exec', name, 'node', '-e', `fetch('http://127.0.0.1:${routerPort}/api/ping').then(r=>console.log(r.status)).catch(()=>console.log('unreachable'))`]).catch(() => ({ stdout: 'not running' }));
    const diagnostic = await exec('docker', ['logs', name]);
    const redacted = (diagnostic.stdout + diagnostic.stderr).replaceAll(password, '[redacted]').replaceAll(encryption, '[redacted]').replace(/freellmapi-[A-Za-z0-9_-]+/g, '[redacted]');
    console.error(JSON.stringify({ container: status.trim(), internalHealth: internal.stdout.trim(), diagnostic: redacted }));
  }
  assert(ready, 'real FreeLLMAPI starts');
  const chain = await admin.call('/fallback', undefined, 'GET');
  await admin.call('/fallback', chain.map(row => ({ modelDbId: row.modelDbId, priority: row.priority, enabled: ['exhausted-proof', 'kilo-auto/free', 'freebuff'].includes(row.modelId) && row.platform === 'custom' })), 'PUT');
  await copyFile('src/local/fixtures/fake-freebuff.cjs', join(dir, 'freebuff')); await chmod(join(dir, 'freebuff'), 0o755);
  const key = await admin.key();
  child = spawn(process.execPath, [join(process.cwd(), 'dist/local/main.js')], { cwd: project, env: {
    ...process.env, PATH: `${dir}:${process.env.PATH}`, MILO_PORT: String(port), MILO_FREELLMAPI_URL: `${admin.url}/v1`, MILO_FREELLMAPI_KEY: key, MILO_OPENCODE_URL: providerUrl, MILO_TEST_HOME: homedir(), MILO_APP_TIMEOUT_MS: '20000'
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; child.stderr.on('data', chunk => { logs += chunk; });
  for (let attempt = 0; attempt < 60; attempt++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/v1/models`)).ok) break; } catch { /* startup */ }
    await delay(100);
  }
  const send = async body => {
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, stream: false }), signal: AbortSignal.timeout(45000) });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result)); return result.choices[0].message.content;
  };
  const routed = await send({ model: 'freellmapi', messages: [{ role: 'user', content: 'Reply with route marker' }] });
  assert.equal(routed, 'FreeLLMAPI routed reply 42');
  assert(routes.some(path => path.startsWith('/first/')) && routes.some(path => path.startsWith('/kilo/')), 'real router fails over between endpoints');
  const kilo = await send({ model: 'kilo', messages: [{ role: 'user', content: 'Reply with Kilo marker' }] });
  assert.equal(kilo, 'FreeLLMAPI routed reply 42');
  const fixture = JSON.parse(await readFile('src/local/fixtures/opencode.json', 'utf8'));
  fixture.model = 'opencode'; fixture.cwd = project;
  const first = await send(fixture);
  fixture.messages.push({ role: 'assistant', content: first }, { role: 'user', content: '  Follow up exactly.\n' });
  const second = await send(fixture);
  assert.equal(sessionCount, 1);
  assert.deepEqual(prompts.map(p => p.parts), [[{ type: 'text', text: fixture.messages[1].content }], [{ type: 'text', text: '  Follow up exactly.\n' }]]);
  const fallback = await send({ model: 'freellmapi', messages: [{ role: 'user', content: 'Freebuff bridge works 42' }], tools: fixture.tools });
  assert.equal(fallback, 'Freebuff bridge works 42');
  assert(!logs.includes(key) && !logs.includes(password), 'credentials never reach daemon logs');
  console.log(JSON.stringify({ kind: 'offline built-path stand-in', router: 'real pinned FreeLLMAPI Docker image', routed, kilo, opencode: [first, second], sessions: sessionCount, lastFallback: fallback, upstreamRoutes: routes, credentialsInLogs: false }, null, 2));
} finally {
  if (child && child.exitCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); }
  await exec('docker', ['rm', '-f', name]).catch(() => {});
  provider.closeAllConnections(); provider.close();
  await rm(join(homedir(), '.config/manicode/projects', basename(project)), { recursive: true, force: true });
  await rm(dir, { recursive: true, force: true });
}
