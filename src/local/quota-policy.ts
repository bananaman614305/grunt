// Waits at or below this threshold are treated as short transient rate limits (HTTP 429).
// Longer waits or pools with zero recoverable routes fail fast as global exhaustion (HTTP 402).
export const TRANSIENT_RETRY_WINDOW_SECONDS = 60;

type Refill = 'rolling' | 'account-window' | 'daily' | 'utc-daily' | 'monday' | 'monthly' | 'utc-monthly' | 'earned' | 'provider-reported' | 'unpublished' | 'disabled';
type QuotaLimit = {
  amount: number;
  unit: 'requests' | 'tokens' | 'credits' | 'PT';
  period: 'minute' | 'hour' | 'day' | 'month';
  scope: 'account' | 'workspace' | 'ip' | 'free projects';
};
interface QuotaPolicy {
  refill: Refill;
  limits?: readonly QuotaLimit[];
  detail: string;
  documentation: string;
}

// Public policy for the exact free route. Numeric limits describe documented
// scopes, not a local counter or a promise about live upstream capacity.
const kiloFreeLimit = { amount: 200, unit: 'requests', period: 'hour', scope: 'ip' } as const;
const policies: Readonly<Record<string, QuotaPolicy>> = {
  freepi: { refill: 'utc-daily', detail: 'The account-specific daily free allowance renews at the authenticated refill_at time. Amounts vary by account and may be promotional. Every paid, earned and bonus wallet must be verified empty before and after each request. One account request is admitted at a time; no automatic purchase is made. Public reviewed requests and explicit trace-sale consent are required.', documentation: 'https://freepi.ai/docs/models-and-limits' },
  opencode: { refill: 'unpublished', detail: 'Free models are promotional and change independently. The rotation tracks cooldowns per model. OpenCode lists GLM-5.3-Flash Free as retired on November 18, 2026.',
    documentation: 'https://opencode.ai/docs/console/models/' },
  kilo: { refill: 'provider-reported', limits: [kiloFreeLimit],
    detail: 'The free gateway limit is shared by IP. Upstreams can throttle independently. Kilo does not publish an exact reset clock.',
    documentation: 'https://kilo.ai/docs/gateway/usage-and-billing' },
  zro: { refill: 'daily', detail: 'DeepSeek free usage resets daily. The public policy does not give the hour or allowance size. An HTTP 402 can also be a per-key spending cap.',
    documentation: 'https://zro.moonmath.ai/' },
  tokenharbor: { refill: 'account-window', limits: [{ amount: 60, unit: 'requests', period: 'minute', scope: 'account' },
    { amount: 1800, unit: 'requests', period: 'hour', scope: 'account' }, { amount: 100, unit: 'requests', period: 'minute', scope: 'ip' },
    { amount: 3000, unit: 'requests', period: 'hour', scope: 'ip' }], detail: 'The free allowance runs in account-specific seven-day windows. Grunt reads the current start and reset from the allowance API.',
    documentation: 'https://status.tokenharbor.ai/docs/api/allowance' },
  runcrate: { refill: 'monday', detail: 'The workspace’s weekly free allowance renews each Monday. The API keys page shows current usage and exact resets for the workspace.',
    documentation: 'https://www.runcrate.ai/inference/free' },
  'mistral-vibe': { refill: 'unpublished', detail: 'Vibe CLI limits depend on the account plan. The provider does not publish a fixed free CLI quota or reset for this route.',
    documentation: 'https://docs.mistral.ai/vibe/code/cli/install-setup' },
  omi: { refill: 'rolling', detail: 'Omi CLI Free ($0/mo) enforces rolling 5-hour and weekly usage windows with no fixed published token or request cap. The CLI reports remaining usage and reset timing when a window is exhausted.',
    documentation: 'https://cli.builditomi.com/' },
  livekit: { refill: 'monthly', limits: [{ amount: 100, unit: 'requests', period: 'minute', scope: 'free projects' },
    { amount: 600000, unit: 'tokens', period: 'minute', scope: 'free projects' }], detail: 'Build allowances reset on the first day of the month. Inference rate limits use sliding 60-second windows shared across the account’s free projects.',
    documentation: 'https://docs.livekit.io/deploy/admin/quotas-and-limits/' },
  pollinations: { refill: 'earned', detail: 'This route requires a Quest Pollen balance and an eligible zero-price model. The free balance is earned through quests and events. No automatic refill or account-wide request cap is published for the route.',
    documentation: 'https://gen.pollinations.ai/docs' },
  beatapi: { refill: 'rolling', limits: [{ amount: 1, unit: 'requests', period: 'minute', scope: 'account' }],
    detail: 'Before a top-up, the successful-request limit is shared across the free models on the account. Grunt shares this cooldown across its BeatAPI rotation.',
    documentation: 'https://docs.beatapi.io/free-models' },
  perch: { refill: 'utc-monthly', limits: [{ amount: 20000, unit: 'PT', period: 'month', scope: 'account' }],
    detail: 'The Starter plan renews at the start of the UTC calendar month. The free CLI route shares the Starter allowance with Perch’s other clients.',
    documentation: 'https://www.perchai.app/faq' },
  nous: { refill: 'provider-reported', detail: 'The free Hermes plan has standard rate limits. The gateway can report a recovery time; advertised daily, weekly and monthly included usage applies to paid plans.',
    documentation: 'https://portal.nousresearch.com/' },
  kenari: { refill: 'utc-daily', limits: [{ amount: 5, unit: 'requests', period: 'minute', scope: 'account' },
    { amount: 50, unit: 'requests', period: 'day', scope: 'account' }],
    detail: 'These are the published new-account defaults. Model overrides and account tier can differ. The successful daily quota renews at 00:00 UTC.',
    documentation: 'https://kenari.id/en/docs/rate-limits' },
  'aperture-ai': { refill: 'utc-daily', limits: [{ amount: 200, unit: 'requests', period: 'day', scope: 'account' }, { amount: 20, unit: 'requests', period: 'minute', scope: 'account' }],
    detail: 'Free requests reset at 00:00 UTC. The exact :free alias requires no credits and never falls back to paid models. Named daily_quota_exceeded errors use the published reset; generic or upstream throttles retain explicit provider retry signals without being treated as daily exhaustion. TPM and concurrency are unpublished.', documentation: 'https://www.aperture-ai.run/developers/docs.html' },
  darus: { refill: 'utc-daily', limits: [{ amount: 10000000, unit: 'tokens', period: 'day', scope: 'account' }, { amount: 25, unit: 'requests', period: 'minute', scope: 'account' }],
    detail: 'Free tier resets at 00:00 UTC (07:00 WIB), with one concurrent request. Grunt requires the exact -FREE model and live protectBalance=true; it stops rather than spending wallet funds. TPM is unpublished.', documentation: 'https://gateway.darusalfatah.id/dokumentasi' },
  fikra: { refill: 'provider-reported', limits: [{ amount: 1000, unit: 'requests', period: 'minute', scope: 'account' }, { amount: 100000, unit: 'requests', period: 'day', scope: 'account' }],
    detail: 'Temporary shared free window, not recurring tokens. The live gate can expire earlier than the public November 25 date or close when its shared budget is exhausted. No TPM/TPD cap is advertised for the exact free alias.', documentation: 'https://fikraapi.co.ke/free-deepseek-api' },
  openference: { refill: 'provider-reported', detail: 'Temporary DeepSeek free alias through December 31, 2026 UTC. Numeric daily and concurrency allowances are unpublished. Daily exhaustion reports resets_at; concurrent-request limits clear when a request finishes. No paid fallback.', documentation: 'https://openference.com/free-ai-api' },
  crowllm: { refill: 'provider-reported', detail: 'The pinned GLM free route has zero model pricing in the live catalog. Request caps and reset schedules are unpublished. Welcome account credit is separate and is not used by this route.',
    documentation: 'https://crowllm.com/models/glm-5.3-flash:free' },
  goedel: { refill: 'utc-daily', limits: [{ amount: 600000, unit: 'tokens', period: 'day', scope: 'account' },
    { amount: 150000, unit: 'tokens', period: 'day', scope: 'account' }],
    detail: 'Separate daily allowances are 600,000 uncached input tokens and 150,000 output tokens. They reset at 00:00 UTC. The free key also has a 100,000 uncached input token per minute refill rate and two concurrent requests.',
    documentation: 'https://inference.goedelmachines.com/docs' },
  millionseek: { refill: 'utc-daily', limits: [{ amount: 100000000, unit: 'tokens', period: 'day', scope: 'account' }],
    detail: '100M combined input/output tokens renew at 00:00 UTC, with five concurrent requests. Temporary bonus tokens are not the recurring allowance. Named daily_quota_exceeded errors report the midnight reset; session_limit_reached and capacity errors retain their own retry signals. The exact free alias has the owner-approved 198K usable input exception. No paid model or wallet fallback.',
    documentation: 'https://100milionseek.top/docs' },
  ifm: { refill: 'utc-daily', limits: [{ amount: 10000000, unit: 'tokens', period: 'day', scope: 'account' }],
    detail: 'IFM documents 10M combined prompt and completion tokens per API key per day, renewing at 00:00 UTC; the cap alone does not prove the route is free. Past it IFM returns 429 with Retry-After. Unpublished per-minute guards also exist, and live responses carried larger and differently named daily counters than the documentation, a mismatch Grunt has not reconciled. Grunt treats HTTP 402 as a stop, never as a quota.',
    documentation: 'https://docs.ifm.ai/docs/limits.md' },
  numes: { refill: 'provider-reported', detail: 'Free routes have separate limits. A Numes traffic cap includes Retry-After. An upstream 429 without it signals congestion without a published reset.',
    documentation: 'https://numes.ai/docs/routing/fallbacks' },
  'antseed-vikey': { refill: 'provider-reported', detail: 'The pinned seller controls the sliding free window and its buyer/IP limits. The Antseed buyer can return the remaining wait when a window is exhausted.',
    documentation: 'https://antseed.com/docs/staked-free-tier/' },
  'reflection-beam': { refill: 'provider-reported', limits: [kiloFreeLimit],
    detail: 'Shares Kilo’s free gateway IP limit. Reflection’s upstream beta can also throttle, with no published exact reset.',
    documentation: 'https://kilo.ai/docs/gateway/usage-and-billing' },
  nvidia: { refill: 'provider-reported', detail: 'NVIDIA lists a free endpoint. The exact quota depends on the active entitlement.',
    documentation: 'https://build.nvidia.com/deepseek-ai/deepseek-v4.1-flash/build' },
  freebuff: { refill: 'disabled', detail: 'Routing is disabled.', documentation: 'https://www.freebuff.com/' },
  apinex: { refill: 'disabled', detail: 'The recurring free offer was retired from Grunt routing.', documentation: 'https://apinex.ai/' },
};

export function providerQuotaPolicy(id: string): QuotaPolicy | undefined {
  return Object.hasOwn(policies, id) ? policies[id] : undefined;
}

export function scheduledQuotaRefill(id: string, now = Date.now()): number | undefined {
  const refill = providerQuotaPolicy(id)?.refill;
  const date = new Date(now);
  const next = refill === 'utc-daily' ? date.setUTCHours(24, 0, 0, 0)
    : refill === 'utc-monthly' ? Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) : NaN;
  return Number.isFinite(next) ? next : undefined;
}

// Call only after the adapter identifies exhaustion of the named allowance.
export function calendarQuotaDelay(id: string, now = Date.now()): number | undefined {
  const reset = scheduledQuotaRefill(id, now);
  return reset === undefined ? undefined : Math.ceil((reset - now) / 1000);
}

export interface SellerQuota {
  windowSeconds: number;
  perAddress?: number;
  perIp?: number;
}

export function sellerQuota(value: unknown): SellerQuota | undefined {
  if (!value || typeof value !== 'object') return;
  const row = value as Record<string, unknown>;
  const natural = (value: unknown, max: number): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= max;
  if (!natural(row.windowSeconds, 31 * 86400)) return;
  const perAddress = natural(row.perAddress, 10_000_000) ? row.perAddress : undefined;
  const perIp = natural(row.perIp, 10_000_000) ? row.perIp : undefined;
  if (perAddress || perIp) return { windowSeconds: row.windowSeconds, ...(perAddress ? { perAddress } : {}), ...(perIp ? { perIp } : {}) };
}

export interface ObservedQuota {
  unit: 'tokens' | 'credits' | 'requests' | 'usd';
  remaining: number;
  limit?: number;
  used?: number;
  observedAt: number;
  source: 'provider_header' | 'provider_api';
}

const observedUnits = new Set<ObservedQuota['unit']>(['tokens', 'credits', 'requests', 'usd']);
const observedSources = new Set<ObservedQuota['source']>(['provider_header', 'provider_api']);

export function observedQuota(value: unknown): ObservedQuota | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const row = value as Record<string, unknown>;
  const amount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1e15;
  if (typeof row.unit !== 'string' || !observedUnits.has(row.unit as ObservedQuota['unit'])) return;
  if (typeof row.source !== 'string' || !observedSources.has(row.source as ObservedQuota['source'])) return;
  if (!amount(row.remaining)) return;
  if (typeof row.observedAt !== 'number' || !Number.isSafeInteger(row.observedAt) || row.observedAt <= 0 || row.observedAt > 8640000000000000) return;
  const limit = amount(row.limit) ? row.limit : undefined;
  const used = amount(row.used) ? row.used : undefined;
  if (row.limit !== undefined && limit === undefined) return;
  if (row.used !== undefined && used === undefined) return;
  return {
    unit: row.unit as ObservedQuota['unit'],
    remaining: row.remaining,
    ...(limit === undefined ? {} : { limit }),
    ...(used === undefined ? {} : { used }),
    observedAt: row.observedAt,
    source: row.source as ObservedQuota['source']
  };
}
