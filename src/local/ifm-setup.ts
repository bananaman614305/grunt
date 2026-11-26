import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { readDataSharingConsent } from './data-sharing.js';
import { Ifm, IFM_HOST, IFM_SERVICE } from './ifm.js';
import { firstWorkingGrant, resolveSquireGrant, writePrivateProviderGrant } from './provider-grant.js';
import type { BrowserSquire, SetupSquire } from './setup.js';

export const IFM_STORE = { service: IFM_SERVICE, label: 'Grunt Free', api_hosts: [IFM_HOST], auth_shape: 'bearer' } as const;
type Squire = SetupSquire & Partial<Pick<BrowserSquire, 'call'>>;
interface SummaryCredential {
  reference: string;
  service?: string;
  label?: string;
  field_names?: string[];
  allowed_hosts?: string[];
  auth_strategy?: string;
}

/**
 * Connects an IFM key the person already holds. Unlike the other sources, this setup never signs up: IFM's
 * price, terms and data practices are unverified, so the person creates the account and key themselves and
 * stores the key in Trusty Squire under service ifm, label Grunt Free, host api.ifm.ai.
 */
export async function setupIfm({ directory, squire, notify, connect, signal, background }: {
  directory: string;
  squire: Squire;
  notify(line: string): void;
  connect?: () => Promise<void>;
  signal?: AbortSignal;
  background: boolean;
}) {
  const id = IFM_STORE.service;
  if (!(await readDataSharingConsent(directory, [id])).includes(id)) throw new Error('IFM requires its current data-sharing approval');
  signal?.throwIfAborted();
  if (await new Ifm({ directory }).available()) {
    notify('IFM: K2 Horizon route reused');
    return;
  }
  await connect?.();
  signal?.throwIfAborted();
  if (!squire.call) throw new Error('IFM requires service-scoped vault lookup');
  const result = await squire.call('list_credentials', { service: id, fields: 'summary' });
  if (!Array.isArray(result.credentials)) throw new Error('IFM vault lookup did not complete');
  const matches = (result.credentials as SummaryCredential[]).filter(item => item
    && item.service === id && item.label === IFM_STORE.label
    && item.reference?.startsWith('vault://')
    && item.allowed_hosts?.length === 1 && item.allowed_hosts[0] === IFM_HOST
    && (item.auth_strategy === undefined || item.auth_strategy === 'api_key')
    && item.field_names?.length === 1 && /^(value|api_?key|token|key)$/i.test(item.field_names[0]!));
  if (!matches.length) throw new Error('IFM needs a key you created yourself, stored in Trusty Squire as service ifm, label Grunt Free, host api.ifm.ai');
  signal?.throwIfAborted();
  const grant = await firstWorkingGrant(
    matches.map(item => item.reference!),
    reference => resolveSquireGrant(id, reference, squire, { directory, ...(signal ? { signal } : {}), background, notify }),
    grant => new Ifm({ directory, loadGrant: async () => grant }).available(),
    signal
  );
  if (!grant) throw new Error('IFM K2 Horizon route could not be verified');
  signal?.throwIfAborted();
  if (grant.storedInVault) {
    await rm(join(directory, `${id}.json`), { force: true });
    notify('IFM: K2 Horizon connected through local Grunt vault; price and terms remain unverified by Grunt');
    return;
  }
  await writePrivateProviderGrant(id, { base_url: grant.base_url, token: grant.token }, directory);
  notify('IFM: K2 Horizon connected through Trusty Squire; price and terms remain unverified by Grunt');
}
