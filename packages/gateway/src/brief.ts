/**
 * Brief injection (ADR-011): the one place a routed request's body is ever
 * added to.
 *
 * The routed path in `routes/chat.ts` wires this in with two lines, just
 * before it forwards:
 *
 *   const brief = await routedBrief(deps.log, callerScope(c), { extension, taskType: decision.signals?.taskType, logger: deps.logger });
 *   return forward(c, deps, applyBrief(body, brief), decision, brief);
 *
 * with `forward` merging `briefHeaders(brief?.version)` into the response
 * headers after `applyMiloHeaders`. That call site -- not this module -- is
 * where the two opt-outs take effect, and both are enforced *inside*
 * `routedBrief` so the wiring stays unconditional:
 *
 *   - per request: `milo: { brief: false }` arrives as `extension.brief` and
 *     short-circuits before the store is read;
 *   - per key: the `briefEnabled` switch in the preference settings row
 *     (`preference_settings`, ADR-011's per-key disable).
 *
 * Everything else about the body still passes through untouched: the brief
 * is one *appended* final system message, never an edit to anything the
 * client sent, and the routed response names the brief that shaped it in
 * `x-milo-brief-version` so injection is always disclosed.
 */

import { compileBrief, effectiveRows } from "@milo/core";
import type { ChatMessage, CompiledBrief, MiloRequestExtension, PreferenceStore, TaskType } from "@milo/core";
import type { Logger } from "./app.js";
import { errorMessage } from "./errors.js";
import type { Body } from "./routes/shared.js";

/** Names the brief that shaped a routed response. */
export const BRIEF_VERSION_HEADER = "x-milo-brief-version";

/**
 * The brief to inject for this routed request, or undefined: the request
 * opted out, the key's `briefEnabled` switch is off, the caller has no
 * output-shaping rows, or the store could not be read. A store failure is
 * logged and swallowed -- a missing brief degrades the answer's shape, a 500
 * would cost the answer itself.
 */
export async function routedBrief(
  store: PreferenceStore,
  keyHash: string,
  opts: { extension?: MiloRequestExtension | undefined; taskType?: TaskType | undefined; logger?: Logger } = {},
): Promise<CompiledBrief | undefined> {
  if (opts.extension?.brief === false) return undefined;
  try {
    const settings = await store.getPreferenceSettings(keyHash);
    if (!settings.briefEnabled) return undefined;
    const rows = await store.listPreferences(keyHash);
    if (rows.length === 0) return undefined;
    return compileBrief(effectiveRows(rows, opts.taskType));
  } catch (err) {
    opts.logger?.warn("preference brief read failed", { error: errorMessage(err) });
    return undefined;
  }
}

/**
 * Returns `body` with the brief appended as a final system message, or the
 * body untouched when there is no brief. Never mutates the input, and never
 * touches any field but `messages` -- ADR-011's amendment to the pass-through
 * rule is exactly this one appended message.
 */
export function applyBrief(body: Body, brief: CompiledBrief | undefined): Body {
  if (brief === undefined) return body;
  const messages = Array.isArray(body["messages"]) ? (body["messages"] as ChatMessage[]) : [];
  return { ...body, messages: [...messages, { role: "system", content: brief.text }] };
}

/**
 * The disclosure header for an injected brief, as a record to merge into the
 * response headers. Empty when nothing was injected, so the header's absence
 * always means "no brief shaped this response".
 */
export function briefHeaders(version: string | undefined): Record<string, string> {
  return version === undefined ? {} : { [BRIEF_VERSION_HEADER]: version };
}
