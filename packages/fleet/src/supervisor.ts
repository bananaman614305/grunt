/**
 * The supervisor (ADR-015): turn a worker's recent event window into a Jev
 * supervision call and read back a typed verdict. Two halves:
 *
 *   - `summarizeWindow` is PURE: it reduces an ordered `WorkerEvent[]` to the
 *     coarse counts and gaps the Jev questions grade (repetition, idle gap,
 *     whether an edit landed). No message content, no I/O. Unit-tested
 *     directly against fixture streams.
 *   - `classifyWorker` sends that summary to Jev and maps the answers to a
 *     `WorkerClassification`. The mapping is pure over Jev's answers -- it adds
 *     no heuristic of its own -- so a fake Jev that grades the summary makes
 *     fixture streams flow end-to-end to the expected verdict.
 *
 * The supervisor never inspects raw pi JSON or model output; it sees only the
 * `WorkerEvent` shape and the summary below, which is what keeps generated
 * content out of the supervision call.
 */

import type { JevClientLike } from "@milo/core";
import type { WorkerEvent } from "./events.js";
import { isWorkerVerdict, SUPERVISION_QUESTIONS } from "./questions.js";
import type { WorkerClassification } from "./types.js";

/** Total budget for one supervision call, ms. Same habit as the router's gate. */
export const SUPERVISION_BUDGET_MS = 8_000;

/**
 * The coarse activity summary handed to Jev. Every field is a count, a ratio,
 * or a gap -- nothing that could carry worker output. `toolHistogram` is a
 * plain object so it serialises into the Jev `state` verbatim.
 */
export type WindowSummary = {
  /** Events considered (turns + tool calls + malformed markers). */
  eventCount: number;
  turns: number;
  toolCalls: number;
  malformed: number;
  /** Tool executions by name, over the window. */
  toolHistogram: Record<string, number>;
  /** distinct tool names / total tool calls, 1 when no tools ran. Low = repetition. */
  toolVariety: number;
  /** The most-repeated single tool's share of all tool calls, 0..1. */
  topToolShare: number;
  /** Whether any edit-shaped tool call appears in the window. */
  editsLanded: boolean;
  /** Milliseconds since the last event, relative to `now`; null when empty. */
  idleMs: number | null;
  /** Output tokens summed over the window's turns. */
  outputTokens: number;
};

/**
 * Reduce a worker's recent events to the supervision summary. `now` is the
 * reference time for the idle gap (injected for deterministic tests).
 */
export function summarizeWindow(events: readonly WorkerEvent[], now: number): WindowSummary {
  const toolHistogram: Record<string, number> = {};
  let turns = 0;
  let toolCalls = 0;
  let malformed = 0;
  let editsLanded = false;
  let outputTokens = 0;

  for (const event of events) {
    if (event.kind === "turn") {
      turns += 1;
      outputTokens += event.outputTokens;
    } else if (event.kind === "tool") {
      toolCalls += 1;
      toolHistogram[event.tool] = (toolHistogram[event.tool] ?? 0) + 1;
      if (event.edits) editsLanded = true;
    } else {
      malformed += 1;
    }
  }

  const counts = Object.values(toolHistogram);
  const distinct = counts.length;
  const toolVariety = toolCalls === 0 ? 1 : distinct / toolCalls;
  const topToolShare = toolCalls === 0 ? 0 : Math.max(0, ...counts) / toolCalls;

  const last = events[events.length - 1];
  const idleMs = last === undefined ? null : Math.max(0, now - last.at);

  return {
    eventCount: events.length,
    turns,
    toolCalls,
    malformed,
    toolHistogram,
    toolVariety,
    topToolShare,
    editsLanded,
    idleMs,
    outputTokens,
  };
}

/** Options for one supervision pass. */
export type ClassifyOptions = {
  /** Reference time for the idle gap; defaults to `Date.now()`. */
  now?: number;
  /** Total Jev budget for this call, ms. */
  budgetMs?: number;
};

/**
 * Ask Jev to classify one worker from its recent event window. Returns the
 * typed verdict, Jev's confidence, and the `needs_human` gate. Throws on a Jev
 * failure or a malformed answer; the fleet decides what that means (it leaves
 * the worker's prior classification in place and records the error).
 */
export async function classifyWorker(
  jev: JevClientLike,
  recentEvents: readonly WorkerEvent[],
  opts: ClassifyOptions = {},
): Promise<WorkerClassification> {
  const now = opts.now ?? Date.now();
  const summary = summarizeWindow(recentEvents, now);

  const result = await jev.systemone(
    { state: summary as unknown as Record<string, unknown>, questions: SUPERVISION_QUESTIONS },
    { budgetMs: opts.budgetMs ?? SUPERVISION_BUDGET_MS },
  );

  const state = result.answers["worker_state"];
  if (state?.type !== "choice" || !isWorkerVerdict(state.choice)) {
    throw new Error("jev returned a worker_state answer of the wrong shape");
  }
  const gate = result.answers["needs_human"];
  const needsHuman = gate?.type === "noul" ? gate.noul >= 0.5 : false;

  return {
    verdict: state.choice,
    confidence: state.confidence,
    needsHuman,
    latencyMs: result.latencyMs,
  };
}
