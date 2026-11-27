import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { HEARTBEAT_KEYS, PostHogTelemetry, ROUTE_SUMMARY_KEYS, SETUP_KEYS, SYSTEM_KEYS, sendSetupCompleted } from './telemetry.js';
import type { TelemetryEvent } from './telemetry.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const KEY = 'phc_test_only_offline_key';
const INSTALL = '0123456789abcdef0123456789abcdef';
const DISTINCT = createHash('sha256').update('grunt-posthog-v1:' + INSTALL).digest('hex');
const now = Date.UTC(2026, 10, 27, 15);

interface Received { path: string; body: { api_key: string; batch: TelemetryEvent[] } }
async function posthog(reply: (request: IncomingMessage, response: ServerResponse) => void = (_request, response) => { response.writeHead(200).end('{"status":1}'); }) {
  const received: Received[] = [];
  const server = createServer(async (request, response) => {
    let text = '';
    for await (const chunk of request) text += chunk;
    received.push({ path: request.url ?? '', body: JSON.parse(text) });
    reply(request, response);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { received, env: { GRUNT_POSTHOG_KEY: KEY, GRUNT_POSTHOG_HOST: `http://127.0.0.1:${(server.address() as AddressInfo).port}` } };
}
async function directory(install = INSTALL) {
  const path = await mkdtemp(join(tmpdir(), 'grunt-telemetry-'));
  cleanups.push(() => rm(path, { recursive: true, force: true }));
  if (install) await writeFile(join(path, 'registry-install'), install, { mode: 0o600 });
  return path;
}
function telemetry(dir: string, env: Record<string, string>, clock = { at: now }) {
  return new PostHogTelemetry({ directory: dir, env, now: () => clock.at, version: '1.2.3',
    listed: () => ['kilo', 'zro'], retired: id => id === 'zro', stats: () => ({ openRoutes: 2, enabledSources: 5 }) });
}
const PII = /PRIVATE|\/home|\/tmp|127\.0\.0\.1|sk-|gpt|claude|prompt|response/i;
function expectAllowlisted(event: TelemetryEvent, keys: readonly string[]) {
  expect(Object.keys(event).sort()).toEqual(['distinct_id', 'event', 'properties', 'timestamp', 'uuid']);
  expect(Object.keys(event.properties).sort()).toEqual([...keys, ...SYSTEM_KEYS].sort());
  expect(event.properties.$process_person_profile).toBe(false);
  expect(event.distinct_id).toBe(DISTINCT);
  expect(event.uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(JSON.stringify(event)).not.toMatch(PII);
  expect(JSON.stringify(event)).not.toContain(INSTALL);
}

it('sends a heartbeat and listed route totals in one US PostHog batch with only allowlisted fields', async () => {
  const { received, env } = await posthog();
  const sent = telemetry(await directory(), env);
  sent.record('kilo', 'ok', 1240);
  sent.record('kilo', 'quota');
  sent.record('kilo', 'logged_out');
  sent.record('kilo', 'upstream');
  sent.record('kilo', 'cancelled');
  sent.signup('kilo', true);
  sent.signup('zro', false);
  sent.record('PRIVATE-unlisted-route', 'ok', 10);
  await sent.exchange();
  expect(received).toHaveLength(1);
  expect(received[0]!.path).toBe('/batch/');
  expect(received[0]!.body.api_key).toBe(KEY);
  const [heartbeat, ...routes] = received[0]!.body.batch;
  expectAllowlisted(heartbeat!, HEARTBEAT_KEYS);
  expect(heartbeat).toMatchObject({ event: 'daemon_heartbeat', timestamp: '2026-11-27T00:00:00.000Z', properties: {
    version: '1.2.3', os: process.platform, arch: process.arch, open_routes: 2, enabled_sources: 5, $insert_id: `hb:${DISTINCT}:2026-11-27` } });
  expect(routes.map(route => route.properties.route)).toEqual(['kilo', 'zro']);
  for (const route of routes) expectAllowlisted(route, ROUTE_SUMMARY_KEYS);
  expect(routes[0]!.properties).toEqual({ version: '1.2.3', route: 'kilo', ok: 1, failed: 1, quota: 1, auth: 1, latency_ms: 1200, signup_ok: 1, signup_failed: 0,
    retired: false, $insert_id: `route:${DISTINCT}:2026-11-27:kilo`, $process_person_profile: false, $geoip_disable: true });
  expect(routes[1]!.properties).toMatchObject({ route: 'zro', signup_failed: 1, retired: true });
});

it('keeps insert ids and uuids stable within a day so later totals replace earlier ones', async () => {
  const { received, env } = await posthog();
  const clock = { at: now };
  const sent = telemetry(await directory(), env, clock);
  sent.record('kilo', 'ok', 100);
  await sent.exchange();
  sent.record('kilo', 'ok', 100);
  clock.at += 60 * 60 * 1000;
  await sent.exchange();
  const [first, second] = received.map(request => request.body.batch);
  expect(second!.map(event => [event.uuid, event.properties.$insert_id, event.timestamp])).toEqual(first!.map(event => [event.uuid, event.properties.$insert_id, event.timestamp]));
  expect(second![1]!.properties.ok).toBe(2);
});

it('sends yesterday final totals and clears them only after a 2xx response', async () => {
  let status = 503;
  const { received, env } = await posthog((_request, response) => { response.writeHead(status).end(); });
  const clock = { at: now - 24 * 60 * 60 * 1000 };
  const sent = telemetry(await directory(), env, clock);
  sent.record('kilo', 'ok', 100);
  clock.at = now;
  await sent.exchange();
  const ids = (index: number) => received[index]!.body.batch.map(event => String(event.properties.$insert_id));
  expect(ids(0)).toEqual([`hb:${DISTINCT}:2026-11-27`, `route:${DISTINCT}:2026-11-26:kilo`]);
  await sent.exchange();
  expect(ids(1)).toContain(`route:${DISTINCT}:2026-11-26:kilo`);
  status = 200;
  await sent.exchange();
  await sent.exchange();
  expect(ids(3)).toEqual([`hb:${DISTINCT}:2026-11-27`]);
});

it('creates a private install id when none exists and never sends its raw value', async () => {
  const { received, env } = await posthog();
  const dir = await directory('');
  await telemetry(dir, env).exchange();
  const install = await readFile(join(dir, 'registry-install'), 'utf8');
  expect(install).toMatch(/^[0-9a-f]{32}$/);
  if (process.platform !== 'win32') expect((await stat(join(dir, 'registry-install'))).mode & 0o777).toBe(0o600);
  const distinct = createHash('sha256').update('grunt-posthog-v1:' + install).digest('hex');
  expect(received[0]!.body.batch[0]!.distinct_id).toBe(distinct);
  expect(JSON.stringify(received)).not.toContain(install);
});

it('sends setup_completed with only allowlisted fields', async () => {
  const { received, env } = await posthog();
  expect(await sendSetupCompleted({ directory: await directory(), sourcesConfigured: 3, version: '1.2.3', env, now: () => now })).toBe(true);
  const [event] = received[0]!.body.batch;
  expectAllowlisted(event!, SETUP_KEYS);
  expect(event).toMatchObject({ event: 'setup_completed', properties: { version: '1.2.3', os: process.platform, arch: process.arch,
    sources_configured: 3, $insert_id: `setup:${DISTINCT}:2026-11-27` } });
});

it('does nothing without a project key', async () => {
  const { received, env } = await posthog();
  const offline = { GRUNT_POSTHOG_HOST: env.GRUNT_POSTHOG_HOST };
  const dir = await directory('');
  const sent = telemetry(dir, offline);
  sent.record('kilo', 'ok', 100);
  expect(sent.enabled).toBe(false);
  await sent.exchange();
  expect(await sendSetupCompleted({ directory: dir, sourcesConfigured: 1, env: offline })).toBe(false);
  expect(received).toEqual([]);
  await expect(readFile(join(dir, 'registry-install'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('swallows unreachable hosts, refuses redirects and lets callers cancel a stalled request', async () => {
  const dir = await directory();
  await expect(telemetry(dir, { GRUNT_POSTHOG_KEY: KEY, GRUNT_POSTHOG_HOST: 'http://127.0.0.1:0' }).exchange()).resolves.toBeUndefined();
  const redirect = await posthog((_request, response) => { response.writeHead(307, { Location: 'http://127.0.0.1:1/batch/' }).end(); });
  expect(await sendSetupCompleted({ directory: dir, sourcesConfigured: 1, env: redirect.env })).toBe(false);
  const stalled = await posthog(() => {});
  const controller = new AbortController();
  const started = Date.now();
  const pending = sendSetupCompleted({ directory: dir, sourcesConfigured: 1, env: stalled.env, signal: controller.signal });
  setTimeout(() => controller.abort(), 50);
  expect(await pending).toBe(false);
  expect(Date.now() - started).toBeLessThan(2000);
});
