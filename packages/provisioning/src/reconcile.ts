/**
 * Reconciles OpenRouter's reported spend on each account's sub-key against
 * what Milo actually charged, and posts a ledger `adjustment` to true up any
 * gap. The gap this catches: a stream cut before its final usage chunk
 * arrives, so Milo never learns the request's cost and never calls
 * `recordUsage` for it, while OpenRouter still billed the sub-key for the
 * tokens it generated.
 *
 * Checkpointing: `BillingStore`/`Account` are pinned (ADR-007) and have no
 * dedicated "last reconciled at" field, so there is nowhere to durably store
 * a running "OpenRouter usage as of the last checkpoint" baseline other than
 * the ledger itself. Instead this derives everything from data the store
 * already has, using an invariant that holds by construction:
 *
 *   openRouterUsage (all-time, from OpenRouter) is always equal to
 *   miloUpstreamRecorded (all-time sum of usage_records.upstream_cost_micro_usd)
 *   plus priorReconcileAdjustments (all-time sum of adjustments this function
 *   has already posted) -- UNLESS a stream-cut (or other) gap has opened up
 *   a new, not-yet-reconciled difference.
 *
 * So each run computes:
 *
 *   discrepancy = openRouterUsage - priorReconcileAdjustments - miloUpstreamRecorded
 *
 * and, if positive, posts an adjustment of exactly that amount with
 * reference `reconcile:<hash>:<iso>`. That adjustment brings
 * `priorReconcileAdjustments` back into balance, so calling this again
 * immediately (no new usage in between) recomputes `discrepancy` as 0 and
 * posts nothing -- idempotent for the same checkpoint without needing a
 * separate stored cursor. `checkpoint` in the result is the timestamp of the
 * latest reconcile adjustment on file for that account (or the account's
 * `createdAt` if none has ever been posted), reported for observability and
 * for callers that want to log "usage since <checkpoint>".
 */

import type { Account, BillingStore } from "@milo/core";
import { usdToMicro } from "@milo/core";
import type { OpenRouterProvisioningClient } from "./client.js";

const RECONCILE_PREFIX = (hash: string) => `reconcile:${hash}:`;

export type ReconcileAccountResult = {
  accountId: string;
  hash: string;
  openRouterUsageMicroUsd: number;
  miloUpstreamMicroUsd: number;
  priorAdjustmentsMicroUsd: number;
  /** 0 when OpenRouter's reported spend is already fully accounted for. */
  discrepancyMicroUsd: number;
  posted: boolean;
  /** ISO timestamp of the last (now-current, if `posted`) reconcile checkpoint. */
  checkpoint: string;
};

export type ReconcileSummary = {
  accounts: ReconcileAccountResult[];
  totalPostedMicroUsd: number;
};

export async function reconcileUsage(opts: {
  store: BillingStore;
  client: OpenRouterProvisioningClient;
  accounts: Account[];
  /** Injectable clock for tests. Defaults to `() => new Date()`. */
  now?: () => Date;
}): Promise<ReconcileSummary> {
  const { store, client, accounts } = opts;
  const now = opts.now ?? (() => new Date());

  const results: ReconcileAccountResult[] = [];
  for (const account of accounts) {
    const hash = account.openRouterSubKeyHash;
    if (!hash) continue; // nothing provisioned yet, nothing to reconcile

    const keyInfo = await client.getKey(hash);
    const openRouterUsageMicroUsd = usdToMicro(keyInfo.usageUsd);

    const ledger = await store.listLedger(account.id);
    const prefix = RECONCILE_PREFIX(hash);
    let priorAdjustmentsMicroUsd = 0;
    let checkpoint = account.createdAt;
    for (const entry of ledger) {
      if (entry.kind !== "adjustment" || !entry.reference.startsWith(prefix)) continue;
      // amountMicroUsd is negative (a spend); its magnitude is the amount
      // previously recognized as OpenRouter usage Milo hadn't yet charged.
      priorAdjustmentsMicroUsd += -entry.amountMicroUsd;
      if (entry.createdAt > checkpoint) checkpoint = entry.createdAt;
    }

    const usage = await store.usageSummary(account.id);
    const miloUpstreamMicroUsd = usage.upstreamCostMicroUsd;

    const discrepancyMicroUsd = openRouterUsageMicroUsd - priorAdjustmentsMicroUsd - miloUpstreamMicroUsd;

    let posted = false;
    if (discrepancyMicroUsd > 0) {
      const iso = now().toISOString();
      await store.postLedger({
        accountId: account.id,
        kind: "adjustment",
        amountMicroUsd: -discrepancyMicroUsd,
        reference: `reconcile:${hash}:${iso}`,
      });
      posted = true;
      checkpoint = iso;
    }

    results.push({
      accountId: account.id,
      hash,
      openRouterUsageMicroUsd,
      miloUpstreamMicroUsd,
      priorAdjustmentsMicroUsd,
      discrepancyMicroUsd: Math.max(0, discrepancyMicroUsd),
      posted,
      checkpoint,
    });
  }

  return {
    accounts: results,
    totalPostedMicroUsd: results.reduce((sum, r) => sum + (r.posted ? r.discrepancyMicroUsd : 0), 0),
  };
}
