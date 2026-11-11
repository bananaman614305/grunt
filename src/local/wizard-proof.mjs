// Built CLI proof with offline Squire, router and service-manager stand-ins.
// Does not open an account, run Docker or touch the installed Milo service.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, chmod, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
const root = process.cwd(), dir = await mkdtemp(join(tmpdir(), 'milo-wizard-proof-'));
const events = [], daemons = [];
let routed = 0, login = 0;
const backend = serve({ hostname: '127.0.0.1', port: 0, fetch: async request => {
  const path = new URL(request.url).pathname, body = request.method === 'POST' || request.method === 'PUT' ? await request.json() : undefined;
  events.push(path);
  if (path === '/api/auth/login') { login++; return Response.json({ token: 'synthetic-admin' }); }
  if (path === '/api/keys') return Response.json([]);
  if (path === '/api/keys/custom') {
    assert.equal(body.apiKey, 'synthetic-grant');
    assert.equal(body.baseUrl, 'https://egress.example.test/v1');
    assert.equal(body.models[0].model, 'llama-3.3-70b-versatile');
    return Response.json({});
  }
  if (path === '/api/fallback') return Response.json(request.method === 'GET' ? [{ modelDbId: 1, platform: 'custom', modelId: 'llama-3.3-70b-versatile', keyLabel: 'Milo groq (Squire)', priority: 1 }] : {});
  if (path === '/api/settings/api-key') return Response.json({ apiKey: 'synthetic-router' });
  if (path === '/v1/models') return Response.json({ data: [] });
  if (path === '/v1/chat/completions') {
    assert.equal(request.headers.get('authorization'), 'Bearer synthetic-router');
    routed++; return Response.json({ choices: [{ message: { role: 'assistant', content: 'Milo is ready' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 4 } });
  }
  return Response.json({});
} });
await new Promise(resolve => backend.on('listening', resolve));
const routerUrl = `http://127.0.0.1:${backend.address().port}/v1`;
const probe = serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
await new Promise(resolve => probe.on('listening', resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const bin = join(dir, 'bin'), state = join(dir, 'milo'), pi = join(dir, 'pi');
await mkdir(bin); await mkdir(state);
const broker = join(dir, 'broker.mjs'), hook = join(dir, 'hook.mjs'), marker = join(dir, 'restart');
await writeFile(broker, `
import { Server } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/server/index.js'))};
import { StdioServerTransport } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/server/stdio.js'))};
import { CallToolRequestSchema } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/types.js'))};
const server = new Server({ name: 'offline Squire', version: '1' }, { capabilities: { tools: {} } });
server.setRequestHandler(CallToolRequestSchema, async ({ params: { name } }) => {
  let result;
  if (name === 'list_credentials') result = { credentials: [{ service: 'groq', reference: 'groq-proof', field_names: ['api_key'] }] };
  else if (name === 'grant_app_access') result = { base_url: 'https://egress.example.test/v1', token: 'synthetic-grant' };
  else throw new Error('Unexpected tool: ' + name);
  return { content: [{ type: 'text', text: JSON.stringify(result) }] };
});
await server.connect(new StdioServerTransport());
`);
await writeFile(hook, `
import { StdioClientTransport } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/client/stdio.js'))};
const start = StdioClientTransport.prototype.start;
StdioClientTransport.prototype.start = function() { this._serverParams.args = [${JSON.stringify(broker)}]; return start.call(this); };
`);
for (const [name, content] of Object.entries({
  docker: '#!/bin/sh\nif [ "$1" = inspect ]; then echo 1; fi\nif [ "$1" = run ] && [ "$2" = --rm ]; then echo empty; fi\nexit 0\n',
  opencode: '#!/bin/sh\nexit 0\n',
  npm: `#!/bin/sh\nln -s ${JSON.stringify(join(root, 'node_modules'))} "$3/node_modules"\n`,
  systemctl: `#!/bin/sh\nif [ "$2" = restart ]; then touch ${JSON.stringify(marker)}; fi\nexit 0\n`
})) { await writeFile(join(bin, name), content); await chmod(join(bin, name), 0o755); }
const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, MILO_CONFIG_DIR: state, XDG_CONFIG_HOME: join(dir, 'config'), PI_CODING_AGENT_DIR: pi, MILO_FREELLMAPI_URL: routerUrl, MILO_PORT: String(port), MILO_SOURCES: 'freellmapi', MILO_FREEBUFF_BRIDGE: '0', NODE_OPTIONS: `--import=${hook}` };
let logs = '';
async function startDaemon() {
  const child = spawn(process.execPath, [join(state, 'runtime/dist/local/main.js')], { env: { ...env, NODE_OPTIONS: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  daemons.push(child);
  child.stderr.on('data', chunk => { logs += chunk; });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/v1/models`)).ok) return child; } catch { /* Starting. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Proof daemon did not start');
}
let output = '', stopping = false;
const frames = [], started = Date.now();
const monitor = setInterval(async () => {
  if (stopping) return;
  try { await readFile(marker); stopping = true; await startDaemon(); } catch (error) { if (stopping) console.error(error); }
}, 50);
try {
  const child = spawn('script', ['-q', '-e', '-c', `stty cols 100 rows 40 && exec ${process.execPath} dist/local/main.js setup`, '/dev/null'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let picked = false;
  const collect = chunk => {
    output += chunk; frames.push([(Date.now() - started) / 1000, 'o', chunk.toString()]);
    if (!picked && output.includes('Choose your providers')) { picked = true; setTimeout(() => child.stdin.write('\r'), 250); }
  };
  child.stdout.on('data', collect); child.stderr.on('data', collect);
  const timer = setTimeout(() => child.kill('SIGKILL'), 45000);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  clearTimeout(timer); clearInterval(monitor);
  assert.equal(code, 0, output + '\nDaemon logs:\n' + logs);
  assert(output.includes('Milo is ready'), output);
  assert(!output.includes('synthetic-grant') && !output.includes('synthetic-router'));
  assert(events.includes('/api/keys/custom'));
  const models = JSON.parse(await readFile(join(pi, 'models.json'), 'utf8'));
  assert.equal(models.providers.milo.baseUrl, `http://127.0.0.1:${port}/v1`);
  const addChild = spawn(process.execPath, ['dist/local/main.js', 'add', 'groq'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let addOutput = ''; addChild.stdout.on('data', chunk => { addOutput += chunk; }); addChild.stderr.on('data', chunk => { addOutput += chunk; });
  const addCode = await new Promise(resolve => addChild.on('exit', resolve));
  assert.equal(addCode, 0, addOutput); assert(addOutput.includes('groq connected'));
  assert(!addOutput.includes('Milo background service') && !addOutput.includes('synthetic-grant'));

  const first = daemons.at(-1); first.kill('SIGTERM'); await new Promise(resolve => first.on('exit', resolve));
  await startDaemon();
  const piChild = spawn('pi', ['--provider', 'milo', '--model', 'milo', '--no-session', '--no-extensions', '--no-skills', '--no-prompt-templates', '-p', 'Say Milo is ready.'], { env: { ...env, PATH: process.env.PATH, NODE_OPTIONS: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let piOutput = ''; piChild.stdout.on('data', chunk => { piOutput += chunk; }); piChild.stderr.on('data', chunk => { piOutput += chunk; });
  const piTimer = setTimeout(() => piChild.kill('SIGKILL'), 20000);
  const piCode = await new Promise(resolve => piChild.once('exit', resolve)); clearTimeout(piTimer);
  assert.equal(piCode, 0, piOutput); assert(piOutput.includes('Milo is ready'), piOutput);
  assert(routed >= 2); assert(login >= 3); assert(logs.includes('Milo source: freellmapi answered'));
  const proof = `Feature proof (not a defect report): built setup CLI exited; existing vault entry minted a grant; custom provider received only synthetic grant; Pi config written; separate daemon live request passed; daemon restarted; real Pi CLI answered through offline router.\n\n${output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')}\nPi after restart:\n${piOutput}\nSource logs:\n${logs}`;
  await writeFile('/tmp/milo-wizard-proof.txt', proof);
  await writeFile('/tmp/milo-wizard-rail.cast', [JSON.stringify({ version: 2, width: 100, height: 40, timestamp: Math.floor(started / 1000), title: 'Milo setup — isolated offline proof' }), ...frames.map(frame => JSON.stringify(frame))].join('\n') + '\n');
  console.log(proof);
} finally {
  clearInterval(monitor);
  for (const child of daemons) child.kill('SIGTERM');
  await new Promise(resolve => backend.close(resolve));
  await rm(dir, { recursive: true, force: true });
}
