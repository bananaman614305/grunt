import { FreeApi } from './free-api.js';
import type { FreeApiGrant } from './free-api.js';
import { verifiedDeepSeekFetch } from './deepseek-response.js';
import { readDataSharingConsent } from './data-sharing.js';
import { providerGrantDirectory, readPrivateProviderGrant, validateProviderGrant, writePrivateProviderGrant } from './provider-grant.js';
import { credentialFingerprint, isCredentialFingerprint, readVaultGrant, validateDirectOrigin } from './vault.js';
import { SourceError } from './source.js';
import type { ModelRequest, Source } from './source.js';

export const APINEX_DEEPSEEK = 'free/deepseek-v4.1-flash';
export interface ApinexGrant extends FreeApiGrant {
  free_account_verified: true;
  daily_checkin_at: string;
  credential_sha256?: string;
}
function validate(value: unknown): ApinexGrant {
  const grant = value as Partial<ApinexGrant> | null;
  const access = validateProviderGrant(value);
  if (grant?.free_account_verified !== true || typeof grant.daily_checkin_at !== 'string'
    || !Number.isFinite(Date.parse(grant.daily_checkin_at))) throw new Error('APInex daily free check-in verification is missing');
  const expected = credentialFingerprint(access);
  if (grant.credential_sha256 !== undefined && (!isCredentialFingerprint(grant.credential_sha256) || grant.credential_sha256 !== expected)) {
    throw new Error('APInex daily free check-in verification does not match the current credential');
  }
  return { ...access, free_account_verified: true, daily_checkin_at: grant.daily_checkin_at, credential_sha256: expected };
}
export async function readApinexGrant(
  location = providerGrantDirectory(),
  env: NodeJS.ProcessEnv = process.env
): Promise<ApinexGrant> {
  return validate(await readPrivateProviderGrant('apinex', location, env));
}
// Called only after Squire has completed today's actual free-account check-in.
export async function writeApinexGrant(
  grant: FreeApiGrant,
  location = providerGrantDirectory(),
  env: NodeJS.ProcessEnv = process.env
) {
  const value = validate({ ...grant, free_account_verified: true, daily_checkin_at: new Date().toISOString() });
  const fingerprint = value.credential_sha256!;
  let isDirect = false;
  try { validateDirectOrigin('apinex', value.base_url); isDirect = true; } catch { /* Legacy egress or test URL. */ }
  const vaulted = isDirect ? await readVaultGrant('apinex', location, env).catch(() => undefined) : undefined;
  if (isDirect && vaulted && credentialFingerprint(vaulted) === fingerprint) {
    await writePrivateProviderGrant('apinex', {
      base_url: value.base_url,
      credential_source: 'vault',
      credential_sha256: fingerprint,
      free_account_verified: true,
      daily_checkin_at: value.daily_checkin_at
    }, location);
    return;
  }
  await writePrivateProviderGrant('apinex', value, location);
}
export class Apinex implements Source {
  readonly id = 'apinex';
  readonly supportsFunctionTools = true;
  private source: FreeApi;
  private location: string;
  private shutdown = new AbortController();
  constructor(private options: { directory?: string; fetcher?: typeof fetch; timeout?: number; loadGrant?: () => Promise<ApinexGrant>; now?: () => number } = {}) {
    this.location = options.directory ?? providerGrantDirectory();
    this.source = new FreeApi('apinex', { ...options, fetcher: verifiedDeepSeekFetch(options.fetcher), loadGrant: () => this.grant() });
  }
  private approved = async () => (await readDataSharingConsent(this.location, [this.id])).includes(this.id);
  private async grant() {
    const grant = validate(await (this.options.loadGrant?.() ?? readApinexGrant(this.location)));
    const today = new Date((this.options.now ?? Date.now)()).toISOString().slice(0, 10);
    if (new Date(grant.daily_checkin_at).toISOString().slice(0, 10) !== today) throw new Error('APInex daily free check-in is required');
    return grant;
  }
  private async access(grant: ApinexGrant, caller: AbortSignal): Promise<void> {
    caller.throwIfAborted();
    const signal = AbortSignal.any([caller, this.shutdown.signal, AbortSignal.timeout(5000)]);
    try {
      const response = await (this.options.fetcher ?? fetch)(`${grant.base_url}/v1/subscription`, {
        headers: { Authorization: `Bearer ${grant.token}` }, redirect: 'error', signal
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new SourceError(response.status === 401 ? 'logged_out' : response.status === 429 ? 'quota' : 'upstream', `APInex access check returned HTTP ${response.status}`);
      }
      const state = await response.json() as { mode?: unknown; allowed?: unknown; tokens_remaining?: unknown; resets_at_utc?: unknown };
      signal.throwIfAborted();
      const remaining = state?.tokens_remaining;
      if (state?.mode !== 'free') throw new SourceError('refused', 'APInex free account access is not active');
      if (state.allowed !== true || typeof remaining !== 'number' || !Number.isFinite(remaining) || remaining <= 0) {
        const reset = typeof state.resets_at_utc === 'string' ? Date.parse(state.resets_at_utc) : NaN;
        const retry = Number.isFinite(reset) ? Math.max(1, Math.ceil((reset - (this.options.now ?? Date.now)()) / 1000)) : undefined;
        throw new SourceError('quota', 'APInex daily free allowance is unavailable; complete its daily check-in', retry);
      }
    } catch (error) {
      caller.throwIfAborted();
      if (this.shutdown.signal.aborted) throw new SourceError('cancelled', 'APInex access check closed');
      if (signal.aborted) throw new SourceError('timeout', 'APInex access check timed out');
      if (error instanceof SourceError) throw error;
      throw new SourceError('upstream', 'APInex access check is unavailable');
    }
  }
  async available() {
    if (!await this.approved()) return false;
    try {
      const grant = await this.grant();
      await this.access(grant, new AbortController().signal);
      return true;
    } catch { return false; }
  }
  async healthCheck() { return this.available(); }
  async complete(request: ModelRequest, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!await this.approved()) throw new SourceError('refused', 'APInex data sharing is not approved; rerun usegrunt setup');
    let grant: ApinexGrant;
    try { grant = await this.grant(); }
    catch { throw new SourceError('logged_out', 'APInex daily free check-in is required; rerun usegrunt setup'); }
    await this.access(grant, signal);
    return this.source.complete({ ...request, model: this.id }, signal);
  }
  async close() { this.shutdown.abort(); await this.source.close(); }
}
