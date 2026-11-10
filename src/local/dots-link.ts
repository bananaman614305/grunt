import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SourceError } from './source.js';

export function dotsConfigDir(env = process.env) { return env.MILO_CONFIG_DIR || join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'milo'); }
export function dotsGateway(env = process.env) {
  const url = new URL(env.MILO_DOTS_URL ?? 'https://usemilo.dev');
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) throw new SourceError('upstream', 'MILO_DOTS_URL must be an HTTPS origin or a loopback test origin');
  return url.origin;
}
export async function readDotsLink(env = process.env): Promise<{ deviceSecret: string; gateway: string } | undefined> {
  try {
    const value = JSON.parse(await readFile(join(dotsConfigDir(env), 'dots.json'), 'utf8'));
    if (typeof value.deviceSecret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.deviceSecret) || typeof value.gateway !== 'string') return;
    const gateway = dotsGateway({ ...env, MILO_DOTS_URL: env.MILO_DOTS_URL ?? value.gateway });
    // Never forward a stored device secret to a different gateway override.
    if (gateway !== value.gateway) return;
    return { deviceSecret: value.deviceSecret, gateway };
  } catch { return; }
}
export async function dotsLink(env = process.env, fetcher: typeof fetch = fetch, print: (text: string) => void = console.log) {
  const gateway = dotsGateway(env), deviceSecret = randomBytes(32).toString('base64url');
  let body;
  try {
    const response = await fetcher(gateway + '/dots/link', { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceSecret }), signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error();
    body = await response.json() as { code: string; connector: string };
    if (typeof body.code !== 'string' || !/^[A-F0-9]{4}(?:-[A-F0-9]{4}){2}$/.test(body.code)) throw new Error();
  } catch { throw new SourceError('upstream', 'Milo could not create a dots pairing. Try milo dots link again.'); }
  const config = dotsConfigDir(env);
  await mkdir(config, { recursive: true, mode: 0o700 });
  const temporary = join(config, `.dots-${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify({ gateway, deviceSecret }) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(temporary, join(config, 'dots.json'));
  print(`Pairing code: ${body.code}\nConnector: ${gateway}/mcp\nCode expires in ten minutes. Add the connector to your dot, enter this code, and choose Allow.\nThen tell your dot: When Milo sends a request, answer it and send the answer back with milo_submit_reply.\nEnable the source with MILO_SOURCES=dots,freellmapi,opencode,kilo.`);
  return { code: body.code, connector: gateway + '/mcp' };
}
