import { readDataSharingConsent } from './data-sharing.js';
import { fikraFreeWindow, PromotionalApi, PROMOTIONAL_PROVIDERS } from './promotional-api.js';
import type { PromotionalProvider } from './promotional-api.js';
import { validateProviderGrant, writePrivateProviderGrant } from './provider-grant.js';
import type { BrowserSquire, SetupSquire } from './setup.js';

type Squire = SetupSquire & Partial<Pick<BrowserSquire, 'signup' | 'call'>>;
export async function setupPromotionalApi(id: PromotionalProvider, options: {
  directory: string; squire: Squire; notify(line: string): void; connect?: () => Promise<void>; signal?: AbortSignal; background: boolean;
}) {
  const { directory, squire, notify, signal } = options, spec = PROMOTIONAL_PROVIDERS[id];
  if (!(await readDataSharingConsent(directory, [id])).includes(id)) throw new Error(`${id} requires current data-sharing approval`);
  signal?.throwIfAborted();
  if (await new PromotionalApi(id, { directory }).available()) { notify(`${id}: temporary free route reused`); return; }
  if (options.background) throw new Error(`${id} needs foreground setup`);
  const verifyWindow = async () => {
    const cutoff = Date.parse(spec.expires);
    const expiry = Date.now() >= cutoff ? undefined : id === 'fikra'
      ? await fikraFreeWindow(fetch, Date.now(), signal).catch(() => undefined) : cutoff;
    if (expiry === undefined || Date.now() >= expiry) {
      throw new Error(`${id} promotion is closed or cannot be verified; signup was not started`);
    }
  };
  await verifyWindow();
  await options.connect?.();
  const select = async () => {
    if (!squire.call) throw new Error(`${id} requires scoped vault lookup`);
    const result = await squire.call('list_credentials', { service: id, fields: 'summary' });
    if (!Array.isArray(result.credentials)) throw new Error(`${id} vault lookup incomplete`);
    return (result.credentials as { service?: string; label?: string; reference?: string; allowed_hosts?: string[]; field_names?: string[]; auth_strategy?: string }[])
      .filter(item => item?.service === id && item.label === 'Grunt Free' && item.reference?.startsWith('vault://')
        && item.allowed_hosts?.includes(spec.host) && item.allowed_hosts.every(host =>
          [spec.host, new URL(spec.signup).hostname, `*.${new URL(spec.signup).hostname}`].includes(host))
        && (item.auth_strategy === undefined || item.auth_strategy === 'api_key')
        && item.field_names?.length === 1 && /^(value|api_?key|token|key)$/i.test(item.field_names[0]!));
  };
  let matches = await select();
  if (!matches.length) {
    if (!squire.signup) throw new Error(`${id} requires browser-capable Trusty Squire`);
    signal?.throwIfAborted();
    await verifyWindow();
    await squire.signup(id, spec.signup,
      `Reuse this user's account and connected identity. If no account exists, create one ordinary personal free account. Use Squire's configured verification tools, including its configured CAPTCHA solver when needed. Pause for the user only if Squire cannot finish a required verification step. Never skip or forge verification. Do not add a card, pay, top up, activate a paid plan, or create a second account. Reuse or create one key named Grunt Free and capture directly into Squire service ${id}, label Grunt Free, auth_shape bearer, api_hosts ["${spec.host}"]. Never show its value. Use only ${spec.model}. If key model restrictions are offered, allow only this exact free alias. Leave paid BYOK routing disabled. Complete and follow a Google or GitHub authorization popup instead of repeatedly clicking the product login page. This is a temporary offer. Do not call paid quote endpoints or impersonate another client.`);
    matches = await select();
  }
  if (matches.length !== 1) throw new Error(`${id} requires one unambiguous Grunt Free API key`);
  signal?.throwIfAborted();
  const grant = validateProviderGrant(await squire.credentials.grant(matches[0]!.reference!));
  if (!await new PromotionalApi(id, { directory, loadGrant: async () => grant }).available()) throw new Error(`${id} free catalog/gate verification failed`);
  signal?.throwIfAborted();
  await writePrivateProviderGrant(id, grant, directory);
  notify(`${id}: temporary free route connected; Grunt will verify a live reply.`);
}
