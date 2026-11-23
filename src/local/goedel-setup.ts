import { readDataSharingConsent } from './data-sharing.js';
import { Goedel } from './goedel.js';
import { firstWorkingGrant, writePrivateProviderGrant } from './provider-grant.js';
import type { BrowserSquire, SetupSquire } from './setup.js';

export const GOEDEL_STORE = { service: 'goedel', label: 'Grunt Free', api_hosts: ['api.goedelmachines.com'], auth_shape: 'bearer' } as const;
type Squire = SetupSquire & Partial<Pick<BrowserSquire, 'signup' | 'call'>>;
interface SummaryCredential {
  reference: string;
  service?: string;
  label?: string;
  field_names?: string[];
  allowed_hosts?: string[];
  auth_strategy?: string;
}

export async function setupGoedel({ directory, squire, notify, connect, signal }: {
  directory: string;
  squire: Squire;
  notify(line: string): void;
  connect?: () => Promise<void>;
  signal?: AbortSignal;
  background: boolean;
}) {
  const id = GOEDEL_STORE.service;
  if (!(await readDataSharingConsent(directory, [id])).includes(id)) throw new Error('Gödel requires its current data-sharing approval');
  signal?.throwIfAborted();
  if (await new Goedel({ directory }).available()) {
    notify('Gödel: verified Free Key reused for public requests');
    return;
  }
  await connect?.();
  signal?.throwIfAborted();

  const select = async () => {
    if (!squire.call) throw new Error('Gödel requires service-scoped vault lookup');
    const result = await squire.call('list_credentials', { service: ['goedel', 'goedel machines'], fields: 'summary' });
    if (!Array.isArray(result.credentials)) throw new Error('Gödel vault lookup did not complete');
    return (result.credentials as SummaryCredential[]).filter(item => item
      && (item.service === id && item.label === GOEDEL_STORE.label || item.service === 'goedel machines' && item.label === 'Grunt free diagnostics')
      && item.reference?.startsWith('vault://')
      // The grant routes to the first allowed host. Squire's store adds the session's
      // observed hosts, so the others need only stay inside the provider's domain.
      && Array.isArray(item.allowed_hosts) && item.allowed_hosts[0] === GOEDEL_STORE.api_hosts[0]!
      && item.allowed_hosts.every((host: unknown) => typeof host === 'string'
        && (host === 'goedelmachines.com' || host === '*.goedelmachines.com' || host.endsWith('.goedelmachines.com')))
      && (item.auth_strategy === undefined || item.auth_strategy === 'api_key')
      && item.field_names?.length === 1 && /^(value|api_?key|token|key)$/i.test(item.field_names[0]!));
  };

  let matches = await select();
  if (!matches.length) {
    if (!squire.signup) throw new Error('Gödel setup requires browser-capable Trusty Squire');
    signal?.throwIfAborted();
    await squire.signup(id, 'https://inference.goedelmachines.com/keys',
      `Reuse the user’s existing Gödel account or sign in to one ordinary free account with the connected Google identity. Use Squire’s configured verification tools, including its configured CAPTCHA solver when needed. On the Keys page create or reuse one dedicated Free Key named Grunt Free. Verify the key type is Free and the shown prefix is sk-gm-free-. No student key, paid key, plan, payment details, top-up or extra account. Capture the key directly into Squire under service goedel, label ${GOEDEL_STORE.label}, auth_shape bearer and api_hosts ["${GOEDEL_STORE.api_hosts[0]}"]. Never show, return or fetch the key.`);
    matches = await select();
  }
  if (!matches.length) throw new Error('Gödel needs one unambiguous Free Key vault entry');
  signal?.throwIfAborted();
  const grant = await firstWorkingGrant(matches.map(item => item.reference!), reference => squire.credentials.grant(reference),
    grant => new Goedel({ directory, loadGrant: async () => grant }).available(), signal);
  if (!grant) throw new Error('Gödel Free Key could not be verified');
  signal?.throwIfAborted();
  await writePrivateProviderGrant(id, grant, directory);
  notify('Gödel: verified Free Key connected through Trusty Squire for public requests');
}
