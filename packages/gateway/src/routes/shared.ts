/**
 * The parts `chat.ts` and `messages.ts` both need.
 *
 * Milo speaks two dialects -- OpenAI's `/v1/chat/completions` and Anthropic's
 * `/v1/messages` -- over one router, one rate limiter and one decision log.
 * Only the request and response *shapes* differ, so everything between
 * "parse the body" and "hand the stream back" lives here and each route keeps
 * just its own translation layer.
 */

import { DEFAULT_ROSTER, DEFAULT_ROSTER_INFO } from "@milo/core";
import type { DecisionRecord, Roster, RouteDecision, RoutingUnavailableError } from "@milo/core";
import type { Context } from "hono";
import type { AppDeps } from "../app.js";
import { callerScope } from "../billing.js";
import { errorMessage } from "../errors.js";

/** A parsed request body. Both dialects are JSON objects at the top level. */
export type Body = Record<string, unknown>;

export type Upstream = NonNullable<DecisionRecord["upstream"]>;

/**
 * Reads the request body as a JSON object, or `undefined` if it is not one.
 * The caller renders the error, because the two dialects word it differently.
 */
export async function readJsonObject(c: Context): Promise<Body | undefined> {
  let text: string;
  try {
    text = await c.req.text();
  } catch {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    return parsed as Body;
  } catch {
    return undefined;
  }
}

/**
 * The tier-to-model table one request routes against, in precedence order:
 *
 *   1. the roster this caller stored with `PUT /v1/roster`, found by the hash
 *      of their credential -- their Milo key's hash when they authenticated
 *      with one (ADR-007), their OpenRouter key's otherwise (ADR-008);
 *   2. the roster this deployment was configured with (`milo.config.json`);
 *   3. the shipped default.
 *
 * It lives here rather than in a route so every dialect resolves it the same
 * way and a route added later gets it by calling one function. `candidates`
 * still filters *within* whichever table this returns -- the two are different
 * questions: this one is "which models are mine", that one is "which of them
 * for this request".
 *
 * A failed roster read is logged and falls through to the deployment's table.
 * A user who cannot reach their own list is better served by a routed answer
 * from the defaults than by a 500.
 */
export async function resolveRoster(c: Context, deps: AppDeps): Promise<Roster> {
  try {
    const stored = await deps.log.getRoster(callerScope(c));
    if (stored !== undefined) return stored.roster;
  } catch (err) {
    deps.logger.error("per-key roster read failed", { error: errorMessage(err) });
  }
  return deps.roster ?? DEFAULT_ROSTER;
}

/**
 * The six headers that explain a routed response. Identical on both routes: a
 * client that learned to read them from the OpenAI surface reads them off the
 * Anthropic one without changing a line.
 *
 * Every decision that reaches here came from Jev or from a forced tier, so a
 * missing `signals` now means only "forced, no question was asked"; there is
 * no degraded decision left to describe.
 */
export function applyMiloHeaders(headers: Headers, decision: RouteDecision): void {
  headers.set("x-milo-decision-id", decision.id);
  headers.set("x-milo-model", decision.model);
  headers.set("x-milo-tier", decision.tier);
  headers.set("x-milo-task-type", decision.signals?.taskType ?? "unknown");
  headers.set("x-milo-difficulty", decision.signals ? decision.signals.difficulty.toFixed(2) : "unknown");
  headers.set("x-milo-sticky", decision.sticky ? "true" : "false");
}

/** `Retry-After` when Milo could not route at all, in seconds. */
export const ROUTING_RETRY_AFTER_SECONDS = 2;

/**
 * What a client is told when Jev could not answer. It names the class of
 * failure and nothing else -- no upstream text, no key material (ADR-003) --
 * and it says what the user can do about it, because the alternative Milo
 * used to offer (a guessed mid-tier model) is gone: an explicit model id
 * still passes straight through to OpenRouter.
 */
export function routingUnavailableMessage(cause: string): string {
  return `Milo could not route this request: ${cause} from the decision model. Retry, or set an explicit model.`;
}

/**
 * The `Retry-After` value for a routing failure: whatever hint the error
 * carried, else two seconds. Whole seconds, since that is what the header
 * takes, and never zero.
 */
export function retryAfterSeconds(err: RoutingUnavailableError): string {
  const ms = err.retryAfterMs;
  if (ms === undefined) return String(ROUTING_RETRY_AFTER_SECONDS);
  return String(Math.max(1, Math.ceil(ms / 1000)));
}

/** The `Retry-After` value for a rate-limited key, from its bucket's refill. */
export function retryAfterFromBucket(ms: number): string {
  return String(Math.max(1, Math.ceil(ms / 1000)));
}

/** What a client is told when its key is out of routed-request budget. */
export function rateLimitedMessage(perMinute: number): string {
  return (
    `Milo routes at most ${perMinute} requests a minute for one key. ` +
    "Retry shortly, or set an explicit model, which Milo forwards without routing."
  );
}

export function onFinished(done: () => void): TransformStream<Uint8Array, Uint8Array> {
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk);
    },
    flush() {
      done();
    },
  });
}

/**
 * Posture-aware provider strategy (extends ADR-010's sampled-path rule to
 * every routed forward): when the caller's body names no `provider` of its
 * own, `balanced` and `quality` postures sort OpenRouter's providers by
 * live throughput -- the live benchmark showed unpinned routed calls riding
 * the price-weighted default onto providers slow enough to blow a two-minute
 * client timeout on hard tasks -- while `low` keeps OpenRouter's own
 * price-first default. A caller-supplied `provider` field always passes
 * through untouched.
 */
export function applyProviderStrategy<T extends Record<string, unknown>>(
  body: T,
  posture: "low" | "balanced" | "quality",
  model?: string,
): T {
  if (body["provider"] !== undefined || posture === "low") return body;
  return { ...body, provider: { sort: "throughput", ...maxPriceFor(model) } };
}

/**
 * Keeps a routed response's internal reasoning out of the client-visible
 * payload by default. OpenRouter still lets the model reason; `exclude` only
 * controls whether its trace is returned alongside the answer. Applies to
 * chat completions, messages, and responses — the same `reasoning` object
 * OpenRouter accepts on every dialect.
 *
 * A caller can explicitly request reasoning with either the current
 * `reasoning.exclude` field or the legacy `include_reasoning` field. Invalid
 * or null `reasoning` values are also left to OpenRouter to validate.
 */
export function applyReasoningExclusion<T extends Record<string, unknown>>(body: T): T {
  const reasoning = body["reasoning"];
  if (typeof reasoning === "object" && reasoning !== null && !Array.isArray(reasoning)) {
    const config = reasoning as Record<string, unknown>;
    if (config["exclude"] !== undefined) return body;
    return { ...body, reasoning: { ...config, exclude: true } };
  }
  if (reasoning !== undefined || body["include_reasoning"] !== undefined) return body;
  return { ...body, reasoning: { exclude: true } };
}

/**
 * A price ceiling for the throughput sort: the model's listed default-roster
 * rate with 10% headroom, so sorting by speed can never buy a premium
 * variant of the same model (the first sorted run picked a $2.40/M "fast"
 * variant of a $1.20/M model and doubled the routed cost). A model not in
 * the default roster gets no ceiling; the sort alone still applies.
 */
/**
 * Re-points Milo's own provider strategy at a different model.
 *
 * `applyProviderStrategy` computes the price ceiling for the model the
 * decision picked, and `prepareBody` only rewrites `model` -- so any path
 * that forwards the same body to a DIFFERENT model (the all-samples-failed
 * fallback to `unsampledTier`, the gate's escalated retry) used to ship a
 * ceiling computed for the model that is no longer being called. A fast
 * model's ceiling excludes every endpoint of a frontier model, and OpenRouter
 * answers "no allowed providers" -- a 404 on a request that had nothing wrong
 * with it. This recomputes the ceiling for the model actually being called.
 *
 * It only touches a `provider` field that is exactly what
 * `applyProviderStrategy` would have produced for `fromModel`: a
 * caller-supplied provider preference still passes through untouched, ceiling
 * and all.
 */
export function retargetProviderStrategy<T extends Record<string, unknown>>(
  body: T,
  fromModel: string | undefined,
  toModel: string,
): T {
  if (!isAppliedStrategy(body["provider"], fromModel)) return body;
  return { ...body, provider: { sort: "throughput", ...maxPriceFor(toModel) } };
}

/** Whether `provider` is exactly the strategy Milo applies for `model`. */
function isAppliedStrategy(provider: unknown, model: string | undefined): boolean {
  if (typeof provider !== "object" || provider === null || Array.isArray(provider)) return false;
  const applied = provider as Record<string, unknown>;
  if (applied["sort"] !== "throughput") return false;
  const keys = Object.keys(applied);
  const ceiling = maxPriceFor(model).max_price;
  if (ceiling === undefined) return keys.length === 1;
  if (keys.length !== 2) return false;
  const actual = applied["max_price"];
  if (typeof actual !== "object" || actual === null) return false;
  const price = actual as Record<string, unknown>;
  return price["prompt"] === ceiling.prompt && price["completion"] === ceiling.completion;
}

export function maxPriceFor(model: string | undefined): { max_price?: { prompt: number; completion: number } } {
  if (model === undefined) return {};
  for (const tier of ["fast", "mid", "frontier"] as const) {
    const entry = DEFAULT_ROSTER_INFO.tiers[tier].find((m) => m.id === model);
    if (entry !== undefined) {
      return { max_price: { prompt: entry.inputUsdPerM * 1.1, completion: entry.outputUsdPerM * 1.1 } };
    }
  }
  return {};
}
