/**
 * Milo-issued keys: who is calling, whether they can pay, and what the call
 * cost them (ADR-007).
 *
 * Every `/v1/*` request resolves to one of two `AuthMode`s before a route
 * runs:
 *
 *   - `byok` -- the bearer is the user's own OpenRouter key. This is today's
 *     path and nothing in this file touches it: no lookup, no gate, no
 *     charge, and the outgoing headers are the client's own, unmodified.
 *   - `milo` -- the bearer is an `mk_` key. The account's OpenRouter sub-key
 *     (minted on first use, stored encrypted) goes upstream instead, the
 *     balance is checked before the call, and the usage OpenRouter reports is
 *     charged after it.
 *
 * Three rules hold everywhere below, and the tests in `billing.test.ts` exist
 * to keep them holding:
 *
 *   1. Neither the `mk_` key nor the sub-key is ever logged, stored in a
 *      decision, returned in a header, or put in an error message. The only
 *      forms that leave this file are a SHA-256 digest (the account's
 *      identity for rate limiting and per-key rosters) and an `Authorization`
 *      header addressed to OpenRouter.
 *   2. A charge never fails a request that already succeeded. A ledger write
 *      that is refused or errors after the answer has gone out is logged and
 *      dropped, because the user has their tokens either way and a 500 at
 *      that point would only cost them the response too.
 *   3. A request Milo cannot price is not guessed at: it charges nothing and
 *      logs a warning naming the decision, so reconciliation against
 *      OpenRouter's own usage figures can find it later.
 */

import type { Context, MiddlewareHandler } from "hono";
import {
  BALANCE_HEADER,
  COST_HEADER,
  DEFAULT_PRICING,
  MILO_KEY_PREFIX,
  defaultRosterModel,
  microToUsd,
  usdToMicro,
} from "@milo/core";
import type { Account, AccountId, AuthMode, BillingStore, MicroUsd, PricingConfig, UsageRecord } from "@milo/core";
import { decryptSecret as decryptBillingEnvelope, sha256Hex } from "@milo/billing";
import { decryptSecret as decryptProvisioningEnvelope, ensureSubKey } from "@milo/provisioning";
import type { OpenRouterProvisioningClient } from "@milo/provisioning";
import type { StripeClient } from "@milo/stripe";
import type { AppDeps } from "./app.js";
import { credential, isAnthropicPath, keyHash, upstreamAuthorization } from "./app.js";
import { anthropicErrorResponse, errorMessage, errorResponse } from "./errors.js";
import { hashKey } from "./rate-limit.js";
import { addUsage, usageFromStream } from "./routes/usage.js";
import type { Surface, UpstreamUsage } from "./routes/usage.js";

/**
 * `BillingStore` plus the one read the account page needs that the pinned
 * contract does not declare: the account's own recent usage rows. Optional,
 * so a store that does not have it still satisfies the interface -- the usage
 * route then answers with the summary and an empty list rather than failing.
 */
export type UsageListing = {
  listUsage(accountId: AccountId, opts?: { limit?: number; sinceIso?: string }): Promise<UsageRecord[]>;
};

/** Everything the billing surfaces need, as `createGateway` assembles it. */
export type BillingRuntime = {
  store: BillingStore & Partial<UsageListing>;
  stripe?: StripeClient;
  provisioning?: OpenRouterProvisioningClient;
  /** Base64 of 32 bytes, `MILO_ENCRYPTION_KEY`. Decrypts the sub-key. */
  encryptionKey: string;
  pricing: PricingConfig;
  /** Where a user tops up. Defaults to `/account` on this deployment. */
  accountUrl?: string;
};

/** What a caller is told when a deployment has no billing wired up at all. */
export const MILO_KEYS_DISABLED = "Milo keys are not enabled on this deployment.";

const AUTH_CONTEXT_KEY = "miloAuth";

// ---------------------------------------------------------------------------
// Auth resolution
// ---------------------------------------------------------------------------

/** A refusal that has to be rendered in the calling route's dialect. */
export class AuthRefusal extends Error {
  constructor(
    readonly status: 401 | 403 | 503,
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "AuthRefusal";
  }
}

/**
 * Who is calling, and with what credential upstream.
 *
 * A bearer that does not start with `mk_` is a BYOK request and resolves
 * without touching the database -- Milo cannot validate an OpenRouter key
 * without spending a call, and never could (ADR-003).
 *
 * An `mk_` bearer is looked up by the SHA-256 of the whole key, which is the
 * only form the database holds. Unknown and revoked are the same answer (401)
 * on purpose: telling the two apart would tell a key-guesser which of their
 * guesses once existed.
 */
export async function resolveAuth(c: Context, deps: AppDeps): Promise<AuthMode> {
  const secret = credential(c);
  if (!secret.startsWith(MILO_KEY_PREFIX)) {
    return { kind: "byok", openRouterAuthorization: upstreamAuthorization(c) };
  }

  const billing = deps.billing;
  if (billing === undefined) {
    throw new AuthRefusal(401, MILO_KEYS_DISABLED, "milo_keys_disabled");
  }

  const found = await billing.store.findApiKeyByHash(sha256Hex(secret));
  if (found === undefined || found.revokedAt !== null) {
    throw new AuthRefusal(401, "Unknown or revoked Milo key.", "invalid_api_key");
  }

  const { account, ...apiKey } = found;
  if (account.status === "suspended") {
    throw new AuthRefusal(403, "This Milo account is suspended. Contact support.", "account_suspended");
  }

  const provisioned = await withSubKey(billing, account);
  return {
    kind: "milo",
    account: provisioned,
    apiKey,
    // Empty only for an account that cannot spend (see `withSubKey`). Empty
    // rather than the caller's own bearer on purpose: an `mk_` key must never
    // reach OpenRouter, so the worst case is an upstream 401, not a leak.
    openRouterAuthorization:
      provisioned.openRouterSubKeyEnc === null
        ? ""
        : `Bearer ${decryptSubKey(provisioned.openRouterSubKeyEnc, billing.encryptionKey)}`,
  };
}

/**
 * The stored sub-key, whichever module encrypted it.
 *
 * Two packages ship an AES-256-GCM envelope they both call `v1`, with
 * different framing: `@milo/provisioning` writes `v1:<iv>:<ciphertext+tag>`
 * (base64, colons) and is what `ensureSubKey` uses, while `@milo/billing`
 * writes `v1.<iv>.<tag>.<ciphertext>` (base64url, dots). Both take the same
 * 32-byte `MILO_ENCRYPTION_KEY`, so the separator is enough to tell a row
 * apart and a deployment can hold rows written by either.
 *
 * HORIZON: `packages/provisioning/src/crypto.ts` says in its own header that
 * it exists only because `@milo/billing` did not yet, and should become a
 * re-export of it. When that happens this function collapses to one call.
 */
function decryptSubKey(stored: string, encryptionKey: string): string {
  return stored.startsWith("v1:")
    ? decryptProvisioningEnvelope(stored, encryptionKey)
    : decryptBillingEnvelope(stored, encryptionKey);
}

/**
 * The account's OpenRouter sub-key, minted on first use. The plaintext never
 * comes back here -- `ensureSubKey` stores it encrypted and returns the
 * updated account, and the decryption above is the only place it is read.
 *
 * "First use" means the first request that could actually spend: an account
 * below the reserve is about to be refused with 402, and minting a key on
 * Milo's OpenRouter account for a request that will never reach OpenRouter
 * would hand anyone who can sign up a way to litter it.
 */
async function withSubKey(billing: BillingRuntime, account: Account): Promise<Account> {
  if (account.openRouterSubKeyEnc !== null) return account;
  if (account.balanceMicroUsd < billing.pricing.reserveMicroUsd) return account;

  if (billing.provisioning === undefined) {
    throw new AuthRefusal(
      503,
      "This Milo account has no OpenRouter sub-key yet and the deployment cannot mint one.",
      "subkey_unavailable",
    );
  }

  const provisioned = await ensureSubKey({
    store: billing.store,
    client: billing.provisioning,
    encryptionKey: billing.encryptionKey,
    account,
  });
  if (provisioned.openRouterSubKeyEnc === null) {
    throw new AuthRefusal(503, "Milo could not provision an OpenRouter key for this account.", "subkey_unavailable");
  }
  return provisioned;
}

/**
 * Resolves the caller once per request and hands it to the routes. Registered
 * for `/v1/*` right after the "is there a key at all" check, so every route --
 * including ones added later -- reads one resolved identity rather than
 * parsing headers again.
 */
export function billingAuth(deps: AppDeps): MiddlewareHandler {
  return async (c, next) => {
    try {
      c.set(AUTH_CONTEXT_KEY, await resolveAuth(c, deps));
    } catch (err) {
      if (err instanceof AuthRefusal) return refusal(c, err);
      // A database that is down must not read as a bad key.
      deps.logger.error("milo key lookup failed", { error: errorMessage(err) });
      return dialectError(c, 503, "Milo could not check that key right now.", "api_error", "billing_unavailable");
    }
    await next();
    return;
  };
}

/**
 * The resolved caller. Falls back to a BYOK mode built from the request, so a
 * route still works when it is reached without the middleware (a test that
 * builds `AppDeps` by hand, say) -- which is exactly today's behaviour.
 */
export function authOf(c: Context): AuthMode {
  const resolved = c.get(AUTH_CONTEXT_KEY) as AuthMode | undefined;
  return resolved ?? { kind: "byok", openRouterAuthorization: upstreamAuthorization(c) };
}

/**
 * Whether this request is charged at all. False for BYOK, which lets a
 * passthrough route hand the upstream body straight back rather than
 * buffering or teeing it for a charge that will never be posted.
 */
export function isMetered(c: Context): boolean {
  return authOf(c).kind === "milo";
}

/**
 * The caller's identity for anything stored or bucketed per key: the Milo
 * key's hash in `milo` mode, the OpenRouter credential's hash otherwise.
 *
 * Keying on the Milo key rather than the account means rotating a key gets a
 * fresh rate-limit bucket and a fresh roster slot, which is the same property
 * a BYOK user gets by rotating their OpenRouter key (ADR-008).
 */
export function callerScope(c: Context): string {
  const auth = authOf(c);
  return auth.kind === "milo" ? auth.apiKey.keyHash : keyHash(c);
}

/**
 * The rate limiter's bucket for this caller, already hashed.
 * `byokAuthorization` is whatever the route bucketed on before Milo keys
 * existed, so a BYOK caller's bucket is bit-for-bit the one it was.
 */
export function rateLimitBucket(c: Context, byokAuthorization: string): string {
  const auth = authOf(c);
  return auth.kind === "milo" ? auth.apiKey.keyHash : hashKey(byokAuthorization);
}

/**
 * The headers to send upstream. A BYOK request hands its own headers over
 * untouched; a Milo request swaps in the account's sub-key and drops
 * `x-api-key`, so an `mk_` key can never reach OpenRouter.
 */
export function upstreamHeadersFor(c: Context, auth: AuthMode = authOf(c)): Headers {
  if (auth.kind === "byok") return c.req.raw.headers;
  const headers = new Headers(c.req.raw.headers);
  headers.set("authorization", auth.openRouterAuthorization);
  headers.delete("x-api-key");
  return headers;
}

/**
 * The bare OpenRouter key that pays for this request upstream -- the account's
 * sub-key for a Milo caller, the caller's own key for a BYOK request -- with
 * the `Bearer ` prefix stripped. This is the key Jev-via-OpenRouter (ADR-021)
 * authenticates its classification call with, so the same key that pays for
 * the completion also pays for its routing decision. Returns `""` when no key
 * is present, and never exposes an `mk_` bearer (that is swapped for the
 * sub-key first, exactly as `upstreamHeadersFor` does for the completion).
 */
export function forwardedUpstreamKey(c: Context): string {
  const auth = upstreamHeadersFor(c).get("authorization") ?? "";
  return auth.replace(/^Bearer\s+/i, "").trim();
}

/**
 * The per-call bearer for a Jev call under the `"openrouter"` transport
 * (ADR-022), or `undefined`. Returns the caller's forwarded OpenRouter key --
 * the same key that pays for the completion -- when this deployment forwards
 * the Jev key (`deps.forwardJevKey`, set only under the `"openrouter"`
 * transport), so under that transport EVERY Jev call (routing and the
 * auxiliary features -- ranking, the completeness gate, verification, pruning,
 * fact capture and relevance, preference capture) bills to the user's own key
 * and Milo's `JEV_API_KEY` is never used for a user-facing call.
 *
 * Returns `undefined` under the default TypeSafe transport (Milo's key is
 * used, as before) and also when no forwarded key is present. A per-request
 * Jev call always has one; an auxiliary feature that somehow does not simply
 * passes `undefined`, and the `"openrouter"` Jev client then rejects the call
 * rather than falling back to Milo's key -- the feature fails open (its
 * existing behaviour), so the request still succeeds without it.
 */
export function forwardedJevKey(c: Context, deps: AppDeps): string | undefined {
  if (deps.forwardJevKey !== true) return undefined;
  const key = forwardedUpstreamKey(c);
  return key !== "" ? key : undefined;
}

// ---------------------------------------------------------------------------
// The credit gate
// ---------------------------------------------------------------------------

/**
 * The refusal a broke account gets, or `undefined` when the request may
 * proceed. Called before anything is spent -- before Jev, not just before
 * OpenRouter -- because a request that cannot be paid for should not cost
 * Milo a decision either.
 */
export function creditGate(c: Context, deps: AppDeps): Response | undefined {
  const auth = authOf(c);
  if (auth.kind !== "milo") return undefined;

  const pricing = deps.billing?.pricing ?? DEFAULT_PRICING;
  const balance = auth.account.balanceMicroUsd;
  if (balance >= pricing.reserveMicroUsd) return undefined;

  const headers = { [BALANCE_HEADER]: usdHeader(balance) };
  const message = `Milo credits exhausted. Add credits at ${accountUrl(c, deps)}.`;
  return isAnthropicPath(new URL(c.req.url).pathname)
    ? anthropicErrorResponse(c, 402, message, "billing_error", headers)
    : errorResponse(c, 402, message, "insufficient_quota", "insufficient_credits", headers);
}

/** Where this deployment tells a user to top up. */
export function accountUrl(c: Context, deps: AppDeps): string {
  const configured = deps.billing?.accountUrl;
  if (configured !== undefined && configured !== "") return configured;
  return `${requestOrigin(c)}/account`;
}

/**
 * This deployment's own origin, as the client reached it: scheme, host and
 * port, honouring a proxy's `x-forwarded-proto` (Fly terminates TLS, so the
 * request Milo sees is plain HTTP). Returned as a string to be concatenated
 * with a path rather than run through `new URL`, because Stripe's return URLs
 * carry a literal `{CHECKOUT_SESSION_ID}` placeholder that must survive.
 */
export function requestOrigin(c: Context): string {
  const url = new URL(c.req.url);
  const proto = c.req.header("x-forwarded-proto");
  if (proto === "https" || proto === "http") url.protocol = `${proto}:`;
  return url.origin;
}

// ---------------------------------------------------------------------------
// Charging
// ---------------------------------------------------------------------------

/** What a charge needs to know about the request it is settling. */
export type ChargeContext = {
  surface: Surface;
  /** The model that answered, for the roster-price fallback and the record. */
  model: string;
  /** Set on a routed request; absent on explicit-model passthrough. */
  decisionId?: string;
};

/**
 * Charges a buffered response and stamps the two cost headers on it. The
 * caller has already read the body and its usage (the decision log wants the
 * same numbers), so this adds no latency beyond the ledger write, which has
 * to happen before the headers can be honest.
 */
export async function chargeBuffered(
  c: Context,
  deps: AppDeps,
  headers: Headers,
  ctx: ChargeContext,
  usage: UpstreamUsage,
): Promise<void> {
  const auth = authOf(c);
  if (auth.kind !== "milo" || deps.billing === undefined) return;
  try {
    await settle(deps, auth, ctx, usage, headers);
  } catch (err) {
    // The answer is already bought and paid for upstream; failing the
    // response now would take the user's tokens away as well as the record.
    deps.logger.error("charge failed", {
      ...(ctx.decisionId !== undefined ? { decisionId: ctx.decisionId } : {}),
      error: errorMessage(err),
    });
  }
}

/**
 * Tees a streamed response so the usage in its last frames can be read
 * without touching the bytes the client gets, and posts the charge when the
 * stream ends.
 *
 * HTTP trailers are not available here (neither Hono's `Response` nor the
 * clients Milo serves would carry them), so a streamed response cannot report
 * its own cost in a header: `x-milo-balance-usd` carries the balance as it
 * was *before* the request and `x-milo-cost-usd` is the literal `pending`.
 * The settled numbers land in the ledger and in `GET /v1/account/usage`.
 */
export function chargeStream(
  c: Context,
  deps: AppDeps,
  headers: Headers,
  ctx: ChargeContext,
  stream: ReadableStream<Uint8Array>,
  baseUsage?: UpstreamUsage,
): ReadableStream<Uint8Array> {
  const auth = authOf(c);
  if (auth.kind !== "milo" || deps.billing === undefined) return stream;

  headers.set(COST_HEADER, "pending");
  headers.set(BALANCE_HEADER, usdHeader(auth.account.balanceMicroUsd));

  const [passthrough, meter] = stream.tee();
  const work = (async () => {
    const usage = addUsage(baseUsage ?? {}, await usageFromStream(ctx.surface, meter));
    await settle(deps, auth, ctx, usage);
  })().catch((err: unknown) => {
    deps.logger.error("streamed charge failed", {
      ...(ctx.decisionId !== undefined ? { decisionId: ctx.decisionId } : {}),
      error: errorMessage(err),
    });
  });
  deps.track?.(work);

  return passthrough;
}

/**
 * Posts the ledger entry and the usage record for one answered request, and
 * (when it can still affect the response) sets the cost headers.
 *
 * `charged = round(upstream * (1 + margin)) + decision fee`, the fee only on
 * a routed request: it pays for the Jev call, and a passthrough never made
 * one. The ledger reference is the decision id, or `passthrough:<upstream
 * id>` for a call Milo did not route, so every entry points at something that
 * can be looked up.
 */
async function settle(
  deps: AppDeps,
  auth: Extract<AuthMode, { kind: "milo" }>,
  ctx: ChargeContext,
  usage: UpstreamUsage,
  headers?: Headers,
): Promise<void> {
  const billing = deps.billing;
  if (billing === undefined) return;

  const upstreamCostMicroUsd = upstreamCost(deps, ctx, usage);
  if (upstreamCostMicroUsd === undefined) {
    // No cost reported and no way to estimate one (a stream that ended early,
    // or a model the shipped roster cannot price). Reconciliation against
    // OpenRouter's own usage for this sub-key is how this gets caught, so the
    // line names the request.
    deps.logger.warn("upstream cost unknown; nothing charged", {
      ...(ctx.decisionId !== undefined ? { decisionId: ctx.decisionId } : {}),
      model: ctx.model,
      surface: ctx.surface,
    });
    return;
  }

  const fee = ctx.decisionId === undefined ? 0 : billing.pricing.decisionFeeMicroUsd;
  const chargedMicroUsd = Math.round(upstreamCostMicroUsd * (1 + billing.pricing.margin)) + fee;
  const reference = ctx.decisionId ?? `passthrough:${usage.id ?? "unknown"}`;

  let balanceMicroUsd = auth.account.balanceMicroUsd - chargedMicroUsd;
  try {
    const entry = await billing.store.postLedger({
      accountId: auth.account.id,
      kind: "usage",
      amountMicroUsd: -chargedMicroUsd,
      reference,
    });
    balanceMicroUsd = entry.balanceAfterMicroUsd;
  } catch (err) {
    // A stream that outran the reserve lands here. The answer is already
    // delivered; the account keeps the debt as an unposted charge and the
    // usage row below is what says it happened.
    if (isInsufficientBalance(err)) {
      deps.logger.warn("charge refused: balance below the reserve floor", {
        ...(ctx.decisionId !== undefined ? { decisionId: ctx.decisionId } : {}),
        chargedMicroUsd,
        reference,
      });
      balanceMicroUsd = auth.account.balanceMicroUsd;
    } else {
      throw err;
    }
  }

  await billing.store.recordUsage({
    accountId: auth.account.id,
    apiKeyId: auth.apiKey.id,
    decisionId: ctx.decisionId ?? null,
    model: ctx.model,
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    upstreamCostMicroUsd,
    chargedMicroUsd,
  });

  headers?.set(COST_HEADER, usdHeader(chargedMicroUsd));
  headers?.set(BALANCE_HEADER, usdHeader(balanceMicroUsd));
}

/**
 * What OpenRouter charged Milo for this call, in micro-USD.
 *
 * `usage.cost` is the number to use and OpenRouter puts it on the chat and
 * Responses dialects. On the Anthropic dialect it is not always there -- the
 * Messages shape is Anthropic's, and the cost field is OpenRouter's addition
 * to it -- so when it is missing the cost is estimated from the token counts
 * and the shipped roster's per-million prices (ADR-006's table, the same
 * numbers `/v1/roster` publishes). That estimate is approximate: it does not
 * know about cache discounts, provider surcharges, or a model that is not in
 * the table at all, so it is logged when it is used and `undefined` when the
 * model is unknown, which charges nothing rather than guessing.
 */
function upstreamCost(deps: AppDeps, ctx: ChargeContext, usage: UpstreamUsage): MicroUsd | undefined {
  if (usage.costUsd !== undefined) return usdToMicro(usage.costUsd);
  if (usage.inputTokens === undefined && usage.outputTokens === undefined) return undefined;

  const priced = defaultRosterModel(ctx.model);
  if (priced === undefined) return undefined;

  const usd =
    ((usage.inputTokens ?? 0) * priced.inputUsdPerM + (usage.outputTokens ?? 0) * priced.outputUsdPerM) / 1_000_000;
  deps.logger.warn("no upstream cost reported; estimated from roster prices", {
    ...(ctx.decisionId !== undefined ? { decisionId: ctx.decisionId } : {}),
    model: ctx.model,
    surface: ctx.surface,
  });
  return usdToMicro(usd);
}

/**
 * Records which account a decision belongs to, so `/v1/decisions*` can scope
 * its answers (ADR-007). The router writes the decision row before the
 * gateway gets control, so this is an update rather than an insert, and a
 * failure is logged rather than raised: a missing account stamp costs the
 * user a row in their own history, not their answer.
 */
export async function noteDecisionAccount(c: Context, deps: AppDeps, decisionId: string): Promise<void> {
  const auth = authOf(c);
  if (auth.kind !== "milo") return;
  try {
    await deps.log.setAccount(decisionId, auth.account.id);
  } catch (err) {
    deps.logger.error("decision account stamp failed", { decisionId, error: errorMessage(err) });
  }
}

/**
 * Stamps the caller's key hash on a decision, the same way `noteDecisionAccount`
 * stamps an account: the router logs the decision before the gateway's
 * tenant-limits guard has anywhere to put it, so this is an update after the
 * fact. Only writes when a deployment tracks per-key spend (`tenantLimits`'s
 * spend cap), so an unconfigured deployment's decisions carry no key hash and
 * this never touches the database. A failure is logged rather than raised: a
 * missing stamp costs the spend cap one under-counted row, not the caller's
 * answer.
 */
export async function noteDecisionKeyHash(c: Context, deps: AppDeps, decisionId: string): Promise<void> {
  if (deps.tenantLimits?.spendCapEnabled !== true) return;
  try {
    await deps.log.setKeyHash(decisionId, callerScope(c));
  } catch (err) {
    deps.logger.error("decision key-hash stamp failed", { decisionId, error: errorMessage(err) });
  }
}

/** The account whose decisions this caller may read, or undefined for BYOK. */
export function decisionScope(c: Context): AccountId | undefined {
  const auth = authOf(c);
  return auth.kind === "milo" ? auth.account.id : undefined;
}

// ---------------------------------------------------------------------------
// Shared rendering
// ---------------------------------------------------------------------------

/** Micro-USD as the header carries it: plain USD, six decimals, no symbol. */
export function usdHeader(micro: MicroUsd): string {
  return microToUsd(micro).toFixed(6);
}

/** An error in whichever dialect the requested path speaks. */
export function dialectError(
  c: Context,
  status: 401 | 402 | 403 | 503,
  message: string,
  type: "authentication_error" | "api_error" | "invalid_request_error",
  code: string,
): Response {
  if (!isAnthropicPath(new URL(c.req.url).pathname)) return errorResponse(c, status, message, type, code);
  const anthropicType = type === "invalid_request_error" ? "permission_error" : type;
  return anthropicErrorResponse(c, status, message, anthropicType);
}

function refusal(c: Context, err: AuthRefusal): Response {
  const type =
    err.status === 401 ? "authentication_error" : err.status === 403 ? "invalid_request_error" : "api_error";
  return dialectError(c, err.status, err.message, type, err.code);
}

/**
 * `InsufficientBalanceError` by name rather than by `instanceof`: the store
 * is injected, so the class it threw may come from a different module
 * instance than the one this package imports.
 */
function isInsufficientBalance(err: unknown): boolean {
  return err instanceof Error && err.name === "InsufficientBalanceError";
}
