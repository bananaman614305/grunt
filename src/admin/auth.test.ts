import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { AdminAuthError, canonicalOwnerEmail, GoogleOAuth, hashToken, randomToken, readAdminAuthConfig, secureEqual } from './auth.js';
import type { AdminAuthConfig } from './auth.js';

const now = Date.parse('2026-11-17T12:00:00Z'), seconds = Math.floor(now / 1000);
const config: AdminAuthConfig = { clientId: 'synthetic-admin.apps.googleusercontent.com', clientSecret: 'synthetic-google-secret',
  sessionSecret: 'synthetic-session-secret-with-at-least-32-bytes', publicUrl: 'https://api.example.test', uiOrigin: 'https://example.test', owners: ['owner@example.test'] };
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const otherPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...pair.publicKey.export({ format: 'jwk' }), kid: 'test-key', use: 'sig', alg: 'RS256' };
const flow = { nonce: 'n'.repeat(43), verifier: 'v'.repeat(43) };
const claims = { iss: 'https://accounts.google.com', aud: config.clientId, sub: 'google-owner-123', email: 'owner@example.test', email_verified: true,
  nonce: flow.nonce, iat: seconds, exp: seconds + 3600 };
function jwt(patch: Record<string, unknown> = {}, headerPatch: Record<string, unknown> = {}, wrongSignature = false) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-key', typ: 'JWT', ...headerPatch })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ ...claims, ...patch })).toString('base64url');
  const signature = sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), wrongSignature ? otherPair.privateKey : pair.privateKey).toString('base64url');
  return `${header}.${payload}.${signature}`;
}
function fixture(token = jwt(), keys: unknown[] = [jwk]) {
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    expect(init?.redirect).toBe('error');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    if (url === 'https://oauth2.googleapis.com/token') return Response.json({ id_token: token, access_token: 'synthetic-unused-access-token' });
    if (url === 'https://www.googleapis.com/oauth2/v3/certs') return Response.json({ keys });
    throw new Error('Unexpected external endpoint');
  });
  return { fetcher, oauth: new GoogleOAuth(config, { fetcher, now: () => now }) };
}
const env = () => ({ GRUNT_ADMIN_GOOGLE_CLIENT_ID: config.clientId, GRUNT_ADMIN_GOOGLE_CLIENT_SECRET: config.clientSecret,
  GRUNT_ADMIN_SESSION_SECRET: config.sessionSecret, GRUNT_ADMIN_OWNERS: 'Owner@Example.Test' });

it('fails closed without explicit full owners and every auth secret', () => {
  expect(readAdminAuthConfig({})).toBeUndefined();
  for (const key of Object.keys(env())) {
    const value: Record<string, string> = env(); delete value[key];
    expect(readAdminAuthConfig(value)).toBeUndefined();
  }
  expect(readAdminAuthConfig({ ...env(), GRUNT_ADMIN_OWNERS: 'banana.man614305,lunchboxfortwo' })).toBeUndefined();
  expect(readAdminAuthConfig({ ...env(), GRUNT_ADMIN_SESSION_SECRET: 'short' })).toBeUndefined();
});
it('canonicalizes exact email case without treating aliases or Gmail dots as the same owner', () => {
  const value = readAdminAuthConfig(env());
  expect(value?.owners).toEqual(['owner@example.test']);
  expect(value?.publicUrl).toBe('https://api.grunt.run');
  expect(canonicalOwnerEmail('Name.Last+admin@gmail.com')).toBe('name.last+admin@gmail.com');
  expect(canonicalOwnerEmail('name..last@gmail.com')).toBeUndefined();
  expect(canonicalOwnerEmail('owner@localhost')).toBeUndefined();
  expect(canonicalOwnerEmail('owner@example.test\n')).toBeUndefined();
});
it.each(['http://api.example.test', 'https://api.example.test/path', 'https://user:password@api.example.test', 'https://api.example.test/?key=value', 'javascript:alert(1)'])('rejects unsafe configured origins: %s', url => {
  expect(readAdminAuthConfig({ ...env(), GRUNT_ADMIN_PUBLIC_URL: url })).toBeUndefined();
  expect(readAdminAuthConfig({ ...env(), GRUNT_ADMIN_UI_ORIGIN: url })).toBeUndefined();
});
it('creates independent random state, nonce and PKCE verifier with a fixed Google callback', () => {
  const oauth = fixture().oauth, begin = oauth.begin(), again = oauth.begin();
  for (const key of ['state', 'nonce', 'verifier'] as const) {
    expect(begin[key]).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(begin[key]).not.toBe(again[key]);
  }
  expect(new Set([begin.state, begin.nonce, begin.verifier]).size).toBe(3);
  const url = new URL(begin.authorizationUrl);
  expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
  expect(url.searchParams.get('redirect_uri')).toBe('https://api.example.test/admin/auth/callback');
  expect(url.searchParams.get('scope')).toBe('openid email');
  expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  expect(url.searchParams.get('code_challenge')).toBe(createHash('sha256').update(begin.verifier).digest('base64url'));
  expect(url.searchParams.has('client_secret')).toBe(false);
});
it('validates a signed owner identity and exchanges the bound verifier only at Google', async () => {
  const { oauth, fetcher } = fixture();
  await expect(oauth.exchange('synthetic-code', flow)).resolves.toEqual({ email: 'owner@example.test', subject: 'google-owner-123' });
  const request = fetcher.mock.calls[0]![1]!;
  expect(request.method).toBe('POST');
  const body = new URLSearchParams(String(request.body));
  expect(body.get('code_verifier')).toBe(flow.verifier);
  expect(body.get('client_secret')).toBe(config.clientSecret);
  expect(body.get('redirect_uri')).toBe('https://api.example.test/admin/auth/callback');
});
it.each([
  ['issuer', { iss: 'https://attacker.example.test' }],
  ['nonstring issuer', { iss: ['https://accounts.google.com'] }],
  ['audience', { aud: 'another-client' }],
  ['multiple audiences', { aud: [config.clientId] }],
  ['authorized party', { azp: 'another-client' }],
  ['expired', { exp: seconds }],
  ['future issuance', { iat: seconds + 61 }],
  ['old issuance', { iat: seconds - 86401 }],
  ['future not-before', { nbf: seconds + 61 }],
  ['nonce', { nonce: 'm'.repeat(43) }],
  ['unverified email', { email_verified: false }],
  ['string email verification', { email_verified: 'true' }],
  ['missing subject', { sub: '' }]
])('rejects invalid signed claims: %s', async (_name, patch) => {
  await expect(fixture(jwt(patch)).oauth.exchange('synthetic-code', flow)).rejects.toMatchObject({ code: 'invalid_response' });
});
it('rejects a valid Google identity outside the exact configured owner list', async () => {
  for (const email of ['other@example.test', 'owner+alias@example.test', 'ow.ner@example.test']) {
    await expect(fixture(jwt({ email })).oauth.exchange('synthetic-code', flow)).rejects.toMatchObject({ code: 'owner_required' });
  }
  await expect(fixture(jwt({ email: 'Owner@Example.Test' })).oauth.exchange('synthetic-code', flow)).resolves.toMatchObject({ email: 'owner@example.test' });
});
it('rejects wrong signatures and JWT-provided algorithms or alternate key hosts', async () => {
  await expect(fixture(jwt({}, {}, true)).oauth.exchange('synthetic-code', flow)).rejects.toMatchObject({ code: 'invalid_response' });
  for (const header of [{ alg: 'none' }, { alg: 'HS256' }, { jku: 'https://attacker.example.test/keys' }, { crit: ['untrusted'] }]) {
    const { oauth, fetcher } = fixture(jwt({}, header));
    await expect(oauth.exchange('synthetic-code', flow)).rejects.toMatchObject({ code: 'invalid_response' });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual(['https://oauth2.googleapis.com/token']);
  }
});
it('rejects unknown, duplicate and unsafe Google keys', async () => {
  for (const keys of [[{ ...jwk, kid: 'another-key' }], [jwk, jwk], [{ ...jwk, use: 'enc' }], [{ ...jwk, alg: 'HS256' }], [{ ...jwk, kty: 'oct' }]]) {
    await expect(fixture(jwt(), keys).oauth.exchange('synthetic-code', flow)).rejects.toMatchObject({ code: 'invalid_response' });
  }
});
it('caches keys, then refreshes once to permit normal Google key rotation', async () => {
  const nextJwk = { ...jwk, kid: 'next-key' }, { oauth, fetcher } = fixture();
  await oauth.exchange('synthetic-code', flow);
  await oauth.exchange('synthetic-code', flow);
  expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/certs'))).toHaveLength(1);
  fetcher.mockImplementation(async input => String(input).endsWith('/token')
    ? Response.json({ id_token: jwt({}, { kid: 'next-key' }) }) : Response.json({ keys: [nextJwk] }));
  await expect(oauth.exchange('synthetic-code', flow)).resolves.toMatchObject({ email: 'owner@example.test' });
  expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/certs'))).toHaveLength(2);
});
it('reports only fixed safe errors for provider failures, malformed and oversized responses', async () => {
  const responses = [new Response('synthetic-sensitive-provider-payload', { status: 500 }), new Response('not json'), Response.json({ id_token: 'malformed' }), new Response('x'.repeat(1024 * 1024 + 1))];
  for (const response of responses) {
    const fetcher = vi.fn<typeof fetch>(async () => response), oauth = new GoogleOAuth(config, { fetcher, now: () => now });
    await expect(oauth.exchange('synthetic-code', flow)).rejects.toBeInstanceOf(AdminAuthError);
    await oauth.exchange('synthetic-code', flow).catch(error => expect(String(error)).not.toContain('synthetic-sensitive-provider-payload'));
  }
});
it('rejects malformed flow values before sending a credential-injected request', async () => {
  const { oauth, fetcher } = fixture();
  await expect(oauth.exchange('code\n', flow)).rejects.toMatchObject({ code: 'invalid_request' });
  await expect(oauth.exchange('code', { ...flow, verifier: 'short' })).rejects.toMatchObject({ code: 'invalid_request' });
  await expect(oauth.exchange('code', { ...flow, nonce: 'short' })).rejects.toMatchObject({ code: 'invalid_request' });
  expect(fetcher).not.toHaveBeenCalled();
});
it('hashes opaque tokens with the session secret and compares values without normalization', () => {
  const token = randomToken(); expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(hashToken(token, config.sessionSecret)).toMatch(/^[a-f0-9]{64}$/);
  expect(hashToken(token, config.sessionSecret)).not.toBe(hashToken(token, 'other-synthetic-secret'));
  expect(secureEqual(token, token)).toBe(true); expect(secureEqual(token, token + 'x')).toBe(false);
  expect(secureEqual('A', 'a')).toBe(false);
});
