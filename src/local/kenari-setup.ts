import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readDataSharingConsent } from './data-sharing.js';
import { Kenari, KENARI_FREE_MODEL } from './kenari.js';
import { firstWorkingGrant, resolveSquireGrant } from './provider-grant.js';
import type { BrowserSquire, SetupSquire } from './setup.js';

export const KENARI_STORE = { service: 'kenari', label: 'Grunt Free', api_hosts: ['kenari.id'], auth_shape: 'bearer' };
type Squire = SetupSquire & Partial<Pick<BrowserSquire, 'signup' | 'call'>>;
interface SummaryCredential {
  reference: string; service?: string; label?: string; field_names?: string[]; allowed_hosts?: string[]; auth_strategy?: string;
}

export async function setupKenari(options: {
  directory: string; squire: Squire; signal?: AbortSignal; background?: boolean; connect?: () => Promise<void>; notify(line: string): void;
}) {
  const { directory, squire, signal, notify } = options;
  const id = KENARI_STORE.service;
  if (!(await readDataSharingConsent(directory, [id])).includes(id)) throw new Error('Kenari requires its current data-sharing approval');
  signal?.throwIfAborted();
  if (await new Kenari({ directory }).available()) {
    notify('Kenari: verified free ERNIE access reused');
    return;
  }
  await options.connect?.();
  signal?.throwIfAborted();

  const select = async () => {
    if (!squire.call) throw new Error('Kenari requires service-scoped vault lookup');
    const result = await squire.call('list_credentials', { service: id, fields: 'summary' });
    if (!Array.isArray(result.credentials)) throw new Error('Kenari vault lookup did not complete');
    const dedicated = (result.credentials as SummaryCredential[]).filter(credential =>
      credential?.service?.trim().toLowerCase() === id && credential.label === KENARI_STORE.label);
    if (dedicated.some(credential => credential.allowed_hosts?.[0] !== KENARI_STORE.api_hosts[0]!
      || typeof credential.reference !== 'string' || !credential.reference.startsWith('vault://')
      || (credential.auth_strategy !== undefined && credential.auth_strategy !== 'api_key')
      || credential.field_names?.length !== 1 || !/^(value|api_?key|token|key)$/i.test(credential.field_names[0]!))) {
      throw new Error('Kenari Grunt Free credential needs a single API key with kenari.id as its first host');
    }
    return dedicated;
  };
  let matches = await select();
  if (!matches.length) {
    if (!squire.signup) throw new Error('Kenari setup requires a browser-capable Trusty Squire');
    signal?.throwIfAborted();
    await squire.signup(id, 'https://kenari.id/login',
      `Reuse this user's Kenari account with the Google identity already connected to Squire, or create one ordinary free account if none exists. Use Squire's configured verification tools, including its configured CAPTCHA solver when needed. No duplicate account, paid plan, top-up, card, or other paid feature. Create at most one Grunt Free key restricted to ${KENARI_FREE_MODEL}, with paid capabilities off. Store it directly in the vault under service kenari and label ${KENARI_STORE.label} with ${KENARI_STORE.api_hosts[0]} as its primary API host. Do not display, return or read the secret.`,
      { model: KENARI_FREE_MODEL, key_name: 'grunt' });
    matches = await select();
  }
  if (!matches.length) throw new Error('Kenari needs one unambiguous free-route vault credential');
  signal?.throwIfAborted();
  const grant = await firstWorkingGrant(
    matches.map(item => item.reference),
    reference => resolveSquireGrant(id, reference, squire, {
      directory,
      ...(signal ? { signal } : {}),
      ...(options.background !== undefined ? { background: options.background } : {}),
      notify
    }),
    grant => new Kenari({ directory, loadGrant: async () => grant }).available(),
    signal
  );
  if (!grant) throw new Error('Kenari free ERNIE is unavailable');
  signal?.throwIfAborted();

  if (grant.storedInVault) {
    await rm(join(directory, 'kenari.json'), { force: true });
    notify('Kenari: exact free ERNIE route connected through local Grunt vault');
    return;
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `kenari.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify({ base_url: grant.base_url, token: grant.token }), { flag: 'wx', mode: 0o600 });
    signal?.throwIfAborted();
    await rename(temporary, join(directory, 'kenari.json'));
  } finally { await rm(temporary, { force: true }); }
  notify('Kenari: exact free ERNIE route connected through Trusty Squire');
}
