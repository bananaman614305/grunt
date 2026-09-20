/**
 * `/v1/memory` -- disclosure and control for personal-fact memory (ADR-017).
 *
 * Fact memory keeps the user's own words (encrypted), so the three
 * non-negotiables ADR-017 bakes in all live on this surface:
 *
 *   - `GET /v1/memory` lists every fact the calling key stored, DECRYPTED --
 *     id, category, text, provenance, timestamps -- plus the kill switch.
 *     Nothing stored is hidden; a fact the user cannot see is one they cannot
 *     trust.
 *   - `DELETE /v1/memory/:id` removes one fact on demand. The whole set dies
 *     with the key hash anyway (rotate the key and Milo has never heard of
 *     you), but a user should not have to rotate a key to be forgotten.
 *   - `PUT /v1/memory/settings { enabled }` is the per-key kill switch:
 *     `false` turns capture and injection off for everything from the key.
 *
 * Scoped exactly as preferences and rosters are (ADR-008): `callerScope(c)` --
 * the account key's hash for an `mk_` key, the SHA-256 of the bearer otherwise
 * -- so one caller can neither read nor delete another's facts, and a delete
 * for a fact that is not yours is the same 404 a missing one gets.
 *
 * When the deployment has no encryption key (`deps.factMemory` absent), the
 * feature is disabled: the list answers empty with `enabled` reflecting the
 * stored switch and a `disabled` flag, because a fact store with no envelope
 * must not decrypt or store anything. Delete and the switch still work -- they
 * need no crypto.
 */

import type { Context, Hono } from "hono";
import type { AppDeps } from "../app.js";
import { callerScope } from "../billing.js";
import { errorMessage, errorResponse } from "../errors.js";
import { readJsonObject } from "./shared.js";

export function registerMemoryRoutes(app: Hono, deps: AppDeps): void {
  app.get("/v1/memory", (c) => listFacts(c, deps));
  app.put("/v1/memory/settings", (c) => putSettings(c, deps));
  app.delete("/v1/memory/:id", (c) => deleteFact(c, deps));
}

async function listFacts(c: Context, deps: AppDeps): Promise<Response> {
  const keyHash = callerScope(c);
  try {
    const settings = await deps.log.getFactSettings(keyHash);
    const encryptor = deps.factMemory?.encryptor;
    // No envelope: the feature is disabled deployment-wide. Answer empty and
    // say so rather than decrypting nothing.
    if (encryptor === undefined) {
      return c.json({ data: [], settings: { enabled: settings.enabled }, disabled: true });
    }
    const rows = await deps.log.listFacts(keyHash, encryptor);
    return c.json({
      // The caller knows their own key; the hash adds nothing but noise. The
      // retrieval embedding (ADR-018) is an internal ranking artifact, not
      // something the owner reads, so it is dropped from the listing too.
      data: rows.map(({ keyHash: _keyHash, embedding: _embedding, ...row }) => row),
      settings: { enabled: settings.enabled },
    });
  } catch (err) {
    deps.logger.error("fact list failed", { error: errorMessage(err) });
    return errorResponse(c, 500, "Milo could not read stored facts.", "api_error", "internal_error");
  }
}

async function deleteFact(c: Context, deps: AppDeps): Promise<Response> {
  const id = c.req.param("id") ?? "";
  try {
    const deleted = await deps.log.deleteFact(callerScope(c), id);
    if (!deleted) {
      // Missing and someone else's are the same answer on purpose: the
      // endpoint must not confirm that an id exists under another key.
      return errorResponse(c, 404, "No fact with that id.", "not_found_error", "fact_not_found");
    }
    return c.json({ deleted: true, id });
  } catch (err) {
    deps.logger.error("fact delete failed", { error: errorMessage(err) });
    return errorResponse(c, 500, "Milo could not delete that fact.", "api_error", "internal_error");
  }
}

async function putSettings(c: Context, deps: AppDeps): Promise<Response> {
  const body = await readJsonObject(c);
  if (body === undefined || typeof body["enabled"] !== "boolean") {
    return errorResponse(
      c,
      400,
      'Body must be a JSON object with a boolean "enabled".',
      "invalid_request_error",
      "invalid_request_body",
    );
  }
  try {
    const settings = await deps.log.setFactSettings(callerScope(c), { enabled: body["enabled"] });
    return c.json({ settings: { enabled: settings.enabled } });
  } catch (err) {
    deps.logger.error("fact settings write failed", { error: errorMessage(err) });
    return errorResponse(c, 500, "Milo could not update the fact-memory setting.", "api_error", "internal_error");
  }
}
