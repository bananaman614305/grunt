import { configRoot } from '../brand.js';
import { constants } from 'node:fs';
import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { FreeApiGrant } from './free-api.js';
import {
  defaultProviderOrigin,
  readVaultGrant,
  validateProviderEndpoint,
  validateVaultToken,
  writeVaultEntry
} from './vault.js';
import type { VaultEntrySource, VaultProvider } from './vault.js';

export const providerGrantDirectory = () => configRoot();
type Provider = 'runcrate' | 'apinex' | 'kilo' | 'goedel' | 'crowllm' | 'fikra' | 'openference' | 'darus' | 'aperture-ai' | 'millionseek' | 'ifm';
const RECEIPT_PROVIDERS = new Set<Provider>(['runcrate', 'apinex']);
function name(provider: Provider) {
  if (provider !== 'runcrate' && provider !== 'apinex' && provider !== 'kilo' && provider !== 'goedel' && provider !== 'crowllm' && provider !== 'fikra' && provider !== 'openference' && provider !== 'darus' && provider !== 'aperture-ai' && provider !== 'millionseek' && provider !== 'ifm') throw new Error('Invalid private provider');
  return provider;
}
export function validateProviderGrant(value: unknown): FreeApiGrant {
  const grant = value as Partial<FreeApiGrant> | null;
  if (!grant || typeof grant.base_url !== 'string' || typeof grant.token !== 'string' || !grant.token.trim()) throw new Error('Invalid private provider grant');
  let url: URL;
  try { url = new URL(grant.base_url); } catch { throw new Error('Invalid private provider endpoint'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Invalid private provider endpoint');
  return { base_url: grant.base_url.replace(/\/$/, ''), token: grant.token };
}
export function validatePinnedProviderGrant(
  provider: VaultProvider,
  value: unknown,
  options: { strictEgressLength?: boolean } = {}
): FreeApiGrant {
  const grant = value as Partial<FreeApiGrant> | null;
  if (!grant || typeof grant.base_url !== 'string') throw new Error('Invalid private provider grant');
  const token = validateVaultToken(grant.token);
  const endpoint = validateProviderEndpoint(provider, grant.base_url, options);
  return { base_url: endpoint.base_url, token };
}
export async function materializeDirectGrant(
  provider: VaultProvider,
  input: { token: string; origin?: string; source?: VaultEntrySource },
  location = providerGrantDirectory()
): Promise<FreeApiGrant> {
  const saved = await writeVaultEntry(provider, {
    api_key: input.token,
    origin: input.origin ?? defaultProviderOrigin(provider),
    source: input.source ?? 'local'
  }, location);
  return { base_url: saved.origin, token: validateVaultToken(input.token) };
}
// Several vault entries can match a provider. Use the first whose grant passes the
// provider's own free-route check; undefined when none does.
export async function firstWorkingGrant(references: readonly string[], grant: (reference: string) => Promise<unknown>,
  works: (grant: FreeApiGrant) => Promise<boolean>, signal?: AbortSignal): Promise<FreeApiGrant | undefined> {
  for (const reference of references) {
    signal?.throwIfAborted();
    try {
      const candidate = validateProviderGrant(await grant(reference));
      const available = await works(candidate);
      signal?.throwIfAborted();
      if (available) return candidate;
    } catch { signal?.throwIfAborted(); }
  }
  return undefined;
}
async function readProviderGrantFile(provider: Provider, location: string): Promise<unknown> {
  const file = await open(join(location, `${name(provider)}.json`), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid?.()) throw new Error('Unsafe private provider grant file');
    return JSON.parse(await file.readFile('utf8'));
  } finally { await file.close(); }
}
export async function readPrivateProviderGrant(
  provider: Provider,
  location: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<unknown> {
  const id = name(provider);
  const vaulted = await readVaultGrant(id, location, env);
  if (vaulted && !RECEIPT_PROVIDERS.has(id)) {
    return { base_url: vaulted.base_url, token: vaulted.token };
  }
  if (vaulted && RECEIPT_PROVIDERS.has(id)) {
    const saved = await readProviderGrantFile(id, location);
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
      return { ...(saved as Record<string, unknown>), base_url: vaulted.base_url, token: vaulted.token };
    }
    return saved;
  }
  return readProviderGrantFile(id, location);
}
export async function writePrivateProviderGrant(provider: Provider, value: FreeApiGrant, location: string) {
  const temporary = join(location, `${name(provider)}.${randomUUID()}.tmp`);
  await mkdir(location, { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    await rename(temporary, join(location, `${provider}.json`));
  } finally { await rm(temporary, { force: true }); }
}
