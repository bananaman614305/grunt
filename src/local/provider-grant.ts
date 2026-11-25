import { configRoot } from '../brand.js';
import { constants } from 'node:fs';
import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { FreeApiGrant } from './free-api.js';

export const providerGrantDirectory = () => configRoot();
type Provider = 'runcrate' | 'apinex' | 'kilo' | 'goedel' | 'crowllm' | 'fikra' | 'openference' | 'darus' | 'aperture-ai' | 'millionseek' | 'ifm';
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
export async function readPrivateProviderGrant(provider: Provider, location: string): Promise<unknown> {
  const file = await open(join(location, `${name(provider)}.json`), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid?.()) throw new Error('Unsafe private provider grant file');
    return JSON.parse(await file.readFile('utf8'));
  } finally { await file.close(); }
}
export async function writePrivateProviderGrant(provider: Provider, value: FreeApiGrant, location: string) {
  const temporary = join(location, `${name(provider)}.${randomUUID()}.tmp`);
  await mkdir(location, { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    await rename(temporary, join(location, `${provider}.json`));
  } finally { await rm(temporary, { force: true }); }
}
