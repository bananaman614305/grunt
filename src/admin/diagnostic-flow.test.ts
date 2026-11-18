import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '@libsql/client';
import { Sources, SourceError } from '../local/source.js';
import { DiagnosticsStore } from '../local/diagnostics.js';
import { createLocalApp } from '../local/api.js';
import { serve } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import { bundledRegistry } from '../registry.js';
import { WorkerPool } from '../local/worker-pool.js';
import { projectCollectorSnapshot } from './collector.js';
import { OpenCode } from '../local/opencode.js';
import { idleEvents } from '../local/fixtures/opencode-events.js';
import { AdminStore } from './store.js';
import { adminRoutes } from './routes.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

it('delivers a redacted fallback trace from a local request through authenticated remote ingestion and read-only diagnosis', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'grunt-admin-flow-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const journal = await DiagnosticsStore.open({ directory });
  cleanups.push(() => journal.close());
  const sources = new Sources([
    { id: 'kilo', supportsFunctionTools: true, available: async () => true, close: async () => {}, complete: async () => {
      throw new SourceError('upstream', 'SECRET_UPSTREAM_MESSAGE', undefined, 'SECRET_UPSTREAM_OUTPUT',
        { httpStatus: 200, transport: 'http', endpointLabel: 'chat.completions', failureReason: 'response_choices' });
    } },
    new OpenCode({ url: 'http://127.0.0.1:4096', fetcher: async input => {
      const path = new URL(String(input)).pathname;
      if (path === '/event') return idleEvents();
      if (path === '/session') return Response.json({ id: 'session_one' });
      if (path === '/session/session_one/message') return Response.json({
        info: { tokens: { input: 150, output: 12, cache: { read: 10, write: 15 }, reasoning: 4 } },
        parts: [{ type: 'text', text: 'SECRET_GENERATED_CONTENT' }]
      });
      throw new Error('Unexpected OpenCode call');
    } })
  ]);
  sources.setDiagnostics(journal);
  cleanups.push(() => sources.close());
  const local = createLocalApp(sources, { port: 8792 });
  const response = await local.request('http://127.0.0.1:8792/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'grunt', cwd: directory, messages: [{ role: 'user', content: 'SECRET_USER_PROMPT' }], max_tokens: 256 })
  });
  expect(response.status).toBe(200);
  expect(response.headers.get('X-Grunt-Source')).toBe('opencode');
  const requestId = response.headers.get('X-Grunt-Request-Id');
  expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
  const eventsResponse = await local.request('http://127.0.0.1:8792/v1/diagnostics/events');
  const { events } = await eventsResponse.json();
  expect(events.filter((event: { type: string }) => event.type === 'attempt.finish')).toHaveLength(2);

  const client = createClient({ url: 'file::memory:' });
  cleanups.push(async () => { client.close(); });
  const store = new AdminStore(client); await store.init();
  const env = {
    GRUNT_ADMIN_GOOGLE_CLIENT_ID: 'synthetic-admin.apps.googleusercontent.com',
    GRUNT_ADMIN_GOOGLE_CLIENT_SECRET: 'synthetic-client-secret',
    GRUNT_ADMIN_SESSION_SECRET: 'synthetic-session-secret-with-at-least-32-bytes',
    GRUNT_ADMIN_OWNERS: 'owner@example.test', GRUNT_ADMIN_INSTANCES: 'chad',
    GRUNT_ADMIN_INGEST_KEY: 'synthetic-machine-ingest-key-with-32-characters',
    GRUNT_ADMIN_READ_TOKEN: 'synthetic-agent-read-key-with-at-least-32-characters'
  };
  const remote = adminRoutes(store, { env });
  const batch = { version: 1, instanceId: 'chad', observedAt: Date.now(), snapshot: sources.status(), events };
  const upload = await remote.request('https://api.grunt.run/admin/ingest', {
    method: 'POST', headers: { Authorization: `Bearer ${env.GRUNT_ADMIN_INGEST_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(batch)
  });
  expect(upload.status).toBe(200);
  expect((await remote.request(`https://api.grunt.run/admin/api/requests/${requestId}`)).status).toBe(401);
  const headers = { Authorization: `Bearer ${env.GRUNT_ADMIN_READ_TOKEN}` };
  const detail = await remote.request(`https://api.grunt.run/admin/api/requests/${requestId}?instanceId=chad`, { headers });
  expect(detail.status).toBe(200);
  const trace = await detail.json();
  expect(trace.request).toMatchObject({ id: requestId, outcome: 'passed', source: 'opencode', attemptCount: 2 });
  expect(trace.events).toContainEqual(expect.objectContaining({
    source: 'kilo', type: 'attempt.finish', outcome: 'failed', httpStatus: 200, failureReason: 'response_choices'
  }));
  expect(trace.events).toContainEqual(expect.objectContaining({ source: 'opencode', type: 'attempt.finish', outcome: 'passed', inputTokens: 175, outputTokens: 16 }));
  const windowStart = Date.now() - 60000;
  const usage = await remote.request(`https://api.grunt.run/admin/api/source-usage?today=${windowStart}&week=${windowStart}&instanceId=chad`, { headers });
  expect(usage.status).toBe(200);
  expect((await usage.json()).sources).toContainEqual(expect.objectContaining({
    source: 'opencode', today: expect.objectContaining({ replies: 1, inputTokens: 175, outputTokens: 16 })
  }));
  expect(JSON.stringify(trace)).not.toMatch(/SECRET_|Bearer|vault:|\/tmp\//);
  const replay = await remote.request('https://api.grunt.run/admin/ingest', {
    method: 'POST', headers: { Authorization: `Bearer ${env.GRUNT_ADMIN_INGEST_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(batch)
  });
  expect(replay.status).toBe(200);
  const replayed = await (await remote.request(`https://api.grunt.run/admin/api/requests/${requestId}?instanceId=chad`, { headers })).json();
  expect(replayed.events).toHaveLength(trace.events.length);
  expect((await remote.request('https://api.grunt.run/admin/auth/logout', { method: 'POST', headers })).status).toBe(403);
});

it('attributes simultaneous worker replies through the loopback API, collector and lifetime usage', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'grunt-worker-flow-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const journal = await DiagnosticsStore.open({ directory });
  cleanups.push(() => journal.close());
  let unblock!: () => void;
  const pendingReply = new Promise<void>(resolve => { unblock = resolve; });
  const sources = new Sources(['kilo', 'zro'].map(id => ({
    id, available: async () => true, complete: async (request, signal) => {
      expect(request.messages.at(-1)?.content).toContain('PRIVATE_TASK_CONTEXT');
      expect(request.tools).toEqual([]);
      expect(request.worker).toBeUndefined();
      await pendingReply;
      signal.throwIfAborted();
      return { text: 'PRIVATE_WORKER_REPLY', inputTokens: 15, outputTokens: 5 };
    }
  })), { registry: () => bundledRegistry, random: () => 0 });
  sources.setDiagnostics(journal);
  const workers = new WorkerPool(sources);
  cleanups.push(async () => { unblock(); await workers.close(); await sources.close(); });
  const app = createLocalApp(sources, { workers });
  const base = 'http://127.0.0.1:8788';
  const send = (headers: Record<string, string> = {}, task = { task: 'PRIVATE_TASK_CONTEXT' }) =>
    app.request(base + '/v1/workers/run', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(task) });

  expect((await send({ Origin: 'https://untrusted.example' })).status).toBe(403);
  expect((await send({}, { task: '' })).status).toBe(400);
  expect((await send({}, { task: 'a'.repeat(256 * 1024) })).status).toBe(413);
  const responses = Promise.all([send(), send()]);
  await expect.poll(() => workers.status().active.map(worker => worker.source).sort()).toEqual(['kilo', 'zro']);
  const during = await (await app.request(base + '/v1/workers')).json();
  expect(during.active).toHaveLength(2);
  unblock();
  const results = await Promise.all((await responses).map(response => response.json()));
  expect(results.map(result => result.source).sort()).toEqual(['kilo', 'zro']);
  expect(results.map(result => result.text)).toEqual(['PRIVATE_WORKER_REPLY', 'PRIVATE_WORKER_REPLY']);

  const client = createClient({ url: 'file::memory:' });
  cleanups.push(async () => { client.close(); });
  const store = new AdminStore(client); await store.init();
  const raw = await (await app.request(base + '/v1/status')).json();
  const snapshot = projectCollectorSnapshot(raw);
  const { events } = await (await app.request(base + '/v1/diagnostics/events')).json();
  await store.ingest({ version: 1, instanceId: 'fixture', observedAt: Date.now(), snapshot, events });
  const overview = await store.overview('fixture');
  expect(overview.instances[0]?.snapshot?.workers?.recent.map(worker => worker.id).sort()).toEqual(results.map(result => result.id).sort());
  const usage = await store.sourceUsage(Date.now() - 60000, Date.now() - 60000, 'fixture');
  expect(usage.totals.lifetime).toMatchObject({ replies: 2, tokens: 40, completeReports: 2 });
  expect(JSON.stringify(await store.exportData())).not.toMatch(/PRIVATE_|\/tmp\//);
});

it('cancels a running subworker when a loopback client disconnects', async () => {
  let adapterSignal: AbortSignal | undefined;
  const sources = new Sources([{
    id: 'kilo', available: async () => true,
    complete: async (_request, signal) => {
      adapterSignal = signal;
      signal.throwIfAborted();
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    }
  }], { registry: () => bundledRegistry });
  const workers = new WorkerPool(sources);
  let port = 0;
  const server = serve({ fetch: request => createLocalApp(sources, { port, workers }).fetch(request), hostname: '127.0.0.1', port }, info => { port = info.port; });
  cleanups.push(async () => {
    await workers.close();
    server.closeAllConnections?.();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  if (!port) await new Promise<void>(resolve => server.once('listening', resolve));
  port = (server.address() as AddressInfo).port;
  const controller = new AbortController();
  const response = fetch(`http://127.0.0.1:${port}/v1/workers/run`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ task: 'Review fixture' }), signal: controller.signal
  });
  void response.catch(() => {});
  await expect.poll(() => adapterSignal).toBeDefined();
  controller.abort();
  await expect(response).rejects.toMatchObject({ name: 'AbortError' });
  await expect.poll(() => workers.status().recent[0]?.state).toBe('cancelled');
  expect(adapterSignal?.aborted).toBe(true);
});
