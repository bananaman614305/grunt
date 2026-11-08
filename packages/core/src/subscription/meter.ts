/**
 * The per-subscription usage meter (ADR-031).
 *
 * Holds the latest plan-limit reading each CLI gave and any rate-limit
 * refusal Milo has seen, and turns them into a `CapacitySnapshot` the router
 * can act on. When a CLI has never reported a number, the snapshot says so
 * (`source: "unknown"`), or, once Milo has its own calls and refusals to go
 * on, `"estimated"`: limited or not, with no percentage invented.
 */

import type { UsageStore } from "./store.js";
import { SUBSCRIPTIONS } from "./types.js";
import type { BackendOutcome, CapacitySnapshot, LimitSignal, LimitWindow, SubscriptionId } from "./types.js";

export type UsageMeterOptions = {
  store?: UsageStore;
  now?: () => number;
  /**
   * How long a subscription counts as limited after a rate-limit error when
   * the CLI did not say when the limit resets. Default 15 minutes.
   */
  cooldownMs?: number;
};

const DEFAULT_COOLDOWN_MS = 15 * 60 * 1000;

type State = {
  limits?: LimitSignal;
  /** Epoch ms until which the subscription is treated as refusing work. */
  limitedUntil?: number;
  calls: number;
};

export class UsageMeter {
  private readonly state = new Map<SubscriptionId, State>();
  private readonly store: UsageStore | undefined;
  private readonly now: () => number;
  private readonly cooldownMs: number;

  constructor(opts: UsageMeterOptions = {}) {
    this.store = opts.store;
    this.now = opts.now ?? Date.now;
    this.cooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    for (const id of SUBSCRIPTIONS) this.state.set(id, { calls: 0 });
  }

  /** Restores the last readings and any still-running cooldown from the store. */
  async load(): Promise<void> {
    if (this.store === undefined) return;
    const [limits, lastLimited] = await Promise.all([this.store.loadLimits(), this.store.lastRateLimited()]);
    for (const id of SUBSCRIPTIONS) {
      const state = this.get(id);
      const reading = limits[id];
      if (reading !== undefined) state.limits = reading;
      const at = lastLimited[id];
      if (at !== undefined) {
        const until = this.limitEnd(reading, Date.parse(at));
        if (until > this.now()) state.limitedUntil = until;
      }
    }
  }

  /** Records a fresh limit reading from a CLI. */
  async observe(backend: SubscriptionId, limits: LimitSignal): Promise<void> {
    const state = this.get(backend);
    state.limits = limits;
    if (limits.status === "limited") state.limitedUntil = this.limitEnd(limits, this.now());
    else if (state.limitedUntil !== undefined && limits.status === "allowed") delete state.limitedUntil;
    await this.store?.saveLimits(backend, limits);
  }

  /** Notes the outcome of one call: its limits, and a cooldown on a rate-limit refusal. */
  async recordOutcome(backend: SubscriptionId, outcome: BackendOutcome): Promise<void> {
    const state = this.get(backend);
    state.calls += 1;
    if (outcome.limits !== undefined) await this.observe(backend, outcome.limits);
    if (!outcome.ok && outcome.error === "rate_limited") {
      state.limitedUntil = this.limitEnd(outcome.limits ?? state.limits, this.now());
    }
  }

  snapshot(backend: SubscriptionId): CapacitySnapshot {
    const state = this.get(backend);
    const now = this.now();
    const limitedUntil = state.limitedUntil !== undefined && state.limitedUntil > now ? state.limitedUntil : undefined;
    const snapshot: CapacitySnapshot = {
      backend,
      limited: limitedUntil !== undefined,
      source: state.calls > 0 || limitedUntil !== undefined ? "estimated" : "unknown",
    };
    if (limitedUntil !== undefined) snapshot.limitedUntil = new Date(limitedUntil).toISOString();

    const limits = state.limits;
    if (limits !== undefined) {
      snapshot.observedAt = limits.observedAt;
      const tightest = tightestWindow(limits.windows, now);
      if (tightest !== undefined) {
        snapshot.source = "cli";
        snapshot.usedPercent = tightest.usedPercent;
        snapshot.remainingPercent = round1(100 - tightest.usedPercent);
        snapshot.window = tightest.name;
        if (tightest.resetsAt !== undefined) snapshot.resetsAt = tightest.resetsAt;
        if (tightest.usedPercent >= 100 && !snapshot.limited) {
          snapshot.limited = true;
          if (tightest.resetsAt !== undefined) snapshot.limitedUntil = tightest.resetsAt;
        }
      }
    }
    return snapshot;
  }

  snapshots(): CapacitySnapshot[] {
    return SUBSCRIPTIONS.map((id) => this.snapshot(id));
  }

  private get(id: SubscriptionId): State {
    let state = this.state.get(id);
    if (state === undefined) {
      state = { calls: 0 };
      this.state.set(id, state);
    }
    return state;
  }

  /**
   * When a refusal is expected to lift: the reset of the fullest window
   * the CLI reported, else `from` plus the cooldown.
   */
  private limitEnd(limits: LimitSignal | undefined, from: number): number {
    const resets = (limits?.windows ?? [])
      .filter((w) => w.resetsAt !== undefined && (w.usedPercent ?? 100) >= 100)
      .map((w) => Date.parse(w.resetsAt as string))
      .filter((t) => Number.isFinite(t) && t > from);
    if (resets.length > 0) return Math.min(...resets);
    return from + this.cooldownMs;
  }
}

/**
 * The fullest window that has a usage number. A window whose reset time has
 * already passed has reset, so it counts as empty.
 */
function tightestWindow(
  windows: LimitWindow[],
  now: number,
): (LimitWindow & { usedPercent: number }) | undefined {
  let best: (LimitWindow & { usedPercent: number }) | undefined;
  for (const w of windows) {
    if (w.usedPercent === undefined) continue;
    const reset = w.resetsAt !== undefined ? Date.parse(w.resetsAt) : NaN;
    const used = Number.isFinite(reset) && reset <= now ? 0 : w.usedPercent;
    if (best === undefined || used > best.usedPercent) best = { ...w, usedPercent: used };
  }
  return best;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
