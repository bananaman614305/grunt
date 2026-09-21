/**
 * Preference capture, gateway side (ADR-011).
 *
 * Detection already happened: the capture questions rode the routing
 * systemone call, and when they fired the router put a
 * `PreferenceCaptureSignal` on the decision's `signals.capture`. This module
 * is the second half -- the one extra Jev call on the rare preference-stating
 * turn that resolves *which value* was stated, as a choice over the field's
 * closed vocabulary, and records it.
 *
 * The routed path in `routes/chat.ts` wires it in with one fire-and-forget
 * line after the decision is logged (`maybeCapture` no-ops when detection
 * did not fire, when the deployment has no Jev client in `deps.jev`, or when
 * the key's `captureEnabled` switch is off, so the call site stays
 * unconditional):
 *
 *   void maybeCapture(deps.log, deps.jev, { keyHash: callerScope(c), messages, signals: decision.signals, provenance: decision.fingerprint, logger: deps.logger });
 *
 * Nothing in here can fail a request: every failure path logs a warning at
 * most and resolves undefined. Nothing in here stores content: the Jev call
 * is classification only, the candidate is closed-vocabulary labels, and the
 * provenance is the decision's fingerprint -- a digest the request already
 * has (ADR-003).
 */

import { buildJevState, isPreferenceField, resolutionQuestions, resolveCapture } from "@milo/core";
import type {
  ChatMessage,
  JevClientLike,
  PreferenceRow,
  PreferenceStore,
  RouteSignals,
  TaskType,
} from "@milo/core";
import type { Logger } from "./app.js";
import { errorMessage } from "./errors.js";

/**
 * Budget for the resolution call, retries included. Generous relative to the
 * routing call's, because nothing waits on it: the user's response has
 * already been forwarded when this settles.
 */
export const CAPTURE_BUDGET_MS = 5_000;

export type MaybeCaptureOptions = {
  /** The caller's identity: `callerScope(c)`, never a credential. */
  keyHash: string;
  /** The conversation, for the resolution call's state. */
  messages: ChatMessage[];
  /** The routed decision's signals; `signals.capture` is the trigger. */
  signals: RouteSignals | undefined;
  /** The decision's fingerprint: the stored row's provenance. */
  provenance: string;
  budgetMs?: number;
  /**
   * The caller's forwarded OpenRouter key (ADR-022): under the `"openrouter"`
   * Jev transport it authenticates the resolution call so it bills to the
   * user's key, never Milo's `JEV_API_KEY`. Absent under the TypeSafe transport.
   */
  jevKey?: string;
  logger?: Logger;
};

/**
 * Runs the resolution call and upserts the captured preference, when -- and
 * only when -- detection fired on the routing call. Resolves the stored row,
 * or undefined for every no-op and failure path.
 */
export async function maybeCapture(
  store: PreferenceStore,
  jev: JevClientLike | undefined,
  opts: MaybeCaptureOptions,
): Promise<PreferenceRow | undefined> {
  const detected = opts.signals?.capture;
  if (detected === undefined || jev === undefined) return undefined;

  try {
    const settings = await store.getPreferenceSettings(opts.keyHash);
    if (!settings.captureEnabled) return undefined;

    // `signals.capture.field` is a string on the pinned contract; only the
    // preferences module knows the vocabulary, so re-check before asking Jev.
    const field = detected.field;
    if (!isPreferenceField(field)) return undefined;

    const { state } = buildJevState(opts.messages);
    const result = await jev.systemone(
      { state, questions: resolutionQuestions(field) },
      {
        budgetMs: opts.budgetMs ?? CAPTURE_BUDGET_MS,
        ...(opts.jevKey !== undefined && opts.jevKey !== "" ? { apiKey: opts.jevKey } : {}),
      },
    );

    const candidate = resolveCapture(result.answers, detected, taskTypeOf(opts.signals));
    if (candidate === undefined) return undefined;

    const row = await store.upsertPreference(opts.keyHash, {
      ...candidate,
      provenance: opts.provenance,
    });
    opts.logger?.info("captured preference", {
      // Labels and numbers only: never the user's words (ADR-011).
      field: row.field,
      value: row.value,
      scope: row.scope,
      version: row.version,
      confidence: Number(row.confidence.toFixed(3)),
    });
    return row;
  } catch (err) {
    opts.logger?.warn("preference capture failed", { error: errorMessage(err) });
    return undefined;
  }
}

function taskTypeOf(signals: RouteSignals | undefined): { taskType?: TaskType } {
  return signals === undefined ? {} : { taskType: signals.taskType };
}
