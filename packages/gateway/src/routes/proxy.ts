/**
 * Catch-all `/v1/*` proxy to OpenRouter.
 *
 * Registered last, so it only ever sees what the explicit routes did not
 * claim: `/v1/generation`, `/v1/credits`, `/v1/keys`, and whatever OpenRouter
 * adds next. Milo stays a drop-in as their API grows instead of a subset of
 * it that quietly 404s (docs/PLAN.md, "OpenRouter API drift").
 *
 * Method, path, query string and body go across unchanged; `forwardHeaders`
 * inside the client decides which headers travel.
 */

import type { Hono } from "hono";
import { OpenRouterError } from "@milo/core";
import type { AppDeps } from "../app.js";
import { passThroughHeaders } from "../app.js";
import { errorMessage, errorResponse } from "../errors.js";

const BODYLESS = new Set(["GET", "HEAD", "OPTIONS"]);

export function registerProxyRoute(app: Hono, deps: AppDeps): void {
  app.all("/v1/*", async (c) => {
    const url = new URL(c.req.url);
    // The client's base URL is `<milo>/v1` and OpenRouter's is
    // `https://openrouter.ai/api/v1`, so the `/v1` prefix is dropped here and
    // supplied again by the client's base URL.
    const path = `${url.pathname.slice("/v1".length) || "/"}${url.search}`;

    const opts: Parameters<AppDeps["openRouter"]["proxy"]>[0] = {
      method: c.req.method,
      path,
      headers: c.req.raw.headers,
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
