// Reproduction J-576dc1e6: built setup CLI, real MCP transport, offline Squire/router.
// Run after pnpm build. Never opens the user's Squire session or starts onboarding.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = await mkdtemp(join(tmpdir(), 'milo-setup-session-'));
const hook = join(dir, 'hook.mjs');
const server = join(dir, 'server.mjs');
const userConfig = join(dir, 'user-config');
const moduleUrl = name => import.meta.resolve(name);
const setupUrl = pathToFileURL(join(process.cwd(), 'dist/local/setup.js')).href;
await writeFile(join(dir, 'docker'), '#!/bin/sh\nif [ "$1" = inspect ]; then printf "1\\n"; fi\nexit 0\n');
await chmod(join(dir, 'docker'), 0o755);
await writeFile(server, `
import { appendFileSync } from 'node:fs';
import { Server } from ${JSON.stringify(moduleUrl('@modelcontextprotocol/sdk/server/index.js'))};
import { StdioServerTransport } from ${JSON.stringify(moduleUrl('@modelcontextprotocol/sdk/server/stdio.js'))};
import { CallToolRequestSchema } from ${JSON.stringify(moduleUrl('@modelcontextprotocol/sdk/types.js'))};
const record = event => appendFileSync(process.env.MILO_PROOF_EVENTS, JSON.stringify(event) + '\\n');
record({ event: 'server', userConfig: process.env.XDG_CONFIG_HOME === process.env.MILO_PROOF_USER_CONFIG });
if (process.env.XDG_CONFIG_HOME !== process.env.MILO_PROOF_USER_CONFIG || process.env.MILO_PROOF_CASE === 'transport-failure') process.exit(1);
const server = new Server({ name: 'offline Squire', version: '1' }, { capabilities: { tools: {} } });
server.setRequestHandler(CallToolRequestSchema, async ({ params: { name, arguments: args } }) => {
  record({ event: name, action: args?.action, id: args?.approval_id });
  if (process.env.MILO_PROOF_CASE === 'no-session') return { isError: true, content: [{ type: 'text', text: 'No session: private upstream detail' }] };
  let result;
  if (name === 'list_credentials') result = { credentials: [
    { service: 'milo-freellmapi-admin', reference: 'admin', field_names: ['password', 'encryption_key'] },
    { service: 'groq', reference: 'groq', field_names: ['api_key'] }
  ] };
  else if (name === 'fetch_credential' && args.action === 'resume') result = {
    status: 'credential_fetched', fields: args.approval_id === 'admin'
      ? { password: 'SyntheticAdmin!42', encryption_key: 'SyntheticEncryption!42' }
      : { api_key: 'SyntheticProvider!42' }
  };
  else throw new Error('Unexpected new approval or signup');
  return { content: [{ type: 'text', text: JSON.stringify(result) }] };
});
await server.connect(new StdioServerTransport());
`);
await writeFile(hook, `
import { appendFileSync } from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { StdioClientTransport } from ${JSON.stringify(moduleUrl('@modelcontextprotocol/sdk/client/stdio.js'))};
import { FreeLLMAdmin } from ${JSON.stringify(setupUrl)};
const record = event => appendFileSync(process.env.MILO_PROOF_EVENTS, JSON.stringify(event) + '\\n');
const spawn = childProcess.spawn;
childProcess.spawn = function(command, args, options) {
  if (args?.includes('connect')) {
    record({ event: 'onboarding-attempt' });
    throw new Error('Proof blocked Squire onboarding');
  }
  return spawn(command, args, options);
};
syncBuiltinESMExports();
const start = StdioClientTransport.prototype.start;
StdioClientTransport.prototype.start = function() {
  if (this._serverParams.args?.[1] !== 'server') throw new Error('Unexpected Squire command');
  // Only replace the executable fixture; preserve the production child environment.
  this._serverParams.args = [${JSON.stringify(server)}];
  return start.call(this);
};
FreeLLMAdmin.prototype.login = async () => { record({ event: 'router-login' }); };
FreeLLMAdmin.prototype.configureChain = async () => { record({ event: 'router-configured' }); };
FreeLLMAdmin.prototype.addKey = async (provider, key) => {
  if (provider !== 'groq' || key !== 'SyntheticProvider!42') throw new Error('Wrong provider delivery');
  record({ event: 'provider-imported' });
};
FreeLLMAdmin.prototype.key = async () => { throw new Error('Proof complete: router and provider connected'); };
`);

try {
  for (const scenario of ['legacy-override', 'custom-state', 'legacy-migration', 'no-session', 'transport-failure']) {
    const scenarioDir = join(dir, scenario);
    const legacyBase = join(scenarioDir, 'legacy-config');
    const customState = join(scenarioDir, 'persistent-milo');
    const legacy = scenario.startsWith('legacy');
    const custom = scenario !== 'legacy-override';
    const sourceDir = legacy ? join(legacyBase, 'milo') : customState;
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, 'approvals.json'), JSON.stringify(['admin', 'groq'].map(reference => ({
      id: reference, reference, ...(reference === 'groq' ? { field: 'api_key' } : {}),
      approveUrl: 'https://approval.test/' + reference, createdAt: Date.now(), expiresAt: Date.now() + 900000
    }))));
    const eventsPath = join(scenarioDir, 'events.jsonl');
    await writeFile(eventsPath, '');
    const child = spawn(process.execPath, ['--import', hook, 'dist/local/main.js', 'setup'], {
      env: {
        ...process.env, PATH: `${dir}:${process.env.PATH}`, XDG_CONFIG_HOME: legacy ? legacyBase : userConfig,
        MILO_CONFIG_DIR: custom ? customState : '', MILO_SQUIRE_XDG_CONFIG_HOME: legacy ? userConfig : '',
        MILO_PROOF_CASE: scenario, MILO_PROOF_EVENTS: eventsPath, MILO_PROOF_USER_CONFIG: userConfig
      }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    const events = (await readFile(eventsPath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    console.log(JSON.stringify({ reproduction: 'J-576dc1e6', scenario, code, output: output.trim(), events }));
    assert.equal(code, 1, 'proof stops before the daemon starts');
    assert(!output.includes('Synthetic') && !output.includes('private upstream detail'), 'CLI does not print upstream secrets or details');
    assert.equal(events.filter(e => e.event === 'server').length, 1, 'no Squire retry or onboarding');
    assert(events.some(e => e.event === 'server' && e.userConfig), 'Squire receives its own config location');
    assert(!events.some(e => e.event === 'onboarding-attempt'), 'never launches Squire connect');
    assert(!events.some(e => e.event === 'fetch_credential' && e.action === 'start'), 'never requests a replacement approval');
    if (scenario === 'no-session' || scenario === 'transport-failure') {
      assert.equal(output.trim(), 'Connect Trusty Squire separately, then rerun milo setup');
      assert(!events.some(e => e.event === 'router-login'), 'stops before router/provider setup');
    } else {
      assert.equal(output.trim(), 'groq: connected\nProof complete: router and provider connected');
      assert(events.some(e => e.event === 'router-configured') && events.some(e => e.event === 'provider-imported'), 'setup reaches the router and provider');
      assert.deepEqual(events.filter(e => e.event === 'fetch_credential').map(e => e.id), ['admin', 'groq']);
      assert.deepEqual(JSON.parse(await readFile(join(custom ? customState : sourceDir, 'approvals.json'), 'utf8')), [], 'delivered approvals are cleared in Milo state');
    }
  }
} finally { await rm(dir, { recursive: true, force: true }); }
