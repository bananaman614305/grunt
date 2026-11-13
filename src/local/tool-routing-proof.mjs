// Reproduction FT1: built HTTP API, real tmux, synthetic Freebuff TUI.
// The synthetic TUI avoids live login and proves routing, not live Pi tool execution.
import assert from 'node:assert/strict';
import { mkdtemp, copyFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { Freebuff } from '../../dist/local/freebuff.js';
import { Sources } from '../../dist/local/source.js';
import { createLocalApp } from '../../dist/local/api.js';
import { bundledRegistry } from '../../dist/registry.js';

const before = process.argv.includes('--before');
const directory = await mkdtemp(join(tmpdir(), 'grunt-tools-proof-'));
await copyFile('src/local/fixtures/fake-freebuff.cjs', join(directory, 'freebuff'));
await chmod(join(directory, 'freebuff'), 0o755);
process.env.PATH = `${directory}:${process.env.PATH}`;
process.env.MILO_TEST_HOME = directory;
process.env.MILO_TEST_REASONING = '1';
const tools = [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }];
const delegate = new Freebuff({ home: directory, startup: 100, poll: 20 });
let invocations = 0;
const complete = delegate.complete.bind(delegate);
delegate.complete = async (request, signal) => {
  assert.deepEqual(request.tools, tools);
  invocations++;
  return complete(request, signal);
};
const sources = [];
let app;
const server = serve({ fetch: request => app.fetch(request), hostname: '127.0.0.1', port: 0 });
await new Promise(resolve => server.once('listening', resolve));
const url = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
try {
  for (const sticky of [false, true]) {
    const chain = new Sources([delegate], sticky ? { registry: () => bundledRegistry } : undefined);
    sources.push(chain);
    app = createLocalApp(chain, { port: server.address().port });
    for (const model of ['freebuff', 'milo']) {
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, cwd: directory, messages: [{ role: 'user', content: 'FT1 routing restored' }], tools }) });
      const body = await response.json();
      if (before) {
        assert.equal(response.status, 503);
        assert.match(body.error.message, /Tool-capable sources are unavailable/);
        assert.equal(invocations, 0);
      } else {
        assert.equal(response.status, 200, JSON.stringify(body));
        assert.equal(body.choices[0].message.content, 'FT1 routing restored');
        assert.equal(body.choices[0].message.tool_calls, undefined);
      }
    }
  }
  assert.equal(invocations, before ? 0 : 4);
  console.log(JSON.stringify({ reproduction: 'FT1', standIn: 'built HTTP API, real tmux, synthetic Freebuff TUI', bridge: false, invocations, result: before ? 'tool requests excluded with HTTP 503' : 'explicit and automatic tool requests reach Freebuff with intact definitions; final text returned', liveToolExecutionProven: false }));
} finally {
  await Promise.all(sources.map(source => source.close()));
  await new Promise(resolve => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
