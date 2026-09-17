/**
 * The parts `chat.ts` and `messages.ts` both need.
 *
 * Milo speaks two dialects -- OpenAI's `/v1/chat/completions` and Anthropic's
 * `/v1/messages` -- over one router, one rate limiter and one decision log.
 * Only the request and response *shapes* differ, so everything between
 * "parse the body" and "hand the stream back" lives here and each route keeps
 * just its own translation layer.
 */

import { degradedDecision as coreDegradedDecision } from "@milo/core";
import type { DecisionRecord, RouteDecision } from "@milo/core";
import type { Context } from "hono";
import type { AppDeps } from "../app.js";

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
 * The seven headers that explain a routed response. Identical on both routes:
 * a client that learned to read them from the OpenAI surface reads them off
 * the Anthropic one without changing a line.
 */
export function applyMiloHeaders(headers: Headers, decision: RouteDecision): void {
  headers.set("x-milo-decision-id", decision.id);
  headers.set("x-milo-model", decision.model);
  headers.set("x-milo-tier", decision.tier);
  // A degraded decision has no signals; say `unknown` rather than inventing a
  // task type or a difficulty the router never got.
  headers.set("x-milo-task-type", decision.signals?.taskType ?? "unknown");
  headers.set("x-milo-difficulty", decision.signals ? decision.signals.difficulty.toFixed(2) : "unknown");
  headers.set("x-milo-sticky", decision.sticky ? "true" : "false");
  headers.set("x-milo-degraded", decision.degraded ? "true" : "false");
}

/**
 * A degraded decision the gateway minted itself. `resolveModel` can throw on
 * a roster with nothing eligible, and the whole point of a degraded decision
 * is that it still answers, so widen the search before giving up on it.
 */
export function degradedDecision(
  deps: AppDeps,
  conversation: string,
  candidates: string[] | undefined,
  reason: string,
): RouteDecision {
  return coreDegradedDecision({
    fingerprint: conversation,
    roster: deps.roster,
    ...(candidates !== undefined ? { candidates } : {}),
    reason,
    clock: deps.now,
  });
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
