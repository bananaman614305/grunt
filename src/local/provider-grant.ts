import { hasOwnerMode, openPrivateFile } from './private-file.js';
import { configRoot } from '../brand.js';
import { constants } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { ID_PATTERN, disabledAdapters, knownAdapters, safePublicHttpsOrigin } from '../registry.js';
import type { FreeApiGrant } from './free-api.js';
import {
  credentialFingerprint,
  defaultProviderOrigin,
  isCredentialFingerprint,
  isVaultProvider,
  readVaultGrant,
  validateDirectOrigin,
  validateProviderEndpoint,
  validateVaultToken,
  writeVaultEntry
} from './vault.js';
import type { VaultEntrySource, VaultProvider } from './vault.js';

export const providerGrantDirectory = () => configRoot();
export const LOCAL_VAULT_REFERENCE_PREFIX = 'vault://grunt-local/';
export function localVaultReference(provider: string): string {
  return `${LOCAL_VAULT_REFERENCE_PREFIX}${provider}`;
}
export function isLocalVaultReference(reference: string): boolean {
  return reference.startsWith(LOCAL_VAULT_REFERENCE_PREFIX);
}
export function parseLocalVaultReference(reference: string): string | undefined {
  if (!isLocalVaultReference(reference)) return undefined;
  const id = reference.slice(LOCAL_VAULT_REFERENCE_PREFIX.length);
  return id.length > 0 && !id.includes('/') ? id : undefined;
}
type Provider = 'runcrate' | 'kilo' | 'goedel' | 'crowllm' | 'fikra' | 'openference' | 'darus' | 'aperture-ai' | 'millionseek' | 'ifm';
const RECEIPT_PROVIDERS = new Set<Provider>(['runcrate']);
export interface SquireGrantSource {
  credentials: { grant(reference: string): Promise<{ base_url: string; token: string }> };
  materializeDirectVaultGrant?(
    provider: VaultProvider,
    reference: string,
    options?: {
      directory?: string;
      origin?: string;
      field?: string;
      reason?: string;
      onApproval?: (info: { approvalId: string; approvalUrl: string }) => Promise<void> | void;
      waitForApproval?: boolean;
      pollIntervalMs?: number;
      timeoutMs?: number;
      signal?: AbortSignal;
      // Return the approved key without writing the local vault, so the caller can verify it first.
      stage?: boolean;
    }
  ): Promise<{ base_url: string; token: string }>;
}
export interface ResolvedSquireGrant extends FreeApiGrant {
  transport: 'direct' | 'egress';
  storedInVault: boolean;
  // A passkey-approved export that was staged rather than written to the vault.
  exported?: boolean;
}
function name(provider: Provider) {
  if (provider !== 'runcrate' && provider !== 'kilo' && provider !== 'goedel' && provider !== 'crowllm' && provider !== 'fikra' && provider !== 'openference' && provider !== 'darus' && provider !== 'aperture-ai' && provider !== 'millionseek' && provider !== 'ifm') throw new Error('Invalid private provider');
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
function isDirectOrigin(provider: string, baseUrl: string): boolean {
  if (!isVaultProvider(provider)) return false;
  try {
    validateDirectOrigin(provider, baseUrl);
    return true;
  } catch {
    return false;
  }
}
/**
 * Resolves a captured provider credential reference into a direct local Grunt
 * vault grant when captured in-process via embedded signup, or into a legacy
 * Squire egress grant / opt-in passkey export for backwards compatibility.
 */
export async function resolveSquireGrant(
  provider: string,
  reference: string,
  squire: SquireGrantSource,
  options: {
    directory?: string;
    signal?: AbortSignal;
    background?: boolean;
    exportToVault?: boolean;
    stageExport?: boolean;
    notify?: (line: string) => void;
    onApproval?: (info: { approvalId: string; approvalUrl: string }) => Promise<void> | void;
  } = {}
): Promise<ResolvedSquireGrant> {
  options.signal?.throwIfAborted();
  if (isLocalVaultReference(reference)) {
    if (isVaultProvider(provider)) {
      const vaulted = await readVaultGrant(provider, options.directory ?? configRoot());
      if (!vaulted) throw new Error(`No stored local Grunt vault key for ${provider}`);
      return { base_url: vaulted.base_url, token: vaulted.token, transport: 'direct', storedInVault: true };
    }
    const grant = validateProviderGrant(await squire.credentials.grant(reference));
    return {
      ...grant,
      transport: 'direct',
      storedInVault: false
    };
  }
  if (options.exportToVault === true && isVaultProvider(provider) && typeof squire.materializeDirectVaultGrant === 'function') {
    try {
      const direct = await squire.materializeDirectVaultGrant(provider, reference, {
        ...(options.directory ? { directory: options.directory } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        waitForApproval: !options.background,
        ...(options.stageExport ? { stage: true } : {}),
        onApproval: info => {
          if (options.onApproval) return options.onApproval(info);
          options.notify?.(`${provider}: confirm Squire passkey export at ${info.approvalUrl} to store key in local Grunt vault`);
        }
      });
      return options.stageExport
        ? { base_url: direct.base_url, token: direct.token, transport: 'direct', storedInVault: false, exported: true }
        : { base_url: direct.base_url, token: direct.token, transport: 'direct', storedInVault: true };
    } catch {
      options.signal?.throwIfAborted();
    }
  }
  const grant = validateProviderGrant(await squire.credentials.grant(reference));
  return {
    ...grant,
    transport: isDirectOrigin(provider, grant.base_url) ? 'direct' : 'egress',
    storedInVault: false
  };
}
// Several vault entries can match a provider. Use the first whose grant passes the
// provider's own free-route check; undefined when none does.
export async function firstWorkingGrant<T extends FreeApiGrant>(
  references: readonly string[],
  grant: (reference: string) => Promise<T>,
  works: (grant: T) => Promise<boolean>,
  signal?: AbortSignal
): Promise<T | undefined>;
export async function firstWorkingGrant(
  references: readonly string[],
  grant: (reference: string) => Promise<unknown>,
  works: (grant: FreeApiGrant) => Promise<boolean>,
  signal?: AbortSignal
): Promise<FreeApiGrant | undefined>;
export async function firstWorkingGrant<T extends FreeApiGrant = FreeApiGrant>(
  references: readonly string[],
  grant: (reference: string) => Promise<unknown>,
  works: (grant: T) => Promise<boolean>,
  signal?: AbortSignal
): Promise<T | undefined> {
  for (const reference of references) {
    signal?.throwIfAborted();
    try {
      const raw = await grant(reference);
      const validated = validateProviderGrant(raw);
      const candidate = (raw && typeof raw === 'object' && !Array.isArray(raw)
        ? { ...(raw as Record<string, unknown>), ...validated }
        : validated) as T;
      const available = await works(candidate);
      signal?.throwIfAborted();
      if (available) return candidate;
    } catch { signal?.throwIfAborted(); }
  }
  return undefined;
}
export async function readPrivateProviderGrantFile(provider: Provider, location: string): Promise<unknown> {
  const file = await openPrivateFile(join(location, `${name(provider)}.json`), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || !hasOwnerMode(stat, 0o600)) throw new Error('Unsafe private provider grant file');
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
  if (RECEIPT_PROVIDERS.has(id)) {
    const saved = await readPrivateProviderGrantFile(id, location);
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return saved;
    const record = saved as Record<string, unknown>;
    if (record.credential_source === 'vault') {
      if (record.token !== undefined || !isCredentialFingerprint(record.credential_sha256) || !vaulted) {
        throw new Error(`Invalid ${id} vault-backed verification receipt`);
      }
      if (credentialFingerprint(vaulted) !== record.credential_sha256) {
        throw new Error(`${id} verification receipt does not match the current local vault credential`);
      }
      return { ...record, base_url: vaulted.base_url, token: vaulted.token };
    }
    const access = validateProviderGrant(record);
    if (record.credential_sha256 !== undefined
      && (!isCredentialFingerprint(record.credential_sha256) || record.credential_sha256 !== credentialFingerprint(access))) {
      throw new Error(`${id} verification receipt does not match its saved credential`);
    }
    return record;
  }
  return readPrivateProviderGrantFile(id, location);
}
export async function writePrivateProviderGrant(provider: Provider, value: Record<string, unknown> | FreeApiGrant, location: string) {
  const temporary = join(location, `${name(provider)}.${randomUUID()}.tmp`);
  await mkdir(location, { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    await rename(temporary, join(location, `${provider}.json`));
  } finally { await rm(temporary, { force: true }); }
}

function declarativeProviderName(id: string): string {
  if (!ID_PATTERN.test(id) || knownAdapters.has(id) || disabledAdapters.has(id)) throw new Error('Invalid declarative provider');
  return id;
}

export function declarativeGrantAllowed(grant: FreeApiGrant, baseUrl: string): boolean {
  const expectedOrigin = safePublicHttpsOrigin(baseUrl);
  if (!expectedOrigin) return false;
  let url: URL;
  try { url = new URL(grant.base_url); } catch { return false; }
  if (url.origin === 'https://trusty-squire-api.fly.dev') {
    return /^\/v1\/egress\/g_[A-Za-z0-9_-]+$/.test(url.pathname);
  }
  return grant.base_url === expectedOrigin;
}

export async function readDeclarativeProviderGrant(id: string, location: string): Promise<unknown> {
  const valid = declarativeProviderName(id);
  const file = await openPrivateFile(join(location, `${valid}.json`), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || !hasOwnerMode(stat, 0o600)) throw new Error('Unsafe declarative provider grant file');
    return JSON.parse(await file.readFile('utf8'));
  } finally { await file.close(); }
}

export async function writeDeclarativeProviderGrant(id: string, value: FreeApiGrant, location: string) {
  const valid = declarativeProviderName(id);
  const temporary = join(location, `${valid}.${randomUUID()}.tmp`);
  await mkdir(location, { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    await rename(temporary, join(location, `${valid}.json`));
  } finally { await rm(temporary, { force: true }); }
}
