/**
 * The router: conversation in, routing decision out.
 *
 * Order of operations, cheapest first:
 *   1. a forced tier skips Jev entirely;
 *   2. a sticky hit on the fingerprint reuses the decision;
 *   3. otherwise one Jev `/v1/systemone` call under a hard
 *      `ROUTER_LIMITS.jevTimeoutMs` budget, then Policy v1 and the roster.
 *
 * The router never blocks a request. Any Jev failure -- timeout, network,
 * HTTP, or a malformed answer -- degrades to the `mid` tier with
 * `degraded: true`. The reason names the class of failure and never the
 * upstream error text, so no key material can reach a response header or the
 * decision log (ADR-003).
 */

import { ulid } from "ulid";
import type { JevAnswer, JevClientLike, SystemOneResult } from "../jev/types.js";
import type { ChatMessage, RouteDecision, RouteRequest, RouteSignals, Roster, TaskType } from "../types.js";
import { DEFAULT_ROSTER, POLICY_VERSION, ROUTER_LIMITS, TASK_TYPES } from "../types.js";
import { buildJevState } from "./context.js";
import { chooseTier } from "./policy.js";
import { ROUTER_QUESTIONS } from "./questions.js";
import { resolveModel } from "./roster.js";
import { StickyCache } from "./sticky.js";

/** Why the router degraded. Never carries upstream text. */
export type DegradeCause = "timeout" | "network" | "http" | "validation";

export type RouterOptions = {
  jev: JevClientLike;
  roster?: Roster;
  sticky?: StickyCache;
  /** Injectable for tests; defaults to Date.now. */
  clock?: () => number;
  /** Called with every decision the router returns, including degraded ones. */
  onDecision?: (decision: RouteDecision) => void;
  /** Jev budget in ms; defaults to ROUTER_LIMITS.jevTimeoutMs. */
  jevTimeoutMs?: number;
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

function readDifficulty(answer: JevAnswer | undefined): { difficulty: number; confidence: number } {
  if (!isRecord(answer) || answer["type"] !== "score") {
    throw new AnswerValidationError('answer "difficulty" is not a score');
  }
  const score = answer["score"];
  const levels = ROUTER_QUESTIONS["difficulty"];
  const max = levels && levels.type === "score" ? levels.criteria.length - 1 : 3;
  if (!finite(score) || score < 0 || score > max) {
    throw new AnswerValidationError('answer "difficulty" is out of range');
  }
  const confidence = answer["confidence"];
  return { difficulty: score, confidence: finite(confidence) ? confidence : 0 };
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

/** Classifies a failure without ever reading its message into a reason. */
export function classifyFailure(error: unknown): DegradeCause {
  if (error instanceof AnswerValidationError) return "validation";
  if (error instanceof JevTimeoutError) return "timeout";

  // The Jev client classifies its own failures; trust that first.
  const kind = isRecord(error) ? error["kind"] : undefined;
  if (kind === "timeout" || kind === "network" || kind === "http" || kind === "validation") return kind;

  const name = isRecord(error) && typeof error["name"] === "string" ? error["name"] : "";
  if (name === "TimeoutError" || name === "AbortError") return "timeout";

  const status = isRecord(error) ? error["status"] : undefined;
  if (finite(status)) return "http";
  if (name === "JevHttpError" || name === "HttpError") return "http";

  return "network";
}

export class Router {
  private readonly jev: JevClientLike;
  private readonly roster: Roster;
  private readonly sticky: StickyCache;
  private readonly clock: () => number;
  private readonly onDecision: ((decision: RouteDecision) => void) | undefined;
  private readonly jevTimeoutMs: number;

  constructor(opts: RouterOptions) {
    this.jev = opts.jev;
    this.roster = opts.roster ?? DEFAULT_ROSTER;
    this.clock = opts.clock ?? Date.now;
    this.sticky = opts.sticky ?? new StickyCache(opts.clock ? { clock: opts.clock } : {});
    this.onDecision = opts.onDecision;
    this.jevTimeoutMs = opts.jevTimeoutMs ?? ROUTER_LIMITS.jevTimeoutMs;
  }

  async route(req: RouteRequest): Promise<RouteDecision> {
    // 1. Forced tier: the caller has already decided, so do not spend a Jev call.
    if (req.forcedTier !== undefined) {
      return this.emit({
        id: ulid(),
        fingerprint: req.fingerprint,
        tier: req.forcedTier,
        model: resolveModel(req.forcedTier, this.roster, req.candidates),
        reason: `forced to the ${req.forcedTier} tier by the request`,
        policyVersion: POLICY_VERSION,
        sticky: false,
        degraded: false,
        createdAt: this.nowIso(),
      });
    }

    // 2. Sticky hit: same conversation, same model, fresh decision id.
    const hit = this.sticky.get(req.fingerprint);
    if (hit !== undefined) {
      return this.emit({ ...hit, id: ulid(), sticky: true, createdAt: this.nowIso() });
    }

    // 3. Ask Jev.
    const startedAt = this.clock();
    let signals: RouteSignals;
    try {
      const result = await this.callJev(req.messages, req.tools);
      signals = toSignals(result, this.clock() - startedAt);
    } catch (error) {
      return this.emit(this.degraded(req, classifyFailure(error)));
    }

    const { tier, reason } = chooseTier(signals, req.posture);
    const model = resolveModel(tier, this.roster, req.candidates, { longOutput: signals.longOutput });

    const decision: RouteDecision = {
      id: ulid(),
      fingerprint: req.fingerprint,
      signals,
      tier,
      model,
      reason: `${signals.taskType} task, ${reason}; chose ${model}`,
      policyVersion: POLICY_VERSION,
      sticky: false,
      degraded: false,
      createdAt: this.nowIso(),
    };

    // Only clean decisions get pinned: a degraded one must not stick a
    // conversation to the fallback tier for the next thirty minutes.
    this.sticky.set(req.fingerprint, decision);
    return this.emit(decision);
  }

  private async callJev(messages: ChatMessage[], tools: unknown[] | undefined): Promise<SystemOneResult> {
    const { state } = buildJevState(messages, tools);
    const budget = this.jevTimeoutMs;
    const signal = AbortSignal.timeout(budget);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new JevTimeoutError(`jev exceeded ${budget}ms`)),
        budget,
      );
    });

    const call = this.jev.systemone({ state, questions: ROUTER_QUESTIONS }, { signal });
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

  private degraded(req: RouteRequest, cause: DegradeCause): RouteDecision {
    return {
      id: ulid(),
      fingerprint: req.fingerprint,
      tier: "mid",
      model: resolveModel("mid", this.roster, req.candidates),
      reason: `routing signals unavailable (${cause}), fell back to the mid tier`,
      policyVersion: POLICY_VERSION,
      sticky: false,
      degraded: true,
      createdAt: this.nowIso(),
    };
  }

  private nowIso(): string {
    return new Date(this.clock()).toISOString();
  }

  private emit(decision: RouteDecision): RouteDecision {
    this.onDecision?.(decision);
    return decision;
  }
}
