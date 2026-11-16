// Built add CLI with isolated Docker, vault and HTTP endpoint stand-ins.
// Uses synthetic secrets only; never changes the installed grunt service.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
const dir = await mkdtemp(join(tmpdir(), 'grunt-add-url-'));
import { providerLabel } from '../../dist/local/setup.js';
let base = 'https://my-company-production-resource.openai.azure.com/openai/v1';
let records = [], next = 0, enabled = [], discoveries = 0;
const backend = serve({ hostname: '127.0.0.1', port: 0, fetch: async request => {
  const path = new URL(request.url).pathname;
  const body = ['POST', 'PUT'].includes(request.method) ? await request.json() : undefined;
  if (path === '/api/auth/login') return Response.json({ token: 'synthetic-admin' });
  if (path === '/api/keys') return Response.json(records);
  if (path === '/api/keys/custom/discover-models') {
    assert.equal(body.baseUrl, 'https://egress.test/grant' + new URL(base).pathname);
    assert.equal(body.apiKey, 'synthetic-grant'); discoveries++;
    return Response.json({ models: [{ id: 'brand-new-model' }] });
  }
  if (path === '/api/keys/custom') {
    if (body.label === `Milo ${providerLabel(base)} (Squire)`) {
      assert.deepEqual(body.models, [{ model: 'brand-new-model', supportsTools: true }]);
      records.push({ id: ++next, platform: 'custom', label: body.label, baseUrl: body.baseUrl, models: [{ modelId: 'brand-new-model' }] });
      return Response.json({ keyId: next });
    }
    return Response.json({});
  }
  if (request.method === 'DELETE') { records = records.filter(row => path !== `/api/keys/${row.id}`); return Response.json({}); }
  if (path === '/api/fallback') {
    if (request.method === 'GET') return Response.json(records.map(row => ({ modelDbId: row.id, platform: 'custom', modelId: 'brand-new-model', keyLabel: row.label, priority: 0, enabled: false })));
    enabled = body; return Response.json({});
  }
  if (path === '/api/settings/api-key') return Response.json({ apiKey: 'synthetic-router' });
  return Response.json({});
} });
await new Promise(resolve => backend.on('listening', resolve));
const broker = join(dir, 'broker.mjs'), hook = join(dir, 'hook.mjs');
await writeFile(broker, `
import assert from 'node:assert/strict';
// Matches the pinned vault label schema: trimmed, nonempty, at most 60 characters.
const credentialLabelSchema = { parse(value) { assert.equal(typeof value, 'string'); assert(value.trim().length > 0 && value.trim().length <= 60); return value.trim(); } };
import { Server } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/server/index.js'))};
import { StdioServerTransport } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/server/stdio.js'))};
import { CallToolRequestSchema } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/types.js'))};
const server = new Server({ name: 'isolated vault', version: '1' }, { capabilities: { tools: {} } });
server.setRequestHandler(CallToolRequestSchema, async ({ params: { name, arguments: args } }) => {
  let result;
  if (name === 'list_credentials') result = { credentials: [] };
  else if (name === 'store_credential') {
    credentialLabelSchema.parse(args.label); assert.match(args.label, /^custom-[a-z0-9.-]+-[a-f0-9]{12}$/); assert.equal(args.value, 'synthetic-hidden-key');
    assert.equal(args.auth_shape, 'bearer'); assert.deepEqual(args.api_hosts, [args.service]);
    result = { reference: 'vault://isolated-example' };
  } else if (name === 'grant_app_access') { assert.equal(args.reference, 'vault://isolated-example'); result = { base_url: 'https://egress.test/grant', token: 'synthetic-grant' }; }
  else throw new Error('Unexpected vault operation');
  return { content: [{ type: 'text', text: JSON.stringify(result) }] };
});
await server.connect(new StdioServerTransport());
`);
await writeFile(hook, `
import { StdioClientTransport } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/client/stdio.js'))};
const start = StdioClientTransport.prototype.start;
StdioClientTransport.prototype.start = function() { this._serverParams.args = [${JSON.stringify(broker)}]; return start.call(this); };
`);
const bin = join(dir, 'bin'); await mkdir(bin);
for (const name of ['docker', 'pi', 'tar', 'npm', 'systemctl']) {
  const path = join(bin, name);
  await writeFile(path, '#!/bin/sh\nif [ "$1" = inspect ]; then echo 1; fi\nif [ "$1" = run ] && [ "$2" = --rm ]; then echo empty; fi\nexit 0\n'); await chmod(path, 0o755);
}
const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, MILO_CONFIG_DIR: join(dir, 'state'), MILO_ROUTER_RUNTIME: 'docker', MILO_FREELLMAPI_URL: `http://127.0.0.1:${backend.address().port}`, NODE_OPTIONS: `--import=${hook}` };
async function run(prompted, expectedRows = 1) {
  const child = spawn('script', ['-q', '-e', '-c', `stty -echo cols 120 rows 40 && exec ${process.execPath} dist/local/main.js add${prompted ? '' : ` ${base}`}`, '/dev/null'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', entered = false, confirmed = false, keyed = false, selected = false;
  const send = value => setTimeout(() => child.stdin.write(value), 100);
  const collect = chunk => {
    output += chunk;
    if (prompted && !entered && output.includes('Provider name or base URL')) { entered = true; send(base + '\r'); }
    if (!confirmed && output.includes('Send your API key to')) { confirmed = true; send('y'); }
    if (!keyed && output.includes('API key for ' + new URL(base).host)) { keyed = true; send('synthetic-hidden-key\r'); }
    if (!selected && output.includes('Choose a model for your crew')) { selected = true; send('\r'); }
  };
  child.stdout.on('data', collect); child.stderr.on('data', collect);
  const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
  const code = await new Promise(resolve => child.on('exit', resolve)); clearTimeout(timer);
  assert.equal(code, 0, output);
  assert(output.includes(`${base} connected`), output);
  assert(!output.includes('synthetic-hidden-key') && !output.includes('synthetic-grant'), 'CLI leaked a secret');
  assert.equal(records.length, expectedRows); assert.equal(enabled.length, expectedRows); assert.equal(enabled[0].enabled, true);
  console.log(`PASS built usegrunt add${prompted ? ' (prompted URL)' : ' <URL>'}: host confirmed, hidden key vaulted, discovered model selected and enabled; ${expectedRows} provider rows.`);
}
try { await run(false); await run(true); assert.equal(discoveries, 2); const firstLabel = records[0].label; base += '/other'; await run(false, 2); assert.notEqual(records[1].label, firstLabel); await run(true, 2); assert.equal(discoveries, 4); }
finally { await new Promise(resolve => backend.close(resolve)); await rm(dir, { recursive: true, force: true }); }
