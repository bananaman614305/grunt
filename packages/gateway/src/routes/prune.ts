/**
 * Executing context pruning (ADR-014, ADR-013 phase C gate 6) on a routed
 * `POST /v1/chat/completions` request, BEFORE it is forwarded.
 *
 * `maybePrune` decides whether the gate applies (enabled, over the token
 * floor, not `low` posture, a Jev client present), asks Jev the two pruning
 * questions once (`checkPrune`, core -- a separate call that never touches
 * the router's own), and, when the pure `decidePrune` says so, replaces a
 * contiguous older range of the caller's messages with one summary note. It
 * mutates `body.messages` in place and returns the disclosure the forwards
 * set on the response and record; every failure path forwards the request
 * unpruned. The safety of WHAT is dropped lives entirely in the pure core
 * functions -- this file only wires them to the request.
 */

import {
  CHARS_PER_TOKEN,
  checkPrune,
  decidePrune,
  defaultRosterModel,
  estimatePromptTokens,
  messageText,
  pruneNote,
  prunableWindow,
} from "@milo/core";
import type { ChatMessage, CostPosture, MiloRequestExtension, PruneUpstream, RouteDecision } from "@milo/core";
import type { AppDeps } from "../app.js";
import type { Body } from "./shared.js";

export const PRUNED_HEADER = "x-milo-pruned";
export const PRUNED_TOKENS_HEADER = "x-milo-pruned-tokens";

/** Default token floor a conversation must exceed before pruning is considered. */
export const PRUNING_MIN_CONTEXT_TOKENS = 40_000;

/** Fallback context window when the picked model has no known `contextLength`. */
export const PRUNING_DEFAULT_CONTEXT_WINDOW = 128_000;

/** What a fired prune reports back to the forward: disclosure and the record. */
export type PruneOutcome = {
  pruned: number;
  tokensSaved: number;
  from: number;
  to: number;
  confidence: number;
  floor: number;
  fillRatio: number;
};

/** A failure class for the log: a name, never upstream text. */
function classify(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "AbortError" || error.name === "TimeoutError") return "timeout";
    if (/fetch failed|ECONNREFUSED|ENOTFOUND|network/i.test(error.message)) return "network";
    return error.name === "Error" ? "error" : error.name;
  }
  return "error";
}

/**
 * Whether the pruning gate is enabled for this request. Off by default; a
 * deployment turns it on with `pruning.enabled`, and a request opts in or out
 * with `milo: { prune }`, where `false` always wins.
 */
function pruneEnabled(deps: AppDeps, extension: MiloRequestExtension | undefined): boolean {
  if (extension?.prune === false) return false;
  if (extension?.prune === true) return true;
  return deps.pruning?.enabled === true;
}

function contextWindowFor(deps: AppDeps, model: string): number {
  const known = defaultRosterModel(model)?.contextLength;
  if (known !== undefined && known > 0) return known;
  return deps.pruning?.contextWindowTokens ?? PRUNING_DEFAULT_CONTEXT_WINDOW;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Prunes safe older context from `body` in place when the gate applies and
 * Jev clears the sliding floor. Returns the disclosure when a range was
 * dropped, else `undefined` (nothing changed). Never throws and never fails
 * the request: a Jev error, an empty window, or a "keep it" verdict all mean
 * "forward unpruned".
 */
export async function maybePrune(
  deps: AppDeps,
  body: Body,
  decision: RouteDecision,
  posture: CostPosture,
  extension: MiloRequestExtension | undefined,
): Promise<PruneOutcome | undefined> {
  const jev = deps.jev;
  if (jev === undefined) return undefined;
  if (posture === "low") return undefined;
  if (!pruneEnabled(deps, extension)) return undefined;

  const messages = Array.isArray(body["messages"]) ? (body["messages"] as ChatMessage[]) : [];
  const minTokens = deps.pruning?.minContextTokens ?? PRUNING_MIN_CONTEXT_TOKENS;
  const approxTokens = estimatePromptTokens(messages);
  if (approxTokens < minTokens) return undefined;

  const window = prunableWindow(messages);
  if (window.end <= window.start) return undefined;

  const fillRatio = approxTokens / contextWindowFor(deps, decision.model);

  let answers;
  try {
    answers = await checkPrune(jev, messages);
  } catch (error) {
    deps.logger.warn("context pruning check failed; forwarding unpruned", {
      decisionId: decision.id,
      error: classify(error),
    });
    return undefined;
  }

  const verdict = decidePrune(answers, fillRatio, window);
  if (!verdict.prune || verdict.from === undefined || verdict.to === undefined) return undefined;

  const from = verdict.from;
  const to = verdict.to;
  let droppedChars = 0;
  for (const message of messages.slice(from, to)) droppedChars += messageText(message.content).length;
  const note: ChatMessage = { role: "system", content: pruneNote(to - from) };
  body["messages"] = [...messages.slice(0, from), note, ...messages.slice(to)];

  const tokensSaved = Math.max(0, Math.round((droppedChars - messageText(note.content).length) / CHARS_PER_TOKEN));
  deps.logger.info("context pruned", {
    decisionId: decision.id,
    pruned: to - from,
    tokensSaved,
  });
  return {
    pruned: to - from,
    tokensSaved,
    from,
    to,
    confidence: verdict.confidence,
    floor: verdict.floor,
    fillRatio,
  };
}

/** Sets the two disclosure headers when a range was pruned. */
export function applyPruneHeaders(headers: Headers, outcome: PruneOutcome | undefined): void {
  if (outcome === undefined) return;
  headers.set(PRUNED_HEADER, String(outcome.pruned));
  headers.set(PRUNED_TOKENS_HEADER, String(outcome.tokensSaved));
}

/** The decision-log `prune` block for the upstream record, or `{}` when none. */
export function pruneRecord(outcome: PruneOutcome | undefined): { prune?: PruneUpstream } {
  if (outcome === undefined) return {};
  return {
    prune: {
      pruned: outcome.pruned,
      tokensSaved: outcome.tokensSaved,
      from: outcome.from,
      to: outcome.to,
      confidence: round2(outcome.confidence),
      floor: round2(outcome.floor),
      fillRatio: round2(outcome.fillRatio),
    },
  };
}
