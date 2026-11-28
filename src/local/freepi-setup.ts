import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { readDataSharingConsent } from './data-sharing.js';
import { FreePi, FREEPI_BASE, FREEPI_CLIENT_VERSION, FREEPI_CONSENT_VERSION, readFreePiJson } from './freepi.js';

// The provider's pinned official device OAuth protocol (free-pi-cli 0.6.25).
// No guest credentials, browser cookie extraction, third-party proxy or paid plan.
export async function setupFreePi({ directory, squire, signal: caller, background, notify, fetcher = fetch }: {
  directory: string; squire: { signup(service: string, url: string, instructions: string, facts?: Record<string, string>): Promise<void> };
  signal?: AbortSignal; background: boolean; notify(line: string): void; fetcher?: typeof fetch;
}) {
  if (!(await readDataSharingConsent(directory, ['freepi'])).includes('freepi')) throw new Error('Free-Pi requires its explicit material trace-sale approval');
  caller?.throwIfAborted();
  if (await new FreePi({ directory, fetcher }).available()) { notify('Free-Pi: verified free account reused'); return; }
  if (background) throw new Error('Free-Pi needs foreground GitHub device authorization');
  const signal = AbortSignal.any([AbortSignal.timeout(900000), ...(caller ? [caller] : [])]);
  const post = async (path: string, body: unknown) => {
    const response = await fetcher(`${FREEPI_BASE}${path}`, { method: 'POST', redirect: 'error', signal,
      headers: { 'Content-Type': 'application/json', 'x-client-version': FREEPI_CLIENT_VERSION, 'User-Agent': 'grunt' }, body: JSON.stringify(body) });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Free-Pi device sign-in returned HTTP ${response.status}`); }
    return readFreePiJson(response, signal, 65536);
  };
  const device = await post('/auth/github/device', {});
  if (typeof device.session_id !== 'string' || !/^[0-9a-f-]{36}$/i.test(device.session_id)
    || typeof device.user_code !== 'string' || !/^[A-Z0-9-]{4,20}$/.test(device.user_code)
    || device.verification_uri !== 'https://github.com/login/device' || typeof device.expires_in !== 'number' || device.expires_in <= 0 || device.expires_in > 900
    || typeof device.interval !== 'number' || device.interval < 1 || device.interval > 60) throw new Error('Free-Pi device response contract changed');
  // The saved provider-specific approval is required before accepting consent v4.
  await post('/auth/consent', { session_id: device.session_id, consent_version: FREEPI_CONSENT_VERSION, readFreePiJson });
  const deadline = Date.now() + device.expires_in * 1000;
  await squire.signup('freepi', device.verification_uri,
    `Complete the official Free-Pi GitHub device sign-in for this user's existing GitHub identity. Enter the current device code ${device.user_code}. Confirm the visible app is Free-Pi and asks only for read-only email scope. Use normal Squire OAuth controls and any required human approval. Do not create duplicate accounts, add cards, buy/earn credits, enable subscriptions, referrals or rewards, or change account settings. Free-Pi trace-sale terms have been separately approved by this user. Stop if different permissions or payment are requested. Do not expose a token or device authorization URL outside this private sign-in flow.`, { user_code: device.user_code, device_code: device.user_code });
  let token: string | undefined, interval = device.interval;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const result = await post('/auth/token', { session_id: device.session_id });
    if (typeof result.token === 'string' && result.token) { token = result.token; break; }
    if (result.status !== 'pending') throw new Error('Free-Pi device sign-in was not approved');
    if (result.retry_after !== undefined) {
      if (typeof result.retry_after !== 'number' || result.retry_after <= 0 || result.retry_after > 120) throw new Error('Invalid Free-Pi poll delay');
      interval = Math.max(interval, result.retry_after);
    }
    await sleep(interval * 1000, undefined, { signal });
  }
  if (!token) throw new Error('Free-Pi device code expired; retry foreground setup');
  if (!await new FreePi({ directory, fetcher, loadToken: async () => token! }).available()) throw new Error('Free-Pi exact free model and zero-wallet account could not be verified');
  signal.throwIfAborted();
  const root = join(directory, 'freepi');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const temporary = join(root, `credentials.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify({ token, issuer: FREEPI_BASE }), { mode: 0o600, flag: 'wx' });
    await rename(temporary, join(root, 'credentials.json'));
  } finally { await rm(temporary, { force: true }); }
  notify('Free-Pi: account connected; Grunt will verify a public-only live reply.');
}
