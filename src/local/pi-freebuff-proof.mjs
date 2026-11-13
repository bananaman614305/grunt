// Reproduction PF1: real Pi and built HTTP adapter; optional synthetic Freebuff TUI.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, copyFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { Freebuff } from '../../dist/local/freebuff.js';
import { Sources } from '../../dist/local/source.js';
import { createLocalApp } from '../../dist/local/api.js';
import { configurePi } from '../../dist/local/harnesses.js';

const bridged = process.argv.includes('--bridge');
const synthetic = process.argv.includes('--synthetic');
const dir = await mkdtemp(join(tmpdir(), 'pi-freebuff-proof-'));
const config = join(dir, 'pi');
const skill = join(dir, 'skills', 'proof-read');
await mkdir(skill, { recursive: true });
await writeFile(join(skill, 'SKILL.md'), '---\nname: proof-read\ndescription: Read the proof nonce with the Pi read tool.\n---\nUse the Pi read tool to read nonce.txt, then reply with its exact content. Never invent the nonce.\n');
await writeFile(join(dir, 'nonce.txt'), 'PI_TOOL_ROUNDTRIP_7391\n');
if (synthetic) {
  await copyFile('src/local/fixtures/fake-freebuff.cjs', join(dir, 'freebuff'));
  await chmod(join(dir, 'freebuff'), 0o755);
  process.env.PATH = `${dir}:${process.env.PATH}`;
  process.env.MILO_TEST_HOME = dir;
  process.env.MILO_TEST_JSON_BRIDGE = '1';
}
const source = new Freebuff({ toolBridge: bridged, ...(synthetic ? { home: dir, startup: 100, poll: 20 } : {}), timeout: 30000 });
const sources = new Sources([source]);
let app;
const server = serve({ fetch: request => app.fetch(request), hostname: '127.0.0.1', port: 0 });
await new Promise(resolve => server.once('listening', resolve));
app = createLocalApp(sources, { port: server.address().port });
process.env.PI_CODING_AGENT_DIR = config;
await configurePi(server.address().port);
try {
  const run = await new Promise((resolve, reject) => {
    const child = spawn('pi', ['--offline', '--no-extensions', '--no-context-files', '--no-prompt-templates', '--no-session', '--provider', 'grunt', '--model', 'grunt', '--tools', 'read', '--skill', skill, '--mode', 'json', '-p', '/skill:proof-read'], { cwd: dir, env: process.env, stdio: ['ignore','pipe','pipe'], signal: AbortSignal.timeout(45000) });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.on('error', error => reject(new Error(`${error.message}: ${output.slice(-4000)}`)));
    child.on('close', code => resolve({ code, output }));
  });
  if (!bridged) {
    assert.equal(run.code, 0, run.output);
    assert.doesNotMatch(run.output, /Tool-capable sources are unavailable/);
    console.log(JSON.stringify({ reproduction: 'PF1', actualPi: true, bridge: false, result: 'Pi request reached the unbridged delegate and returned final text; Pi tool execution is not proven' }));
  } else {
    assert.equal(run.code, 0, run.output);
    const events = run.output.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
    const executed = events.find(event => event.type === 'tool_execution_end' && event.toolName === 'read');
    assert.ok(executed && !executed.isError, run.output);
    assert.match(JSON.stringify(executed.result), /PI_TOOL_ROUNDTRIP_7391/);
    const final = events.filter(event => event.type === 'message_end' && event.message?.role === 'assistant').at(-1)?.message;
    assert.equal(final?.stopReason, 'stop', run.output);
    assert.match(JSON.stringify(final.content), /PI_TOOL_ROUNDTRIP_7391/);
    console.log(JSON.stringify({ reproduction: 'PF1', actualPi: true, syntheticFreebuff: synthetic, bridge: true, result: 'Pi loaded proof-read skill, executed read and consumed its real nonce result' }));
  }
} finally {
  await sources.close();
  await new Promise(resolve => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
}
