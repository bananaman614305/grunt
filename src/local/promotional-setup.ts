import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { readDataSharingConsent } from './data-sharing.js';
import { PromotionalApi, PROMOTIONAL_PROVIDERS } from './promotional-api.js';
import type { PromotionalProvider } from './promotional-api.js';
import { firstWorkingGrant, resolveSquireGrant, writePrivateProviderGrant } from './provider-grant.js';
import type { BrowserSquire, SetupSquire } from './setup.js';
import { SetupRefusal } from './setup-failure.js';

export const PROMOTIONAL_STORE = { service: 'fikra', label: 'Grunt Free', api_hosts: [PROMOTIONAL_PROVIDERS.fikra.host], auth_shape: 'bearer' };
type Squire = SetupSquire & Partial<Pick<BrowserSquire, 'signup' | 'call'>>;
export async function setupPromotionalApi(id: PromotionalProvider, options: {
  directory: string; squire: Squire; notify(line: string): void; connect?: () => Promise<void>; signal?: AbortSignal; background: boolean;
}) {
  const { directory, squire, notify, signal } = options, spec = PROMOTIONAL_PROVIDERS[id];
  if (Date.now() >= Date.parse(spec.expires)) throw new SetupRefusal('free promotion expired', `${id}'s vetted free promotion has expired; use another free route`);
  if (!(await readDataSharingConsent(directory, [id])).includes(id)) throw new Error(`${id} requires current data-sharing approval`);
  signal?.throwIfAborted();
  if (await new PromotionalApi(id, { directory }).available()) { notify(`${id}: temporary free route reused`); return; }
  await options.connect?.();
  const select = async () => {
    if (!squire.call) throw new Error(`${id} requires scoped vault lookup`);
    const result = await squire.call('list_credentials', { service: id, fields: 'summary' });
    if (!Array.isArray(result.credentials)) throw new Error(`${id} vault lookup incomplete`);
    return (result.credentials as { service?: string; label?: string; reference?: string; allowed_hosts?: string[]; field_names?: string[]; auth_strategy?: string }[])
      .filter(item => item?.service === id && item.label === PROMOTIONAL_STORE.label && item.reference?.startsWith('vault://')
        && item.allowed_hosts?.includes(spec.host) && item.allowed_hosts.every(host =>
          [spec.host, new URL(spec.signup).hostname, `*.${new URL(spec.signup).hostname}`].includes(host))
        && (item.auth_strategy === undefined || item.auth_strategy === 'api_key')
        && item.field_names?.length === 1 && /^(value|api_?key|token|key)$/i.test(item.field_names[0]!));
  };
  let matches = await select();
  if (!matches.length) {
    if (!squire.signup) throw new Error(`${id} requires browser-capable Trusty Squire`);
    signal?.throwIfAborted();
    await squire.signup(id, spec.signup,
      `Reuse this user's account and connected identity. If no account exists, create one ordinary personal free account. Use Squire's configured verification tools, including its configured CAPTCHA solver when needed. Pause for the user only if Squire cannot finish a required verification step. Never skip or forge verification. Do not add a card, pay, top up, activate a paid plan, or create a second account. Reuse or create one key named Grunt Free and capture directly into Squire service ${id}, label ${PROMOTIONAL_STORE.label}, auth_shape bearer, api_hosts ["${spec.host}"]. Never show its value. Use only ${spec.model}. If key model restrictions are offered, allow only this exact free alias. Leave paid BYOK routing disabled. Complete and follow a Google or GitHub authorization popup instead of repeatedly clicking the product login page. This is a temporary offer. Do not call paid quote endpoints or impersonate another client.`);
    matches = await select();
  }
  if (!matches.length) throw new Error(`${id} requires one unambiguous Grunt Free API key`);
  signal?.throwIfAborted();
  const grant = await firstWorkingGrant(
    matches.map(item => item.reference!),
    reference => resolveSquireGrant(id, reference, squire, { directory, ...(signal ? { signal } : {}), background: options.background, notify }),
    grant => new PromotionalApi(id, { directory, loadGrant: async () => grant }).available(),
    signal
  );
  if (!grant) throw new Error(`${id} free catalog/gate verification failed`);
  signal?.throwIfAborted();
  if (grant.storedInVault) {
    await rm(join(directory, `${id}.json`), { force: true });
    notify(`${id}: temporary free route connected through local Grunt vault; Grunt will verify a live reply.`);
    return;
  }
  await writePrivateProviderGrant(id, { base_url: grant.base_url, token: grant.token }, directory);
  notify(`${id}: temporary free route connected; Grunt will verify a live reply.`);
}
