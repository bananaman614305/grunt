/**
 * Billing contracts for Milo-issued keys and prepaid credits. Pinned so the
 * database, gateway, Stripe, provisioning, and account-page work can proceed
 * in parallel. See docs/adr/007-milo-keys-and-credits.md.
 *
 * Money is integer micro-dollars (1e-6 USD) everywhere; never floats.
 */

export type MicroUsd = number; // integer, 1 USD = 1_000_000

export const MILO_KEY_PREFIX = "mk_";
/** Shown to the user once; stored only as SHA-256 hex. */
export type MiloKeyId = string; // ulid
export type AccountId = string; // ulid

export type Account = {
  id: AccountId;
  email: string;
  stripeCustomerId: string | null;
  /** OpenRouter provisioning sub-key for this account, encrypted at rest. */
  openRouterSubKeyEnc: string | null;
  openRouterSubKeyHash: string | null; // OpenRouter's key hash, for usage lookups
  balanceMicroUsd: MicroUsd; // may go slightly negative on a stream that outran the reserve
  status: "active" | "suspended";
  createdAt: string;
  updatedAt: string;
};

export type ApiKey = {
  id: MiloKeyId;
  accountId: AccountId;
  keyHash: string; // SHA-256 hex of the full key
  prefix: string; // first 8 chars after mk_, for display
  name: string;
  createdAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
};

export type LedgerKind = "credit_purchase" | "usage" | "adjustment" | "refund";

export type LedgerEntry = {
  id: string; // ulid
  accountId: AccountId;
  kind: LedgerKind;
  /** Positive adds to the balance, negative spends. */
  amountMicroUsd: MicroUsd;
  balanceAfterMicroUsd: MicroUsd;
  /** Stripe checkout session id, Milo decision id, or an operator note. */
  reference: string;
  createdAt: string;
};

export type UsageRecord = {
  id: string; // ulid
  accountId: AccountId;
  apiKeyId: MiloKeyId;
  decisionId: string | null; // null for explicit-model passthrough
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** What OpenRouter charged Milo, from the response's usage.cost (USD). */
  upstreamCostMicroUsd: MicroUsd;
  /** What the account was charged: upstream * (1 + margin) + decision cost. */
  chargedMicroUsd: MicroUsd;
  createdAt: string;
};

export type PricingConfig = {
  /** Fraction on top of upstream cost, e.g. 0.15. */
  margin: number;
  /** Flat per-routed-request charge covering the Jev call, in micro-USD. */
  decisionFeeMicroUsd: MicroUsd;
  /** Reserve held per request before the upstream call, released on settle. */
  reserveMicroUsd: MicroUsd;
};

export const DEFAULT_PRICING: PricingConfig = {
  margin: 0.15,
  decisionFeeMicroUsd: 50, // $0.00005
  reserveMicroUsd: 50_000, // $0.05
};

export type CreditPack = { id: string; usdCents: number; label: string };
export const CREDIT_PACKS: CreditPack[] = [
  { id: "pack_5", usdCents: 500, label: "$5" },
  { id: "pack_20", usdCents: 2_000, label: "$20" },
  { id: "pack_100", usdCents: 10_000, label: "$100" },
];

/** Response header carrying what this request cost the account, in USD. */
export const COST_HEADER = "x-milo-cost-usd";
/** Response header carrying the remaining balance after this request, in USD. */
export const BALANCE_HEADER = "x-milo-balance-usd";

/**
 * How a request authenticated. `byok` is today's path: the bearer is the
 * user's own OpenRouter key and Milo charges nothing. `milo` is a Milo key:
 * the account's OpenRouter sub-key goes upstream and usage is charged.
 */
export type AuthMode =
  | { kind: "byok"; openRouterAuthorization: string }
  | { kind: "milo"; account: Account; apiKey: ApiKey; openRouterAuthorization: string };

export interface BillingStore {
  createAccount(email: string): Promise<Account>;
  getAccount(id: AccountId): Promise<Account | undefined>;
  getAccountByEmail(email: string): Promise<Account | undefined>;
  updateAccount(id: AccountId, patch: Partial<Omit<Account, "id" | "createdAt">>): Promise<Account>;
  createApiKey(accountId: AccountId, name: string): Promise<{ key: ApiKey; secret: string }>;
  findApiKeyByHash(keyHash: string): Promise<(ApiKey & { account: Account }) | undefined>;
  revokeApiKey(id: MiloKeyId): Promise<void>;
  listApiKeys(accountId: AccountId): Promise<ApiKey[]>;
  /** Atomic: applies the entry and returns the new balance. Rejects a spend that would go below -reserve. */
  postLedger(entry: Omit<LedgerEntry, "id" | "balanceAfterMicroUsd" | "createdAt">): Promise<LedgerEntry>;
  listLedger(accountId: AccountId, opts?: { limit?: number }): Promise<LedgerEntry[]>;
  recordUsage(record: Omit<UsageRecord, "id" | "createdAt">): Promise<UsageRecord>;
  usageSummary(accountId: AccountId, sinceIso?: string): Promise<{ requests: number; chargedMicroUsd: MicroUsd; upstreamCostMicroUsd: MicroUsd; byModel: Record<string, number> }>;
  /** Idempotency for Stripe webhooks: returns false if the event was already applied. */
  markStripeEvent(eventId: string): Promise<boolean>;
}

export function usdToMicro(usd: number): MicroUsd {
  return Math.round(usd * 1_000_000);
}
export function microToUsd(micro: MicroUsd): number {
  return micro / 1_000_000;
}
