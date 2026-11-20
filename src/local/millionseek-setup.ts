import { readDataSharingConsent } from './data-sharing.js';
import { MillionSeek, MILLIONSEEK_HOST, MILLIONSEEK_MODEL, MILLIONSEEK_SERVICE } from './millionseek.js';
import { validateProviderGrant, writePrivateProviderGrant } from './provider-grant.js';
import type { BrowserSquire, SetupSquire } from './setup.js';

type Squire = SetupSquire & Partial<Pick<BrowserSquire, 'signup' | 'call'>>;
interface Credential { service?: string; label?: string; reference?: string; allowed_hosts?: string[]; field_names?: string[]; auth_strategy?: string }
export async function setupMillionSeek({ directory, squire, notify, connect, signal, background }: {
  directory: string; squire: Squire; notify(line: string): void; connect?: () => Promise<void>; signal?: AbortSignal; background: boolean;
}) {
  if (!(await readDataSharingConsent(directory, ['millionseek'])).includes('millionseek')) throw new Error('100milionseek requires current data-sharing approval');
  signal?.throwIfAborted();
  if (await new MillionSeek({ directory }).available()) { notify('100milionseek: recurring free route reused'); return; }
  if (background) throw new Error('100milionseek requires foreground setup');
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
    await squire.signup(MILLIONSEEK_SERVICE, `https://${MILLIONSEEK_HOST}/signup`,
      `Reuse the user's existing 100milionseek account and key if available; otherwise create one ordinary free account using the verified account email through Squire's sealed signup slots. Honor one account per person/inbox; never create aliases, rotate accounts, redeem token-reset vouchers, or resell access. Stop if signup slots are paused. Use normal observed controls and Squire's configured verification tools. A visible Cloudflare checkbox inside its frame can receive normal keyboard focus: focus the preceding email field, Tab, verify focus on the checkbox, then Space. Never forge verification or inject tokens; hand off if supported controls cannot complete it. Never add payment details, buy tokens, or use paid models. Capture the newly created key directly with Squire's observed Copy key button and store service ${MILLIONSEEK_SERVICE}, label Grunt Free, auth_shape bearer, api_hosts ["${MILLIONSEEK_HOST}"]. Never return the key. Verify ${MILLIONSEEK_MODEL}, 198000 input and a recurring 100M-token UTC-day allowance; temporary bonuses are separate. Stop if payment, SMS, Discord or Telegram is required.`);
    matches = await select();
  }
  if (matches.length !== 1) throw new Error('100milionseek requires one unambiguous scoped free key');
  const grant = validateProviderGrant(await squire.credentials.grant(matches[0]!.reference!));
  if (!await new MillionSeek({ directory, loadGrant: async () => grant }).available()) throw new Error('100milionseek recurring free entitlement could not be verified');
  signal?.throwIfAborted();
  await writePrivateProviderGrant('millionseek', grant, directory);
  notify('100milionseek: recurring free route connected; Grunt will verify a live reply.');
}
