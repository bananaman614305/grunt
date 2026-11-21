import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readDataSharingConsent } from './data-sharing.js';
import { Numes } from './numes.js';

import { validateProviderGrant } from './provider-grant.js';
import type { BrowserSquire, SetupSquire } from './setup.js';

type Squire = SetupSquire & Partial<Pick<BrowserSquire, 'signup' | 'call'>>;
interface SummaryCredential {
  reference: string; service?: string; label?: string; field_names?: string[]; allowed_hosts?: string[]; auth_strategy?: string;
}

export async function setupNumes(options: {
  directory: string; squire: Squire; signal?: AbortSignal; background?: boolean; connect?: () => Promise<void>; notify(line: string): void;
}) {
  const { directory, squire, signal, notify } = options;
  const id = 'numes';
  if (!(await readDataSharingConsent(directory, [id])).includes(id)) throw new Error('Numes requires its current data-sharing approval');
  signal?.throwIfAborted();
  if (await new Numes({ directory }).available()) {
    notify('Numes: verified free access reused');
    return;
  }
  if (options.background) throw new Error('Numes needs foreground setup to connect its free account');
  await options.connect?.();
  signal?.throwIfAborted();

  const select = async () => {
    if (!squire.call) throw new Error('Numes requires service-scoped vault lookup');
    const result = await squire.call('list_credentials', { service: id, fields: 'summary' });
    if (!Array.isArray(result.credentials)) throw new Error('Numes vault lookup did not complete');
    const dedicated = (result.credentials as SummaryCredential[]).filter(credential =>
      credential?.service?.trim().toLowerCase() === id && credential.label === 'Grunt Free');
    if (dedicated.some(credential => credential.allowed_hosts?.[0] !== 'api.numes.ai'
      || credential.allowed_hosts.some(host => !['api.numes.ai', 'numes.ai', 'auth.numes.ai', '*.numes.ai'].includes(host))
      || typeof credential.reference !== 'string' || !credential.reference.startsWith('vault://')
      || (credential.auth_strategy !== undefined && credential.auth_strategy !== 'api_key')
      || credential.field_names?.length !== 1 || !/^(value|api_?key|token|key)$/i.test(credential.field_names[0]!))) {
      throw new Error('Numes Grunt Free credential needs a single API key scoped to api.numes.ai');
    }
    return dedicated;
  };
  let matches = await select();
  if (!matches.length) {
    if (!squire.signup) throw new Error('Numes setup requires a browser-capable Trusty Squire');
    signal?.throwIfAborted();
    await squire.signup(id, 'https://numes.ai/dashboard',
      `Reuse this user's Numes account with the Google identity already connected to Squire, or create one ordinary free account if none exists. Stop for normal human verification when required. No duplicate account, payment method, top-up, or paid plan. Reuse or create one dedicated Grunt Free USD inference key with a numeric 0 spending limit and no reset. Verify the saved spending cap is exactly zero and keep it there. Capture the key directly into Squire under service numes, label Grunt Free, auth_shape bearer and api_hosts ["api.numes.ai"]. Never show, return or fetch the key.`);
    matches = await select();
  }
  const [credential] = matches;
  if (!credential || matches.length !== 1) throw new Error('Numes needs one unambiguous free-route vault credential');
  signal?.throwIfAborted();
  const grant = validateProviderGrant(await squire.credentials.grant(credential.reference));
  if (!await new Numes({ directory, loadGrant: async () => grant }).available()) throw new Error('Numes free routes are unavailable');
  signal?.throwIfAborted();

  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `numes.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(grant), { flag: 'wx', mode: 0o600 });
    signal?.throwIfAborted();
    await rename(temporary, join(directory, 'numes.json'));
  } finally { await rm(temporary, { force: true }); }
  notify('Numes: verified free route connected through Trusty Squire');
}
