/**
 * Catch-all `/v1/*` proxy to OpenRouter.
 *
 * Registered last, so it only ever sees what the explicit routes did not
 * claim: `/v1/generation`, `/v1/credits`, `/v1/keys`, and whatever OpenRouter
 * adds next. Milo stays a drop-in as their API grows instead of a subset of
 * it that quietly 404s (docs/PLAN.md, "OpenRouter API drift").
 *
 * Method, path, query string and body go across unchanged; `forwardHeaders`
 * inside the client decides which headers travel. The one substitution is the
 * credential: a Milo key is swapped for the account's OpenRouter sub-key, so
 * an `mk_` key never reaches OpenRouter (ADR-007).
 *
 * Nothing here is charged. These paths are OpenRouter's own reads and writes
 * (`/v1/credits`, `/v1/generation`, `/v1/keys`), not inference, and the ones
 * that could bill -- a completion endpoint Milo has not claimed yet -- are
 * bounded by the sub-key's own spend limit, which OpenRouter keeps equal to
 * the account's balance. HORIZON: meter this path too, or refuse the
 * inference endpoints on it, before the limit is the only thing between an
 * account and free margin.
 */

import type { Hono } from "hono";
import { OpenRouterError } from "@milo/core";
import type { AppDeps } from "../app.js";
import { passThroughHeaders } from "../app.js";
import { creditGate, upstreamHeadersFor } from "../billing.js";
import { errorMessage, errorResponse } from "../errors.js";

const BODYLESS = new Set(["GET", "HEAD", "OPTIONS"]);

export function registerProxyRoute(app: Hono, deps: AppDeps): void {
  app.all("/v1/*", async (c) => {
    // These paths can reach an inference endpoint Milo has not claimed yet,
    // so a Milo key with no credit is refused here as well.
    const refusal = creditGate(c, deps);
    if (refusal !== undefined) return refusal;

    const url = new URL(c.req.url);
    // The client's base URL is `<milo>/v1` and OpenRouter's is
    // `https://openrouter.ai/api/v1`, so the `/v1` prefix is dropped here and
    // supplied again by the client's base URL.
    const path = `${url.pathname.slice("/v1".length) || "/"}${url.search}`;

    const opts: Parameters<AppDeps["openRouter"]["proxy"]>[0] = {
      method: c.req.method,
      path,
      headers: upstreamHeadersFor(c),
    };
    if (!BODYLESS.has(c.req.method)) opts.body = await c.req.text();

    let upstream: Response;
    try {
      upstream = await deps.openRouter.proxy(opts);
    } catch (err) {
      deps.logger.error("openrouter proxy request failed", { path: url.pathname, error: errorMessage(err) });
      if (err instanceof OpenRouterError && err.status === 400) {
        return errorResponse(c, 400, "Milo will not proxy that path.", "invalid_request_error", "invalid_path");
      }
      return errorResponse(c, 502, "Upstream request to OpenRouter failed.", "api_error", "upstream_unavailable");
    }

    return new Response(upstream.body, { status: upstream.status, headers: passThroughHeaders(upstream) });
  });
}
