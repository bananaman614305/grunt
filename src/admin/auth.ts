import { createHash, createHmac, createPublicKey, randomBytes, timingSafeEqual, verify } from 'node:crypto';
import type { JsonWebKey } from 'node:crypto';

export interface AdminAuthConfig {
  clientId: string;
  clientSecret: string;
  sessionSecret: string;
  publicUrl: string;
  uiOrigin: string;
  owners: string[];
}

export class AdminAuthError extends Error {
  constructor(readonly code: 'invalid_request' | 'invalid_response' | 'owner_required' | 'provider_unavailable') {
    super(`Admin authentication failed: ${code}`);
  }
}

const tokenEndpoint = 'https://oauth2.googleapis.com/token';
const keysEndpoint = 'https://www.googleapis.com/oauth2/v3/certs';
const maxJsonBytes = 1024 * 1024;
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
function invalid(): never { throw new AdminAuthError('invalid_response'); }

export function canonicalOwnerEmail(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 254 || value !== value.trim()) return undefined;
  const email = value.toLowerCase();
  const parts = email.split('@');
  if (parts.length !== 2 || !parts[0] || parts[0].length > 64 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(parts[0])
    || parts[0].startsWith('.') || parts[0].endsWith('.') || parts[0].includes('..')) return undefined;
  const labels = parts[1]!.split('.');
  if (labels.length < 2 || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return undefined;
  return email;
}

function httpsOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') return undefined;
    return url.origin;
  } catch { return undefined; }
}

/** No owners are inferred from names, Google login hints or the public UI. */
export function readAdminAuthConfig(env: NodeJS.ProcessEnv = process.env): AdminAuthConfig | undefined {
  const clientId = env.GRUNT_ADMIN_GOOGLE_CLIENT_ID;
  const clientSecret = env.GRUNT_ADMIN_GOOGLE_CLIENT_SECRET;
  const sessionSecret = env.GRUNT_ADMIN_SESSION_SECRET;
  const ownerText = env.GRUNT_ADMIN_OWNERS;
  const publicUrl = httpsOrigin(env.GRUNT_ADMIN_PUBLIC_URL ?? 'https://api.grunt.run');
  const uiOrigin = httpsOrigin(env.GRUNT_ADMIN_UI_ORIGIN ?? 'https://grunt.run');
  if (!clientId || !/^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/.test(clientId)
    || !clientSecret || clientSecret.length > 4096 || /[\u0000-\u0020\u007f]/.test(clientSecret)
    || !sessionSecret || Buffer.byteLength(sessionSecret) < 32 || sessionSecret.length > 4096 || /[\u0000-\u001f\u007f]/.test(sessionSecret)
    || !ownerText || !publicUrl || !uiOrigin) return undefined;
  const owners = ownerText.split(',').map(value => canonicalOwnerEmail(value.trim()));
  if (!owners.length || owners.length > 16 || owners.some(owner => !owner)) return undefined;
  return { clientId, clientSecret, sessionSecret, publicUrl, uiOrigin, owners: [...new Set(owners as string[])] };
}

export function randomToken(): string { return randomBytes(32).toString('base64url'); }
export function hashToken(token: string, secret: string): string { return createHmac('sha256', secret).update(token).digest('hex'); }
export function secureEqual(left: string, right: string): boolean {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function boundedJson(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw new AdminAuthError('provider_unavailable');
  }
  if (Number(response.headers.get('content-length')) > maxJsonBytes) {
    await response.body.cancel().catch(() => {});
    invalid();
  }
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maxJsonBytes) invalid();
      chunks.push(part.value);
    }
    return object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } catch (error) {
    if (error instanceof AdminAuthError) throw error;
    throw new AdminAuthError('invalid_response');
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

function part(value: string): Record<string, unknown> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) invalid();
  try { return object(JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))); }
  catch { return invalid(); }
}

/** Google endpoints are fixed. JWT-supplied key URLs are never fetched. */
export class GoogleOAuth {
  private cachedKeys: { keys: Record<string, unknown>[]; expiresAt: number } | undefined;
  private fetcher: typeof fetch;
  private now: () => number;
  constructor(readonly config: AdminAuthConfig, options: { fetcher?: typeof fetch; now?: () => number } = {}) {
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? Date.now;
  }
  begin(): { authorizationUrl: string; state: string; nonce: string; verifier: string } {
    const state = randomToken(), nonce = randomToken(), verifier = randomToken();
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({ client_id: this.config.clientId, response_type: 'code', scope: 'openid email',
      redirect_uri: `${this.config.publicUrl}/admin/auth/callback`, state, nonce,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', prompt: 'select_account' }).toString();
    return { authorizationUrl: url.href, state, nonce, verifier };
  }
  private async request(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
    try {
      return await boundedJson(await this.fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(10000) }));
    } catch (error) {
      if (error instanceof AdminAuthError) throw error;
      throw new AdminAuthError('provider_unavailable');
    }
  }
  private async keys(refresh = false): Promise<Record<string, unknown>[]> {
    if (!refresh && this.cachedKeys && this.cachedKeys.expiresAt > this.now()) return this.cachedKeys.keys;
    const data = await this.request(keysEndpoint);
    if (!Array.isArray(data.keys) || !data.keys.length || data.keys.length > 20) invalid();
    const keys = data.keys.map(object);
    this.cachedKeys = { keys, expiresAt: this.now() + 300000 };
    return keys;
  }
  private async identity(token: string, nonce: string): Promise<{ email: string; subject: string }> {
    if (token.length > 16384) invalid();
    const pieces = token.split('.');
    if (pieces.length !== 3 || pieces.some(piece => !piece)) invalid();
    const [headerPart, claimsPart, signaturePart] = pieces as [string, string, string];
    const header = part(headerPart), claims = part(claimsPart);
    if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(header.kid)
      || 'crit' in header || 'jku' in header || 'jwk' in header || 'x5u' in header || !/^[A-Za-z0-9_-]+$/.test(signaturePart)) invalid();
    let matching = (await this.keys()).filter(key => key.kid === header.kid);
    // Google may rotate keys during a cached interval. Refresh once, never use
    // an unrecognized algorithm, embedded public key, or alternate key host.
    if (!matching.length) matching = (await this.keys(true)).filter(key => key.kid === header.kid);
    if (matching.length !== 1) invalid();
    const key = matching[0]!;
    if (key.kty !== 'RSA' || key.use !== 'sig' || (key.alg !== undefined && key.alg !== 'RS256')
      || typeof key.n !== 'string' || key.n.length > 2048 || typeof key.e !== 'string' || key.e.length > 16) invalid();
    try {
      const publicKey = createPublicKey({ key: key as JsonWebKey, format: 'jwk' });
      if ((publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
        || !verify('RSA-SHA256', Buffer.from(`${headerPart}.${claimsPart}`), publicKey, Buffer.from(signaturePart, 'base64url'))) invalid();
    } catch { invalid(); }
    const now = Math.floor(this.now() / 1000);
    if (typeof claims.iss !== 'string' || !['accounts.google.com', 'https://accounts.google.com'].includes(claims.iss) || claims.aud !== this.config.clientId
      || (claims.azp !== undefined && claims.azp !== this.config.clientId)
      || typeof claims.exp !== 'number' || !Number.isSafeInteger(claims.exp) || claims.exp <= now || claims.exp > now + 86400
      || typeof claims.iat !== 'number' || !Number.isSafeInteger(claims.iat) || claims.iat > now + 60 || claims.iat < now - 86400 || claims.iat >= claims.exp
      || (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || !Number.isSafeInteger(claims.nbf) || claims.nbf > now + 60))
      || typeof claims.nonce !== 'string' || !secureEqual(claims.nonce, nonce)
      || claims.email_verified !== true || typeof claims.sub !== 'string' || !/^[A-Za-z0-9_-]{1,255}$/.test(claims.sub)) invalid();
    const email = canonicalOwnerEmail(claims.email);
    if (!email || !this.config.owners.includes(email)) throw new AdminAuthError('owner_required');
    return { email, subject: claims.sub };
  }
  async exchange(code: string, flow: { nonce: string; verifier: string }): Promise<{ email: string; subject: string }> {
    if (typeof code !== 'string' || !code || code.length > 4096 || /[\u0000-\u0020\u007f]/.test(code)
      || !/^[A-Za-z0-9_-]{43,128}$/.test(flow.verifier) || !/^[A-Za-z0-9_-]{43,128}$/.test(flow.nonce)) throw new AdminAuthError('invalid_request');
    const response = await this.request(tokenEndpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.config.clientId, client_secret: this.config.clientSecret, code,
        redirect_uri: `${this.config.publicUrl}/admin/auth/callback`, grant_type: 'authorization_code', code_verifier: flow.verifier }).toString() });
    if (typeof response.id_token !== 'string') invalid();
    return this.identity(response.id_token, flow.nonce);
  }
}
