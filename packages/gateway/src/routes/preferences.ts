/**
 * `/v1/preferences` -- disclosure and control for preference memory
 * (ADR-011).
 *
 * Milo remembering things about a caller is only tolerable if the caller can
 * see and delete every one of them, so both halves exist from day one:
 *
 *   - `GET /v1/preferences` lists every stored row for the calling key --
 *     scope, field, value, confidence, version, provenance, timestamps --
 *     plus the key's capture and brief switches. The rows are labels from a
 *     closed vocabulary; there is no content to show because none is stored.
 *   - `DELETE /v1/preferences/:id` removes one row on demand. The whole set
 *     dies with the key hash anyway (rotate the key and Milo has never heard
 *     of you), but a user should not have to rotate a key to be forgotten.
 *
 * Scoped exactly as per-key rosters are (ADR-008): `callerScope(c)` -- the
 * account key's hash for an `mk_` key, the SHA-256 of the bearer credential
 * otherwise -- so one caller can neither read nor delete another's rows, and
 * a delete for a row that is not yours is the same 404 a missing row gets.
 */

import type { Context, Hono } from "hono";
import type { AppDeps } from "../app.js";
import { callerScope } from "../billing.js";
import { errorMessage, errorResponse } from "../errors.js";

export function registerPreferencesRoutes(app: Hono, deps: AppDeps): void {
  app.get("/v1/preferences", (c) => listPreferences(c, deps));
  app.delete("/v1/preferences/:id", (c) => deletePreference(c, deps));
}

async function listPreferences(c: Context, deps: AppDeps): Promise<Response> {
  const keyHash = callerScope(c);
  try {
    const [rows, settings] = await Promise.all([
      deps.log.listPreferences(keyHash),
      deps.log.getPreferenceSettings(keyHash),
    ]);
    return c.json({
      // The caller knows their own key; the hash adds nothing but noise.
      data: rows.map(({ keyHash: _keyHash, ...row }) => row),
      settings: { captureEnabled: settings.captureEnabled, briefEnabled: settings.briefEnabled },
    });
  } catch (err) {
    deps.logger.error("preference list failed", { error: errorMessage(err) });
    return errorResponse(c, 500, "Milo could not read stored preferences.", "api_error", "internal_error");
  }
}

async function deletePreference(c: Context, deps: AppDeps): Promise<Response> {
  const id = c.req.param("id") ?? "";
  try {
    const deleted = await deps.log.deletePreference(callerScope(c), id);
    if (!deleted) {
      // Missing and someone else's are the same answer on purpose: the
      // endpoint must not confirm that an id exists under another key.
      return errorResponse(c, 404, "No preference with that id.", "not_found_error", "preference_not_found");
    }
    return c.json({ deleted: true, id });
  } catch (err) {
    deps.logger.error("preference delete failed", { error: errorMessage(err) });
    return errorResponse(c, 500, "Milo could not delete that preference.", "api_error", "internal_error");
  }
}
