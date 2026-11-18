import { afterEach, expect, it, vi } from 'vitest';
import { createClient } from '@libsql/client';
import { randomUUID } from 'node:crypto';
import { AdminStore } from './store.js';
import { AdminAuthError, hashToken, randomToken } from './auth.js';
import { adminRoutes } from './routes.js';

const clients: ReturnType<typeof createClient>[] = [];
afterEach(() => { for (const client of clients.splice(0)) client.close(); });
const now = Date.parse('2026-11-17T06:00:00Z');
const origin = 'https://grunt.run';
const base = 'https://api.grunt.run';
const env = {
  GRUNT_ADMIN_GOOGLE_CLIENT_ID: 'synthetic-admin.apps.googleusercontent.com',
  GRUNT_ADMIN_GOOGLE_CLIENT_SECRET: 'synthetic-client-secret',
  GRUNT_ADMIN_SESSION_SECRET: 'synthetic-session-secret-with-at-least-32-bytes',
  GRUNT_ADMIN_OWNERS: 'owner@example.test,second@example.test',
  GRUNT_ADMIN_INGEST_KEY: 'synthetic-machine-ingest-key-with-32-characters',
  GRUNT_ADMIN_READ_TOKEN: 'synthetic-agent-read-key-with-at-least-32-characters',
  GRUNT_ADMIN_INSTANCES: 'chad'
};
function cookie(response: Response, name: string): string {
  return response.headers.getSetCookie().find(value => value.startsWith(name + '='))?.split(';')[0] ?? '';
}
async function fixture(overrides: NodeJS.ProcessEnv = {}, options: { ready?: boolean } = {}) {
  const client = createClient({ url: 'file::memory:' }); clients.push(client);
  const clock = { at: now }, store = new AdminStore(client, { now: () => clock.at }); await store.init();
  const auth = {
    begin: vi.fn(() => {
      const state = randomToken(), nonce = randomToken(), verifier = randomToken();
      return { authorizationUrl: `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`, state, nonce, verifier };
    }),
    exchange: vi.fn(async () => ({ email: 'owner@example.test', subject: 'subject-owner' }))
  };
  const configuration = { ...env, ...overrides };
  const app = adminRoutes(store, { env: configuration, auth, now: () => clock.at, ...options });
  const request = (path: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (path.startsWith('/api/') && !headers.has('Origin')) headers.set('Origin', origin);
    return app.request(base + '/admin' + path, { ...init, headers });
  };
  const begin = async () => {
    const response = await request('/auth/google');
    return { response, state: new URL(response.headers.get('Location')!).searchParams.get('state')!, cookie: cookie(response, '__Secure-grunt_admin_oauth') };
  };
  const login = async () => {
    const start = await begin();
    const response = await request(`/auth/callback?state=${start.state}&code=synthetic-code`, { headers: { Cookie: start.cookie } });
    return { response, cookie: cookie(response, '__Secure-grunt_admin_session'), start };
  };
  return { app, store, client, request, auth, begin, login, clock, configuration };
}
const batch = () => ({ version: 1, instanceId: 'chad', observedAt: now, snapshot: { version: 1, updatedAt: now, activeRequests: 0, sources: [{ id: 'kilo', state: 'ready', active: 0 }] }, events: [] });

it('fails closed without explicit owner and Google configuration', async () => {
  const f = await fixture({ GRUNT_ADMIN_OWNERS: '' });
  for (const path of ['/api/session', '/api/overview', '/auth/google']) {
    const response = await f.request(path); expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: 'admin_not_configured' } });
  }
  expect(f.auth.begin).not.toHaveBeenCalled();
});
it('requires authentication on every data and export endpoint', async () => {
  const f = await fixture();
  for (const path of ['/api/session', '/api/overview', '/api/providers', '/api/requests', `/api/requests/${randomUUID()}`, '/api/runs', '/api/export']) {
    const response = await f.request(path); expect(response.status).toBe(401); expect(response.headers.get('Cache-Control')).toBe('no-store');
  }
});
it('sets secure browser-bound OAuth state and stores only its keyed hash', async () => {
  const f = await fixture(), start = await f.begin();
  expect(start.response.status).toBe(302);
  const set = start.response.headers.get('Set-Cookie')!;
  for (const text of ['Secure', 'HttpOnly', 'SameSite=Lax', 'Path=/admin/auth']) expect(set).toContain(text);
  const rows = await f.client.execute('SELECT * FROM admin_login_states');
  expect(rows.rows).toHaveLength(1); expect(rows.rows[0]!.hash).not.toBe(start.state);
  expect(rows.rows[0]!.hash).toBe(hashToken(`state:${start.state}`, env.GRUNT_ADMIN_SESSION_SECRET));
});
it('rejects callback browser-state mismatch before token exchange', async () => {
  const f = await fixture(), start = await f.begin();
  const response = await f.request(`/auth/callback?state=${start.state}&code=synthetic-code`, { headers: { Cookie: `__Secure-grunt_admin_oauth=${randomToken()}` } });
  expect(response.status).toBe(303); expect(response.headers.get('Location')).toBe(origin + '/admin/?auth=signin_failed');
  expect(f.auth.exchange).not.toHaveBeenCalled();
});
it('rejects duplicate state or code query parameters', async () => {
  const f = await fixture(), start = await f.begin();
  const response = await f.request(`/auth/callback?state=${start.state}&state=${start.state}&code=one&code=two`, { headers: { Cookie: start.cookie } });
  expect(response.headers.get('Location')).toBe(origin + '/admin/?auth=signin_failed'); expect(f.auth.exchange).not.toHaveBeenCalled();
});
it('accepts an owner, rotates to a new session and consumes state exactly once', async () => {
  const f = await fixture(), result = await f.login();
  expect(result.response.status).toBe(303); expect(result.response.headers.get('Location')).toBe(origin + '/admin/');
  const set = result.response.headers.getSetCookie().find(value => value.startsWith('__Secure-grunt_admin_session='))!;
  for (const text of ['Secure', 'HttpOnly', 'SameSite=Lax', 'Path=/admin']) expect(set).toContain(text);
  const session = await f.request('/api/session', { headers: { Cookie: result.cookie, Origin: origin } });
  expect(session.status).toBe(200);
  expect(await session.json()).toMatchObject({ user: { email: 'owner@example.test' }, csrfToken: expect.stringMatching(/^[a-f0-9]{64}$/) });
  const replay = await f.request(`/auth/callback?state=${result.start.state}&code=synthetic-code`, { headers: { Cookie: result.start.cookie } });
  expect(replay.headers.get('Location')).toBe(origin + '/admin/?auth=signin_failed'); expect(f.auth.exchange).toHaveBeenCalledOnce();
});
it('denies nonowners and never creates their session', async () => {
  const f = await fixture(); f.auth.exchange.mockResolvedValue({ email: 'other@example.test', subject: 'other-subject' });
  const result = await f.login(); expect(result.cookie).toBe('');
  expect(result.response.headers.get('Location')).toBe(origin + '/admin/?auth=owner_denied');
  expect((await f.client.execute('SELECT * FROM admin_sessions')).rows).toHaveLength(0);
});
it('returns the configured Pages playtest only to a signed-in owner', async () => {
  const playtestUrl = 'https://round-5.amazing-adventure.pages.dev/';
  const f = await fixture({ GRUNT_ADMIN_PLAYTEST_URL: playtestUrl });
  expect((await f.request('/api/session')).status).toBe(401);
  const { cookie } = await f.login();
  const response = await f.request('/api/session', { headers: { Cookie: cookie, Origin: origin } });
  expect(await response.json()).toMatchObject({ playtestUrl });
});

it.each(['https://preview.pages.dev/?secret=test', 'https://pages.dev.evil.example/', 'http://preview.pages.dev/'])
  ('omits a playtest URL outside the configured Pages policy (%s)', async playtestUrl => {
    const f = await fixture({ GRUNT_ADMIN_PLAYTEST_URL: playtestUrl });
    const { cookie } = await f.login();
    const response = await f.request('/api/session', { headers: { Cookie: cookie, Origin: origin } });
    expect(await response.json()).not.toHaveProperty('playtestUrl');
  });
it('turns safe Google owner errors into fixed redirects without credential-bearing details', async () => {
  const f = await fixture(); f.auth.exchange.mockRejectedValue(new AdminAuthError('owner_required'));
  const result = await f.login(); expect(result.response.headers.get('Location')).toBe(origin + '/admin/?auth=owner_denied');
  expect(result.response.headers.get('Location')).not.toContain('synthetic-code');
});
it('rejects expired OAuth challenges and expired sessions', async () => {
  const f = await fixture(), start = await f.begin(); f.clock.at += 10 * 60 * 1000 + 1;
  const response = await f.request(`/auth/callback?state=${start.state}&code=synthetic-code`, { headers: { Cookie: start.cookie } });
  expect(response.headers.get('Location')).toBe(origin + '/admin/?auth=signin_failed'); expect(f.auth.exchange).not.toHaveBeenCalled();
  const current = await f.login(); f.clock.at += 12 * 60 * 60 * 1000 + 1;
  expect((await f.request('/api/overview', { headers: { Cookie: current.cookie } })).status).toBe(401);
});
it('rechecks owner configuration for an otherwise valid stored session', async () => {
  const f = await fixture(), login = await f.login();
  const changed = adminRoutes(f.store, { env: { ...env, GRUNT_ADMIN_OWNERS: 'second@example.test' }, now: () => f.clock.at });
  expect((await changed.request(base + '/admin/api/overview', { headers: { Cookie: login.cookie, Origin: origin } })).status).toBe(403);
});
it('only grants credentialed CORS to the configured UI origin', async () => {
  const f = await fixture(), login = await f.login();
  const allowed = await f.request('/api/overview', { headers: { Cookie: login.cookie, Origin: origin } });
  expect(allowed.status).toBe(200); expect(allowed.headers.get('Access-Control-Allow-Origin')).toBe(origin); expect(allowed.headers.get('Access-Control-Allow-Credentials')).toBe('true');
  const denied = await f.request('/api/overview', { headers: { Cookie: login.cookie, Origin: 'https://attacker.example.test' } });
  expect(denied.status).toBe(403); expect(denied.headers.get('Access-Control-Allow-Origin')).toBeNull();
});
it('supports a bounded credentialed preflight without authenticating data', async () => {
  const f = await fixture(), response = await f.request('/api/overview', { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'GET' } });
  expect(response.status).toBe(204); expect(response.headers.get('Access-Control-Allow-Origin')).toBe(origin);
  expect((await f.request('/api/overview', { method: 'OPTIONS', headers: { Origin: 'https://attacker.example.test' } })).status).toBe(403);
});
it('requires the owner session, exact origin, JSON and CSRF token for logout', async () => {
  const f = await fixture(), login = await f.login();
  expect((await f.request('/auth/logout', { headers: { Cookie: login.cookie } })).status).toBe(404);
  expect((await f.request('/auth/logout', { method: 'POST', headers: { Cookie: login.cookie, Origin: origin, 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(403);
  const session = await (await f.request('/api/session', { headers: { Cookie: login.cookie } })).json();
  const response = await f.request('/auth/logout', { method: 'POST', headers: { Cookie: login.cookie, Origin: origin, 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken }, body: '{}' });
  expect(response.status).toBe(200); expect(response.headers.get('Set-Cookie')).toContain('Max-Age=0');
  expect((await f.request('/api/overview', { headers: { Cookie: login.cookie } })).status).toBe(401);
});
it('permits the separate read token only for read APIs, never ingest or browser session', async () => {
  const f = await fixture(), headers = { Authorization: `Bearer ${env.GRUNT_ADMIN_READ_TOKEN}` };
  expect((await f.request('/api/overview', { headers })).status).toBe(200);
  expect((await f.request('/api/session', { headers })).status).toBe(403);
  expect((await f.request('/api/export', { headers })).status).toBe(200);
  expect((await f.request('/ingest', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(batch()) })).status).toBe(401);
});
it('requires an independent machine credential and exact configured instance for ingest', async () => {
  const f = await fixture(), headers = { Authorization: `Bearer ${env.GRUNT_ADMIN_INGEST_KEY}`, 'Content-Type': 'application/json' };
  expect((await f.request('/ingest', { method: 'POST', headers, body: JSON.stringify({ ...batch(), instanceId: 'other' }) })).status).toBe(403);
  const accepted = await f.request('/ingest', { method: 'POST', headers, body: JSON.stringify(batch()) });
  expect(accepted.status).toBe(200); expect(await accepted.json()).toMatchObject({ accepted: true, acceptedEvents: 0 });
  expect((await f.request('/api/overview', { headers: { Authorization: `Bearer ${env.GRUNT_ADMIN_INGEST_KEY}` } })).status).toBe(401);
});
it('rejects conflicting credentials rather than extending machine privileges', async () => {
  const f = await fixture({ GRUNT_ADMIN_READ_TOKEN: env.GRUNT_ADMIN_INGEST_KEY });
  expect((await f.request('/api/overview', { headers: { Authorization: `Bearer ${env.GRUNT_ADMIN_INGEST_KEY}` } })).status).toBe(503);
  expect((await f.request('/ingest', { method: 'POST', headers: { Authorization: `Bearer ${env.GRUNT_ADMIN_INGEST_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(batch()) })).status).toBe(503);
});
it('rejects oversize ingest before database processing and does not reflect bodies', async () => {
  const f = await fixture(), response = await f.request('/ingest', { method: 'POST', headers: { Authorization: `Bearer ${env.GRUNT_ADMIN_INGEST_KEY}`, 'Content-Type': 'application/json' }, body: 'x'.repeat(1024 * 1024 + 1) });
  expect(response.status).toBe(413); expect(await response.text()).not.toContain('xxxx');
});
it('validates filters and unknown configured instance selection', async () => {
  const f = await fixture(), login = await f.login(), headers = { Cookie: login.cookie };
  for (const path of ['/api/requests?limit=1000', '/api/requests?outcome=secret', '/api/requests?source=https://bad.test', '/api/overview?instanceId=other', '/api/requests/not-a-uuid']) expect((await f.request(path, { headers })).status).toBe(400);
  for (const path of ['/api/overview?instanceId=chad', '/api/providers?instanceId=chad', '/api/runs?instanceId=chad', '/api/export?instanceId=chad']) expect((await f.request(path, { headers })).status).toBe(200);
});
it('keeps admin storage failures closed without exposing exceptions', async () => {
  const f = await fixture({}, { ready: false });
  expect((await f.request('/auth/google')).status).toBe(503);
  expect((await f.request('/api/overview')).status).toBe(503);
});
it('serves only packaged public assets and rewrites only the public API meta for a same-origin preview', async () => {
  const f = await fixture();
  const assets = vi.fn(async (name: string) => name === 'index.html'
    ? '<!doctype html><meta name="grunt-admin-api" content="https://api.grunt.run/admin"><script src="admin.js"></script>'
    : name === 'grunt.svg' ? '<svg></svg>' : 'public-asset');
  const preview = adminRoutes(f.store, { now: () => f.clock.at, env: { ...env, GRUNT_ADMIN_UI_ORIGIN: 'https://milo-gateway.fly.dev', GRUNT_ADMIN_PUBLIC_URL: 'https://milo-gateway.fly.dev' }, assets });
  const html = await preview.request('https://milo-gateway.fly.dev/admin/');
  expect(html.status).toBe(200); expect(await html.text()).toContain('content="https://milo-gateway.fly.dev/admin"');
  expect(html.headers.get('Content-Security-Policy')).toContain("script-src 'self'");
  expect(html.headers.get('Content-Security-Policy')).not.toContain('unsafe-inline');
  expect((await preview.request('https://milo-gateway.fly.dev/admin/admin.js')).headers.get('Content-Type')).toContain('text/javascript');
  expect((await preview.request('https://milo-gateway.fly.dev/grunt.svg')).status).toBe(200);
  expect((await preview.request('https://milo-gateway.fly.dev/admin/private.env')).status).toBe(404);
  expect(assets.mock.calls.map(([name]) => name)).toEqual(['index.html', 'admin.js', 'grunt.svg']);
  expect((await preview.request('https://milo-gateway.fly.dev/admin/api/overview')).status).toBe(401);
});
it('canonically redirects the original Admin path without accepting a redirect destination', async () => {
  const f = await fixture();
  for (const path of ['/Admin?next=https://attacker.example.test', '/admin?next=https://attacker.example.test']) {
    const response = await f.app.request(base + path); expect(response.status).toBe(308); expect(response.headers.get('Location')).toBe('/admin/');
  }
});
it('keeps the public login shell available during a private storage outage', async () => {
  const f = await fixture();
  const app = adminRoutes(f.store, { env, ready: false, assets: async () => '<meta name="grunt-admin-api" content="https://api.grunt.run/admin">' });
  expect((await app.request(base + '/admin/')).status).toBe(200);
  expect((await app.request(base + '/admin/api/session')).status).toBe(503);
});
it('requires an explicit instance when a trace ID is present in two installations', async () => {
  const f = await fixture({ GRUNT_ADMIN_INSTANCES: 'chad,laptop' }), id = randomUUID();
  for (const instanceId of ['chad', 'laptop']) await f.store.ingest({ ...batch(), instanceId, events: [{ version: 1, id: randomUUID(), at: now, type: 'request.start', requestId: id, kind: 'user' }] });
  const login = await f.login(), headers = { Cookie: login.cookie };
  expect((await f.request(`/api/requests/${id}`, { headers })).status).toBe(409);
  const scoped = await f.request(`/api/requests/${id}?instanceId=chad`, { headers });
  expect(scoped.status).toBe(200); expect((await scoped.json()).request.instanceId).toBe('chad');
});
it('requires the configured UI Origin for cross-origin cookie reads but permits same-origin preview reads', async () => {
  const f = await fixture(), login = await f.login();
  expect((await f.app.request(base + '/admin/api/overview', { headers: { Cookie: login.cookie } })).status).toBe(403);
  expect((await f.request('/api/overview', { headers: { Cookie: login.cookie, Origin: origin } })).status).toBe(200);
  const preview = adminRoutes(f.store, { now: () => f.clock.at, env: { ...env, GRUNT_ADMIN_UI_ORIGIN: 'https://milo-gateway.fly.dev', GRUNT_ADMIN_PUBLIC_URL: 'https://milo-gateway.fly.dev' } });
  expect((await preview.request('https://milo-gateway.fly.dev/admin/api/overview', { headers: { Cookie: login.cookie } })).status).toBe(200);
  expect((await f.app.request(base + '/admin/api/overview', { headers: { Authorization: `Bearer ${env.GRUNT_ADMIN_READ_TOKEN}` } })).status).toBe(200);
});

it('shares short-lived live activity only with signed-in owners and excludes it from diagnostic exports', async () => {
  const f = await fixture(), login = await f.login();
  const text = 'Added the next quest checkpoint.';
  const activity = {
    version: 1, observedAt: now, phase: 'working', active: [{ source: 'zro', model: 'deepseek-v4.1-flash' }],
    lastReply: null, issues: [{ source: 'kilo', error: 'timeout', state: 'available' }, { source: 'runcrate', error: 'upstream' }],
    events: [
      { at: now, kind: 'progress', text, reasoning: 'private reasoning' },
      { at: now, kind: 'progress', text: 'Authorization Bearer synthetic-value' },
      { at: now, kind: 'tool', tool: 'bash', failed: false, output: 'raw tool content' }
    ]
  };
  const upload = (key: string, instanceId = 'chad') => f.request('/ingest/activity', {
    method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ instanceId, activity })
  });
  expect((await upload(env.GRUNT_ADMIN_READ_TOKEN)).status).toBe(401);
  expect((await upload(env.GRUNT_ADMIN_INGEST_KEY, 'other')).status).toBe(403);
  expect((await upload(env.GRUNT_ADMIN_INGEST_KEY)).status).toBe(200);
  expect((await f.request('/api/activity')).status).toBe(401);
  expect((await f.request('/api/activity', { headers: { Authorization: 'Bearer ' + env.GRUNT_ADMIN_READ_TOKEN } })).status).toBe(403);
  expect((await f.request('/api/activity', { headers: { Cookie: login.cookie, Origin: 'https://example.test' } })).status).toBe(403);
  const owner = { headers: { Cookie: login.cookie } };
  const result = await f.request('/api/activity?instanceId=chad', owner);
  expect(result.headers.get('Cache-Control')).toBe('no-store');
  expect(await result.json()).toEqual({ instances: [{
    instanceId: 'chad', receivedAt: now, activity: { ...activity, events: [
      { at: now, kind: 'progress', text }, { at: now, kind: 'tool', tool: 'bash', failed: false }
    ] }
  }] });
  expect(await (await f.request('/api/export', owner)).text()).not.toContain(text);
  f.clock.at += 121000;
  expect(await (await f.request('/api/activity', owner)).json()).toEqual({ instances: [] });
});

it('protects source usage and requires bounded windows in chronological order', async () => {
  const f = await fixture();
  const window = '?today=' + now + '&week=' + (now - 86400000);
  expect((await f.request('/api/source-usage' + window)).status).toBe(401);
  const { cookie } = await f.login();
  const headers = { Cookie: cookie };
  for (const query of ['', '?today=1&week=2', '?today=' + now + '&week=1', window + '&instanceId=other']) {
    expect((await f.request('/api/source-usage' + query, { headers })).status).toBe(400);
  }
  expect(await (await f.request('/api/source-usage' + window, { headers })).json())
    .toMatchObject({ today: now, week: now - 86400000, lifetimeSince: null, sources: [],
      totals: { today: { replies: 0, tokens: null }, week: { replies: 0, tokens: null }, lifetime: { replies: 0, tokens: null } } });
});

it('projects bounded project context through the private activity feed', async () => {
  const f = await fixture(), { cookie } = await f.login();
  const project = {
    checkpoint: { at: now, summary: 'The courtyard quests are playable.', next: ['Connect the market.', 'Authorization Bearer private'], rawFile: 'unsafe' },
    milestones: [
      { at: now - 1000, number: 2, title: 'Round 2', status: 'review', url: 'https://attacker.example' },
      { at: now - 2000, number: 1, title: 'Project scope', status: 'merged' }
    ]
  };
  const upload = await f.request('/ingest/activity', {
    method: 'POST', headers: { Authorization: 'Bearer ' + env.GRUNT_ADMIN_INGEST_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ instanceId: 'chad', activity: { version: 1, observedAt: now, phase: 'working', active: [], lastReply: null, issues: [], events: [], project } })
  });
  expect(upload.status).toBe(200);
  const feed = await (await f.request('/api/activity', { headers: { Cookie: cookie } })).json();
  expect(feed.instances[0].activity.project).toEqual({
    checkpoint: { at: now, summary: 'The courtyard quests are playable.', next: ['Connect the market.'] },
    milestones: [
      { at: now - 1000, number: 2, title: 'Round 2', status: 'review' },
      { at: now - 2000, number: 1, title: 'Project scope', status: 'merged' }
    ]
  });
  expect(await (await f.request('/api/export', { headers: { Cookie: cookie } })).text()).not.toContain('Connect the market.');
});

it('accepts measured work uptime without exposing it or accepting impossible durations', async () => {
  const f = await fixture(), { cookie } = await f.login();
  const window = { workingMs: 10000, downtimeMs: 5000, providerWaitMs: 5000 };
  const work = { at: now - 1000, state: 'provider_wait', day: window, week: window };
  const send = (value: unknown) => f.request('/ingest/activity', {
    method: 'POST', headers: { Authorization: 'Bearer ' + env.GRUNT_ADMIN_INGEST_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ instanceId: 'chad', activity: { version: 1, observedAt: now, phase: 'working', active: [], lastReply: null, issues: [], events: [], work: value } })
  });
  expect((await send({ ...work, day: { ...window, providerWaitMs: 10000 } })).status).toBe(400);
  expect((await send({ ...work, at: now - 30000 })).status).toBe(400);
  expect((await send(work)).status).toBe(200);
  expect((await f.request('/api/activity')).status).toBe(401);
  const feed = await (await f.request('/api/activity', { headers: { Cookie: cookie } })).json();
  expect(feed.instances[0].activity.work).toEqual(work);
  expect(await (await f.request('/api/export', { headers: { Cookie: cookie } })).text()).not.toContain('providerWaitMs');
});
