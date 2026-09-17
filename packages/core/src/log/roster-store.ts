/**
 * The per-key roster store's contract.
 *
 * A user who already runs OpenRouter has opinions about models, and
 * onboarding now asks for them (ADR-008). What they answer has to outlive the
 * conversation that collected it, and it has to be scoped to *them* on a
 * shared deployment -- but Milo never stores an OpenRouter key (ADR-003). So
 * the row is keyed by the SHA-256 of the bearer credential, the same hash the
 * rate limiter buckets on: enough to recognise the same caller again, useless
 * to anyone who reads the table.
 *
 * `DecisionLog` implements this, for the same reason it implements
 * `StickyStore`: one database, one migration path, one file to back up.
 */

import type { Roster } from "../types.js";

/** Where a stored roster came from. Only users write to this table today. */
export type RosterSource = "user";

/** A 64-character lowercase hex SHA-256, which is all the store ever holds. */
const KEY_HASH = /^[0-9a-f]{64}$/;

/**
 * Guards the one invariant that matters here: the store is given a hash, not
 * a key. A caller that passes a raw credential by mistake gets an error
 * instead of a row containing it.
 */
export function assertKeyHash(keyHash: string): void {
  if (!KEY_HASH.test(keyHash)) {
    throw new Error(
      "roster store: key must be a SHA-256 hex digest of the credential, not the credential itself",
    );
  }
}

export type StoredRoster = {
  keyHash: string;
  roster: Roster;
  source: RosterSource;
  /** ISO 8601, first time this key stored a roster. */
  createdAt: string;
  /** ISO 8601, last write. */
  updatedAt: string;
};

/** One row as `milo roster list` prints it: no model ids, just the shape. */
export type StoredRosterSummary = {
  keyHash: string;
  /** Model ids across all three tiers. */
  modelCount: number;
  source: RosterSource;
  createdAt: string;
  updatedAt: string;
};

export type RosterMeta = {
  /** Defaults to `"user"`. */
  source?: RosterSource;
  /** ISO 8601 write time; defaults to now. Injectable for tests. */
  now?: string;
};

export type RosterStore = {
  getRoster(keyHash: string): Promise<StoredRoster | undefined>;
  setRoster(keyHash: string, roster: Roster, meta?: RosterMeta): Promise<StoredRoster>;
  /** True when a row was there to remove. */
  deleteRoster(keyHash: string): Promise<boolean>;
  listRosters(opts?: { limit?: number }): Promise<StoredRosterSummary[]>;
};

/** Model ids across every tier. */
export function rosterModelCount(roster: Roster): number {
  return Object.values(roster).reduce((total, ids) => total + ids.length, 0);
}
