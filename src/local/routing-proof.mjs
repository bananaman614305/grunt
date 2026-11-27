// Built HTTP/Pi path. --live uses real OpenCode; Freebuff quota is an explicit stand-in.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { Sources, SourceError } from '../../dist/local/source.js';
import { Freebuff } from '../../dist/local/freebuff.js';
import { OpenCode } from '../../dist/local/opencode.js';
import { createLocalApp } from '../../dist/local/api.js';
import { RegistrySync } from '../../dist/local/registry.js';
import { bundledRegistry } from '../../dist/registry.js';

const both = process.argv.includes('--live-both');
const live = process.argv.includes('--live');
const cwd = await mkdtemp(join(tmpdir(), 'grunt-routing-proof-'));
const servers = [];
let openCode, freebuff;
const traces = [];
async function listen(app) {
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  await new Promise(resolve => server.once('listening', resolve)); servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}
async function close(server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
try {
  const git = (...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.name', 'Proof'); git('config', 'user.email', 'proof@example.test');
  await writeFile(join(cwd, 'progress.txt'), 'BASELINE\n'); git('add', '.'); git('commit', '-qm', 'baseline');
  await writeFile(join(cwd, 'progress.txt'), 'BASELINE\nUSER EDIT\n');
  const head = git('rev-parse', 'HEAD');
  const publishedPath = join(cwd, 'published.json');
  const published = { ...bundledRegistry, published: new Date(Date.parse(bundledRegistry.published) + 1000).toISOString() };
  await writeFile(publishedPath, JSON.stringify(published));
  const staticRegistry = new Hono();
  staticRegistry.get('/v1/registry', async c => {
    const body = await readFile(publishedPath, 'utf8');
    const etag = `"${createHash('sha256').update(body).digest('hex').slice(0, 16)}"`;
    c.header('ETag', etag);
    if (c.req.header('If-None-Match') === etag) return c.body(null, 304);
    c.header('Content-Type', 'application/json');
    return c.body(body);
  });
  const gatewayUrl = await listen(staticRegistry);
  const sync = new RegistrySync({ directory: join(cwd, 'cache'), url: `${gatewayUrl}/v1/registry` });
  await sync.load(); await sync.sync(); assert.deepEqual(sync.current, published);
  const etag = (await fetch(`${gatewayUrl}/v1/registry`)).headers.get('etag');
  assert.equal((await fetch(`${gatewayUrl}/v1/registry`, { headers: { 'If-None-Match': etag } })).status, 304);
  await close(servers.shift()); await sync.sync(); assert.deepEqual(sync.current, published);
  const restarted = new RegistrySync({ directory: join(cwd, 'cache'), url: gatewayUrl });
  await restarted.load(); assert.deepEqual(restarted.current, published); await sync.close(); await restarted.close();
  if (live || both) openCode = new OpenCode({ timeout: 120000 });
  else {
    const upstream = new Hono();
    upstream.get('/event', () => new Response(new ReadableStream(), { headers: { 'Content-Type': 'text/event-stream' } }));
    upstream.post('/session', c => c.json({ id: 'proof_session' }));
    upstream.post('/session/:id/message', async c => {
      const body = await c.req.json(); assert.match(body.parts[0].text, /Continue this task from the current state/);
      await writeFile(join(cwd, 'progress.txt'), (await readFile(join(cwd, 'progress.txt'), 'utf8')) + 'DONE\n');
      return c.json({ parts: [{ type: 'text', text: 'DONE' }] });
    });
    openCode = new OpenCode({ url: await listen(upstream) });
  }
  freebuff = both ? new Freebuff({ timeout: 120000 }) : undefined;
  const exhausted = { id: both ? 'opencode' : 'freebuff', available: async () => true, complete: async (request, signal) => {
    if (both) {
      const start = Date.now();
      const result = await openCode.complete({ ...request, userMessages: undefined, messages: [{ role: 'user', content: 'Append exactly PARTIAL PROGRESS followed by a newline as a new line to progress.txt. Preserve existing lines. Reply PARTIAL PROGRESS when done.' }] }, signal);
      const progress = await readFile(join(cwd, 'progress.txt'), 'utf8');
      traces.push(`OpenCode returned ${JSON.stringify(result.text)}; file=${JSON.stringify(progress)} (${Date.now()-start} ms)`);
      assert.equal(progress.trimEnd(), 'BASELINE\nUSER EDIT\nPARTIAL PROGRESS');
      traces.push(`real OpenCode progress completed (${Date.now()-start} ms); injecting quota at adapter boundary`);
      throw new SourceError('quota', 'Forced quota after real OpenCode progress', 120, result.text);
    }
    await writeFile(join(cwd, 'progress.txt'), 'BASELINE\nUSER EDIT\nPARTIAL PROGRESS\n');
    traces.push('simulated Freebuff made progress, then returned quota');
    throw new SourceError('quota', 'Forced quota proof', 120, 'PARTIAL PROGRESS was written to progress.txt');
  } };
  const next = { id: both ? 'freebuff' : 'opencode', available: () => both ? freebuff.available() : openCode.available(), complete: async (request, signal) => {
    assert.match(request.handoffPrompt, /\+PARTIAL PROGRESS/);
    assert(!request.handoffPrompt.includes('+USER EDIT'), 'checkpoint excludes pre-existing edits from agent changes');
    traces.push('Continuation adapter received task, checkpoint diff, partial output and continue instruction');
    const start = Date.now();
    const result = await (both ? freebuff : openCode).complete(request, signal);
    traces.push(`continuation completed (${Date.now()-start} ms)`);
    return result;
  } };
  const sources = new Sources([exhausted, next], { registry: () => restarted.current, random: () => 0 });
  const api = new Hono(); let service;
  api.all('*', c => service.fetch(c.req.raw));
  const url = await listen(api); service = createLocalApp(sources, { port: Number(new URL(url).port) });
  const fixture = JSON.parse(await readFile(new URL('./fixtures/pi.json', import.meta.url), 'utf8'));
  const response = await fetch(`${url}/v1/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(150000),
    body: JSON.stringify({ ...fixture, tools: [], model: 'grunt', cwd, stream: false, messages: [{ role: 'user', content: 'Append the line DONE to progress.txt after the work so far. Preserve all existing lines exactly. Do not change any other files. Reply only DONE when finished.' }] })
  });
  if (response.status !== 200) console.error(JSON.stringify({ status: response.status, body: await response.clone().text(), traces }));
  assert.equal(response.status, 200); const answer = await response.json(); assert(answer.choices[0].message.content.trim());
  const result = await readFile(join(cwd, 'progress.txt'), 'utf8');
  assert.equal(result, 'BASELINE\nUSER EDIT\nPARTIAL PROGRESS\nDONE\n');
  assert.equal(git('rev-parse', 'HEAD'), head); assert.equal(git('stash', 'list'), '');
  console.log(JSON.stringify({ proof: 'grunt-routing-v1', mode: both ? 'real OpenCode to real Freebuff; injected quota after real partial work' : live ? 'live OpenCode, simulated exhausted Freebuff' : 'offline adapters', http: response.status, registry: 'published list, ETag, offline cache restart passed', handoff: 'preserved user edits and partial progress; completed task without restart', checkpoint: 'branch and stash list unchanged', traces }, null, 2));
  await sources.close();
} finally {
  await openCode?.close();
  await freebuff?.close();
  await Promise.all(servers.map(close)); await rm(cwd, { recursive: true, force: true });
}
