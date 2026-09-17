/**
 * `/v1/decisions` -- the audit trail, which is the product's proof.
 *
 * `x-milo-decision-id` on a chat response is only useful if it resolves, so
 * these three reads exist from day one: one decision, the recent list, and
 * the aggregate.
 *
 * They require an `Authorization` header like every other `/v1` route, but
 * any non-empty bearer will do: the log is per deployment, not per key, so
 * one user's key can read another's decisions on a shared instance. That is
 * fine for a single-tenant MVP and not fine for the hosted product.
 * HORIZON: scope the log per key hash (the same SHA-256 the rate limiter
 * uses) and filter these queries by it before Milo is multi-tenant.
 */

import type { Hono } from "hono";
import type { AppDeps } from "../app.js";
import { errorResponse } from "../errors.js";

export function registerDecisionsRoutes(app: Hono, deps: AppDeps): void {
  // Before `/v1/decisions/:id`, or `stats` would be read as a decision id.
  app.get("/v1/decisions/stats", async (c) => {
    return c.json(await deps.log.stats());
  });

  app.get("/v1/decisions", async (c) => {
    const opts: { limit?: number; degradedOnly?: boolean } = {};

    const limit = Number(c.req.query("limit"));
    if (Number.isFinite(limit) && limit > 0) opts.limit = Math.floor(limit);
    if (isTrue(c.req.query("degraded"))) opts.degradedOnly = true;

    return c.json({ data: await deps.log.listRecent(opts) });
  });

  app.get("/v1/decisions/:id", async (c) => {
    const record = await deps.log.get(c.req.param("id"));
    if (record === undefined) {
      return errorResponse(c, 404, "No decision with that id.", "not_found_error", "decision_not_found");
    }
    return c.json(record);
  });
}

function isTrue(value: string | undefined): boolean {
  return value === "" || value === "1" || value?.toLowerCase() === "true";
}
