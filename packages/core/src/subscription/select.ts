/**
 * Backend selection (ADR-031): task preference, then remaining capacity.
 *
 * Each task family has a preferred subscription. That preference only
 * breaks ties: a subscription that is refusing work goes last, one below the
 * reserve goes behind one with more room, and when both report a number and
 * the other has much more left, work moves to the other. The point is to
 * spend the plan that has capacity going unused.
 */

import type { TaskType } from "../types.js";
import type { CapacitySnapshot, Classification, SubscriptionId } from "./types.js";

export type SelectionPolicy = {
  /** Below this many percent left, a subscription yields to one with more. Default 10. */
  reservePercent: number;
  /** Switch away from the preferred subscription when the other has this many more percent left. Default 30. */
  balanceMarginPercent: number;
};

export const DEFAULT_SELECTION_POLICY: SelectionPolicy = { reservePercent: 10, balanceMarginPercent: 30 };

/**
 * Which subscription each task family tries first. Code-changing work starts
 * on Codex; prose, analysis and conversation start on Claude. This is a
 * starting point to be revised from replay results, not a measured ranking.
 */
export const TASK_PREFERENCE: Record<TaskType, SubscriptionId> = {
  edit: "codex",
  feature: "codex",
  debug: "codex",
  ops: "codex",
  chat: "claude",
  research: "claude",
  docs: "claude",
  review: "claude",
  classify: "claude",
};

export type Selection = {
  /** Every available backend, in the order to try them. */
  order: SubscriptionId[];
  /** One sentence: why the first backend was chosen. */
  reason: string;
};

export function selectBackends(
  classification: Classification,
  capacity: CapacitySnapshot[],
  available: SubscriptionId[],
  policy: SelectionPolicy = DEFAULT_SELECTION_POLICY,
): Selection {
  const snap = (id: SubscriptionId): CapacitySnapshot | undefined => capacity.find((s) => s.backend === id);
  const preferred = TASK_PREFERENCE[classification.taskType];
  const byPreference = [...available].sort((a, b) => (a === preferred ? -1 : b === preferred ? 1 : 0));
  const why = `${classification.taskType} task prefers ${preferred}`;

  if (byPreference.length === 0) return { order: [], reason: "no subscription backend is available" };

  const open = byPreference.filter((id) => snap(id)?.limited !== true);
  const limited = byPreference
    .filter((id) => snap(id)?.limited === true)
    .sort((a, b) => (snap(a)?.limitedUntil ?? "").localeCompare(snap(b)?.limitedUntil ?? ""));

  if (open.length === 0) {
    return {
      order: limited,
      reason: `${why}; every subscription is rate-limited, so ${limited[0]} (soonest reset) is tried first`,
    };
  }

  const [first, second] = open as [SubscriptionId, ...SubscriptionId[]];
  const capacityNote = open.map((id) => describe(snap(id))).join(", ");

  if (first !== preferred && byPreference.includes(preferred)) {
    return { order: [...open, ...limited], reason: `${why}, but ${preferred} is rate-limited; ${capacityNote}` };
  }

  if (second !== undefined) {
    const r1 = snap(first)?.remainingPercent;
    const r2 = snap(second)?.remainingPercent;
    if (r1 !== undefined && r1 < policy.reservePercent && (r2 === undefined || r2 > r1)) {
      return {
        order: [second, first, ...open.slice(2), ...limited],
        reason: `${why}, but ${first} is below its ${policy.reservePercent}% reserve; ${capacityNote}`,
      };
    }
    if (r1 !== undefined && r2 !== undefined && r2 - r1 > policy.balanceMarginPercent) {
      return {
        order: [second, first, ...open.slice(2), ...limited],
        reason: `${why}, but ${second} has far more capacity left; ${capacityNote}`,
      };
    }
  }

  return { order: [...open, ...limited], reason: `${why}; ${capacityNote}` };
}

function describe(s: CapacitySnapshot | undefined): string {
  if (s === undefined) return "unknown";
  if (s.remainingPercent !== undefined) {
    return `${s.backend} ${s.remainingPercent}% left${s.window !== undefined ? ` (${s.window})` : ""}`;
  }
  return `${s.backend} capacity unknown`;
}
