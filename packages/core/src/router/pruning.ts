/**
 * Context pruning (ADR-014, ADR-013 phase C gate 6): the Jev questions that
 * ask whether the earliest context is safe to shed, and the pure machinery
 * that turns their answers into a contiguous, tool-safe range to drop.
 *
 * Adapted from the compact-adviser project. Like `gates.ts` and
 * `sampling.ts`, this module is the classification prompt's production home
 * -- the gateway executes pruning (`packages/gateway/src/routes/prune.ts`),
 * but the wording and the safety rules live here next to the router. Pruning
 * edits the caller's own message history, so every function below that
 * decides what to drop is pure and exhaustively unit-tested; a Jev failure
 * means the request is forwarded unpruned (the caller decides that).
 */

import type { JevClientLike, JevNoulQuestion, JevQuestion, JevScoreQuestion } from "../jev/types.js";
import type { ChatMessage } from "../types.js";
import { buildJevState, CHARS_PER_TOKEN, messageText } from "./context.js";

// ---------------------------------------------------------------------------
// The questions
// ---------------------------------------------------------------------------

export const oldestFinishedQuestion: JevNoulQuestion = {
  type: "noul",
  instructions:
    "This is a multi-turn conversation with an AI agent, oldest turns first. Consider only the EARLIEST unit of work in it -- the first task, tool loop, or sub-goal the conversation opened with. Is that earliest unit of work finished and safe to drop from the history without changing how the agent should answer the current, latest request?",
  criteria: {
    true: "The earliest work is complete and self-contained: its result was produced and used, or it was abandoned or superseded, and the current request does not depend on its details. Dropping it would not change the right answer now.",
    false: "The earliest work is unfinished, or the current request still depends on it: an open question, an in-progress task, a plan or constraint stated early and still in force, or a tool result the latest turn refers back to. Dropping it would lose something the agent still needs.",
  },
};

export const prunableQuestion: JevScoreQuestion = {
  type: "score",
  instructions:
    "In this oldest-first conversation, how prunable is the OLDER context -- everything before the latest request -- if the goal is to shrink the history the agent is re-sent while keeping every answer it should give unchanged? Rate how much of the older context is safe to shed, not how long the conversation is.",
  criteria: [
    "Keep it: the older context is load-bearing throughout. Early turns state constraints, decisions or facts the current work still depends on, and dropping any of it risks a worse answer.",
    "Mostly keep: only a little at the very start is finished; most of the older context is still relevant.",
    "Mostly prunable: the older context is largely finished or superseded work; a contiguous older stretch can be shed with little risk.",
    "Fully prunable: the older context is settled, self-contained, finished work with no bearing on the current request; a large older stretch can be shed safely.",
  ],
};

/** The question set for one pruning `systemone` call. Keys are the answer keys. */
export const PRUNING_QUESTIONS: Record<string, JevQuestion> = {
  oldest_finished: oldestFinishedQuestion,
  prunable: prunableQuestion,
};

/** Total budget for one pruning call, ms: same habit as ranking and the gate. */
export const PRUNE_BUDGET_MS = 8_000;

// ---------------------------------------------------------------------------
// The sliding threshold (compact-adviser)
// ---------------------------------------------------------------------------

/** Confidence floor to act when the context is nearly empty (<= 10% full). */
export const PRUNE_FLOOR_MAX = 0.9;
/** Confidence floor to act when the context is nearly full (>= 90% full). */
export const PRUNE_FLOOR_MIN = 0.5;
/** Fill ratio at or below which the floor is `PRUNE_FLOOR_MAX`. */
export const PRUNE_FILL_LOW = 0.1;
/** Fill ratio at or above which the floor is `PRUNE_FLOOR_MIN`. */
export const PRUNE_FILL_HIGH = 0.9;

/**
 * The acting floor at this context fill: 0.90 at <=10% used, falling linearly
 * to 0.50 at >=90% used. The fuller the window, the lower the confidence Milo
 * demands before it sheds context -- because the more it costs to keep it.
 */
export function pruningFloor(contextFillRatio: number): number {
  const fill = Number.isFinite(contextFillRatio) ? contextFillRatio : 0;
  if (fill <= PRUNE_FILL_LOW) return PRUNE_FLOOR_MAX;
  if (fill >= PRUNE_FILL_HIGH) return PRUNE_FLOOR_MIN;
  const t = (fill - PRUNE_FILL_LOW) / (PRUNE_FILL_HIGH - PRUNE_FILL_LOW);
  return PRUNE_FLOOR_MAX - t * (PRUNE_FLOOR_MAX - PRUNE_FLOOR_MIN);
}

/** Below this expected `prunable` score the older context is judged "keep it". */
export const PRUNE_MIN_SCORE = 1.0;

// ---------------------------------------------------------------------------
// The safe droppable window (pure)
// ---------------------------------------------------------------------------

/**
 * A contiguous, tool-safe range of older messages that may be dropped, as
 * indices into the original `messages`: `[start, end)`, with `cuts` the valid
 * boundary indices inside it (group-aligned, including `start` and `end`) that
 * a range may end on. An empty window has `end <= start`.
 */
export type PruneWindow = { start: number; end: number; cuts: number[] };

const EMPTY_WINDOW: PruneWindow = { start: 0, end: 0, cuts: [] };

function isProtectedRole(role: ChatMessage["role"]): boolean {
  return role === "system" || role === "developer";
}

function hasToolCalls(message: ChatMessage): boolean {
  return Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
}

/**
 * Splits the conversation into indivisible units. A unit is one message,
 * except that an assistant message bearing `tool_calls` absorbs the `tool`
 * result messages that immediately follow it: that whole call/result group is
 * one unit and may only be dropped or kept as a whole. A `tool` message that
 * is NOT part of such a group (its call is missing or already closed) starts
 * its own unit and is marked protected, so a boundary can never orphan it.
 */
type Unit = { start: number; end: number; protected: boolean };

function toUnits(messages: ChatMessage[], lastUserIdx: number): Unit[] {
  const units: Unit[] = [];
  let i = 0;
  while (i < messages.length) {
    const message = messages[i] as ChatMessage;
    // Everything at or after the latest user turn is off limits, but keep it
    // as (protected) units so the walk stays simple.
    const beyondLatest = i >= lastUserIdx;
    if (message.role === "assistant" && hasToolCalls(message)) {
      let end = i + 1;
      while (end < messages.length && (messages[end] as ChatMessage).role === "tool") end += 1;
      units.push({ start: i, end, protected: beyondLatest });
      i = end;
      continue;
    }
    const isOrphanTool = message.role === "tool";
    units.push({ start: i, end: i + 1, protected: beyondLatest || isProtectedRole(message.role) || isOrphanTool });
    i += 1;
  }
  return units;
}

/**
 * The largest safe contiguous window of older messages that may be dropped:
 * the first (oldest) maximal run of consecutive droppable units, aligned to
 * unit boundaries so a tool-call/result group is never split. Returns an
 * empty window when nothing is safe to shed.
 *
 * Invariants honoured here, so the caller cannot violate them:
 *   - system and developer messages are never inside the window;
 *   - the latest user turn and everything after it is never inside it;
 *   - the window never starts or ends inside a tool group;
 *   - the window is a single contiguous range.
 */
export function prunableWindow(messages: ChatMessage[]): PruneWindow {
  let lastUserIdx = -1;
  for (let i = 0; i < messages.length; i += 1) {
    if ((messages[i] as ChatMessage).role === "user") lastUserIdx = i;
  }
  // No latest user turn to protect means we cannot tell what is "current":
  // shed nothing rather than guess.
  if (lastUserIdx < 0) return EMPTY_WINDOW;

  const units = toUnits(messages, lastUserIdx);
  // Find the first maximal run of consecutive droppable units.
  let runStartUnit = -1;
  let runEndUnit = -1;
  for (let u = 0; u < units.length; u += 1) {
    if ((units[u] as Unit).protected) {
      if (runStartUnit >= 0) break;
      continue;
    }
    if (runStartUnit < 0) runStartUnit = u;
    runEndUnit = u;
  }
  if (runStartUnit < 0) return EMPTY_WINDOW;

  const start = (units[runStartUnit] as Unit).start;
  const end = (units[runEndUnit] as Unit).end;
  const cuts: number[] = [];
  for (let u = runStartUnit; u <= runEndUnit; u += 1) cuts.push((units[u] as Unit).start);
  cuts.push(end);
  return { start, end, cuts };
}

// ---------------------------------------------------------------------------
// The decision (pure)
// ---------------------------------------------------------------------------

/** What one pruning Jev call reports: the noul and the expected score. */
export type PruneAnswers = {
  /** `oldest_finished` noul, 0..1: the earliest work is finished and safe to drop. */
  finishedSafe: number;
  /** `prunable` expected score, 0..3: how prunable the older context is. */
  prunable: number;
};

/** The pruning verdict over one window: whether to prune, and the range. */
export type PruneDecision = {
  prune: boolean;
  /** The acting confidence compared against the floor (the `finishedSafe` noul). */
  confidence: number;
  /** The sliding floor at this context fill. */
  floor: number;
  /** Inclusive start index of the range to drop, when pruning. */
  from?: number;
  /** Exclusive end index of the range to drop, when pruning. */
  to?: number;
  /** How many messages the range covers (0 when not pruning). */
  droppedCount: number;
  reason: string;
};

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * Decides whether, and how much of, the safe `window` to drop. Pure.
 *
 * Prune only when the earliest work reads as finished with confidence at or
 * above the sliding floor for this fill, and the older context rates at least
 * `PRUNE_MIN_SCORE` prunable. The `prunable` score then sets the ambition:
 * `prunable / 3` of the window, snapped DOWN to a tool-group boundary so a
 * pair is never split, and at least the first (oldest) group when pruning at
 * all. The range is always the oldest part of the window.
 */
export function decidePrune(
  answers: PruneAnswers,
  contextFillRatio: number,
  window: PruneWindow,
): PruneDecision {
  const floor = pruningFloor(contextFillRatio);
  const confidence = clamp01(answers.finishedSafe);
  const span = window.end - window.start;

  if (span <= 0) {
    return { prune: false, confidence, floor, droppedCount: 0, reason: "no safe older range to prune" };
  }
  if (confidence < floor) {
    return {
      prune: false,
      confidence,
      floor,
      droppedCount: 0,
      reason: `earliest work not clearly finished (${confidence.toFixed(2)} < floor ${floor.toFixed(2)})`,
    };
  }
  if (answers.prunable < PRUNE_MIN_SCORE) {
    return {
      prune: false,
      confidence,
      floor,
      droppedCount: 0,
      reason: `older context judged load-bearing (prunable ${answers.prunable.toFixed(2)} < ${PRUNE_MIN_SCORE})`,
    };
  }

  const fraction = clamp01(answers.prunable / 3);
  const target = window.start + Math.round(fraction * span);
  // Snap DOWN to the nearest valid cut, but always drop at least the first group.
  let to = window.start;
  for (const cut of window.cuts) {
    if (cut <= target && cut > window.start) to = cut;
    if (cut > target) break;
  }
  if (to <= window.start) {
    const firstGroupCut = window.cuts.find((cut) => cut > window.start);
    to = firstGroupCut ?? window.end;
  }
  const droppedCount = to - window.start;
  if (droppedCount <= 0) {
    return { prune: false, confidence, floor, droppedCount: 0, reason: "range snapped to nothing" };
  }
  return {
    prune: true,
    confidence,
    floor,
    from: window.start,
    to,
    droppedCount,
    reason: `earliest ${droppedCount} messages prunable (finished ${confidence.toFixed(2)} >= floor ${floor.toFixed(2)}, prunable ${answers.prunable.toFixed(2)}/3)`,
  };
}

// ---------------------------------------------------------------------------
// Summarize, not delete
// ---------------------------------------------------------------------------

/** The one system note that replaces a dropped range. Names a count, no content. */
export function pruneNote(droppedCount: number): string {
  return `[earlier context pruned by Milo: ${droppedCount} messages]`;
}

/** Approximate input tokens for a conversation: total characters / 4 (ADR-014). */
export function estimatePromptTokens(messages: ChatMessage[]): number {
  let chars = 0;
  for (const message of messages) chars += messageText(message.content).length;
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

// ---------------------------------------------------------------------------
// The Jev call
// ---------------------------------------------------------------------------

/**
 * Asks Jev the two pruning questions over the conversation. The state is
 * `buildJevState`'s compact view, exactly what the router builds (a separate
 * call: this never touches the router's own). Throws on a Jev failure or a
 * malformed answer; the caller forwards unpruned on a throw.
 *
 * `apiKey` is the caller's forwarded OpenRouter key (ADR-022): under the
 * `"openrouter"` Jev transport it authenticates this call so it bills to the
 * user's key, not Milo's `JEV_API_KEY`. The TypeSafe transport ignores it, so
 * it can be passed unconditionally.
 */
export async function checkPrune(
  jev: JevClientLike,
  messages: ChatMessage[],
  budgetMs = PRUNE_BUDGET_MS,
  apiKey?: string,
): Promise<PruneAnswers> {
  const { state } = buildJevState(messages);
  const result = await jev.systemone(
    { state, questions: PRUNING_QUESTIONS },
    { budgetMs, ...(apiKey !== undefined && apiKey !== "" ? { apiKey } : {}) },
  );
  const finished = result.answers["oldest_finished"];
  const prunable = result.answers["prunable"];
  if (finished?.type !== "noul" || prunable?.type !== "score") {
    throw new Error("jev returned prune answers of the wrong shape");
  }
  const expected = Object.entries(prunable.probabilities).reduce(
    (sum, [level, p]) => sum + Number(level) * p,
    0,
  );
  return {
    finishedSafe: finished.noul,
    prunable: Number.isFinite(expected) ? expected : prunable.score,
  };
}
