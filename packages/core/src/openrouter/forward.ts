/**
 * Rewrite rules between Milo's OpenAI-compatible surface and OpenRouter's
 * `/v1` API. Only the `model` field is rewritten; everything else passes
 * through untouched, per docs/PLAN.md and ADR-003.
 */

import { MAX_SAMPLE_COUNT } from "../router/policy.js";
import { COST_POSTURES, ROUTED_MODEL_ID, TIERS } from "../types.js";
import type { CostPosture, MiloRequestExtension, Tier } from "../types.js";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/**
 * Returns a copy of `body` with `model` replaced by the resolved OpenRouter
 * model id and the Milo-only `milo` field removed. Key order is preserved:
 * `model` is rewritten in place, every other key keeps its original
 * position, and `milo` is simply omitted.
 */
export function prepareBody(body: Record<string, unknown>, model: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let sawModel = false;
  for (const key of Object.keys(body)) {
    if (key === "milo") continue;
    if (key === "model") {
      result.model = model;
      sawModel = true;
      continue;
    }
    result[key] = body[key];
  }
  if (!sawModel) result.model = model;
  return result;
}

/**
 * Pulls the optional `milo` request extension out of a chat completions
 * body and reports whether the request asked for routing (`model ===
 * "milo/auto"`). Validation is loose: unknown fields are ignored and
 * fields with the wrong shape are dropped silently, never thrown.
 */
export function extractMilo(body: Record<string, unknown>): {
  extension?: MiloRequestExtension;
  isRouted: boolean;
} {
  const isRouted = body.model === ROUTED_MODEL_ID;

  const raw = body.milo;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { isRouted };
  }
  const source = raw as Record<string, unknown>;

  const extension: MiloRequestExtension = {};

  if (typeof source.posture === "string" && isCostPosture(source.posture)) {
    extension.posture = source.posture;
  }
  if (Array.isArray(source.candidates) && source.candidates.every((c) => typeof c === "string")) {
    extension.candidates = source.candidates as string[];
  }
  if (typeof source.tier === "string" && isTier(source.tier)) {
    extension.tier = source.tier;
  }
  // Best-of-N override (ADR-010): 1 disables sampling, larger values set the
  // count on cells the policy samples, capped. Anything malformed is dropped.
  if (typeof source.samples === "number" && Number.isInteger(source.samples) && source.samples >= 1) {
    extension.samples = Math.min(source.samples, MAX_SAMPLE_COUNT);
  // Only `false` means anything: injection is the default (ADR-011), so a
  // stray `brief: true` is the same as saying nothing.
  if (source.brief === false) {
    extension.brief = false;
  }

  return { extension, isRouted };
}

function isCostPosture(value: string): value is CostPosture {
  return (COST_POSTURES as readonly string[]).includes(value);
}

function isTier(value: string): value is Tier {
  return (TIERS as readonly string[]).includes(value);
}

/**
 * Headers that are safe and meaningful to forward to OpenRouter. Everything
 * else — hop-by-hop headers, forwarding metadata, Milo's own `x-milo-*`
 * headers — is dropped by omission.
 */
const FORWARDABLE_HEADERS = ["authorization", "content-type", "accept", "http-referer", "x-title", "user-agent"];

/**
 * Builds the outgoing header set for an OpenRouter request from the
 * incoming client headers: allow-lists a small set of headers worth
 * forwarding (drops hop-by-hop headers, `x-forwarded-*`, and any
 * `x-milo-*` header), then applies OpenRouter's app-attribution headers
 * when provided.
 */
export function forwardHeaders(incoming: Headers, opts?: { referer?: string; title?: string }): Headers {
  const result = new Headers();
  for (const [key, value] of incoming.entries()) {
    const lower = key.toLowerCase();
    if (FORWARDABLE_HEADERS.includes(lower)) {
      result.set(lower, value);
    }
  }
  if (opts?.referer) result.set("HTTP-Referer", opts.referer);
  if (opts?.title) result.set("X-Title", opts.title);
  return result;
}

/** Whether a chat completions body asked for a streamed response. */
export function isStreaming(body: Record<string, unknown>): boolean {
  return body.stream === true;
}
