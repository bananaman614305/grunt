/**
 * The router: conversation in, routing decision out.
 *
 * Order of operations, cheapest first:
 *   1. a forced tier skips Jev entirely;
 *   2. a sticky hit on the fingerprint *at the same user-turn count* reuses
 *      the decision -- from memory, else from the `StickyStore` if one is
 *      configured;
 *   3. an identical ask already in flight is joined rather than duplicated;
 *   4. otherwise one Jev `/v1/systemone` call under a hard
 *      `jevTimeoutMs` budget (retries and backoff included), then Policy v2
 *      and the roster.
 *
 * ## There is no fallback tier
 *
 * Jev is the only decision backend (ADR-002 revision 3). When it cannot
 * answer -- after retries, or because the circuit breaker is open -- `route`
 * **throws** `RoutingUnavailableError` and the gateway turns that into a 503.
 * It does not return a `mid`-tier guess.
 *
 * The old behaviour returned `mid` and marked the decision degraded, which
 * reads as robustness and is not: a request that asked for `milo/auto` asked
 * to be routed, and a silent `mid` is a wrong answer billed at Sonnet prices,
 * indistinguishable in the response from a right one. It also hid outages --
 * the Fly deployment served degraded decisions for an entire cold-start
 * window and looked healthy throughout. Failing loudly puts the choice back
 * with the caller, who can retry, pick a model explicitly, or degrade in a
 * way that suits them. An explicit model id still passes through untouched;
 * only `milo/auto` needs a routing answer, so only `milo/auto` can fail here.
 *
 * The reason and the error message name the *class* of failure and never the
 * upstream error text, so no key material can reach a response header or the
 * decision log (ADR-003).
 */

import { ulid } from "ulid";
import type { JevClientLike, JevAnswer, SystemOneResult } from "../jev/types.js";
import type { ChatMessage, RouteDecision, RouteRequest, RouteSignals, Roster, TaskType } from "../types.js";
import { DEFAULT_ROSTER, POLICY_VERSION, ROUTER_LIMITS, TASK_TYPES } from "../types.js";
import { CircuitBreaker } from "./breaker.js";
import type { BreakerStatus, CircuitBreakerOptions } from "./breaker.js";
import { buildJevState, countUserTurns } from "./context.js";
import { RoutingUnavailableError } from "./errors.js";
import type { RoutingUnavailableCause } from "./errors.js";
import { chooseTier, JEV_PROFILE } from "./policy.js";
import type { PolicyProfile } from "./policy.js";
import { ROUTER_QUESTIONS } from "./questions.js";
import { resolveModel } from "./roster.js";
import { StickyCache } from "./sticky.js";
import type { StickyEntry, StickyStore } from "./sticky-store.js";

export type RouterOptions = {
  jev: JevClientLike;
  roster?: Roster;
  sticky?: StickyCache;
  /**
   * Durable backing for the sticky cache. Consulted on a memory miss and
   * written through on every write, so a redeploy or a second instance does
   * not re-ask Jev for every live conversation. `DecisionLog` implements it.
   */
  stickyStore?: StickyStore;
  /**
   * How long a decision stays pinned. Defaults to
   * `ROUTER_LIMITS.stickyTtlMs` (30 minutes). Ignored when `sticky` is passed;
   * that cache carries its own TTL.
   */
  stickyTtlMs?: number;
  /** Injectable for tests; defaults to Date.now. */
  clock?: () => number;
  /**
   * Called with every decision the router returns. Awaited before `route`
   * resolves; a hook that throws or rejects is caught and handed to `onError`
   * rather than breaking routing. Not called when `route` throws: there is no
   * decision to record.
   */
  onDecision?: (decision: RouteDecision) => void | Promise<void>;
  /** Called when `onDecision` or a sticky-store write throws. Defaults to a no-op. */
  onError?: (err: unknown) => void;
  /**
   * Total budget for getting an answer out of Jev, retries and backoff
   * included. Defaults to `ROUTER_LIMITS.jevTimeoutMs`.
   */
  jevTimeoutMs?: number;
  /**
   * Policy v2 threshold set. Defaults to the validated `JEV_PROFILE`; pass one
   * to try a candidate set without editing `policy.ts`.
   */
  profile?: PolicyProfile;
  /** Circuit-breaker tuning. The clock defaults to the router's. */
  breaker?: CircuitBreakerOptions;
};

/** A Jev answer that does not match its question's shape. */
class AnswerValidationError extends Error {
  override readonly name = "AnswerValidationError";
}

/** The router's own deadline, in case the client ignores the abort signal. */
class JevTimeoutError extends Error {
  override readonly name = "JevTimeoutError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Reads a `noul` answer as a probability in [0, 1]. */
function readNoul(answer: JevAnswer | undefined, key: string): number {
  if (!isRecord(answer) || answer["type"] !== "noul") {
    throw new AnswerValidationError(`answer "${key}" is not a noul`);
  }
  const noul = answer["noul"];
  if (!finite(noul) || noul < 0 || noul > 1) {
    throw new AnswerValidationError(`answer "${key}" has an out-of-range noul`);
  }
  return noul;
}

function readTaskType(answer: JevAnswer | undefined): { taskType: TaskType; confidence: number } {
  if (!isRecord(answer) || answer["type"] !== "choice") {
    throw new AnswerValidationError('answer "task_type" is not a choice');
  }
  const choice = answer["choice"];
  if (typeof choice !== "string" || !(TASK_TYPES as readonly string[]).includes(choice)) {
    throw new AnswerValidationError('answer "task_type" is not a known task type');
  }
  const confidence = answer["confidence"];
  return { taskType: choice as TaskType, confidence: finite(confidence) ? confidence : 0 };
}

/**
 * Reads the per-level probability mass off a score answer, ordered 0..3. A
 * key the backend omitted reads as 0.
 *
 * An answer that carries no distribution at all -- no `probabilities` field,
 * an empty one, or one whose mass sums to zero -- gets an empty array, and the
 * policy falls back to the expected-score rule. An all-zero array would
 * otherwise read as "certainly trivial" and send every request to `fast`.
 */
function readDifficultyLevels(answer: Record<string, unknown>, levelCount: number): number[] {
  const probabilities = answer["probabilities"];
  if (!isRecord(probabilities)) return [];
  const levels: number[] = [];
  let total = 0;
  for (let level = 0; level < levelCount; level += 1) {
    const value = probabilities[String(level)];
    const mass = finite(value) && value > 0 ? value : 0;
    levels.push(mass);
    total += mass;
  }
  return total > 0 ? levels : [];
}

function difficultyLevelCount(): number {
  const question = ROUTER_QUESTIONS["difficulty"];
  return question && question.type === "score" ? question.criteria.length : 4;
}

function readDifficulty(answer: JevAnswer | undefined): {
  difficulty: number;
  confidence: number;
  levels: number[];
} {
  if (!isRecord(answer) || answer["type"] !== "score") {
    throw new AnswerValidationError('answer "difficulty" is not a score');
  }
  const score = answer["score"];
  const levelCount = difficultyLevelCount();
  const max = levelCount - 1;
  if (!finite(score) || score < 0 || score > max) {
    throw new AnswerValidationError('answer "difficulty" is out of range');
  }
  const confidence = answer["confidence"];
  return {
    difficulty: score,
    confidence: finite(confidence) ? confidence : 0,
    levels: readDifficultyLevels(answer, levelCount),
  };
}

/**
 * Maps a Jev result onto RouteSignals, rejecting anything malformed. A
 * malformed answer is a routing failure, not a value to guess around: a
 * mis-typed difficulty would silently route every request to `fast`.
 */
export function toSignals(result: SystemOneResult, fallbackLatencyMs: number): RouteSignals {
  const answers = isRecord(result.answers) ? result.answers : undefined;
  if (answers === undefined) throw new AnswerValidationError("response carries no answers");

  const task = readTaskType(answers["task_type"]);
  const difficulty = readDifficulty(answers["difficulty"]);
  const needsReasoning = readNoul(answers["needs_reasoning"], "needs_reasoning");
  const longOutput = readNoul(answers["long_output"], "long_output");

  return {
    taskType: task.taskType,
    difficulty: difficulty.difficulty,
    difficultyLevels: difficulty.levels,
    needsReasoning,
    longOutput,
    // noul answers carry no confidence of their own, so only the choice and
    // score questions appear here.
    confidences: { task_type: task.confidence, difficulty: difficulty.confidence },
    jevRequestId: typeof result.requestId === "string" ? result.requestId : "",
    jevModel: typeof result.model === "string" ? result.model : "",
    latencyMs: finite(result.latencyMs) ? result.latencyMs : fallbackLatencyMs,
  };
}

/**
 * Classifies a failure without ever reading its message into a reason, and
 * pulls out the detail the gateway needs to answer honestly: the HTTP status,
 * Jev's request id, and any `Retry-After` the server sent.
 */
export function classifyFailure(error: unknown): {
  cause: RoutingUnavailableCause;
  status?: number;
  requestId?: string;
  retryAfterMs?: number;
} {
  if (error instanceof AnswerValidationError) return { cause: "validation" };
  if (error instanceof JevTimeoutError) return { cause: "timeout" };

  const status = isRecord(error) && finite(error["status"]) ? (error["status"] as number) : undefined;
  const requestId =
    isRecord(error) && typeof error["requestId"] === "string" ? (error["requestId"] as string) : undefined;
  const retryAfterMs =
    isRecord(error) && finite(error["retryAfterMs"]) ? (error["retryAfterMs"] as number) : undefined;
  const detail = {
    ...(status !== undefined ? { status } : {}),
    ...(requestId !== undefined && requestId !== "" ? { requestId } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  };

  // The Jev client classifies its own failures; trust that first.
  const kind = isRecord(error) ? error["kind"] : undefined;
  if (kind === "timeout" || kind === "network" || kind === "http" || kind === "validation") {
    // A 429 is a rate limit, which the gateway answers differently from a
    // generic upstream error, so it gets its own cause.
    if (kind === "http" && status === 429) return { cause: "rate_limited", ...detail };
    return { cause: kind, ...detail };
  }

  const name = isRecord(error) && typeof error["name"] === "string" ? error["name"] : "";
  if (name === "TimeoutError" || name === "AbortError") return { cause: "timeout", ...detail };

  if (status !== undefined) {
    return { cause: status === 429 ? "rate_limited" : "http", ...detail };
  }
  if (name === "JevHttpError" || name === "HttpError") return { cause: "http", ...detail };

  return { cause: "network", ...detail };
}

/** One sentence naming the class of failure, never the upstream text. */
function unavailableMessage(cause: RoutingUnavailableCause, status: number | undefined): string {
  switch (cause) {
    case "breaker_open":
      return "routing is unavailable: the Jev circuit breaker is open after repeated failures";
    case "rate_limited":
      return "routing is unavailable: Jev rate limited the request";
    case "http":
      return `routing is unavailable: Jev answered with status ${status ?? "unknown"}`;
    case "validation":
      return "routing is unavailable: Jev's answer did not match the question shapes";
    case "timeout":
      return "routing is unavailable: Jev did not answer within the budget";
    case "network":
    default:
      return "routing is unavailable: Jev could not be reached";
  }
}

/** A Jev call in flight, plus what it will produce. */
type InFlight = Promise<{ signals: RouteSignals }>;

/**
 * Hard bound on concurrent coalescing entries. The map is keyed by the asks
 * actually in flight, so it is normally tiny; the bound only matters if a
 * caller floods the router with distinct fingerprints faster than Jev answers.
 */
export const MAX_IN_FLIGHT = 1_000;

export class Router {
  private readonly jev: JevClientLike;
  private readonly roster: Roster;
  private readonly sticky: StickyCache;
  private readonly stickyStore: StickyStore | undefined;
  private readonly clock: () => number;
  private readonly onDecision: ((decision: RouteDecision) => void | Promise<void>) | undefined;
  private readonly onError: (err: unknown) => void;
  private readonly jevTimeoutMs: number;
  private readonly profile: PolicyProfile;
  /** Exposed for a health endpoint; see `breakerState()`. */
  private readonly circuit: CircuitBreaker;
  /**
   * Jev calls in flight, keyed by fingerprint *and* user-turn count -- the
   * same key stickiness uses, so two callers only share an answer when they
   * would have shared a sticky entry.
   */
  private readonly inFlight = new Map<string, InFlight>();

  constructor(opts: RouterOptions) {
    this.jev = opts.jev;
    this.roster = opts.roster ?? DEFAULT_ROSTER;
    this.clock = opts.clock ?? Date.now;
    this.sticky =
      opts.sticky ??
      new StickyCache({
        ...(opts.clock ? { clock: opts.clock } : {}),
        ...(opts.stickyTtlMs !== undefined ? { ttlMs: opts.stickyTtlMs } : {}),
      });
    this.stickyStore = opts.stickyStore;
    this.onDecision = opts.onDecision;
    this.onError = opts.onError ?? (() => undefined);
    this.jevTimeoutMs = opts.jevTimeoutMs ?? ROUTER_LIMITS.jevTimeoutMs;
    this.profile = opts.profile ?? JEV_PROFILE;
    this.circuit = new CircuitBreaker({ clock: this.clock, ...opts.breaker });
  }

  /**
   * The table this request resolves against: its own, if it brought one, else
   * the Router's. The per-request override is how one gateway serves a
   * different roster to every key without a Router per key (ADR-008); the
   * constructor's roster stays the deployment-wide default.
   */
  private rosterFor(req: RouteRequest): Roster {
    return req.roster ?? this.roster;
  }

  /** What the circuit breaker is doing. For the gateway's health endpoint. */
  breakerState(): BreakerStatus {
    return this.circuit.state();
  }

  /**
   * Routes one request.
   *
   * @throws {RoutingUnavailableError} when Jev cannot answer. Never returns a
   * guessed decision.
   */
  async route(req: RouteRequest): Promise<RouteDecision> {
    // 1. Forced tier: the caller has already decided, so do not spend a Jev
    //    call -- and do not consult the breaker, which has nothing to say
    //    about a decision that needs no backend.
    if (req.forcedTier !== undefined) {
      return this.emit({
        id: ulid(),
        fingerprint: req.fingerprint,
        tier: req.forcedTier,
        model: resolveModel(req.forcedTier, this.rosterFor(req), req.candidates),
        reason: `forced to the ${req.forcedTier} tier by the request`,
        policyVersion: POLICY_VERSION,
        sticky: false,
        createdAt: this.nowIso(),
      });
    }

    const userTurns = countUserTurns(req.messages);

    // 2. Sticky hit, but only for the same ask: see `StickyCache`.
    const hit = await this.stickyHit(req.fingerprint, userTurns);
    if (hit !== undefined) {
      return this.emit({ ...hit.decision, id: ulid(), sticky: true, createdAt: this.nowIso() });
    }

    // 3. Ask Jev, sharing the call with any identical ask already in flight.
    const key = `${req.fingerprint} ${userTurns}`;
    const existing = this.inFlight.get(key);
    const shared = existing !== undefined;
    const call = existing ?? this.startJevCall(key, req);
    const { signals } = await call;

    const { tier, reason } = chooseTier(signals, req.posture, this.profile);
    const model = resolveModel(tier, this.rosterFor(req), req.candidates, {
      longOutput: signals.longOutput,
    });

    const decision: RouteDecision = {
      id: ulid(),
      fingerprint: req.fingerprint,
      signals,
      tier,
      model,
      reason: `${signals.taskType} task, ${reason}; chose ${model}`,
      policyVersion: POLICY_VERSION,
      // A caller that joined an in-flight call did not cause a Jev call of
      // its own, which is exactly what `sticky` means. Its own decision id
      // keeps the log one row per request -- the gateway attaches each
      // request's upstream outcome to its own row -- while the shared
      // `signals.jevRequestId` still says which single Jev call answered
      // them all, so the log stays honest about what was spent. See
      // ADR-002 revision 3.
      sticky: shared,
      createdAt: this.nowIso(),
    };

    // Only the caller that actually made the call pins it; the others would
    // just rewrite the same entry with a later expiry.
    if (!shared) await this.pin(req.fingerprint, decision, userTurns);
    return this.emit(decision);
  }

  /**
   * The live sticky entry for this fingerprint *at this user-turn count*,
   * from memory or, failing that, from the store.
   *
   * An entry recorded at a different user-turn count is not a hit: the
   * conversation has moved on and the old tier was chosen for a different
   * question. It is left in place rather than deleted, because the fresh
   * decision is about to replace it anyway.
   */
  private async stickyHit(fingerprint: string, userTurns: number): Promise<StickyEntry | undefined> {
    const local = this.sticky.get(fingerprint);
    if (local !== undefined) return local.userTurns === userTurns ? local : undefined;

    if (this.stickyStore === undefined) return undefined;
    let stored: StickyEntry | undefined;
    try {
      stored = await this.stickyStore.get(fingerprint);
    } catch (err) {
      // A store that is down must not take routing down with it.
      this.onError(err);
      return undefined;
    }
    if (stored === undefined) return undefined;
    if (stored.expiresAt <= this.clock()) return undefined;
    // Fill the fast path even when the turn count does not match: the entry
    // is live, and the next tool-result continuation of *that* decision would
    // otherwise pay for the store lookup again.
    this.sticky.set(fingerprint, stored);
    return stored.userTurns === userTurns ? stored : undefined;
  }

  /** Pins a decision in memory and, if configured, writes it through to the store. */
  private async pin(fingerprint: string, decision: RouteDecision, userTurns: number): Promise<void> {
    const entry = this.sticky.entryFor(decision, userTurns);
    this.sticky.set(fingerprint, entry);
    if (this.stickyStore === undefined) return;
    try {
      await this.stickyStore.set(fingerprint, entry);
    } catch (err) {
      // The memory cache already has it; a failed write costs one extra Jev
      // call on another instance, not a failed request.
      this.onError(err);
    }
  }

  /**
   * Starts one Jev call and registers it for coalescing. The entry is removed
   * when the call settles, whichever way it settles, so a failure does not
   * pin an outage into the map.
   */
  private startJevCall(key: string, req: RouteRequest): InFlight {
    const call = this.askJev(req);
    // Bound the map. Entries are removed on settle, so this only trips under
    // a flood of distinct fingerprints; dropping the oldest costs a
    // duplicate Jev call, never a wrong answer.
    if (this.inFlight.size >= MAX_IN_FLIGHT) {
      const oldest = this.inFlight.keys().next();
      if (oldest.done !== true) this.inFlight.delete(oldest.value);
    }
    this.inFlight.set(key, call);
    const forget = (): void => {
      // Only clear our own entry: a later call may already have replaced it.
      if (this.inFlight.get(key) === call) this.inFlight.delete(key);
    };
    call.then(forget, forget);
    return call;
  }

  /**
   * One Jev call, through the breaker, mapped onto signals. Throws
   * `RoutingUnavailableError` for every failure path.
   */
  private async askJev(req: RouteRequest): Promise<{ signals: RouteSignals }> {
    const gate = this.circuit.tryAcquire();
    if (!gate.allowed) {
      throw new RoutingUnavailableError("breaker_open", unavailableMessage("breaker_open", undefined), {
        retryAfterMs: gate.retryAfterMs,
      });
    }

    const startedAt = this.clock();
    try {
      const result = await this.callJev(req.messages, req.tools);
      const signals = toSignals(result, this.clock() - startedAt);
      this.circuit.recordSuccess();
      return { signals };
    } catch (error) {
      const { cause, status, requestId, retryAfterMs } = classifyFailure(error);
      this.circuit.recordFailure(cause, status);
      throw new RoutingUnavailableError(cause, unavailableMessage(cause, status), {
        ...(status !== undefined ? { status } : {}),
        ...(requestId !== undefined ? { requestId } : {}),
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      });
    }
  }

  private async callJev(messages: ChatMessage[], tools: unknown[] | undefined): Promise<SystemOneResult> {
    const { state } = buildJevState(messages, tools);
    const budget = this.jevTimeoutMs;
    const signal = AbortSignal.timeout(budget);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new JevTimeoutError(`jev exceeded ${budget}ms`)), budget);
    });

    // The budget covers the client's retries and backoff too, so a retrying
    // client cannot outlive the router's own promise to answer within it.
    const call = this.jev.systemone({ state, questions: ROUTER_QUESTIONS }, { signal, budgetMs: budget });
    // If the deadline wins the race, this promise is still in flight and may
    // reject later with nobody listening. Swallow that; the decision is made.
    call.catch(() => undefined);

    try {
      // The signal is the client's cue to stop; the race is the router's own
      // guarantee that it returns within budget even if the client ignores it.
      return await Promise.race([call, deadline]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private nowIso(): string {
    return new Date(this.clock()).toISOString();
  }

  private async emit(decision: RouteDecision): Promise<RouteDecision> {
    if (this.onDecision !== undefined) {
      try {
        await this.onDecision(decision);
      } catch (err) {
        this.onError(err);
      }
    }
    return decision;
  }
}
