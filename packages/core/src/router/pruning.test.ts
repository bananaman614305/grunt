/**
 * Context pruning (ADR-014): the sliding-threshold curve, every safety
 * invariant of the droppable window, the drop-vs-keep and summarize behaviour
 * of `decidePrune`, and the `checkPrune` Jev wrapper. Everything that decides
 * WHAT to drop is pure, so it is tested here exhaustively -- pruning edits the
 * caller's own history and must never split a pair, drop a system prompt, or
 * touch the latest turn.
 */

import { describe, expect, it } from "vitest";
import type { JevClientLike, SystemOneRequest, SystemOneResult } from "../jev/types.js";
import type { ChatMessage } from "../types.js";
import {
  checkPrune,
  decidePrune,
  estimatePromptTokens,
  PRUNE_FLOOR_MAX,
  PRUNE_FLOOR_MIN,
  PRUNE_MIN_SCORE,
  prunableWindow,
  pruneNote,
  pruningFloor,
  PRUNING_QUESTIONS,
} from "./pruning.js";
import type { PruneWindow } from "./pruning.js";

// ---------------------------------------------------------------------------
// The sliding threshold
// ---------------------------------------------------------------------------

describe("pruningFloor", () => {
  it("is 0.90 at or below 10% full and 0.50 at or above 90% full", () => {
    expect(pruningFloor(0)).toBe(PRUNE_FLOOR_MAX);
    expect(pruningFloor(0.1)).toBe(PRUNE_FLOOR_MAX);
    expect(pruningFloor(0.9)).toBe(PRUNE_FLOOR_MIN);
    expect(pruningFloor(1)).toBe(PRUNE_FLOOR_MIN);
    expect(pruningFloor(5)).toBe(PRUNE_FLOOR_MIN);
  });

  it("falls linearly between the two anchors", () => {
    expect(pruningFloor(0.5)).toBeCloseTo(0.7, 10); // midpoint
    expect(pruningFloor(0.3)).toBeCloseTo(0.8, 10);
    expect(pruningFloor(0.7)).toBeCloseTo(0.6, 10);
  });

  it("loosens monotonically as the context fills", () => {
    let prev = pruningFloor(0);
    for (let fill = 0.05; fill <= 1; fill += 0.05) {
      const now = pruningFloor(fill);
      expect(now).toBeLessThanOrEqual(prev + 1e-9);
      prev = now;
    }
  });

  it("treats a non-finite fill as empty", () => {
    expect(pruningFloor(Number.NaN)).toBe(PRUNE_FLOOR_MAX);
  });
});

// ---------------------------------------------------------------------------
// The safe droppable window
// ---------------------------------------------------------------------------

const sys = (content: string): ChatMessage => ({ role: "system", content });
const dev = (content: string): ChatMessage => ({ role: "developer", content });
const user = (content: string): ChatMessage => ({ role: "user", content });
const asst = (content: string): ChatMessage => ({ role: "assistant", content });
const toolCall = (): ChatMessage => ({ role: "assistant", content: null, tool_calls: [{ id: "t1" }] });
const toolResult = (content: string): ChatMessage => ({ role: "tool", content, tool_call_id: "t1" });

describe("prunableWindow", () => {
  it("never includes the system prompt or the latest user turn", () => {
    const messages = [sys("You are X."), user("old 1"), asst("a1"), user("old 2"), asst("a2"), user("latest")];
    const window = prunableWindow(messages);
    expect(window.start).toBe(1);
    expect(window.end).toBe(5); // stops before the latest user turn at 5
    expect(window.cuts).toEqual([1, 2, 3, 4, 5]);
  });

  it("never includes an interior system/developer message", () => {
    const messages = [sys("preamble"), user("old"), dev("interior rule"), asst("a"), user("latest")];
    const window = prunableWindow(messages);
    // The droppable run is just the first user turn; the interior developer
    // message breaks it and is never in the window.
    expect(window.start).toBe(1);
    expect(window.end).toBe(2);
    expect(window.cuts).toEqual([1, 2]);
  });

  it("aligns the window to whole tool-call/result groups", () => {
    const messages = [sys("s"), user("old"), toolCall(), toolResult("r1"), toolResult("r2"), asst("done"), user("latest")];
    const window = prunableWindow(messages);
    expect(window.start).toBe(1);
    expect(window.end).toBe(6);
    // 3 and 4 (inside the tool group) are NOT valid cut points.
    expect(window.cuts).toEqual([1, 2, 5, 6]);
  });

  it("protects an orphan tool message whose call is not in view", () => {
    const messages = [sys("s"), user("old"), toolResult("orphan"), asst("a"), user("latest")];
    const window = prunableWindow(messages);
    expect(window.start).toBe(1);
    expect(window.end).toBe(2); // the run stops before the orphan tool result
  });

  it("returns an empty window when there is no latest user turn", () => {
    expect(prunableWindow([sys("s"), asst("a")])).toEqual({ start: 0, end: 0, cuts: [] });
  });

  it("returns an empty window when the only user turn is the latest", () => {
    const window = prunableWindow([sys("s"), user("the one and only")]);
    expect(window.end).toBeLessThanOrEqual(window.start);
  });
});

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

const fullWindow: PruneWindow = { start: 1, end: 5, cuts: [1, 2, 3, 4, 5] };
const groupWindow: PruneWindow = { start: 1, end: 6, cuts: [1, 2, 5, 6] };

describe("decidePrune", () => {
  it("prunes the whole window when finished-safe clears the floor and prunable is 3", () => {
    const d = decidePrune({ finishedSafe: 0.95, prunable: 3 }, 0.05, fullWindow);
    expect(d.prune).toBe(true);
    expect(d.from).toBe(1);
    expect(d.to).toBe(5);
    expect(d.droppedCount).toBe(4);
  });

  it("does not prune when finished-safe is below the sliding floor", () => {
    // At 5% full the floor is 0.90; 0.7 is under it.
    const d = decidePrune({ finishedSafe: 0.7, prunable: 3 }, 0.05, fullWindow);
    expect(d.prune).toBe(false);
    expect(d.droppedCount).toBe(0);
  });

  it("acts on the same confidence once the fuller context lowers the floor", () => {
    // At 90% full the floor is 0.50, so 0.7 now clears it.
    const d = decidePrune({ finishedSafe: 0.7, prunable: 3 }, 0.9, fullWindow);
    expect(d.prune).toBe(true);
  });

  it("keeps everything when the older context rates below the prunable minimum", () => {
    const d = decidePrune({ finishedSafe: 0.99, prunable: PRUNE_MIN_SCORE - 0.01 }, 0.05, fullWindow);
    expect(d.prune).toBe(false);
  });

  it("scales how much it drops by the prunable score", () => {
    const light = decidePrune({ finishedSafe: 0.95, prunable: 1.2 }, 0.05, fullWindow);
    const heavy = decidePrune({ finishedSafe: 0.95, prunable: 2.9 }, 0.05, fullWindow);
    expect(light.droppedCount).toBeLessThan(heavy.droppedCount);
  });

  it("never snaps a range into the middle of a tool group", () => {
    // prunable 2 targets index ~4, which is inside the tool group (2..5);
    // it must snap DOWN to cut 2, dropping only the first user turn.
    const d = decidePrune({ finishedSafe: 0.95, prunable: 2 }, 0.05, groupWindow);
    expect(d.prune).toBe(true);
    expect(d.from).toBe(1);
    expect(d.to).toBe(2);
    expect(groupWindow.cuts).toContain(d.to);
  });

  it("drops the whole group when the score reaches for the window end", () => {
    const d = decidePrune({ finishedSafe: 0.95, prunable: 3 }, 0.05, groupWindow);
    expect(d.to).toBe(6);
  });

  it("drops at least the first group when it prunes at all", () => {
    const d = decidePrune({ finishedSafe: 0.95, prunable: PRUNE_MIN_SCORE }, 0.05, groupWindow);
    expect(d.prune).toBe(true);
    expect(d.droppedCount).toBeGreaterThanOrEqual(1);
    expect(d.to).toBe(2); // the first valid cut past the start
  });

  it("does not prune an empty window", () => {
    const d = decidePrune({ finishedSafe: 1, prunable: 3 }, 0.05, { start: 3, end: 3, cuts: [] });
    expect(d.prune).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Summarize, not delete
// ---------------------------------------------------------------------------

describe("pruneNote", () => {
  it("names a count and no content", () => {
    expect(pruneNote(4)).toBe("[earlier context pruned by Milo: 4 messages]");
  });
});

describe("estimatePromptTokens", () => {
  it("approximates total characters over four", () => {
    const messages = [sys("a".repeat(40)), user("b".repeat(40))];
    expect(estimatePromptTokens(messages)).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// The Jev call
// ---------------------------------------------------------------------------

function pruneJev(finishedSafe: number, scoreProbs: Record<string, number>): JevClientLike & { calls: SystemOneRequest[] } {
  const calls: SystemOneRequest[] = [];
  return {
    calls,
    systemone: (req) => {
      calls.push(req as SystemOneRequest);
      const score = Object.entries(scoreProbs).reduce((s, [lvl, p]) => s + Number(lvl) * p, 0);
      return Promise.resolve({
        model: "jev-latest",
        answers: {
          oldest_finished: { type: "noul", noul: finishedSafe },
          prunable: { type: "score", score: Math.round(score), confidence: 0.8, probabilities: scoreProbs },
        },
        usage: { input_tokens: 500, output_tokens: 4 },
        requestId: "req_prune",
        latencyMs: 30,
      } satisfies SystemOneResult);
    },
  };
}

describe("checkPrune", () => {
  const messages = [sys("You are a sub-agent."), user("first task"), asst("done"), user("now do this")];

  it("sends the pruning questions and returns the noul and the expected score", async () => {
    const jev = pruneJev(0.88, { "0": 0, "1": 0, "2": 0.3, "3": 0.7 });
    const answers = await checkPrune(jev, messages);
    expect(answers.finishedSafe).toBe(0.88);
    expect(answers.prunable).toBeCloseTo(2.7, 10);
    expect(jev.calls[0]?.questions).toBe(PRUNING_QUESTIONS);
  });

  it("throws when Jev returns the wrong answer shapes", async () => {
    const jev: JevClientLike = {
      systemone: () =>
        Promise.resolve({
          model: "jev-latest",
          answers: { oldest_finished: { type: "score", score: 1, confidence: 0.5, probabilities: { "1": 1 } } },
          usage: { input_tokens: 1, output_tokens: 1 },
          requestId: "r",
          latencyMs: 1,
        } as unknown as SystemOneResult),
    };
    await expect(checkPrune(jev, messages)).rejects.toThrow(/wrong shape/);
  });
});
