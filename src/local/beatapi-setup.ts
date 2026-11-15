import { rm } from 'node:fs/promises';
import { DATA_SHARING_POLICIES, readDataSharingConsent } from './data-sharing.js';
import { BEATAPI_MODEL, BEATAPI_ORIGIN, beatapiGrantPath, verifyBeatAPIAccess, writeBeatAPIGrant } from './beatapi.js';
interface Credential { service: string | null; reference: string; field_names: string[]; auth_strategy?: string | null; label?: string; allowed_hosts?: string[] }
export interface BeatAPISetupSquire {
  signup(service: string, url: string, goal: string): Promise<void>;
  call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  credentials: { list(): Promise<Credential[]>; grant(reference: string): Promise<{ base_url: string; token: string }> };
  approveDataSharing?(providers: readonly string[]): void;
}
export interface BeatAPISetupOptions { directory: string; squire: BeatAPISetupSquire; signal?: AbortSignal; dataSharingApproved?: readonly string[]; notify?(line: string): void; fetcher?: typeof fetch }
const failure = () => new Error('BeatAPI free account or key verification did not complete; rerun usegrunt setup');
async function bounded<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  let abort: (() => void) | undefined;
  try { return await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return operation(); }), new Promise<never>((_resolve, reject) => {
    abort = () => reject(failure()); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
  })]); } catch { throw failure(); } finally { if (abort) signal.removeEventListener('abort', abort); }
}
const eligible = (c: Credential) => c.service?.trim().toLowerCase() === 'beatapi' && c.auth_strategy !== 'username_password'
  && c.field_names.some(f => ['value', 'apikey', 'key', 'token', 'secret'].includes(f.toLowerCase().replace(/[^a-z]/g, '')))
  && c.allowed_hosts?.[0] === 'api.beatapi.io';
export async function setupBeatAPI(options: BeatAPISetupOptions): Promise<void> {
  // The caller may carry approvals already recorded by this wizard turn, but
  // an unknown or changed policy cannot silently inherit another provider's.
  if (!DATA_SHARING_POLICIES.some(policy => policy.provider === 'beatapi')) throw new Error('BeatAPI data-sharing policy is unavailable');
  const saved = await readDataSharingConsent(options.directory, ['beatapi']);
  if (!saved.includes('beatapi') || (options.dataSharingApproved && !options.dataSharingApproved.includes('beatapi'))) throw new Error('BeatAPI data sharing requires the current grouped setup approval');
  const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(600000)]);
  const invalidate = () => rm(beatapiGrantPath(options.directory), { force: true });
  try {
    await invalidate(); signal.throwIfAborted(); options.squire.approveDataSharing?.(saved);
    const fresh = async () => {
      const result = await bounded(() => options.squire.call('list_credentials', { service: 'beatapi', fields: 'summary' }), signal);
      if (!Array.isArray(result.credentials)) throw failure(); return (result.credentials as Credential[]).filter(eligible);
    };
    const before = await fresh();
    await bounded(() => options.squire.signup('beatapi', 'https://beatapi.io/dashboard/apikeys',
      `Use the personal Google identity already connected to Squire, or the same user's already linked GitHub identity, to sign in to the ordinary BeatAPI account. Reuse this account and existing vaulted BeatAPI key; never create another account, rotate a key or reset it. Verify Credits & billing: lifetime paid $0, no payment method, no subscription, auto recharge Off and unavailable without adding a payment method, no paid top-ups or purchases. Zero balance or the ordinary $2 signup credit is allowed; explicitly verify its signup provenance and no paid payment records. Stop on paid funds, payment method, automatic billing, refusal or unverifiable account facts; never change billing, top up, add a card or buy anything. Reuse the Grunt-owned key named grunt where available. Create exactly one grunt key only if no usable existing key exists. For that owned key, set Usage restrictions to a minimal allowlist containing only ${BEATAPI_MODEL} (an existing grunt key restricted to that model and glm-5.3-flash-free is also allowed). Do not modify an unrelated key. Confirm no paid model is allowed. Capture the new key using operate_extract directly into this user's Squire vault: service beatapi, label grunt, api_hosts ["api.beatapi.io"], auth_shape bearer. Never display, return, fetch or log any raw credential. The user approved BeatAPI's current grouped data-sharing policy; accept required ordinary terms and sharing disclosures only, leave optional marketing off. No phone/SMS, Discord, school approval or payment verification. Required human CAPTCHA/passkey/email verification needs normal browser handoff. Finish only after confirming the account and free-only key settings.`), signal);
    const credentials = await fresh(), owned = credentials.filter(c => c.label === 'grunt');
    const credential = owned.find(c => before.some(old => old.reference === c.reference)) ?? owned[0] ?? credentials.find(c => !before.some(old => old.reference === c.reference));
    if (!credential) throw failure();
    const grant = await bounded(() => options.squire.credentials.grant(credential.reference), signal);
    const usage = await bounded(() => verifyBeatAPIAccess(grant, { ...(options.fetcher ? { fetcher: options.fetcher } : {}), signal }), signal);
    signal.throwIfAborted();
    await writeBeatAPIGrant({ version: 1, ...grant, upstream_origin: BEATAPI_ORIGIN, model: BEATAPI_MODEL, verified_at: new Date().toISOString(), free_account_verified: true,
      lifetime_paid: 0, payment_method_present: false, auto_recharge: false, credit_provenance: usage.credit_balance === 0 ? 'zero' : 'signup', baseline_balance: usage.credit_balance }, options.directory);
    signal.throwIfAborted(); options.notify?.('BeatAPI: free-only DeepSeek V4.1 Flash access connected; one successful request per minute');
  } catch { await invalidate().catch(() => {}); throw failure(); }
}
