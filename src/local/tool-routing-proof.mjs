// Reproduction R2 stand-in: built HTTP API, real tmux, synthetic Freebuff/provider.
import assert from 'node:assert/strict';
import { mkdtemp, copyFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { Freebuff } from '../../dist/local/freebuff.js';
import { Sources, Gateway } from '../../dist/local/source.js';
import { createLocalApp } from '../../dist/local/api.js';
import { bundledRegistry } from '../../dist/registry.js';

const directory = await mkdtemp(join(tmpdir(), 'grunt-tools-proof-'));
await copyFile('src/local/fixtures/fake-freebuff.cjs', join(directory, 'freebuff'));
await chmod(join(directory, 'freebuff'), 0o755);
process.env.PATH = `${directory}:${process.env.PATH}`;
process.env.MILO_TEST_HOME = directory;
process.env.MILO_TEST_REASONING = '1';
const delegate = new Freebuff({ home: directory, startup: 100, poll: 20 });
const call = { id: 'avatar', type: 'function', function: { name: 'app_tool', arguments: '{"app":"beeline:avatar"}' } };
let upstream = 0;
const gateway = new Gateway('http://127.0.0.1:1/v1', 'synthetic', async (_url, init) => {
  const body = JSON.parse(init.body);
  assert.equal(body.tools[0].function.name, 'app_tool');
  assert.equal(body.messages[0].content, 'Use the supplied avatar tool');
  upstream++;
  return Response.json({ choices: [{ message: { content: null, tool_calls: [call] } }] });
});
const sources = new Sources([delegate, gateway], { registry: () => bundledRegistry });
let app;
const server = serve({ fetch: request => app.fetch(request), hostname: '127.0.0.1', port: 0 });
await new Promise(resolve => server.once('listening', resolve));
app = createLocalApp(sources, { port: server.address().port });
const url = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
const send = async body => {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'grunt', cwd: directory, ...body }) });
  return { status: response.status, body: await response.json() };
};
try {
  const hello = await send({ messages: [{ role: 'user', content: 'hello' }] });
  assert.equal(hello.status, 200, JSON.stringify(hello.body));
  assert.equal(hello.body.choices[0].message.content, 'hello');
  const tools = [{ type: 'function', function: { name: 'app_tool', parameters: { type: 'object' } } }];
  const messages = [{ role: 'system', content: 'Use the supplied avatar tool' }, { role: 'user', content: '/draw-avatar' }];
  const avatar = await send({ messages, tools });
  assert.deepEqual(avatar.body.choices[0].message.tool_calls, [call]);
  assert.equal(upstream, 1);
  // The same guard protects the standalone bridge and explicit delegate models.
  const bridge = createLocalApp(new Sources([delegate]), { port: 8789 });
  const rejected = await bridge.request('http://localhost:8789/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'freebuff', cwd: directory, messages, tools }) });
  assert.equal(rejected.status, 503);
  assert.match((await rejected.json()).error.message, /Tool-capable sources are unavailable/);
  console.log(JSON.stringify({ reproduction: 'R2', standIn: 'built HTTP API with real tmux and synthetic providers', finalAnswer: 'hello', returnedToolCall: call.function.name, delegateBridgeRejected: rejected.status }));
} finally {
  await sources.close();
  await new Promise(resolve => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
