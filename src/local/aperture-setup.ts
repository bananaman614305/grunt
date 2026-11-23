import { readDataSharingConsent } from './data-sharing.js';
import { Aperture, APERTURE_HOST, APERTURE_ID, APERTURE_MODEL } from './aperture.js';
import { firstWorkingGrant, writePrivateProviderGrant } from './provider-grant.js';
import type { BrowserSquire, SetupSquire } from './setup.js';

export const APERTURE_STORE = { service: APERTURE_ID, label: 'Grunt Free', api_hosts: [APERTURE_HOST], auth_shape: 'bearer' } as const;
type Squire = SetupSquire & Partial<Pick<BrowserSquire, 'signup' | 'call'>>;
interface Credential { service?: string; label?: string; reference?: string; allowed_hosts?: string[]; field_names?: string[]; auth_strategy?: string }
export async function setupAperture({ directory, squire, notify, connect, signal }: {
  directory: string; squire: Squire; notify(line: string): void; connect?: () => Promise<void>; signal?: AbortSignal; background: boolean;
}) {
  const id = APERTURE_STORE.service;
  if (!(await readDataSharingConsent(directory, [id])).includes(id)) throw new Error('Aperture requires current data-sharing approval');
  signal?.throwIfAborted();
  if (await new Aperture({ directory }).available()) { notify('Aperture: verified Free route reused'); return; }
  await connect?.();
  const select = async () => {
    if (!squire.call) throw new Error('Aperture requires scoped vault lookup');
    const result = await squire.call('list_credentials', { service: id, fields: 'summary' });
    if (!Array.isArray(result.credentials)) throw new Error('Aperture vault lookup incomplete');
    return (result.credentials as Credential[]).filter(item => item?.service === id
      && item.label === APERTURE_STORE.label && item.reference?.startsWith('vault://')
      && item.allowed_hosts?.includes(APERTURE_HOST) && item.allowed_hosts.every(host => [APERTURE_HOST, 'aperture-ai.run', '*.aperture-ai.run'].includes(host))
      && (item.auth_strategy === undefined || item.auth_strategy === 'api_key')
      && item.field_names?.length === 1 && /^(value|api_?key|token|key)$/i.test(item.field_names[0]!));
  };
  let matches = await select();
  if (!matches.length) {
    if (!squire.signup) throw new Error('Aperture requires browser-capable Trusty Squire');
    signal?.throwIfAborted();
    await squire.signup(id, `https://${APERTURE_HOST}/login.html`,
      `Reuse this user's Aperture account, or create one ordinary Free account if none exists. Use Squire's sealed email/password login slots and ordinary verification, including its configured CAPTCHA solver when needed. Never skip or forge verification, create a second account, add a card, pay, top up, buy credits or activate a paid plan. After signing in, open /chat.html and its ordinary Dashboard control. The account API key is available there: capture it directly into Squire service ${id}, label ${APERTURE_STORE.label}, auth_shape bearer, api_hosts ["${APERTURE_HOST}"]. Never show its value. Use this standard authenticated key control and complete any verification the account requests; pause if a required verification cannot be completed. Use only ${APERTURE_MODEL}. Verify /auth/me reports valid=true and plan=free. Stop when daily free quota is exhausted; no paid model or BYOK fallback.`);
    matches = await select();
  }
  if (!matches.length) throw new Error('Aperture requires one unambiguous scoped Grunt Free key');
  signal?.throwIfAborted();
  const grant = await firstWorkingGrant(matches.map(item => item.reference!), reference => squire.credentials.grant(reference),
    grant => new Aperture({ directory, loadGrant: async () => grant }).available(), signal);
  if (!grant) throw new Error('Aperture Free account and zero-price catalog could not be verified');
  signal?.throwIfAborted();
  await writePrivateProviderGrant(id, grant, directory);
  notify('Aperture: Free route connected; Grunt will verify a live reply.');
}
