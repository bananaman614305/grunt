/**
 * Persistence for sticky routing decisions, so a redeploy does not re-ask
 * Jev for every live conversation. The in-memory StickyCache stays the fast
 * path; a store backs it. `userTurns` is how many user messages the
 * decision was made for: a later request with more user turns is a new ask
 * and is re-evaluated, while a tool-result continuation reuses the entry.
 */
import type { RouteDecision } from "../types.js";

export type StickyEntry = {
  decision: RouteDecision;
  userTurns: number;
  expiresAt: number; // epoch ms
};

export interface StickyStore {
  get(fingerprint: string): Promise<StickyEntry | undefined>;
  set(fingerprint: string, entry: StickyEntry): Promise<void>;
  delete(fingerprint: string): Promise<void>;
}
