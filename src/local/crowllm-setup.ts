import { readDataSharingConsent } from './data-sharing.js';
import { CrowLLM } from './crowllm.js';
import { validateProviderGrant, writePrivateProviderGrant } from './provider-grant.js';
import type { BrowserSquire, SetupSquire } from './setup.js';

type Squire = SetupSquire & Partial<Pick<BrowserSquire, 'signup' | 'call'>>;
interface SummaryCredential {
  reference: string;
  service?: string;
  label?: string;
  field_names?: string[];
  allowed_hosts?: string[];
  auth_strategy?: string;
}

export async function setupCrowLLM({ directory, squire, notify, connect, signal, background }: {
  directory: string;
  squire: Squire;
  notify(line: string): void;
  connect?: () => Promise<void>;
  signal?: AbortSignal;
  background: boolean;
}) {
  const id = 'crowllm';
  if (!(await readDataSharingConsent(directory, [id])).includes(id)) throw new Error('CrowLLM requires its current data-sharing approval');
  signal?.throwIfAborted();
  if (await new CrowLLM({ directory }).available()) {
    notify('CrowLLM: verified zero-price GLM route reused');
    return;
  }
  if (background) throw new Error('CrowLLM needs foreground setup to connect a zero-price GLM route');
  await connect?.();
  signal?.throwIfAborted();

  const select = async () => {
    if (!squire.call) throw new Error('CrowLLM requires service-scoped vault lookup');
    const result = await squire.call('list_credentials', { service: id, fields: 'summary' });
    if (!Array.isArray(result.credentials)) throw new Error('CrowLLM vault lookup did not complete');
    return (result.credentials as SummaryCredential[]).filter(item => item
      && item.service === id && item.label === 'Grunt Free'
      && item.reference?.startsWith('vault://')
      && item.allowed_hosts?.length === 1 && item.allowed_hosts[0] === 'crowllm.com'
      && (item.auth_strategy === undefined || item.auth_strategy === 'api_key')
      && item.field_names?.length === 1 && /^(value|api_?key|token|key)$/i.test(item.field_names[0]!));
  };

  let matches = await select();
  if (!matches.length) {
    if (!squire.signup) throw new Error('CrowLLM setup requires browser-capable Trusty Squire');
    signal?.throwIfAborted();
    await squire.signup(id, 'https://crowllm.com/keys',
      'Reuse this user’s CrowLLM account and existing connected Google or GitHub identity. Stop for human verification. Do not create another account, buy credits, add payment details, enable automatic top-ups, or activate a paid plan. Reuse or create one API key named Grunt Free and capture it directly into Squire under service crowllm, label Grunt Free, auth_shape bearer and api_hosts ["crowllm.com"]. Never show or return its value. Grunt will verify the exact zero-price GLM route before inference.');
    matches = await select();
  }
  if (matches.length !== 1) throw new Error('CrowLLM needs one unambiguous zero-price GLM route vault entry');
  signal?.throwIfAborted();
  const grant = validateProviderGrant(await squire.credentials.grant(matches[0]!.reference));
  if (!await new CrowLLM({ directory, loadGrant: async () => grant }).available()) throw new Error('CrowLLM zero-price GLM route could not be verified');
  signal?.throwIfAborted();
  await writePrivateProviderGrant(id, grant, directory);
  notify('CrowLLM: verified zero-price GLM route connected through Trusty Squire');
}
