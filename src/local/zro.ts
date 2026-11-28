import { hasOwnerMode, openPrivateFile } from './private-file.js';
import { configRoot } from '../brand.js';
import { constants } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { FreeApi, isDeepSeekV41Model } from './free-api.js';
import type { FreeApiGrant } from './free-api.js';
import { verifiedDeepSeekFetch } from './deepseek-response.js';
import { SourceError } from './source.js';
import type { ModelRequest, Source } from './source.js';
import { credentialFingerprint, isCredentialFingerprint, readVaultGrant, validateDirectOrigin } from './vault.js';

export const ZRO_STORE = { service: 'zro', label: 'grunt', api_hosts: ['zro.moonmath.ai'], auth_shape: 'bearer' };
export const ZRO_DEEPSEEK = 'deepseek-v4.1-flash';
export interface ZroGrant extends FreeApiGrant {
  free_account_verified: true;
  verified_at: string;
  credential_sha256?: string;
}
const directory = () => configRoot();
function validate(value: unknown): ZroGrant {
  const grant = value as Partial<ZroGrant> | null;
  if (!grant || typeof grant.base_url !== 'string' || typeof grant.token !== 'string' || !grant.token.trim()
    || grant.free_account_verified !== true || typeof grant.verified_at !== 'string' || !Number.isFinite(Date.parse(grant.verified_at))) throw new Error('Zro free account verification is missing');
  const url = new URL(grant.base_url);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Invalid Zro grant endpoint');
  const base_url = grant.base_url.replace(/\/$/, '');
  const expected = credentialFingerprint({ base_url, token: grant.token });
  if (grant.credential_sha256 !== undefined && (!isCredentialFingerprint(grant.credential_sha256) || grant.credential_sha256 !== expected)) {
    throw new Error('Zro free account verification does not match the current credential');
  }
  return { base_url, token: grant.token, free_account_verified: true, verified_at: grant.verified_at, credential_sha256: expected };
}
export async function readZroGrant(location = directory(), env: NodeJS.ProcessEnv = process.env): Promise<ZroGrant> {
  const file = await openPrivateFile(join(location, 'zro.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || !hasOwnerMode(stat, 0o600)) throw new Error('Unsafe Zro grant file');
    const raw = JSON.parse(await file.readFile('utf8')) as Record<string, unknown>;
    const vaulted = await readVaultGrant('zro', location, env);
    if (raw && typeof raw === 'object' && !Array.isArray(raw) && raw.credential_source === 'vault') {
      // While setup swaps in a verified replacement, the receipt also names the key it
      // replaces, so the daemon can load whichever of the two verified keys the vault holds.
      const current = vaulted ? credentialFingerprint(vaulted) : undefined;
      const previous = isCredentialFingerprint(raw.previous_sha256) && raw.previous_sha256 === current ? current : undefined;
      if (raw.token !== undefined || !isCredentialFingerprint(raw.credential_sha256) || !vaulted
        || (current !== raw.credential_sha256 && previous === undefined)) {
        throw new Error('Zro free account verification is missing');
      }
      const { previous_sha256: _previous, ...receipt } = raw;
      return validate({ ...receipt, ...(previous ? { credential_sha256: previous } : {}), base_url: vaulted.base_url, token: vaulted.token });
    }
    const saved = validate(raw);
    if (vaulted && credentialFingerprint(vaulted) !== saved.credential_sha256) {
      throw new Error('Zro free account verification does not match the current credential');
    }
    return saved;
  } finally { await file.close(); }
}
// Called after Squire has confirmed Free plan, no purchased balance and no payment method.
// This is a setup receipt, not a guarantee that an externally upgraded account stays free.
export async function writeZroGrant(grant: FreeApiGrant, location = directory(), env: NodeJS.ProcessEnv = process.env) {
  const value = validate({ ...grant, free_account_verified: true, verified_at: new Date().toISOString() });
  const fingerprint = value.credential_sha256!;
  let isDirect = false;
  try { validateDirectOrigin('zro', value.base_url); isDirect = true; } catch { /* Legacy egress or test URL. */ }
  const vaulted = isDirect ? await readVaultGrant('zro', location, env).catch(() => undefined) : undefined;
  const persisted = isDirect && vaulted && credentialFingerprint(vaulted) === fingerprint
    ? { base_url: value.base_url, credential_source: 'vault', credential_sha256: fingerprint, free_account_verified: true, verified_at: value.verified_at }
    : value;
  await persistReceipt(persisted, location);
}
// First step of replacing the local vault key with a verified one: a vault receipt
// that accepts either the installed key or its replacement. Setup then writes the
// vault entry and the final receipt. Stopping after any step leaves the daemon a
// key it can load: the installed key before the vault write, the replacement after.
// `installed` is carried forward only when the current receipt verifies it; otherwise
// the receipt names the replacement alone and never authorizes an unverified key.
export async function writeZroReplacementReceipt(replacement: FreeApiGrant, installed: FreeApiGrant | undefined, location = directory()) {
  const value = validate({ ...replacement, free_account_verified: true, verified_at: new Date().toISOString() });
  validateDirectOrigin('zro', value.base_url);
  await persistReceipt({ base_url: value.base_url, credential_source: 'vault', credential_sha256: value.credential_sha256,
    ...(installed ? { previous_sha256: credentialFingerprint(installed) } : {}), free_account_verified: true, verified_at: value.verified_at }, location);
}
async function persistReceipt(persisted: unknown, location: string) {
  const temporary = join(location, `zro.${randomUUID()}.tmp`);
  await mkdir(location, { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporary, JSON.stringify(persisted), { mode: 0o600, flag: 'wx' });
    await rename(temporary, join(location, 'zro.json'));
  } finally { await rm(temporary, { force: true }); }
}
export class Zro implements Source {
  readonly inferenceOnly = true;
  readonly id = 'zro';
  readonly availabilityTimeoutMs = 30000;
  readonly supportsFunctionTools = true;
  private source: FreeApi;
  constructor(private options: { directory?: string; fetcher?: typeof fetch; timeout?: number; loadGrant?: () => Promise<ZroGrant> } = {}) {
    this.source = new FreeApi('zro', { ...options, fetcher: verifiedDeepSeekFetch(options.fetcher), verifyModel: isDeepSeekV41Model, loadGrant: () => this.grant() });
  }
  private grant() { return (this.options.loadGrant?.() ?? readZroGrant(this.options.directory)).then(validate); }
  // Availability checks only verified local grant presence; passive request
  // observations and explicit healthCheck() detect externally paused keys
  // without burning live chat completions every 30s.
  async available(signal?: AbortSignal) {
    signal?.throwIfAborted();
    try {
      await this.grant();
      signal?.throwIfAborted();
      return true;
    } catch {
      signal?.throwIfAborted();
      return false;
    }
  }
  // Explicit recovery/maintenance probe: Zro still lists models for a paused key.
  async healthCheck(signal?: AbortSignal) {
    try {
      await this.source.complete({ model: this.id, cwd: this.options.directory ?? directory(), messages: [{ role: 'user', content: 'Reply with one word: ready' }],
        tools: [], stream: false, maxTokens: 16 }, AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(this.availabilityTimeoutMs)]));
      signal?.throwIfAborted();
      return true;
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof SourceError && error.code === 'quota') throw error;
      return false;
    }
  }
  complete(request: ModelRequest, signal: AbortSignal, output?: () => void) {
    // Router aliases select this source; they never select another upstream model.
    return this.source.complete({ ...request, model: this.id }, signal, output);
  }
  async close() { await this.source.close(); }
}
