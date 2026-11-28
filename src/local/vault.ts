import { hasOwnerMode, openPrivateFile } from './private-file.js';
import { configRoot, gruntEnv } from '../brand.js';
import { createHash, randomUUID } from 'node:crypto';
import { constants, realpathSync } from 'node:fs';
import { lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

export const SQUIRE_EGRESS_ORIGIN = 'https://trusty-squire-api.fly.dev';
const MAX_VAULT_BYTES = 512 * 1024;
const VAULT_LOCK_TIMEOUT_MS = 10_000;
const TOKEN_PATTERN = /^[\x21-\x7e]{1,16384}$/;
const STRICT_EGRESS_PATH = /^\/v1\/egress\/g_[A-Za-z0-9_-]{16,64}\/?$/;
const COMPAT_EGRESS_PATH = /^\/v1\/egress\/g_[A-Za-z0-9_-]+\/?$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;

/**
 * Exact pinned HTTPS origins each provider's local vault key is allowed to call
 * for inference. Keeping this allowlist strict prevents a misconfigured or
 * tampered grant from sending a provider API key to an untrusted host.
 */
export const PROVIDER_DIRECT_ORIGINS = {
  beatapi: ['https://api.beatapi.io'],
  pollinations: ['https://gen.pollinations.ai'],
  zro: ['https://zro.moonmath.ai'],
  tokenharbor: ['https://tokenharbor.ai'],
  runcrate: ['https://api.runcrate.ai'],
  nvidia: ['https://integrate.api.nvidia.com'],
  kilo: ['https://api.kilo.ai', 'https://ai-gateway.kilo.ai'],
  kenari: ['https://kenari.id'],
  numes: ['https://api.numes.ai'],
  goedel: ['https://api.goedelmachines.com'],
  crowllm: ['https://crowllm.com'],
  fikra: ['https://api.fikraapi.co.ke'],
  openference: ['https://api.openference.com'],
  darus: ['https://gateway.darusalfatah.id'],
  'aperture-ai': ['https://www.aperture-ai.run', 'https://aperture-ai.run'],
  millionseek: ['https://100milionseek.top'],
  ifm: ['https://api.ifm.ai'],
  groq: ['https://api.groq.com'],
  cerebras: ['https://api.cerebras.ai']
} as const satisfies Record<string, readonly string[]>;

/**
 * Exact pinned HTTPS origins a provider's local vault key is allowed to call
 * for read-only billing/account verification when the provider hosts its
 * billing API on a dedicated first-party origin separate from its inference
 * host (for example, Runcrate's Infrastructure/Billing API at
 * https://www.runcrate.ai/api/v1 per https://www.runcrate.ai/openapi.json,
 * authenticated with the same ApiKeyAuth Bearer rc_live_* token).
 */
export const PROVIDER_VERIFICATION_ORIGINS: Partial<Record<VaultProvider, readonly string[]>> = {
  runcrate: ['https://www.runcrate.ai']
};

export type VaultProvider = keyof typeof PROVIDER_DIRECT_ORIGINS;
export type VaultEntrySource = 'local' | 'squire' | 'import';

export interface VaultEntry {
  api_key: string;
  origin: string;
  source: VaultEntrySource;
  updated_at: string;
}

export interface VaultEntrySummary {
  provider: VaultProvider;
  origin: string;
  source: VaultEntrySource | 'env';
  updated_at?: string;
}

export interface DirectVaultGrant {
  base_url: string;
  token: string;
  source: VaultEntrySource | 'env';
}

interface VaultStore {
  version: 1;
  providers: Partial<Record<VaultProvider, VaultEntry>>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export function isVaultProvider(value: string): value is VaultProvider {
  return Object.hasOwn(PROVIDER_DIRECT_ORIGINS, value);
}

export function assertVaultProvider(value: string): VaultProvider {
  if (!isVaultProvider(value)) throw new Error('Unsupported local vault provider');
  return value;
}

export function providerDirectOrigins(provider: VaultProvider): readonly string[] {
  return PROVIDER_DIRECT_ORIGINS[assertVaultProvider(provider)];
}

export function providerVerificationOrigins(provider: VaultProvider): readonly string[] {
  return PROVIDER_VERIFICATION_ORIGINS[assertVaultProvider(provider)] ?? [];
}

export function providerAllowedRequestOrigins(provider: VaultProvider): readonly string[] {
  const id = assertVaultProvider(provider);
  return [...new Set([...providerDirectOrigins(id), ...providerVerificationOrigins(id)])];
}

export function defaultProviderOrigin(provider: VaultProvider): string {
  return providerDirectOrigins(provider)[0]!;
}

export function vaultPath(directory = configRoot()): string {
  return join(directory, 'vault.json');
}

export function vaultLockPath(directory = configRoot()): string {
  return join(directory, '.vault-lock.db');
}

export function isCredentialFingerprint(value: unknown): value is string {
  return typeof value === 'string' && SHA256_HEX.test(value);
}

/**
 * Cryptographic fingerprint binding a verification receipt to the exact
 * normalized origin and credential secret without storing the secret itself.
 */
export function credentialFingerprint(grant: { base_url: string; token: string }): string {
  return createHash('sha256')
    .update(`${grant.base_url.replace(/\/$/, '')}\0${grant.token}`)
    .digest('hex');
}

const envSlug = (provider: VaultProvider) => provider.toUpperCase().replace(/-/g, '_');

export function vaultEnvKeyName(provider: VaultProvider): string {
  return `GRUNT_VAULT_${envSlug(assertVaultProvider(provider))}_KEY`;
}

export function vaultEnvOriginName(provider: VaultProvider): string {
  return `GRUNT_VAULT_${envSlug(assertVaultProvider(provider))}_ORIGIN`;
}

export function validateVaultToken(value: unknown): string {
  if (typeof value !== 'string' || !TOKEN_PATTERN.test(value)) {
    throw new Error('Invalid local vault API key');
  }
  return value;
}

/**
 * Validates that a direct base URL is HTTPS, carries no userinfo/query/fragment
 * or injected path, and exactly matches one of the provider's pinned origins.
 */
export function validateDirectOrigin(provider: VaultProvider, baseUrl: string): string {
  const allowed = providerDirectOrigins(provider);
  if (typeof baseUrl !== 'string' || /[?#]/.test(baseUrl)) {
    throw new Error(`Untrusted direct HTTPS origin for ${provider}`);
  }
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw new Error(`Untrusted direct HTTPS origin for ${provider}`); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
    || (url.pathname !== '' && url.pathname !== '/')
    || !allowed.includes(url.origin)) {
    throw new Error(`Untrusted direct HTTPS origin for ${provider}`);
  }
  return url.origin;
}

/**
 * Validates that a read-only billing/account verification origin is HTTPS,
 * carries no userinfo/query/fragment or injected path, and exactly matches one
 * of the provider's vault-pinned verification origins.
 */
export function validateVerificationOrigin(provider: VaultProvider, baseUrl: string): string {
  const allowed = providerVerificationOrigins(provider);
  if (typeof baseUrl !== 'string' || /[?#]/.test(baseUrl)) {
    throw new Error(`Untrusted verification HTTPS origin for ${provider}`);
  }
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw new Error(`Untrusted verification HTTPS origin for ${provider}`); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
    || (url.pathname !== '' && url.pathname !== '/')
    || !allowed.includes(url.origin)) {
    throw new Error(`Untrusted verification HTTPS origin for ${provider}`);
  }
  return url.origin;
}

/**
 * Validates an outbound direct or billing-verification request URL against the
 * provider's strict vault origin allowlist before attaching a bearer token.
 */
export function validateProviderRequestUrl(
  provider: VaultProvider,
  rawUrl: string,
  scope: 'direct' | 'verification'
): string {
  if (typeof rawUrl !== 'string' || /#/.test(rawUrl)) {
    throw new Error(`Untrusted ${scope} request URL for ${provider}`);
  }
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new Error(`Untrusted ${scope} request URL for ${provider}`); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new Error(`Untrusted ${scope} request URL for ${provider}`);
  }
  if (scope === 'direct') validateDirectOrigin(provider, url.origin);
  else validateVerificationOrigin(provider, url.origin);
  return url.href;
}

export function isSquireEgressEndpoint(baseUrl: string, strictLength = true): boolean {
  if (typeof baseUrl !== 'string' || /[?#]/.test(baseUrl)) return false;
  let url: URL;
  try { url = new URL(baseUrl); } catch { return false; }
  const pattern = strictLength ? STRICT_EGRESS_PATH : COMPAT_EGRESS_PATH;
  return url.origin === SQUIRE_EGRESS_ORIGIN
    && !url.username && !url.password && !url.search && !url.hash
    && pattern.test(url.pathname);
}

/**
 * Validates either a pinned direct HTTPS provider origin or a backwards-compatible
 * Trusty Squire egress grant URL. Rejects all other origins, schemes, paths, or
 * credential-bearing URLs.
 */
export function validateProviderEndpoint(
  provider: VaultProvider,
  baseUrl: string,
  options: { strictEgressLength?: boolean } = {}
): { base_url: string; transport: 'direct' | 'egress' } {
  const strictLength = options.strictEgressLength ?? true;
  if (typeof baseUrl !== 'string' || /[?#]/.test(baseUrl)) {
    throw new Error(`Invalid endpoint for ${provider}`);
  }
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw new Error(`Invalid endpoint for ${provider}`); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error(`Invalid endpoint for ${provider}`);
  }
  if (url.origin === SQUIRE_EGRESS_ORIGIN) {
    const pattern = strictLength ? STRICT_EGRESS_PATH : COMPAT_EGRESS_PATH;
    if (!pattern.test(url.pathname)) throw new Error(`Invalid egress endpoint for ${provider}`);
    return { base_url: url.href.replace(/\/$/, ''), transport: 'egress' };
  }
  return { base_url: validateDirectOrigin(provider, baseUrl), transport: 'direct' };
}

async function assertPrivateDirectory(directory: string, create = false): Promise<void> {
  if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !hasOwnerMode(stat, 0o700)) {
    throw new Error('Unsafe local vault directory');
  }
}

function parseVaultEntry(provider: VaultProvider, value: unknown): VaultEntry {
  if (!isRecord(value)) throw new Error('Invalid local vault entry');
  const api_key = validateVaultToken(value.api_key);
  const origin = validateDirectOrigin(provider, typeof value.origin === 'string' ? value.origin : '');
  const source = value.source;
  if (source !== 'local' && source !== 'squire' && source !== 'import') {
    throw new Error('Invalid local vault entry');
  }
  const updated_at = value.updated_at;
  if (typeof updated_at !== 'string' || !Number.isFinite(Date.parse(updated_at))) {
    throw new Error('Invalid local vault entry');
  }
  return { api_key, origin, source, updated_at };
}

async function readVaultStore(directory = configRoot()): Promise<VaultStore | undefined> {
  let file;
  try {
    file = await openPrivateFile(vaultPath(directory), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    throw new Error('Unsafe local vault file');
  }
  try {
    await assertPrivateDirectory(directory, false);
    const stat = await file.stat();
    if (!stat.isFile() || !hasOwnerMode(stat, 0o600) || stat.size > MAX_VAULT_BYTES) {
      throw new Error('Unsafe local vault file');
    }
    const raw: unknown = JSON.parse(await file.readFile('utf8'));
    if (!isRecord(raw) || raw.version !== 1 || !isRecord(raw.providers)) {
      throw new Error('Invalid local vault format');
    }
    const providers: Partial<Record<VaultProvider, VaultEntry>> = {};
    for (const [key, entry] of Object.entries(raw.providers)) {
      if (!isVaultProvider(key)) throw new Error('Invalid local vault format');
      providers[key] = parseVaultEntry(key, entry);
    }
    return { version: 1, providers };
  } catch (error) {
    if (error instanceof Error && (error.message.startsWith('Unsafe local vault') || error.message.startsWith('Invalid local vault') || error.message.startsWith('Untrusted direct'))) {
      throw error;
    }
    throw new Error('Invalid local vault format');
  } finally {
    await file.close();
  }
}

const writeQueues = new Map<string, Promise<unknown>>();

function isSqliteBusy(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = String((error as { code?: unknown }).code ?? '');
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED') return true;
  const message = error instanceof Error ? error.message : '';
  return /\bSQLITE_(?:BUSY|LOCKED)\b/.test(message);
}

function lockQueueKey(directory: string): string {
  const absolute = resolve(directory);
  try {
    return realpathSync(absolute);
  } catch {
    const parts: string[] = [];
    let current = absolute;
    while (true) {
      const parent = dirname(current);
      if (parent === current) return absolute;
      parts.unshift(basename(current));
      current = parent;
      try {
        return join(realpathSync(current), ...parts);
      } catch { /* Continue walking to an existing ancestor. */ }
    }
  }
}

async function ensurePrivateLockFile(lockPath: string): Promise<void> {
  try {
    const created = await openPrivateFile(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await created.close();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST') throw new Error('Unsafe local vault lockfile');
  }
  let handle;
  try {
    handle = await openPrivateFile(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || !hasOwnerMode(stat, 0o600)) {
      throw new Error('Unsafe local vault lockfile');
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'Unsafe local vault lockfile') throw error;
    throw new Error('Unsafe local vault lockfile');
  } finally {
    await handle?.close();
  }
}

/**
 * Acquires an OS-managed process lock backed by SQLite's write transaction on
 * a private mode-0600 lock database. The OS releases the lock automatically on
 * process exit or crash (including SIGKILL), so contenders never unlink another
 * owner's lockfile or evict a live owner by age.
 */
async function withVaultFileLock<T>(
  directory: string,
  work: () => Promise<T>,
  timeoutMs = VAULT_LOCK_TIMEOUT_MS,
  lockPath = vaultLockPath(directory)
): Promise<T> {
  await assertPrivateDirectory(directory, true);
  await ensurePrivateLockFile(lockPath);

  const { createClient } = await import('@libsql/client');
  const db = createClient({ url: pathToFileURL(lockPath).href, concurrency: 1 });
  const deadline = Date.now() + timeoutMs;
  let transaction: Awaited<ReturnType<typeof db.transaction>> | undefined;
  let busyTimeoutSet = false;

  try {
    while (!transaction) {
      try {
        if (!busyTimeoutSet) {
          await db.execute('PRAGMA busy_timeout=0');
          busyTimeoutSet = true;
        }
        transaction = await db.transaction('write');
      } catch (error) {
        if (!isSqliteBusy(error)) throw error;
        if (Date.now() >= deadline) {
          throw new Error('Timed out waiting for local Grunt vault lock');
        }
        await delay(10 + Math.floor(Math.random() * 15));
      }
    }

    try {
      return await work();
    } finally {
      try {
        await transaction.rollback();
      } finally {
        transaction.close();
      }
    }
  } finally {
    db.close();
  }
}

function serializeWrite<T>(directory: string, work: () => Promise<T>, timeoutMs = VAULT_LOCK_TIMEOUT_MS): Promise<T> {
  const key = lockQueueKey(directory);
  const previous = writeQueues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(() => withVaultFileLock(directory, work, timeoutMs));
  writeQueues.set(key, next);
  void next.finally(() => {
    if (writeQueues.get(key) === next) writeQueues.delete(key);
  }).catch(() => {});
  return next;
}

// The same OS-released process lock on a separate lock database, for a multi-step
// update that itself writes the vault (so it cannot hold the vault lock).
export function withNamedLock<T>(directory: string, name: string, work: () => Promise<T>, options: { timeoutMs?: number } = {}): Promise<T> {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error('Invalid lock name');
  const key = `${lockQueueKey(directory)}#${name}`;
  const previous = writeQueues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(() => withVaultFileLock(directory, work, options.timeoutMs ?? VAULT_LOCK_TIMEOUT_MS, join(directory, `.${name}-lock.db`)));
  writeQueues.set(key, next);
  void next.finally(() => {
    if (writeQueues.get(key) === next) writeQueues.delete(key);
  }).catch(() => {});
  return next;
}

export function withVaultLock<T>(
  directory: string,
  work: () => Promise<T>,
  options: { timeoutMs?: number } = {}
): Promise<T> {
  return serializeWrite(directory, work, options.timeoutMs ?? VAULT_LOCK_TIMEOUT_MS);
}

async function persistVaultStore(store: VaultStore, directory: string): Promise<void> {
  await assertPrivateDirectory(directory, true);
  const temporary = join(directory, `.vault-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(store, null, 2), { flag: 'wx', mode: 0o600 });
    await rename(temporary, vaultPath(directory));
  } finally {
    await rm(temporary, { force: true });
  }
}

export function readVaultEnvGrant(
  provider: VaultProvider,
  env: NodeJS.ProcessEnv = process.env
): DirectVaultGrant | undefined {
  const id = assertVaultProvider(provider);
  const slug = envSlug(id);
  const rawKey = gruntEnv(`VAULT_${slug}_KEY`, env);
  if (rawKey === undefined || rawKey === '') return undefined;
  const token = validateVaultToken(rawKey);
  const rawOrigin = gruntEnv(`VAULT_${slug}_ORIGIN`, env);
  const base_url = validateDirectOrigin(id, rawOrigin || defaultProviderOrigin(id));
  return { base_url, token, source: 'env' };
}

export async function readVaultEntry(
  provider: VaultProvider,
  directory = configRoot()
): Promise<VaultEntry | undefined> {
  const id = assertVaultProvider(provider);
  const store = await readVaultStore(directory);
  return store?.providers[id];
}

/**
 * Resolves a direct HTTPS grant for a provider from environment overrides first,
 * then the local mode-0600 Grunt vault file. Returns undefined when neither is
 * configured; throws on unsafe permissions or untrusted origins.
 */
export async function readVaultGrant(
  provider: VaultProvider,
  directory = configRoot(),
  env: NodeJS.ProcessEnv = process.env
): Promise<DirectVaultGrant | undefined> {
  const id = assertVaultProvider(provider);
  const fromEnv = readVaultEnvGrant(id, env);
  if (fromEnv) return fromEnv;
  const entry = await readVaultEntry(id, directory);
  if (!entry) return undefined;
  return { base_url: entry.origin, token: entry.api_key, source: entry.source };
}

export async function writeVaultEntry(
  provider: VaultProvider,
  input: { api_key: string; origin?: string; source?: VaultEntrySource },
  directory = configRoot()
): Promise<VaultEntrySummary> {
  const id = assertVaultProvider(provider);
  const api_key = validateVaultToken(input.api_key);
  const origin = validateDirectOrigin(id, input.origin ?? defaultProviderOrigin(id));
  const source: VaultEntrySource = input.source ?? 'local';
  const updated_at = new Date().toISOString();
  await serializeWrite(directory, async () => {
    await assertPrivateDirectory(directory, true);
    const store = (await readVaultStore(directory)) ?? { version: 1 as const, providers: {} };
    store.providers[id] = { api_key, origin, source, updated_at };
    await persistVaultStore(store, directory);
  });
  return { provider: id, origin, source, updated_at };
}

export async function deleteVaultEntry(
  provider: VaultProvider,
  directory = configRoot()
): Promise<boolean> {
  const id = assertVaultProvider(provider);
  return serializeWrite(directory, async () => {
    const store = await readVaultStore(directory);
    if (!store || !store.providers[id]) return false;
    delete store.providers[id];
    await persistVaultStore(store, directory);
    return true;
  });
}

/**
 * Lists metadata only for local vault entries and active vault env overrides.
 * Never returns API keys or tokens.
 */
export async function listVaultEntries(
  directory = configRoot(),
  env: NodeJS.ProcessEnv = process.env
): Promise<VaultEntrySummary[]> {
  const store = await readVaultStore(directory);
  const summaries = new Map<VaultProvider, VaultEntrySummary>();
  for (const [key, entry] of Object.entries(store?.providers ?? {})) {
    if (!isVaultProvider(key) || !entry) continue;
    summaries.set(key, {
      provider: key,
      origin: entry.origin,
      source: entry.source,
      updated_at: entry.updated_at
    });
  }
  for (const provider of Object.keys(PROVIDER_DIRECT_ORIGINS) as VaultProvider[]) {
    const fromEnv = readVaultEnvGrant(provider, env);
    if (fromEnv) {
      summaries.set(provider, {
        provider,
        origin: fromEnv.base_url,
        source: 'env'
      });
    }
  }
  return [...summaries.values()].sort((a, b) => a.provider.localeCompare(b.provider));
}

/**
 * Extracts a single API key field from a Squire credential payload without
 * logging or echoing the secret.
 */
export function extractCredentialSecret(
  fields: Record<string, unknown>,
  provider: string
): string | undefined {
  const prefix = provider.toLowerCase().replace(/[^a-z0-9]/g, '');
  const entries = Object.entries(fields).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string' && TOKEN_PATTERN.test(entry[1])
  );
  const match = entries.find(([field]) => {
    const normalized = field.toLowerCase().replace(/[^a-z0-9]/g, '');
    const stripped = normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized;
    return ['apikey', 'key', 'token', 'value', 'secret', 'apitoken', 'accesstoken'].includes(stripped);
  });
  if (match) return match[1];
  return entries.length === 1 ? entries[0]![1] : undefined;
}

/**
 * Redacts explicit secret values and common bearer/key patterns from text
 * before writing diagnostics or terminal output.
 */
export function redactVaultSecrets(text: string, secrets: readonly string[] = []): string {
  let sanitized = text;
  const literal = [...new Set(secrets.filter(value => typeof value === 'string' && value.length >= 4))]
    .sort((a, b) => b.length - a.length);
  for (const secret of literal) {
    sanitized = sanitized.split(secret).join('[redacted]');
  }
  return sanitized
    .replace(/\b(?:Bearer|Basic)\s+\S+/gi, '[redacted]')
    .replace(/(https?:\/\/)[^/\s@]+@/gi, '$1[redacted]@')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|sk_[A-Za-z0-9_-]{8,}|gsk_[A-Za-z0-9_-]{8,}|nvapi-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_+/.=-]{16,})/g, '[redacted]');
}
