import { diagnosticFetch } from './diagnostics.js';
import { FreeApi } from './free-api.js';
import type { FreeApiGrant } from './free-api.js';
import { verifiedDeepSeekFetch } from './deepseek-response.js';
import { readDataSharingConsent } from './data-sharing.js';
import { providerGrantDirectory, readPrivateProviderGrant, validateProviderGrant, writePrivateProviderGrant } from './provider-grant.js';
import {
  credentialFingerprint,
  isCredentialFingerprint,
  providerDirectOrigins,
  providerVerificationOrigins,
  readVaultGrant,
  validateDirectOrigin,
  validateProviderRequestUrl
} from './vault.js';
import { SourceError } from './source.js';
import type { ModelRequest, Source } from './source.js';

export const RUNCRATE_DEEPSEEK = 'deepseek-ai/DeepSeek-V4.1-Flash';
export const RUNCRATE_ORIGIN = providerDirectOrigins('runcrate')[0]!;
export const RUNCRATE_BILLING_ORIGIN = providerVerificationOrigins('runcrate')[0]!;
export interface RuncrateVerification {
  free_account_verified: true;
  key_topups_disabled: true;
  credential_sha256: string;
  verified_at: string;
}
export interface RuncrateGrantContext {
  reference?: string;
  secretPlaceholder?: string;
}
export type RuncrateGrantVerifier = (
  grant: FreeApiGrant,
  signal?: AbortSignal,
  context?: RuncrateGrantContext
) => Promise<RuncrateVerification> | RuncrateVerification;
export interface RuncrateSquireCaller {
  call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
}
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
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function unwrapObject(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  return isRecord(value.data) ? value.data : value;
}

async function fetchRuncrateJson(
  fetcher: typeof fetch,
  operation: 'account' | 'models',
  label: string,
  url: string,
  token: string,
  signal: AbortSignal,
  options: { rejectAuthStatuses?: readonly number[] } = {}
): Promise<unknown> {
  let response: Response;
  try {
    response = await diagnosticFetch(fetcher, 'runcrate', operation)(url, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: 'error',
      signal
    });
  } catch (error) {
    signal.throwIfAborted();
    throw new RuncrateVerificationError(
      error instanceof Error ? `Runcrate verification failed: ${error.message}` : 'Runcrate verification request failed'
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    if (options.rejectAuthStatuses?.includes(response.status)) {
      throw new SourceError(
        response.status === 401 ? 'logged_out' : 'refused',
        `runcrate returned HTTP ${response.status}`,
        undefined,
        undefined,
        { httpStatus: response.status, transport: 'http', httpMethod: 'GET', endpointLabel: operation }
      );
    }
    throw new RuncrateVerificationError(`Runcrate ${label} verification returned HTTP ${response.status}`);
  }
  try {
    return await response.json();
  } catch {
    throw new RuncrateVerificationError(`Runcrate ${label} verification returned invalid JSON`);
  }
}

async function fetchRuncrateSquireBillingJson(
  squire: RuncrateSquireCaller,
  reference: string,
  secretPlaceholder: string,
  label: string,
  url: string,
  signal: AbortSignal
): Promise<unknown> {
  const validatedUrl = validateProviderRequestUrl('runcrate', url, 'verification');
  signal.throwIfAborted();
  let rawResult: Record<string, unknown>;
  try {
    rawResult = await squire.call('use_credential', {
      reference,
      http: {
        method: 'GET',
        url: validatedUrl,
        headers: { Authorization: `Bearer ${secretPlaceholder}` }
      }
    });
  } catch (error) {
    signal.throwIfAborted();
    throw new RuncrateVerificationError(
      error instanceof Error ? `Runcrate Squire ${label} verification failed: ${error.message}` : `Runcrate Squire ${label} verification failed`
    );
  }
  signal.throwIfAborted();
  const response = isRecord(rawResult.response) ? rawResult.response : undefined;
  const status = typeof response?.status === 'number' && Number.isInteger(response.status) ? response.status : undefined;
  const body = typeof response?.body === 'string' ? response.body : undefined;
  if (status === undefined || body === undefined || response?.truncated === true) {
    throw new RuncrateVerificationError(`Runcrate Squire ${label} verification returned an invalid response`);
  }
  if (status === 401) {
    throw new SourceError('logged_out', 'runcrate returned HTTP 401', undefined, undefined, {
      httpStatus: 401,
      transport: 'http',
      httpMethod: 'GET',
      endpointLabel: 'account'
    });
  }
  if (status < 200 || status >= 300) {
    throw new RuncrateVerificationError(`Runcrate ${label} verification returned HTTP ${status}`);
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new RuncrateVerificationError(`Runcrate ${label} verification returned invalid JSON`);
  }
}

function assertRuncrateFreeBilling(balanceRaw: unknown, autoRechargeRaw: unknown, paymentMethodsRaw: unknown): void {
  const balance = unwrapObject(balanceRaw);
  if (!balance) throw new RuncrateVerificationError('Runcrate balance verification returned an invalid response');
  const balanceFields = ['creditsBalance', 'credits_balance', 'balance_usd', 'floating_balance_usd'] as const;
  const presentBalances = balanceFields.filter(field => balance[field] !== undefined);
  if (!presentBalances.length) {
    throw new RuncrateVerificationError('Runcrate balance verification did not report credit balance');
  }
  for (const field of [...balanceFields, 'activeUsageCost', 'active_usage_cost'] as const) {
    if (balance[field] !== undefined && (typeof balance[field] !== 'number' || !Number.isFinite(balance[field]) || balance[field] !== 0)) {
      throw new RuncrateVerificationError('Runcrate account has a non-zero paid balance or active paid usage');
    }
  }

  const autoRecharge = unwrapObject(autoRechargeRaw);
  if (!autoRecharge || autoRecharge.enabled !== false) {
    throw new RuncrateVerificationError('Runcrate automatic top-ups must be disabled before using this key');
  }

  const methods = Array.isArray(paymentMethodsRaw)
    ? paymentMethodsRaw
    : isRecord(paymentMethodsRaw) && Array.isArray(paymentMethodsRaw.payment_methods)
      ? paymentMethodsRaw.payment_methods
      : isRecord(paymentMethodsRaw) && Array.isArray(paymentMethodsRaw.paymentMethods)
        ? paymentMethodsRaw.paymentMethods
        : isRecord(paymentMethodsRaw) && Array.isArray(paymentMethodsRaw.data)
          ? paymentMethodsRaw.data
          : undefined;
  if (!methods || methods.length > 0) {
    throw new RuncrateVerificationError('Runcrate account must have no saved payment methods');
  }
}

function assertRuncrateFreeModel(modelsRaw: unknown): void {
  const models = isRecord(modelsRaw) && Array.isArray(modelsRaw.data) ? modelsRaw.data : [];
  if (!models.some(model => isRecord(model) && model.id === RUNCRATE_DEEPSEEK)) {
    throw new RuncrateVerificationError(`Runcrate key does not have access to ${RUNCRATE_DEEPSEEK}`);
  }
}

/**
 * Verifies a direct local-vault Runcrate API key against Runcrate's
 * vault-pinned Infrastructure/Billing origin (https://www.runcrate.ai/api/v1,
 * per https://www.runcrate.ai/openapi.json ApiKeyAuth) and pinned inference
 * origin (https://api.runcrate.ai/v1/models), proving zero prepaid credit
 * balance, zero saved payment methods, disabled auto-recharge/top-ups, and
 * availability of the pinned free DeepSeek model for that exact credential.
 */
export async function verifyRuncrateDirectGrant(
  grant: FreeApiGrant,
  options: { fetcher?: typeof fetch; signal?: AbortSignal } = {}
): Promise<RuncrateVerification> {
  const access = validateProviderGrant(grant);
  let origin: string;
  try {
    origin = validateDirectOrigin('runcrate', access.base_url);
  } catch {
    throw new RuncrateVerificationError('Runcrate direct verification requires the pinned Runcrate HTTPS origin');
  }
  const normalized = { base_url: origin, token: access.token };
  const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(15_000)]);
  const fetcher = options.fetcher ?? fetch;

  const balanceUrl = validateProviderRequestUrl('runcrate', `${RUNCRATE_BILLING_ORIGIN}/api/v1/billing/balance`, 'verification');
  const autoRechargeUrl = validateProviderRequestUrl('runcrate', `${RUNCRATE_BILLING_ORIGIN}/api/v1/billing/auto-recharge`, 'verification');
  const paymentMethodsUrl = validateProviderRequestUrl('runcrate', `${RUNCRATE_BILLING_ORIGIN}/api/v1/billing/payment-methods`, 'verification');
  const modelsUrl = validateProviderRequestUrl('runcrate', `${normalized.base_url}/v1/models`, 'direct');

  const balanceRaw = await fetchRuncrateJson(fetcher, 'account', 'billing_balance', balanceUrl, normalized.token, signal);
  const autoRechargeRaw = await fetchRuncrateJson(fetcher, 'account', 'billing_auto_recharge', autoRechargeUrl, normalized.token, signal);
  const paymentMethodsRaw = await fetchRuncrateJson(fetcher, 'account', 'billing_payment_methods', paymentMethodsUrl, normalized.token, signal);
  assertRuncrateFreeBilling(balanceRaw, autoRechargeRaw, paymentMethodsRaw);

  const modelsRaw = await fetchRuncrateJson(fetcher, 'models', 'models', modelsUrl, normalized.token, signal);
  assertRuncrateFreeModel(modelsRaw);

  return validateRuncrateVerification(normalized, {
    free_account_verified: true,
    key_topups_disabled: true,
    credential_sha256: credentialFingerprint(normalized),
    verified_at: new Date().toISOString()
  });
}

/**
 * Verifies a Trusty Squire Runcrate egress grant (initial or refreshed) by
 * checking Runcrate's billing endpoints through Squire's `use_credential` proxy
 * without ever exporting or forwarding the raw API key, then checking the
 * pinned free DeepSeek model through the egress grant itself.
 */
export async function verifyRuncrateSquireGrant(
  grant: FreeApiGrant,
  options: {
    squire?: Partial<RuncrateSquireCaller>;
    reference?: string;
    secretPlaceholder?: string;
    fetcher?: typeof fetch;
    signal?: AbortSignal;
  } = {}
): Promise<RuncrateVerification> {
  const access = validateProviderGrant(grant);
  if (typeof options.reference !== 'string' || !options.reference.trim() || typeof options.squire?.call !== 'function') {
    throw new RuncrateVerificationError('Runcrate Squire billing verification requires a Squire credential reference');
  }
  const squire: RuncrateSquireCaller = { call: options.squire.call.bind(options.squire) };
  const secretPlaceholder = options.secretPlaceholder ?? '${SECRET}';
  const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(15_000)]);
  const fetcher = options.fetcher ?? fetch;

  const balanceRaw = await fetchRuncrateSquireBillingJson(
    squire,
    options.reference,
    secretPlaceholder,
    'billing_balance',
    `${RUNCRATE_BILLING_ORIGIN}/api/v1/billing/balance`,
    signal
  );
  const autoRechargeRaw = await fetchRuncrateSquireBillingJson(
    squire,
    options.reference,
    secretPlaceholder,
    'billing_auto_recharge',
    `${RUNCRATE_BILLING_ORIGIN}/api/v1/billing/auto-recharge`,
    signal
  );
  const paymentMethodsRaw = await fetchRuncrateSquireBillingJson(
    squire,
    options.reference,
    secretPlaceholder,
    'billing_payment_methods',
    `${RUNCRATE_BILLING_ORIGIN}/api/v1/billing/payment-methods`,
    signal
  );
  assertRuncrateFreeBilling(balanceRaw, autoRechargeRaw, paymentMethodsRaw);

  const modelsRaw = await fetchRuncrateJson(
    fetcher,
    'models',
    'models',
    `${access.base_url}/v1/models`,
    access.token,
    signal,
    { rejectAuthStatuses: [401, 403] }
  );
  assertRuncrateFreeModel(modelsRaw);

  return validateRuncrateVerification(access, {
    free_account_verified: true,
    key_topups_disabled: true,
    credential_sha256: credentialFingerprint(access),
    verified_at: new Date().toISOString()
  });
}

function isWriteOptions(value: NodeJS.ProcessEnv | WriteRuncrateGrantOptions): value is WriteRuncrateGrantOptions {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return ('verification' in candidate && typeof candidate.verification !== 'string')
    || ('env' in candidate && typeof candidate.env !== 'string');
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
// Setup calls this only after confirming free access and disabled key top-ups.
// Both direct local-vault keys and Trusty Squire egress grants (initial or
// refreshed) require an explicit verification proof bound to the exact
// credential fingerprint before writing a receipt.
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
  try { validateDirectOrigin('runcrate', access.base_url); isDirect = true; } catch { /* Squire egress or test URL. */ }
  const verified = validateRuncrateVerification(access, options.verification);
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
