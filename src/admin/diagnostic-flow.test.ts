import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '@libsql/client';
import { Sources, SourceError } from '../local/source.js';
import { DiagnosticsStore } from '../local/diagnostics.js';
import { createLocalApp } from '../local/api.js';
import { OpenCode } from '../local/opencode.js';
import { idleEvents } from '../local/fixtures/opencode-events.js';
import { AdminStore } from './store.js';
import { adminRoutes } from './routes.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

it.each(['response_choices', 'stream_read', 'stream_format', 'stream_incomplete', 'stream_cleanup'] as const)('delivers a redacted %s fallback trace through authenticated remote ingestion and read-only diagnosis', async failureReason => {
  const directory = await mkdtemp(join(tmpdir(), 'grunt-admin-flow-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const journal = await DiagnosticsStore.open({ directory });
  cleanups.push(() => journal.close());
  const sources = new Sources([
    { id: 'kilo', supportsFunctionTools: true, available: async () => true, close: async () => {}, complete: async () => {
      throw new SourceError('upstream', 'SECRET_UPSTREAM_MESSAGE', undefined, 'SECRET_UPSTREAM_OUTPUT',
        { httpStatus: 200, transport: 'http', endpointLabel: 'chat.completions', failureReason });
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
    source: 'kilo', type: 'attempt.finish', outcome: 'failed', httpStatus: 200, failureReason
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
