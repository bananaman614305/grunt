import { readDataSharingConsent } from './data-sharing.js';
import { Darus, DARUS_HOST, DARUS_MODEL } from './darus.js';
import { firstWorkingGrant, writePrivateProviderGrant } from './provider-grant.js';
import type { BrowserSquire, SetupSquire } from './setup.js';

export const DARUS_STORE = { service: 'darus', label: 'Grunt Free', api_hosts: [DARUS_HOST], auth_shape: 'bearer' } as const;
type Squire = SetupSquire & Partial<Pick<BrowserSquire, 'signup' | 'call'>>;
interface Credential { service?: string; label?: string; reference?: string; allowed_hosts?: string[]; field_names?: string[]; auth_strategy?: string }
export async function setupDarus({ directory, squire, notify, connect, signal }: {
  directory: string; squire: Squire; notify(line: string): void; connect?: () => Promise<void>; signal?: AbortSignal; background: boolean;
}) {
  const id = DARUS_STORE.service;
  if (!(await readDataSharingConsent(directory, [id])).includes(id)) throw new Error('Darus requires current data-sharing approval');
  signal?.throwIfAborted();
  if (await new Darus({ directory }).available()) { notify('Darus: protected daily free route reused'); return; }
  await connect?.();
  const select = async () => {
    if (!squire.call) throw new Error('Darus requires scoped vault lookup');
    const result = await squire.call('list_credentials', { service: id, fields: 'summary' });
    if (!Array.isArray(result.credentials)) throw new Error('Darus vault lookup incomplete');
    return (result.credentials as Credential[]).filter(item => item?.service === id
      && ['Grunt Free', 'personal-free'].includes(item.label ?? '') && item.reference?.startsWith('vault://')
      && item.allowed_hosts?.includes(DARUS_HOST) && item.allowed_hosts.every(host => [DARUS_HOST, 'darusalfatah.id', '*.darusalfatah.id'].includes(host))
      && (item.auth_strategy === undefined || item.auth_strategy === 'api_key')
      && item.field_names?.length === 1 && /^(value|api_?key|token|key)$/i.test(item.field_names[0]!));
  };
  let matches = await select();
  if (!matches.length) {
    if (!squire.signup) throw new Error('Darus requires browser-capable Trusty Squire');
    signal?.throwIfAborted();
    await squire.signup(id, `https://${DARUS_HOST}/`,
      `Reuse this user's existing Darus account and connected identity. If none exists, create one ordinary free account. Use Squire's configured verification tools, including its configured CAPTCHA solver when needed; pause only if Squire cannot complete a required verification. Never skip or forge verification. Do not add a card, pay, top up, choose a paid tier, or create another account. Verify the daily Free tier has minBalance 0 and a 10 million token allowance. In dashboard AI turn Simpan Saldo / Protect Balance ON, so exhaustion stops rather than drawing wallet credit; never disable it. Use only ${DARUS_MODEL}. Reuse or create one key named Grunt Free and capture directly into Squire service darus, label ${DARUS_STORE.label}, auth_shape bearer, api_hosts ["${DARUS_HOST}"]. Never show its value. Stop if access needs payment, SMS, Discord or Telegram verification. Do not perform check-in, referral or wallet reward actions.`);
    matches = await select();
  }
  if (!matches.length) throw new Error('Darus requires one unambiguous scoped free API key');
  signal?.throwIfAborted();
  const grant = await firstWorkingGrant(matches.map(item => item.reference!), reference => squire.credentials.grant(reference),
    grant => new Darus({ directory, loadGrant: async () => grant }).available(), signal);
  if (!grant) throw new Error('Darus protected free entitlement could not be verified');
  signal?.throwIfAborted();
  await writePrivateProviderGrant(id, grant, directory);
  notify('Darus: protected daily free route connected; Grunt will verify a live reply.');
}
