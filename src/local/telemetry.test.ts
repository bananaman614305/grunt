import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { DEFAULT_POSTHOG_KEY, HEARTBEAT_KEYS, POSTHOG_HOST, PostHogTelemetry, ROUTE_SUMMARY_KEYS, SETUP_KEYS, SYSTEM_KEYS, postHogHost, postHogKey, queueSetupCompleted } from './telemetry.js';
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

it('sends a queued setup_completed with the next exchange and removes it only after a 2xx response', async () => {
  let status = 503;
  const { received, env } = await posthog((_request, response) => { response.writeHead(status).end(); });
  const dir = await directory();
  expect(await queueSetupCompleted({ directory: dir, sourcesConfigured: 3, version: '1.2.3', env, now: () => now })).toBe(true);
  if (process.platform !== 'win32') expect((await stat(join(dir, 'telemetry-setup.json'))).mode & 0o777).toBe(0o600);
  const sent = telemetry(dir, env);
  await sent.exchange();
  const setup = (index: number) => received[index]!.body.batch.filter(event => event.event === 'setup_completed');
  expect(setup(0)).toHaveLength(1);
  expectAllowlisted(setup(0)[0]!, SETUP_KEYS);
  expect(setup(0)[0]).toMatchObject({ properties: { version: '1.2.3', os: process.platform, arch: process.arch,
    sources_configured: 3, $insert_id: `setup:${DISTINCT}:2026-11-27` } });
  status = 200;
  await sent.exchange();
  expect(setup(1)).toHaveLength(1);
  await sent.exchange();
  expect(setup(2)).toEqual([]);
});

it('drops a malformed queued setup event instead of sending its contents', async () => {
  const { received, env } = await posthog();
  const dir = await directory();
  await writeFile(join(dir, 'telemetry-setup.json'), JSON.stringify({ day: '2026-11-27', version: '/home/PRIVATE', sources_configured: 1 }), { mode: 0o600 });
  await telemetry(dir, env).exchange();
  expect(received[0]!.body.batch.map(event => event.event)).toEqual(['daemon_heartbeat']);
  expect(JSON.stringify(received)).not.toMatch(PII);
});

it('uses the built-in US key by default, a build-time key over it, and the environment only when set', () => {
  expect(DEFAULT_POSTHOG_KEY).toBe('phc_rukwLrDhnHff9WjyCz8X68vRzrHexoUd9aRFRPnAvRgN');
  expect(postHogKey({}, '')).toBe(DEFAULT_POSTHOG_KEY);
  expect(postHogKey({}, 'phc_build')).toBe('phc_build');
  expect(postHogKey({ GRUNT_POSTHOG_KEY: KEY }, 'phc_build')).toBe(KEY);
  expect(postHogKey({ GRUNT_POSTHOG_KEY: '' }, 'phc_build')).toBe('');
  expect(postHogHost({})).toBe('https://us.i.posthog.com');
  expect(POSTHOG_HOST).toBe('https://us.i.posthog.com');
  expect(postHogHost({ GRUNT_POSTHOG_HOST: 'http://127.0.0.1:9/' })).toBe('http://127.0.0.1:9');
});

it('does nothing when the key is set empty', async () => {
  const { received, env } = await posthog();
  const offline = { GRUNT_POSTHOG_KEY: '', GRUNT_POSTHOG_HOST: env.GRUNT_POSTHOG_HOST };
  const dir = await directory('');
  const sent = telemetry(dir, offline);
  sent.record('kilo', 'ok', 100);
  expect(sent.enabled).toBe(false);
  await sent.exchange();
  expect(await queueSetupCompleted({ directory: dir, sourcesConfigured: 1, env: offline })).toBe(false);
  expect(received).toEqual([]);
  await expect(readFile(join(dir, 'registry-install'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(readFile(join(dir, 'telemetry-setup.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('swallows unreachable hosts and refuses redirects', async () => {
  const dir = await directory();
  await expect(telemetry(dir, { GRUNT_POSTHOG_KEY: KEY, GRUNT_POSTHOG_HOST: 'http://127.0.0.1:0' }).exchange()).resolves.toBeUndefined();
  let followed = false;
  const target = await posthog(() => { followed = true; });
  const redirect = await posthog((_request, response) => { response.writeHead(307, { Location: `${target.env.GRUNT_POSTHOG_HOST}/batch/` }).end(); });
  const sent = telemetry(dir, redirect.env, { at: now - 24 * 60 * 60 * 1000 });
  sent.record('kilo', 'ok', 100);
  await sent.exchange();
  await sent.exchange();
  expect(followed).toBe(false);
  expect(redirect.received[1]!.body.batch.map(event => String(event.properties.$insert_id))).toContain(`route:${DISTINCT}:2026-11-26:kilo`);
});

it('keeps a newer setup event queued when an overlapping exchange fails after an earlier one succeeds', async () => {
  const hold = Promise.withResolvers<void>(), first = Promise.withResolvers<void>();
  const acknowledged = Promise.withResolvers<void>();
  let calls = 0;
  const { received, env } = await posthog(async (_request, response) => {
    const call = ++calls;
    if (call === 1) { first.resolve(); await hold.promise; response.writeHead(200).end(); }
    // The second upload fails only after the first one has been acknowledged.
    else if (call === 2) { await acknowledged.promise; response.writeHead(503).end(); }
    else response.writeHead(200).end();
  });
  const dir = await directory();
  const sent = telemetry(dir, env);
  const setups = (index: number) => received[index]!.body.batch.filter(event => event.event === 'setup_completed').map(event => event.properties.sources_configured);
  await queueSetupCompleted({ directory: dir, sourcesConfigured: 1, env, now: () => now });
  const earlier = sent.exchange();
  void earlier.then(acknowledged.resolve);
  await first.promise;
  // A newer setup finishes while the first upload is in flight, and a second exchange starts.
  await queueSetupCompleted({ directory: dir, sourcesConfigured: 2, env, now: () => now });
  const later = sent.exchange();
  // Give an unserialized exchange time to claim the newer event before the first upload is acknowledged.
  for (let wait = 0; wait < 30 && await stat(join(dir, 'telemetry-setup.json')).then(() => true, () => false); wait++) await new Promise(resolve => setTimeout(resolve, 10));
  hold.resolve();
  await Promise.all([earlier, later]);
  expect([setups(0), setups(1)]).toEqual([[1], [2]]);
  await sent.exchange();
  expect(setups(2)).toEqual([2]);
  await sent.exchange();
  expect(setups(3)).toEqual([]);
});

it('retries a failed setup event before a newer one and delivers both', async () => {
  let status = 503;
  const { received, env } = await posthog((_request, response) => { response.writeHead(status).end(); });
  const dir = await directory();
  const sent = telemetry(dir, env);
  const setups = (index: number) => received[index]!.body.batch.filter(event => event.event === 'setup_completed').map(event => event.properties.sources_configured);
  await queueSetupCompleted({ directory: dir, sourcesConfigured: 1, env, now: () => now });
  await sent.exchange();
  // PostHog rejected the first event; a newer setup finishes before the next exchange.
  await queueSetupCompleted({ directory: dir, sourcesConfigured: 2, env, now: () => now });
  status = 200;
  await sent.exchange();
  await sent.exchange();
  await sent.exchange();
  expect(received.map((_, index) => setups(index))).toEqual([[1], [1], [2], []]);
});
