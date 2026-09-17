/**
 * Operator helpers, as plain functions rather than a CLI so the orchestrator
 * can import them from a script (`tsx scripts/whatever.ts`) and so they stay
 * testable. Nothing here reads argv or writes to stdout.
 */
import type { Account, AccountId, BillingStore, LedgerEntry, MicroUsd } from "@milo/core";
import type { PgBillingStore } from "./store.js";

/**
 * Puts credit on an account by hand -- a goodwill grant, a support refund, a
 * migration from an old balance. It goes through `postLedger` like every
 * other balance change, so it shows up in the account's history with the
 * operator's note as its reference rather than appearing from nowhere.
 *
 * `micro` may be negative to claw credit back; a negative grant is subject to
 * the same reserve floor as ordinary spend.
 */
export async function grantCredit(
  store: BillingStore,
  accountId: AccountId,
  micro: MicroUsd,
  note: string,
): Promise<LedgerEntry> {
  if (!Number.isInteger(micro) || micro === 0) {
    throw new Error(`billing: grantCredit needs a non-zero integer of micro-USD, got ${micro}`);
  }
  if (note.trim() === "") {
    throw new Error("billing: grantCredit needs a note; it becomes the ledger entry's reference");
  }
  return store.postLedger({ accountId, kind: "adjustment", amountMicroUsd: micro, reference: note });
}

/** Newest accounts first. */
export async function listAccounts(store: PgBillingStore, opts?: { limit?: number }): Promise<Account[]> {
  return store.listAccounts(opts);
}
