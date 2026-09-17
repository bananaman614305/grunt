/**
 * `/v1/decisions` -- the audit trail, which is the product's proof.
 *
 * `x-milo-decision-id` on a chat response is only useful if it resolves, so
 * these three reads exist from day one: one decision, the recent list, and
 * the aggregate.
 *
 * Who can see what depends on how the request authenticated (ADR-007):
 *
 *   - a **Milo key** sees only its own account's decisions. Every routed
 *     request made with a Milo key stamps the account on its decision row, so
 *     these queries filter on it and `/v1/decisions/:id` 404s a row belonging
 *     to someone else -- the same answer a row that does not exist gets, so
 *     the endpoint cannot be used to probe for other accounts' ids.
 *   - a **bring-your-own-key** caller sees the whole deployment, exactly as
 *     before. The log is per deployment, not per key, so on a shared instance
 *     one OpenRouter key can read another's decisions. That is fine for a
 *     single-tenant MVP and it is what ADR-008 already recorded; Milo keys
 *     are the path off it, and BYOK behaviour is deliberately unchanged here.
 */

import type { Hono } from "hono";
import type { AppDeps } from "../app.js";
import { decisionScope } from "../billing.js";
import { errorResponse } from "../errors.js";

export function registerDecisionsRoutes(app: Hono, deps: AppDeps): void {
  // Before `/v1/decisions/:id`, or `stats` would be read as a decision id.
  app.get("/v1/decisions/stats", async (c) => {
    const accountId = decisionScope(c);
    return c.json(await deps.log.stats(accountId === undefined ? undefined : { accountId }));
  });

  app.get("/v1/decisions", async (c) => {
    const opts: { limit?: number; accountId?: string } = {};

    const limit = Number(c.req.query("limit"));
    if (Number.isFinite(limit) && limit > 0) opts.limit = Math.floor(limit);

    const accountId = decisionScope(c);
    if (accountId !== undefined) opts.accountId = accountId;

    return c.json({ data: await deps.log.listRecent(opts) });
  });

  app.get("/v1/decisions/:id", async (c) => {
    const record = await deps.log.getDecision(c.req.param("id"));
    const accountId = decisionScope(c);
    if (record === undefined || (accountId !== undefined && record.accountId !== accountId)) {
      return errorResponse(c, 404, "No decision with that id.", "not_found_error", "decision_not_found");
    }
    return c.json(record);
  });
}
