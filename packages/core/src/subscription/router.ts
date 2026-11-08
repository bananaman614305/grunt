/**
 * The local subscription router (ADR-031): classify, pick a subscription by
 * task and remaining capacity, run it, and fail over to the other
 * subscription when the first refuses.
 */

import { ulid } from "ulid";
import type { ChatMessage } from "../types.js";
import { heuristicClassify } from "./classify.js";
import type { UsageMeter } from "./meter.js";
import { toPrompt } from "./prompt.js";
import { DEFAULT_SELECTION_POLICY, selectBackends } from "./select.js";
import type { SelectionPolicy } from "./select.js";
import type { UsageStore } from "./store.js";
import type {
  BackendErrorKind,
  BackendOutcome,
  CapacitySnapshot,
  Classification,
  Classifier,
  SubscriptionBackend,
  SubscriptionId,
} from "./types.js";

export type SubscriptionRouterOptions = {
  backends: SubscriptionBackend[];
  meter: UsageMeter;
  /** Where each call is recorded. Optional so tests can run without SQLite. */
  store?: UsageStore;
  /** Defaults to the local heuristic. */
  classify?: Classifier;
  policy?: Partial<SelectionPolicy>;
  /** Re-read plan limits from CLIs that can report them when the last reading is older. Default 5 minutes. */
  limitsMaxAgeMs?: number;
  now?: () => number;
  newId?: () => string;
  onError?: (message: string, meta?: Record<string, unknown>) => void;
};

export type SubscriptionDecision = {
  id: string;
  classification: Classification;
  /** Backends in the order they will be tried. */
  order: SubscriptionId[];
  reason: string;
  /** Set when the request named its backend; no failover then. */
  forced?: SubscriptionId;
  capacity: CapacitySnapshot[];
  createdAt: string;
};

export type Attempt = { backend: SubscriptionId; outcome: BackendOutcome };

export type RouteResult = {
  decision: SubscriptionDecision;
  attempts: Attempt[];
  /** The backend whose answer is returned, when one answered. */
  served?: SubscriptionId;
  /** The last attempt's outcome. */
  outcome: BackendOutcome;
};

export type CompleteRequest = {
  messages: ChatMessage[];
  /** Run only this backend. */
  force?: SubscriptionId;
  /** CLI model override; only used with `force`. */
  model?: string;
  signal?: AbortSignal;
  onText?: (delta: string) => void;
  /** Called once, just before the first backend starts. */
  onDecision?: (decision: SubscriptionDecision) => void;
  /** Called before each backend is tried, so a streaming caller knows which one is answering. */
  onAttempt?: (backend: SubscriptionId, earlier: readonly Attempt[]) => void;
};

/** Errors after which trying the other subscription makes sense. */
const FAILOVER_ON: ReadonlySet<BackendErrorKind> = new Set(["rate_limited", "unavailable", "auth", "failed"]);

const DEFAULT_LIMITS_MAX_AGE_MS = 5 * 60 * 1000;

export class SubscriptionRouter {
  private readonly backends: Map<SubscriptionId, SubscriptionBackend>;
  private readonly opts: SubscriptionRouterOptions;
  private readonly policy: SelectionPolicy;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly classify: Classifier;
  private readonly lastLimitsRead = new Map<SubscriptionId, number>();
  private readonly refreshing = new Map<SubscriptionId, Promise<void>>();

  constructor(opts: SubscriptionRouterOptions) {
    this.opts = opts;
    this.backends = new Map(opts.backends.map((b) => [b.id, b]));
    this.policy = { ...DEFAULT_SELECTION_POLICY, ...opts.policy };
    this.now = opts.now ?? Date.now;
    this.newId = opts.newId ?? (() => ulid());
    this.classify = opts.classify ?? (async (messages) => heuristicClassify(messages));
  }

  get available(): SubscriptionId[] {
    return [...this.backends.keys()];
  }

  /** What the meter knows right now about every enabled backend. */
  capacity(): CapacitySnapshot[] {
    return this.opts.meter.snapshots().filter((s) => this.backends.has(s.backend));
  }

  /**
   * Re-reads plan limits from every backend that can report them without
   * spending quota, when the last reading is older than `maxAgeMs`. Never
   * throws; a failed read leaves the previous reading in place.
   */
  async refreshLimits(maxAgeMs = this.opts.limitsMaxAgeMs ?? DEFAULT_LIMITS_MAX_AGE_MS): Promise<void> {
    await Promise.all(
      [...this.backends.values()].map((backend) => {
        if (backend.readLimits === undefined) return Promise.resolve();
        const last = this.lastLimitsRead.get(backend.id);
        if (last !== undefined && this.now() - last < maxAgeMs) return Promise.resolve();
        const inFlight = this.refreshing.get(backend.id);
        if (inFlight !== undefined) return inFlight;
        const work = (async () => {
          try {
            const limits = await backend.readLimits?.();
            this.lastLimitsRead.set(backend.id, this.now());
            if (limits !== undefined) await this.opts.meter.observe(backend.id, limits);
          } catch (error) {
            this.opts.onError?.("limits read failed", { backend: backend.id, error: String(error) });
          } finally {
            this.refreshing.delete(backend.id);
          }
        })();
        this.refreshing.set(backend.id, work);
        return work;
      }),
    );
  }

  async decide(messages: ChatMessage[], opts: { force?: SubscriptionId; signal?: AbortSignal } = {}): Promise<SubscriptionDecision> {
    // Stale readings are refreshed in the background; this request uses what is known now.
    void this.refreshLimits();
    const classification = await this.classify(messages, opts.signal);
    const capacity = this.capacity();
    const base = { id: this.newId(), classification, capacity, createdAt: new Date(this.now()).toISOString() };

    if (opts.force !== undefined) {
      return { ...base, order: [opts.force], forced: opts.force, reason: `the request asked for ${opts.force}` };
    }
    const selection = selectBackends(classification, capacity, this.available, this.policy);
    return { ...base, order: selection.order, reason: selection.reason };
  }

  async complete(req: CompleteRequest): Promise<RouteResult> {
    if (req.force !== undefined && !this.backends.has(req.force)) {
      throw new Error(`subscription backend "${req.force}" is not enabled`);
    }
    const decision = await this.decide(req.messages, {
      ...(req.force !== undefined ? { force: req.force } : {}),
      ...(req.signal !== undefined ? { signal: req.signal } : {}),
    });
    req.onDecision?.(decision);

    const flat = toPrompt(req.messages);
    const attempts: Attempt[] = [];
    let streamed = false;
    let outcome: BackendOutcome = {
      ok: false,
      error: "unavailable",
      message: "no subscription backend is available",
      latencyMs: 0,
    };

    for (const id of decision.order) {
      const backend = this.backends.get(id);
      if (backend === undefined) continue;
      req.onAttempt?.(id, attempts);
      outcome = await backend.run({
        ...flat,
        ...(req.force !== undefined && req.model !== undefined ? { model: req.model } : {}),
        ...(req.signal !== undefined ? { signal: req.signal } : {}),
        onText: (delta) => {
          streamed = true;
          req.onText?.(delta);
        },
      });
      attempts.push({ backend: id, outcome });
      await this.record(decision, id, outcome);

      if (outcome.ok) return { decision, attempts, served: id, outcome };
      // Once text has reached the caller, a second answer cannot be spliced in.
      if (streamed || decision.forced !== undefined || !FAILOVER_ON.has(outcome.error)) break;
    }
    return { decision, attempts, outcome };
  }

  private async record(decision: SubscriptionDecision, backend: SubscriptionId, outcome: BackendOutcome): Promise<void> {
    try {
      await this.opts.meter.recordOutcome(backend, outcome);
      await this.opts.store?.recordCall({
        id: this.newId(),
        decisionId: decision.id,
        backend,
        createdAt: new Date(this.now()).toISOString(),
        ok: outcome.ok,
        ...(!outcome.ok ? { error: outcome.error } : {}),
        latencyMs: outcome.latencyMs,
        inputTokens: outcome.ok ? outcome.usage.inputTokens : 0,
        cachedInputTokens: outcome.ok ? outcome.usage.cachedInputTokens : 0,
        outputTokens: outcome.ok ? outcome.usage.outputTokens : 0,
        ...(outcome.ok && outcome.usage.apiEquivalentUsd !== undefined
          ? { apiEquivalentUsd: outcome.usage.apiEquivalentUsd }
          : {}),
        taskType: decision.classification.taskType,
        reason: decision.reason,
      });
    } catch (error) {
      // Metering must never fail a request that already has its answer.
      this.opts.onError?.("usage record failed", { backend, error: String(error) });
    }
  }
}
