import { diagnosticFetch } from './diagnostics.js';
import { FreeApi } from './free-api.js';
import type { FreeApiGrant } from './free-api.js';
import { verifiedDeepSeekFetch } from './deepseek-response.js';
import { readDataSharingConsent } from './data-sharing.js';
import { providerGrantDirectory, readPrivateProviderGrant, readPrivateProviderGrantFile, validateProviderGrant, writePrivateProviderGrant } from './provider-grant.js';
import { credentialFingerprint, isCredentialFingerprint, readVaultGrant, validateDirectOrigin } from './vault.js';
import { SourceError } from './source.js';
import type { ModelRequest, Source } from './source.js';

export const RUNCRATE_DEEPSEEK = 'deepseek-ai/DeepSeek-V4.1-Flash';
export interface RuncrateVerification {
  free_account_verified: true;
  key_topups_disabled: true;
  credential_sha256: string;
  verified_at: string;
}
export type RuncrateGrantVerifier = (
  grant: FreeApiGrant,
  signal?: AbortSignal
) => Promise<RuncrateVerification> | RuncrateVerification;
export interface WriteRuncrateGrantOptions {
  env?: NodeJS.ProcessEnv;
  verification?: RuncrateVerification;
}
export class RuncrateVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuncrateVerificationError';
  }
}
export interface RuncrateGrant extends FreeApiGrant {
  free_account_verified: true;
  key_topups_disabled: true;
  verified_at: string;
  credential_sha256?: string;
}
export function validateRuncrateVerification(grant: FreeApiGrant, verification: unknown): RuncrateVerification {
  const access = validateProviderGrant(grant);
  const expected = credentialFingerprint(access);
  const proof = verification as Partial<RuncrateVerification> | null | undefined;
  if (!proof || typeof proof !== 'object' || Array.isArray(proof)
    || proof.free_account_verified !== true
    || proof.key_topups_disabled !== true
    || typeof proof.verified_at !== 'string'
    || !Number.isFinite(Date.parse(proof.verified_at))) {
    throw new RuncrateVerificationError('Runcrate free-account and top-ups-disabled verification is required before writing a receipt');
  }
  if (!isCredentialFingerprint(proof.credential_sha256) || proof.credential_sha256 !== expected) {
    throw new RuncrateVerificationError('Runcrate free-account and top-ups-disabled verification does not match the exact credential');
  }
  return {
    free_account_verified: true,
    key_topups_disabled: true,
    credential_sha256: expected,
    verified_at: proof.verified_at
  };
}
function isWriteOptions(value: NodeJS.ProcessEnv | WriteRuncrateGrantOptions): value is WriteRuncrateGrantOptions {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return ('verification' in candidate && typeof candidate.verification !== 'string')
    || ('env' in candidate && typeof candidate.env !== 'string');
}
async function readExistingReceiptFingerprint(location: string): Promise<{ exists: boolean; fingerprint?: string }> {
  try {
    const saved = await readPrivateProviderGrantFile('runcrate', location);
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return { exists: true };
    const record = saved as Record<string, unknown>;
    if (isCredentialFingerprint(record.credential_sha256)) {
      return { exists: true, fingerprint: record.credential_sha256 };
    }
    try {
      return { exists: true, fingerprint: credentialFingerprint(validateProviderGrant(record)) };
    } catch {
      return { exists: true };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false };
    return { exists: true };
  }
}
function validate(value: unknown): RuncrateGrant {
  const grant = value as Partial<RuncrateGrant> | null;
  const access = validateProviderGrant(value);
  if (grant?.free_account_verified !== true || grant.key_topups_disabled !== true || typeof grant.verified_at !== 'string'
    || !Number.isFinite(Date.parse(grant.verified_at))) throw new Error('Runcrate free account verification is missing');
  const expected = credentialFingerprint(access);
  if (grant.credential_sha256 !== undefined && (!isCredentialFingerprint(grant.credential_sha256) || grant.credential_sha256 !== expected)) {
    throw new Error('Runcrate free account verification does not match the current credential');
  }
  return {
    ...access,
    free_account_verified: true,
    key_topups_disabled: true,
    verified_at: grant.verified_at,
    credential_sha256: expected
  };
}
export async function readRuncrateGrant(
  location = providerGrantDirectory(),
  env: NodeJS.ProcessEnv = process.env
): Promise<RuncrateGrant> {
  return validate(await readPrivateProviderGrant('runcrate', location, env));
}
// Setup calls this only after confirming free access and disabling key top-ups.
// Direct vault keys and any replacement of an existing receipt require an explicit
// verification proof bound to the exact credential fingerprint.
// Like Zro's setup receipt, this does not freeze future account changes at Runcrate.
export async function writeRuncrateGrant(
  grant: FreeApiGrant,
  location = providerGrantDirectory(),
  optionsOrEnv: NodeJS.ProcessEnv | WriteRuncrateGrantOptions = process.env
) {
  const options = isWriteOptions(optionsOrEnv) ? optionsOrEnv : { env: optionsOrEnv };
  const env = options.env ?? process.env;
  const access = validateProviderGrant(grant);
  const fingerprint = credentialFingerprint(access);
  let isDirect = false;
  try { validateDirectOrigin('runcrate', access.base_url); isDirect = true; } catch { /* Legacy egress or test URL. */ }
  const existing = await readExistingReceiptFingerprint(location);
  const isReplacement = existing.exists && existing.fingerprint !== fingerprint;
  const verified = (isDirect || isReplacement || options.verification !== undefined)
    ? validateRuncrateVerification(access, options.verification)
    : {
      free_account_verified: true as const,
      key_topups_disabled: true as const,
      credential_sha256: fingerprint,
      verified_at: new Date().toISOString()
    };
  const value = validate({
    ...access,
    free_account_verified: verified.free_account_verified,
    key_topups_disabled: verified.key_topups_disabled,
    verified_at: verified.verified_at,
    credential_sha256: verified.credential_sha256
  });
  const vaulted = isDirect ? await readVaultGrant('runcrate', location, env).catch(() => undefined) : undefined;
  if (isDirect && vaulted && credentialFingerprint(vaulted) === fingerprint) {
    await writePrivateProviderGrant('runcrate', {
      base_url: value.base_url,
      credential_source: 'vault',
      credential_sha256: fingerprint,
      free_account_verified: true,
      key_topups_disabled: true,
      verified_at: value.verified_at
    }, location);
    return;
  }
  await writePrivateProviderGrant('runcrate', value, location);
}
export class Runcrate implements Source {
  readonly inferenceOnly = true;
  readonly id = 'runcrate';
  readonly supportsFunctionTools = true;
  private source: FreeApi;
  private location: string;
  constructor(private options: { directory?: string; fetcher?: typeof fetch; timeout?: number; loadGrant?: () => Promise<RuncrateGrant> } = {}) {
    this.location = options.directory ?? providerGrantDirectory();
    this.source = new FreeApi('runcrate', { ...options, fetcher: verifiedDeepSeekFetch(options.fetcher), loadGrant: () => this.grant() });
  }
  private approved = async () => (await readDataSharingConsent(this.location, [this.id])).includes(this.id);
  private grant() { return (this.options.loadGrant?.() ?? readRuncrateGrant(this.location)).then(validate); }
  async available() {
    if (!await this.approved()) return false;
    try {
      const grant = await this.grant();
      const response = await diagnosticFetch(this.options.fetcher ?? fetch, 'runcrate', 'models')(`${grant.base_url}/v1/models`, {
        headers: { Authorization: `Bearer ${grant.token}` }, redirect: 'error', signal: AbortSignal.timeout(5000)
      });
      if (!response.ok) { await response.body?.cancel(); return false; }
      const result = await response.json() as { data?: { id?: string }[] };
      return result.data?.some(model => model.id === RUNCRATE_DEEPSEEK) ?? false;
    } catch { return false; }
  }
  async healthCheck() { return this.available(); }
  async complete(request: ModelRequest, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!await this.approved()) throw new SourceError('refused', 'Runcrate data sharing is not approved; rerun usegrunt setup');
    return this.source.complete({ ...request, model: this.id }, signal);
  }
  async close() { await this.source.close(); }
}
