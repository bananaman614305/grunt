import { rm } from 'node:fs/promises';
import { DATA_SHARING_POLICIES, readDataSharingConsent } from './data-sharing.js';
import { BEATAPI_MODEL, BEATAPI_MODELS, BEATAPI_ORIGIN, beatapiGrantPath, readBeatAPIGrant, verifyBeatAPIAccess, verifyBeatAPIModelAccess, writeBeatAPIGrant } from './beatapi.js';
import type { BeatAPIGrant } from './beatapi.js';
interface Credential { service: string | null; reference: string; field_names: string[]; auth_strategy?: string | null; label?: string; allowed_hosts?: string[] }
export interface BeatAPISetupSquire {
  signup(service: string, url: string, goal: string): Promise<void>;
  call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  credentials: { list(): Promise<Credential[]>; grant(reference: string): Promise<{ base_url: string; token: string }> };
  approveDataSharing?(providers: readonly string[]): void;
}
export interface BeatAPISetupOptions { directory: string; squire: BeatAPISetupSquire; signal?: AbortSignal; dataSharingApproved?: readonly string[]; notify?(line: string): void; fetcher?: typeof fetch; background?: boolean; upgradeExisting?: boolean }
const failure = () => new Error('BeatAPI free account or key verification did not complete; rerun usegrunt setup');
const connected = 'BeatAPI: free-only DeepSeek V4.1 Flash and GLM 5.3 Flash connected; one successful request per minute across both models';
const deepseekOnly = 'BeatAPI: free DeepSeek V4.1 Flash connected; GLM 5.3 Flash is unavailable on this key';
async function bounded<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  let abort: (() => void) | undefined;
  try { return await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return operation(); }), new Promise<never>((_resolve, reject) => {
    abort = () => reject(failure()); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
  })]); } catch { throw failure(); } finally { if (abort) signal.removeEventListener('abort', abort); }
}
const ownedKey = (c: Credential) => typeof c?.service === 'string' && c.service.trim().toLowerCase() === 'beatapi'
  && c.label === 'grunt' && typeof c.reference === 'string' && Boolean(c.reference)
  && (c.auth_strategy == null || c.auth_strategy === 'api_key')
  && Array.isArray(c.field_names) && c.field_names.some(f => typeof f === 'string' && ['value', 'apikey', 'key', 'token', 'secret'].includes(f.toLowerCase().replace(/[^a-z]/g, '')))
  && Array.isArray(c.allowed_hosts) && c.allowed_hosts[0] === 'api.beatapi.io';
export async function setupBeatAPI(options: BeatAPISetupOptions): Promise<void> {
  // The caller may carry approvals already recorded by this wizard turn, but
  // an unknown or changed policy cannot silently inherit another provider's.
  if (!DATA_SHARING_POLICIES.some(policy => policy.provider === 'beatapi')) throw new Error('BeatAPI data-sharing policy is unavailable');
  const saved = await readDataSharingConsent(options.directory, ['beatapi']);
  if (!saved.includes('beatapi') || (options.dataSharingApproved && !options.dataSharingApproved.includes('beatapi'))) throw new Error('BeatAPI data sharing requires the current grouped setup approval');
  const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(600000)]);
  const guards = { ...(options.fetcher ? { fetcher: options.fetcher } : {}), signal };
  let verifiedLegacy: BeatAPIGrant | undefined;
  // Background setup reuses verified access as it is; without it, background
  // setup signs up like foreground. A user can explicitly upgrade a working
  // DeepSeek-only receipt with `usegrunt add beatapi`.
  try {
    const grant = await bounded(() => readBeatAPIGrant(options.directory), signal);
    const usage = await bounded(() => verifyBeatAPIAccess(grant, guards), signal);
    signal.throwIfAborted();
    if (usage.credit_balance !== grant.baseline_balance) throw failure();
    if (grant.version !== 1 || options.background || !options.upgradeExisting) {
      options.notify?.('BeatAPI: existing verified free access reused');
      return;
    }
    verifiedLegacy = grant;
  } catch { if (signal.aborted) throw failure(); }
  // Preserve a still-valid v1 route while attempting to add a second model. Background
  // setup keeps the earlier receipt until a new one replaces it.
  const invalidate = async () => {
    if (!verifiedLegacy && !options.background) await rm(beatapiGrantPath(options.directory), { force: true });
  };
  try {
    if (verifiedLegacy) {
      // The authenticated catalog reports effective access for the already
      // verified key. A receipt migration does not renew its billing checks.
      if (await verifyBeatAPIModelAccess(verifiedLegacy, guards)) {
        signal.throwIfAborted();
        await writeBeatAPIGrant({ ...verifiedLegacy, version: 2, models: BEATAPI_MODELS }, options.directory);
        options.notify?.(connected);
        return;
      }
    }
    signal.throwIfAborted(); await invalidate(); signal.throwIfAborted(); options.squire.approveDataSharing?.(saved);
    const fresh = async () => {
      const result = await bounded(() => options.squire.call('list_credentials', { service: 'beatapi', fields: 'summary' }), signal);
      if (!Array.isArray(result.credentials)) throw failure(); return (result.credentials as Credential[]).filter(ownedKey);
    };
    const before = await fresh();
    if (before.length > 1) throw failure();
    await bounded(() => options.squire.signup('beatapi', 'https://beatapi.io/dashboard/apikeys',
      `Use the personal Google identity already connected to Squire, or the same user's already linked GitHub identity, to sign in to the ordinary BeatAPI account. Reuse this account; never create another account, rotate a key or reset it. Go straight to API keys; do not open Credits & billing. Never change billing, top up, add a card or buy anything; stop on refusal. Reuse the Grunt-owned key named grunt where available. Stop if more than one key has that name. Create one grunt key only if no key with that name exists. For that owned key, set Usage restrictions to allow exactly ${BEATAPI_MODELS.join(' and ')} if both are offered; if the free GLM ID is unavailable, allow only ${BEATAPI_MODEL}. Leave all other key settings alone. Never modify an unrelated key. Read the saved restrictions back in the normal dashboard and confirm no other model is allowed. Reuse the corresponding existing vault credential or capture the new key using operate_extract directly into this user's Squire vault with service beatapi, label grunt, api_hosts ["api.beatapi.io"], auth_shape bearer. Never display, return, fetch or log any raw credential. The user approved BeatAPI's current grouped data-sharing policy; accept required ordinary terms and sharing disclosures only, leave optional marketing off. No Discord, school approval or payment verification. Use Squire's configured verification tools, including its configured CAPTCHA solver when needed. Complete only after verifying the saved allowlist and confirming that the Grunt-owned credential is in the vault.`), signal);
    const credentials = await fresh();
    const credential = credentials[0];
    if (!credential || credentials.length !== 1 || (before[0] && before[0].reference !== credential.reference)) throw failure();
    const grant = await bounded(() => options.squire.credentials.grant(credential.reference), signal);
    const usage = await bounded(() => verifyBeatAPIAccess(grant, guards), signal);
    if (verifiedLegacy && usage.credit_balance !== verifiedLegacy.baseline_balance) throw failure();
    const hasGLM = await verifyBeatAPIModelAccess(grant, guards);
    signal.throwIfAborted();
    if (hasGLM || !verifiedLegacy) {
      const verified: Omit<BeatAPIGrant, 'version'> = { ...grant, upstream_origin: BEATAPI_ORIGIN, model: BEATAPI_MODEL, verified_at: verifiedLegacy?.verified_at ?? new Date().toISOString(),
        free_account_verified: true, lifetime_paid: 0, payment_method_present: false, auto_recharge: false,
        credit_provenance: usage.credit_balance === 0 ? 'zero' : 'signup', baseline_balance: usage.credit_balance };
      await writeBeatAPIGrant(hasGLM ? { ...verified, version: 2, models: BEATAPI_MODELS } : { ...verified, version: 1 }, options.directory);
    }
    options.notify?.(hasGLM ? connected : deepseekOnly);
  } catch { await invalidate().catch(() => {}); throw failure(); }
}
