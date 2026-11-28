import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { readDataSharingConsent } from './data-sharing.js';
import { MillionSeek, MILLIONSEEK_HOST, MILLIONSEEK_SERVICE } from './millionseek.js';
import { firstWorkingGrant, resolveSquireGrant, writePrivateProviderGrant } from './provider-grant.js';
import type { BrowserSquire, SetupSquire } from './setup.js';
import { signupIdentityEmail } from './signup-mcp.js';

export const MILLIONSEEK_STORE = { service: MILLIONSEEK_SERVICE, label: 'Grunt Free', api_hosts: [MILLIONSEEK_HOST], auth_shape: 'bearer' };
type Squire = SetupSquire & Partial<Pick<BrowserSquire, 'signup' | 'call'>>;
interface Credential { service?: string; label?: string; reference?: string; allowed_hosts?: string[]; field_names?: string[]; auth_strategy?: string }
export async function setupMillionSeek({ directory, squire, notify, connect, signal, background }: {
  directory: string; squire: Squire; notify(line: string): void; connect?: () => Promise<void>; signal?: AbortSignal; background: boolean;
}) {
  if (!(await readDataSharingConsent(directory, ['millionseek'])).includes('millionseek')) throw new Error('100milionseek requires current data-sharing approval');
  signal?.throwIfAborted();
  if (await new MillionSeek({ directory }).available()) { notify('100milionseek: recurring free route reused'); return; }
  await connect?.();
  const select = async () => {
    if (!squire.call) throw new Error('100milionseek requires scoped vault lookup');
    const result = await squire.call('list_credentials', { service: MILLIONSEEK_SERVICE, fields: 'summary' });
    if (!Array.isArray(result.credentials)) throw new Error('100milionseek vault lookup incomplete');
    return (result.credentials as Credential[]).filter(item => item?.service === MILLIONSEEK_SERVICE && item.reference?.startsWith('vault://')
      && item.allowed_hosts?.includes(MILLIONSEEK_HOST) && item.allowed_hosts.every(host => [MILLIONSEEK_HOST, `*.${MILLIONSEEK_HOST}`].includes(host))
      && (item.auth_strategy === undefined || item.auth_strategy === 'api_key') && item.field_names?.length === 1 && /^(value|api_?key|token|key)$/i.test(item.field_names[0]!));
  };
  let matches = await select();
  if (!matches.length) {
    if (!squire.signup) throw new Error('100milionseek requires browser-capable Trusty Squire');
    signal?.throwIfAborted();
    // Squire knows the profile's email only after a Google step; this form never has one.
    const email = await signupIdentityEmail(directory);
    const facts: [Record<string, string>] | [] = email ? [{ email }] : [];
    await squire.signup(MILLIONSEEK_SERVICE, `https://${MILLIONSEEK_HOST}/signup`,
      `Create one ordinary free 100milionseek account with the supplied email and capture its new API key. On /signup type the supplied email into 'Email', let the human check finish (Squire's configured CAPTCHA solver handles it; never forge or inject tokens yourself), then press 'Create my key'. One account per person/inbox: never create aliases or other accounts, redeem token-reset vouchers or resell access. Stop if the page says signups are closed or paused, or asks for payment, SMS, Discord or Telegram. Never add payment details, buy tokens or a pass, or use paid models. Capture the new key with Squire's observed 'Copy key' button and store service ${MILLIONSEEK_SERVICE}, label ${MILLIONSEEK_STORE.label}, auth_shape bearer, api_hosts ["${MILLIONSEEK_HOST}"]. Never return the key.`, ...facts);
    matches = await select();
  }
  if (!matches.length) throw new Error('100milionseek requires one unambiguous scoped free key');
  const grant = await firstWorkingGrant(
    matches.map(item => item.reference!),
    reference => resolveSquireGrant('millionseek', reference, squire, { directory, ...(signal ? { signal } : {}), background, notify }),
    grant => new MillionSeek({ directory, loadGrant: async () => grant }).available(),
    signal
  );
  if (!grant) throw new Error('100milionseek recurring free entitlement could not be verified');
  signal?.throwIfAborted();
  if (grant.storedInVault) {
    await rm(join(directory, 'millionseek.json'), { force: true });
    notify('100milionseek: recurring free route connected through local Grunt vault; Grunt will verify a live reply.');
    return;
  }
  await writePrivateProviderGrant('millionseek', { base_url: grant.base_url, token: grant.token }, directory);
  notify('100milionseek: recurring free route connected; Grunt will verify a live reply.');
}
