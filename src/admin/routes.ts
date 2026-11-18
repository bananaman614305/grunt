import { Hono } from 'hono';
import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getCookie, setCookie } from 'hono/cookie';
import { AdminAuthError, GoogleOAuth, hashToken, randomToken, readAdminAuthConfig, secureEqual } from './auth.js';
import { AdminDataError, isAdminSourceId } from './types.js';
import { AgentActivityFeed } from './activity.js';
import type { AdminStore } from './store.js';

const sessionCookie = '__Secure-grunt_admin_session';
const stateCookie = '__Secure-grunt_admin_oauth';
const stateTtl = 10 * 60 * 1000;
const sessionTtl = 12 * 60 * 60 * 1000;
const opaque = /^[A-Za-z0-9_-]{40,128}$/;
type Principal = { kind: 'owner'; email: string; subject: string; token: string } | { kind: 'service' };
type AdminEnv = { Variables: { principal: Principal } };
type AdminContext = Context<AdminEnv>;
export interface AdminRoutesOptions {
  env?: NodeJS.ProcessEnv;
  auth?: Pick<GoogleOAuth, 'begin' | 'exchange'>;
  now?: () => number;
  ready?: boolean;
  assets?: (name: 'index.html' | 'admin.js' | 'admin.css' | 'grunt.svg' | 'favicon.svg') => Promise<string>;
}

function failure(c: AdminContext, code: string, status: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 503) {
  return c.json({ error: { code } }, status);
}
function clearCookie(c: AdminContext, name: string, path: string) {
  setCookie(c, name, '', { httpOnly: true, secure: true, sameSite: 'Lax', path, maxAge: 0 });
}
const bearer = (value: string | undefined) => value?.match(/^Bearer ([A-Za-z0-9._~-]{32,8192})$/i)?.[1];
const credential = (value: string | undefined): value is string => typeof value === 'string' && value.length >= 32 && value.length <= 8192 && !/[\s\u0000-\u001f\u007f]/.test(value);
const requestId = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

/** Private metadata APIs. They never forward arbitrary requests to a daemon. */
export function adminRoutes(store: AdminStore, options: AdminRoutesOptions = {}) {
  const env = options.env ?? process.env, now = options.now ?? Date.now;
  const config = readAdminAuthConfig(env);
  const oauth = config ? options.auth ?? new GoogleOAuth(config, { now }) : undefined;
  const publicOrigin = (value: string): string | undefined => {
    try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/' ? url.origin : undefined; }
    catch { return undefined; }
  };
  const uiOrigin = publicOrigin(env.GRUNT_ADMIN_UI_ORIGIN ?? 'https://grunt.run') ?? 'https://grunt.run';
  const publicUrl = publicOrigin(env.GRUNT_ADMIN_PUBLIC_URL ?? 'https://api.grunt.run');
  const playtestUrl = (() => {
    const input = env.GRUNT_ADMIN_PLAYTEST_URL;
    if (!input || input.length > 512 || !URL.canParse(input)) return undefined;
    const url = new URL(input);
    if (url.protocol === 'https:' && url.hostname.endsWith('.pages.dev') &&
        !url.username && !url.password && !url.port && !url.search && !url.hash) return url.href;
    return undefined;
  })();
  const readToken = env.GRUNT_ADMIN_READ_TOKEN, ingestKey = env.GRUNT_ADMIN_INGEST_KEY;
  const allowedInstances = new Set((env.GRUNT_ADMIN_INSTANCES ?? '').split(',').map(value => value.trim()).filter(Boolean));
  const instancesConfigured = allowedInstances.size > 0 && allowedInstances.size <= 32 && [...allowedInstances].every(isAdminSourceId);
  const keysConflict = credential(readToken) && credential(ingestKey) && secureEqual(readToken, ingestKey);
  const app = new Hono<AdminEnv>();
  const activity = new AgentActivityFeed(now);
  let loginWindow = now(), loginStarts = 0;

  app.use('/admin/*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    c.header('Vary', 'Origin');
    const origin = c.req.header('Origin');
    if (origin && origin !== uiOrigin) return failure(c, 'origin_denied', 403);
    if (origin === uiOrigin) {
      c.header('Access-Control-Allow-Origin', uiOrigin);
      c.header('Access-Control-Allow-Credentials', 'true');
    }
    if (c.req.method === 'OPTIONS') {
      if (origin !== uiOrigin) return failure(c, 'origin_denied', 403);
      c.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-CSRF-Token');
      c.header('Access-Control-Max-Age', '600');
      return c.body(null, 204);
    }
    const publicAsset = c.req.method === 'GET' && ['/admin', '/admin/', '/admin/admin.js', '/admin/admin.css', '/admin/grunt.svg'].includes(c.req.path);
    if (options.ready === false && !publicAsset) return failure(c, 'admin_storage_unavailable', 503);
    await next();
  });
  app.use('/admin/ingest/activity', bodyLimit({ maxSize: 64 * 1024, onError: c => failure(c, 'payload_too_large', 413) }));
  app.use('/admin/ingest', bodyLimit({ maxSize: 1024 * 1024, onError: c => failure(c, 'payload_too_large', 413) }));

  // Only these packaged public assets are served. No request path ever becomes
  // a filesystem path, and only the public API origin is injected into HTML.
  const asset = async (c: AdminContext, name: 'index.html' | 'admin.js' | 'admin.css' | 'grunt.svg' | 'favicon.svg') => {
    if (!options.assets || !publicUrl) return failure(c, 'admin_assets_unavailable', 503);
    try {
      let body = await options.assets(name);
      if (name === 'index.html') {
        const value = `${publicUrl}/admin`.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
        body = body.replace(/<meta\b(?=[^>]*\bname=["']grunt-admin-api["'])[^>]*>/i, `<meta name="grunt-admin-api" content="${value}">`);
        c.header('Content-Security-Policy', `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self' ${publicUrl}; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`);
      }
      c.header('Content-Type', name.endsWith('.html') ? 'text/html; charset=utf-8' : name.endsWith('.js') ? 'text/javascript; charset=utf-8' : name.endsWith('.css') ? 'text/css; charset=utf-8' : 'image/svg+xml');
      c.header('Cache-Control', 'no-store');
      c.header('X-Content-Type-Options', 'nosniff');
      return c.body(body);
    } catch { return failure(c, 'admin_assets_unavailable', 503); }
  };
  app.get('/admin', c => c.redirect('/admin/', 308));
  app.get('/Admin', c => c.redirect('/admin/', 308));
  app.get('/admin/', c => asset(c, 'index.html'));
  app.get('/admin/admin.js', c => asset(c, 'admin.js'));
  app.get('/admin/admin.css', c => asset(c, 'admin.css'));
  app.get('/admin/grunt.svg', c => asset(c, 'grunt.svg'));
  app.get('/grunt.svg', c => asset(c, 'grunt.svg'));
  app.get('/favicon.svg', c => asset(c, 'favicon.svg'));

  app.get('/admin/auth/google', async c => {
    if (!config || !oauth || keysConflict) return failure(c, 'admin_not_configured', 503);
    if (now() - loginWindow >= 60000) { loginWindow = now(); loginStarts = 0; }
    if (++loginStarts > 60) { c.header('Retry-After', '60'); return failure(c, 'login_rate_limited', 429); }
    const challenge = oauth.begin(), createdAt = now();
    await store.putState(hashToken(`state:${challenge.state}`, config.sessionSecret), {
      nonce: challenge.nonce, verifier: challenge.verifier, createdAt, expiresAt: createdAt + stateTtl
    });
    setCookie(c, stateCookie, challenge.state, { httpOnly: true, secure: true, sameSite: 'Lax', path: '/admin/auth', maxAge: stateTtl / 1000 });
    return c.redirect(challenge.authorizationUrl, 302);
  });
  app.get('/admin/auth/callback', async c => {
    if (!config || !oauth || keysConflict) return failure(c, 'admin_not_configured', 503);
    clearCookie(c, stateCookie, '/admin/auth');
    const params = new URL(c.req.url).searchParams;
    const state = params.get('state') ?? '', cookieState = getCookie(c, stateCookie) ?? '';
    const code = params.get('code') ?? '';
    const denied = (owner = false) => c.redirect(`${config.uiOrigin}/admin/?auth=${owner ? 'owner_denied' : 'signin_failed'}`, 303);
    if (params.getAll('state').length !== 1 || !opaque.test(state) || !opaque.test(cookieState) || !secureEqual(state, cookieState)) return denied();
    const challenge = await store.consumeState(hashToken(`state:${state}`, config.sessionSecret));
    if (!challenge || challenge.expiresAt <= now() || params.has('error') || params.getAll('code').length !== 1 || !code || code.length > 4096) return denied();
    try {
      const owner = await oauth.exchange(code, { nonce: challenge.nonce, verifier: challenge.verifier });
      if (!config.owners.includes(owner.email)) return denied(true);
      const token = randomToken(), createdAt = now();
      await store.putSession(hashToken(`session:${token}`, config.sessionSecret), {
        email: owner.email, subject: owner.subject, createdAt, expiresAt: createdAt + sessionTtl
      });
      setCookie(c, sessionCookie, token, { httpOnly: true, secure: true, sameSite: 'Lax', path: '/admin', maxAge: sessionTtl / 1000 });
      return c.redirect(`${config.uiOrigin}/admin/`, 303);
    } catch (error) { return denied(error instanceof AdminAuthError && error.code === 'owner_required'); }
  });

  app.use('/admin/api/*', async (c, next) => {
    if (!config || keysConflict) return failure(c, 'admin_not_configured', 503);
    const authorization = c.req.header('Authorization');
    if (authorization) {
      const token = bearer(authorization);
      if (!token || !credential(readToken) || !secureEqual(token, readToken) || c.req.method !== 'GET') return failure(c, 'authentication_required', 401);
      c.set('principal', { kind: 'service' });
      await next(); return;
    }
    const token = getCookie(c, sessionCookie) ?? '';
    if (!opaque.test(token)) return failure(c, 'authentication_required', 401);
    // Production UI and API have distinct origins. Requiring its browser
    // Origin also isolates privileged cookie reads from public API-origin UI.
    // Same-origin previews legitimately omit Origin on GET requests.
    if (uiOrigin !== publicUrl && c.req.header('Origin') !== uiOrigin) return failure(c, 'origin_required', 403);
    const session = await store.session(hashToken(`session:${token}`, config.sessionSecret));
    if (!session || session.expiresAt <= now()) return failure(c, 'authentication_required', 401);
    if (!config.owners.includes(session.email)) return failure(c, 'owner_required', 403);
    c.set('principal', { kind: 'owner', email: session.email, subject: session.subject, token });
    await next();
  });
  app.get('/admin/api/session', c => {
    const principal = c.get('principal');
    if (principal.kind !== 'owner' || !config) return failure(c, 'browser_session_required', 403);
    return c.json({ user: { email: principal.email, subject: principal.subject },
      csrfToken: hashToken(`csrf:${principal.token}`, config.sessionSecret), ...(playtestUrl ? { playtestUrl } : {}) });
  });
  const instance = (c: AdminContext): string | undefined => {
    const value = c.req.query('instanceId');
    if (value !== undefined && (!isAdminSourceId(value) || !allowedInstances.has(value))) throw new AdminDataError('invalid_instance');
    return value;
  };
  app.get('/admin/api/overview', async c => c.json(await store.overview(instance(c))));
  app.get('/admin/api/providers', async c => c.json(await store.providers(instance(c))));
  app.get('/admin/api/source-usage', async c => {
    const day = 86400000, timestamp = now();
    const todayParam = c.req.query('today'), weekParam = c.req.query('week');
    if (!todayParam || !weekParam || !/^\d{1,16}$/.test(todayParam) || !/^\d{1,16}$/.test(weekParam)) {
      return failure(c, 'invalid_usage_window', 400);
    }
    const today = Number(todayParam), week = Number(weekParam);
    if (!Number.isSafeInteger(today) || !Number.isSafeInteger(week)
      || week > today || week < timestamp - 8 * day || today < timestamp - 26 * 3600000 || today > timestamp + 300000) {
      return failure(c, 'invalid_usage_window', 400);
    }
    return c.json(await store.sourceUsage(today, week, instance(c)));
  });
  app.get('/admin/api/activity', c => {
    if (c.get('principal').kind !== 'owner') return failure(c, 'browser_session_required', 403);
    return c.json(activity.read(instance(c)));
  });
  app.get('/admin/api/runs', async c => c.json(await store.runs(instance(c))));
  app.get('/admin/api/requests', async c => {
    const limit = c.req.query('limit'), source = c.req.query('source'), outcome = c.req.query('outcome'), before = c.req.query('before');
    if (limit !== undefined && (!/^\d{1,3}$/.test(limit) || Number(limit) < 1 || Number(limit) > 100)) return failure(c, 'invalid_filter', 400);
    if (source !== undefined && !isAdminSourceId(source)) return failure(c, 'invalid_filter', 400);
    if (outcome !== undefined && !['passed', 'failed', 'cancelled', 'pending'].includes(outcome)) return failure(c, 'invalid_filter', 400);
    if (before !== undefined && (!/^[A-Za-z0-9_-]{1,512}$/.test(before))) return failure(c, 'invalid_filter', 400);
    const instanceId = instance(c);
    return c.json(await store.requests({ ...(limit ? { limit: Number(limit) } : {}), ...(source ? { source } : {}), ...(outcome ? { outcome } : {}), ...(before ? { before } : {}), ...(instanceId ? { instanceId } : {}) }));
  });
  app.get('/admin/api/requests/:id', async c => {
    if (!requestId(c.req.param('id'))) return failure(c, 'invalid_request_id', 400);
    const trace = await store.request(c.req.param('id'), instance(c));
    return trace ? c.json(trace) : failure(c, 'request_not_found', 404);
  });
  app.get('/admin/api/export', async c => {
    const data = await store.exportData(instance(c));
    c.header('Content-Disposition', 'attachment; filename="grunt-diagnostics.json"');
    return c.json(data);
  });
  app.post('/admin/auth/logout', async c => {
    if (!config || keysConflict) return failure(c, 'admin_not_configured', 503);
    if (c.req.header('Origin') !== uiOrigin || c.req.header('Content-Type')?.split(';')[0]?.trim() !== 'application/json') return failure(c, 'csrf_required', 403);
    const token = getCookie(c, sessionCookie) ?? '', csrf = c.req.header('X-CSRF-Token') ?? '';
    if (!opaque.test(token) || !secureEqual(csrf, hashToken(`csrf:${token}`, config.sessionSecret))) return failure(c, 'csrf_required', 403);
    const hashed = hashToken(`session:${token}`, config.sessionSecret), session = await store.session(hashed);
    if (!session || !config.owners.includes(session.email)) return failure(c, 'authentication_required', 401);
    await store.deleteSession(hashed);
    clearCookie(c, sessionCookie, '/admin');
    return c.json({ signedOut: true });
  });
  app.use('/admin/ingest/*', async (c, next) => {
    if (!credential(ingestKey) || !instancesConfigured || keysConflict) return failure(c, 'admin_ingest_not_configured', 503);
    const token = bearer(c.req.header('Authorization'));
    if (!token || !secureEqual(token, ingestKey)) return failure(c, 'authentication_required', 401);
    await next();
  });
  app.post('/admin/ingest/activity', async c => {
    if (c.req.header('Content-Type')?.split(';')[0]?.trim() !== 'application/json') return failure(c, 'json_required', 400);
    let value: Record<string, unknown> | null;
    try { value = await c.req.json(); } catch { return failure(c, 'invalid_payload', 400); }
    const selected = value?.instanceId;
    if (typeof selected !== 'string' || !allowedInstances.has(selected)) return failure(c, 'instance_denied', 403);
    activity.update(selected, value?.activity);
    return c.json({ accepted: true });
  });
  app.post('/admin/ingest', async c => {
    if (c.req.header('Content-Type')?.split(';')[0]?.trim() !== 'application/json') return failure(c, 'json_required', 400);
    let value: unknown;
    try { value = await c.req.json(); } catch { return failure(c, 'invalid_payload', 400); }
    const selected = value && typeof value === 'object' && 'instanceId' in value ? value.instanceId : undefined;
    if (typeof selected !== 'string' || !allowedInstances.has(selected)) return failure(c, 'instance_denied', 403);
    return c.json(await store.ingest(value));
  });
  app.onError((error, c) => {
    if (error instanceof AdminDataError && error.code === 'ambiguous_admin_request') return failure(c, 'instance_selection_required', 409);
    if (error instanceof AdminDataError && error.code !== 'admin_storage_unavailable') return failure(c, 'invalid_payload', 400);
    return failure(c, 'admin_unavailable', 503);
  });
  return app;
}
