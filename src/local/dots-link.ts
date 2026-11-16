import { gruntEnv, configRoot } from '../brand.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { SourceError } from './source.js';

export function dotsConfigDir(env = process.env) { return configRoot(env); }
export function dotsGateway(env = process.env) {
  const url = new URL(gruntEnv('DOTS_URL', env) ?? 'https://api.grunt.run');
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) throw new SourceError('upstream', 'GRUNT_DOTS_URL must be an HTTPS origin or a loopback test origin');
  return url.origin;
}
export async function readDotsLink(env = process.env): Promise<{ deviceSecret: string; gateway: string } | undefined> {
  try {
    const value = JSON.parse(await readFile(join(dotsConfigDir(env), 'dots.json'), 'utf8'));
    if (typeof value.deviceSecret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.deviceSecret) || typeof value.gateway !== 'string') return;
    const gateway = dotsGateway({ ...env, GRUNT_DOTS_URL: gruntEnv('DOTS_URL', env) ?? value.gateway });
    if (gateway !== value.gateway) return;
    return { deviceSecret: value.deviceSecret, gateway };
  } catch { return; }
}
// Pairing operations share one device secret even when two browser windows approve concurrently.
const pairing = new Map<string, Promise<unknown>>();
export async function redeemDots(input: { ticket?: string; code?: string }, env = process.env, fetcher: typeof fetch = fetch, expectedReturn?: string) {
  if ((input.ticket && !/^[A-Za-z0-9_-]{43}$/.test(input.ticket)) || (input.code && !/^[A-Z0-9_-]{16}$/.test(input.code)) || (!input.ticket && !input.code)) throw new SourceError('upstream', 'Invalid grunt pairing');
  const config = dotsConfigDir(env), gateway = dotsGateway(env);
  const prior = pairing.get(config) ?? Promise.resolve();
  const result = prior.catch(() => {}).then(async () => {
    const existing = await readDotsLink(env);
    const deviceSecret = existing?.deviceSecret ?? randomBytes(32).toString('base64url');
    let value;
    try {
      const response = await fetcher(gateway + '/dots/redeem', { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...input, deviceSecret }), signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error();
      value = await response.json() as { paired?: boolean; return?: string };
      if (!value.paired || !validPairReturn(value.return, gateway) || (expectedReturn !== undefined && value.return !== expectedReturn)) throw new Error();
    } catch { throw new SourceError('upstream', 'grunt pairing was refused or expired. Return to the Allow page and try again.'); }
    // A refused ticket never creates or replaces local configuration.
    await mkdir(config, { recursive: true, mode: 0o700 });
    const temporary = join(config, `.dots-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify({ gateway, deviceSecret }) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temporary, join(config, 'dots.json'));
    return value.return!;
  });
  pairing.set(config, result);
  try { return await result; } finally { if (pairing.get(config) === result) pairing.delete(config); }
}
export function validPairReturn(value: unknown, gateway: string): value is string {
  if (typeof value !== 'string') return false;
  try { const url = new URL(value); return url.origin === gateway && !url.username && !url.password && !url.hash && url.pathname === '/oauth/complete' && Array.from(url.searchParams.keys()).length === 1 && /^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get('flow') ?? ''); }
  catch { return false; }
}
export async function dotsLink(code: string | undefined, env = process.env, fetcher: typeof fetch = fetch, print: (text: string) => void = console.log) {
  if (!code) throw new SourceError('upstream', 'Use usegrunt dots link <code> only with the fallback code from the Allow page');
  const target = await redeemDots({ code: code.toUpperCase() }, env, fetcher);
  print('grunt is paired. Return to the Allow page and choose Continue to ChatGPT.');
  return target;
}
export async function pairDots(request: Request, env = process.env, fetcher: typeof fetch = fetch) {
  const reject = () => new Response('grunt refused this pairing. Return to the Allow page and try again.', { status: 403, headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
  if (!gruntEnv('SOURCES', env)?.split(',').some(id => id.trim() === 'dots')) return reject();
  const gateway = dotsGateway(env), url = new URL(request.url);
  let referrer: URL;
  try { referrer = new URL(request.headers.get('referer') ?? ''); } catch { return reject(); }
  // A hostile site cannot send our gateway's browser-controlled Referer or navigation headers.
  if (referrer.origin !== gateway || (request.headers.has('origin') && request.headers.get('origin') !== gateway) || (request.headers.has('sec-fetch-mode') && request.headers.get('sec-fetch-mode') !== 'navigate') || (request.headers.has('sec-fetch-dest') && request.headers.get('sec-fetch-dest') !== 'document')) return reject();
  const ticket = url.searchParams.get('ticket'), target = url.searchParams.get('return');
  if (!ticket || !validPairReturn(target, gateway)) return reject();
  try {
    const confirmed = await redeemDots({ ticket }, env, fetcher, target);
    if (confirmed !== target) return reject();
    return new Response(null, { status: 303, headers: { Location: confirmed, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
  } catch { return reject(); }
}
