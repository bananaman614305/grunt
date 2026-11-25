import { readDataSharingConsent } from './data-sharing.js';
import { OPENROUTER_PARTICLE_HOST, OPENROUTER_PARTICLE_ID, OpenRouterParticle } from './openrouter-particle.js';
import { firstWorkingGrant, writePrivateProviderGrant } from './provider-grant.js';
import type { BrowserSquire, SetupSquire } from './setup.js';

export const OPENROUTER_PARTICLE_LABEL = 'Grunt Free';
type Squire = SetupSquire & Partial<Pick<BrowserSquire, 'signup' | 'call'>>;
interface SummaryCredential {
  reference?: string; service?: string; label?: string; field_names?: string[]; allowed_hosts?: string[]; auth_strategy?: string;
}

// Only a key labelled Grunt Free on openrouter.ai is considered. Other OpenRouter keys in the vault, such as an
// application's inference or management keys, are never reused for this free route.
export async function setupOpenRouterParticle({ directory, squire, notify, connect, signal }: {
  directory: string; squire: Squire; notify(line: string): void; connect?: () => Promise<void>; signal?: AbortSignal; background: boolean;
}) {
  const id = OPENROUTER_PARTICLE_ID;
  if (!(await readDataSharingConsent(directory, [id])).includes(id)) throw new Error('OpenRouter Particle requires its own data-sharing approval');
  signal?.throwIfAborted();
  if (await new OpenRouterParticle({ directory }).available(signal)) {
    notify('OpenRouter Particle: verified free route reused');
    return;
  }
  await connect?.();
  signal?.throwIfAborted();
  const select = async () => {
    if (!squire.call) throw new Error('OpenRouter Particle requires service-scoped vault lookup');
    const result = await squire.call('list_credentials', { service: 'openrouter', fields: 'summary' });
    if (!Array.isArray(result.credentials)) throw new Error('OpenRouter vault lookup did not complete');
    return (result.credentials as SummaryCredential[]).filter(item => item && item.service === 'openrouter' && item.label === OPENROUTER_PARTICLE_LABEL
      && item.reference?.startsWith('vault://') && item.allowed_hosts?.length === 1 && item.allowed_hosts[0] === OPENROUTER_PARTICLE_HOST
      && (item.auth_strategy === undefined || item.auth_strategy === 'api_key')
      && item.field_names?.length === 1 && /^(value|api_?key|token|key)$/i.test(item.field_names[0]!));
  };
  let matches = await select();
  if (!matches.length) {
    if (!squire.signup) throw new Error('OpenRouter Particle setup requires browser-capable Trusty Squire');
    signal?.throwIfAborted();
    await squire.signup('openrouter', 'https://openrouter.ai/settings/keys',
      `Reuse this user's existing OpenRouter account and connected Google or GitHub identity. If none exists, create one ordinary free account. Use Squire's configured verification tools; pause only if Squire cannot complete a required verification, and never skip or forge one. Do not create another account, add a card, buy or top up credits, enable auto top-up or activate a paid plan. Create one ordinary API key (not a management key) named ${OPENROUTER_PARTICLE_LABEL} with a credit limit of 0 if the form offers one, and capture it directly into Squire under service openrouter, label ${OPENROUTER_PARTICLE_LABEL}, auth_shape bearer and api_hosts ["${OPENROUTER_PARTICLE_HOST}"]. Never show or return its value. Do not change the account's privacy or logging settings. Grunt will verify the exact free route before inference.`);
    matches = await select();
  }
  if (!matches.length) throw new Error('OpenRouter Particle needs one unambiguous Grunt Free key vault entry');
  signal?.throwIfAborted();
  const grant = await firstWorkingGrant(matches.map(item => item.reference!), reference => squire.credentials.grant(reference),
    grant => new OpenRouterParticle({ directory, loadGrant: async () => grant }).available(signal), signal);
  if (!grant) throw new Error('OpenRouter Particle free route could not be verified');
  signal?.throwIfAborted();
  await writePrivateProviderGrant(id, grant, directory);
  notify('OpenRouter Particle: verified free route connected through Trusty Squire; Grunt will verify a live reply.');
}
