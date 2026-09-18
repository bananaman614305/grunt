import { describe, expect, it } from "vitest";
import type { JevClientLike, SystemOneRequest, SystemOneResult } from "@milo/core";
import type { WorkerEvent } from "./events.js";
import { SUPERVISION_QUESTIONS } from "./questions.js";
import { classifyWorker, summarizeWindow, type WindowSummary } from "./supervisor.js";

// --- fixture event streams -------------------------------------------------

/** A worker looping the same failing tool: many calls, one tool, no edits. */
const LOOPING: WorkerEvent[] = [
  { kind: "turn", at: 100, outputTokens: 40 },
  { kind: "tool", at: 110, tool: "run_tests", edits: false },
  { kind: "turn", at: 120, outputTokens: 38 },
  { kind: "tool", at: 130, tool: "run_tests", edits: false },
  { kind: "turn", at: 140, outputTokens: 41 },
  { kind: "tool", at: 150, tool: "run_tests", edits: false },
  { kind: "tool", at: 160, tool: "run_tests", edits: false },
];

/** A worker that finished: varied work, an edit landed, then it went quiet. */
const FINISHED: WorkerEvent[] = [
  { kind: "tool", at: 100, tool: "read_file", edits: false },
  { kind: "turn", at: 110, outputTokens: 300 },
  { kind: "tool", at: 120, tool: "edit", edits: true },
  { kind: "tool", at: 130, tool: "run_tests", edits: false },
  { kind: "turn", at: 140, outputTokens: 120 },
];

/** A worker gone quiet: a couple of early events, then a long idle gap. */
const QUIET: WorkerEvent[] = [
  { kind: "tool", at: 100, tool: "read_file", edits: false },
  { kind: "turn", at: 110, outputTokens: 30 },
];

/** A worker making forward progress: varied tools, edits, recent activity. */
const PROGRESSING: WorkerEvent[] = [
  { kind: "tool", at: 100, tool: "read_file", edits: false },
  { kind: "turn", at: 110, outputTokens: 200 },
  { kind: "tool", at: 120, tool: "grep", edits: false },
  { kind: "tool", at: 130, tool: "edit", edits: true },
  { kind: "turn", at: 140, outputTokens: 180 },
  { kind: "tool", at: 150, tool: "write", edits: true },
];

describe("summarizeWindow", () => {
  it("scores a looping stream as high-repetition, no edits", () => {
    const s = summarizeWindow(LOOPING, 170);
    expect(s.toolCalls).toBe(4);
    expect(s.editsLanded).toBe(false);
    expect(s.topToolShare).toBe(1); // all four tool calls are run_tests
    expect(s.toolVariety).toBeCloseTo(0.25); // one distinct tool / four calls
    expect(s.idleMs).toBe(10);
  });

  it("scores a finished stream as edited and winding down", () => {
    const s = summarizeWindow(FINISHED, 700);
    expect(s.editsLanded).toBe(true);
    expect(s.idleMs).toBe(560);
  });

  it("scores a quiet stream as idle with a large gap", () => {
    const s = summarizeWindow(QUIET, 5_000);
    expect(s.eventCount).toBe(2);
    expect(s.editsLanded).toBe(false);
    expect(s.idleMs).toBe(4_890);
  });

  it("reports a null idle gap for an empty window", () => {
    expect(summarizeWindow([], 100).idleMs).toBeNull();
  });
});

// --- a fake Jev that grades the summary the questions describe -------------

type StubCall = Omit<SystemOneRequest, "model"> & { model?: string };

/**
 * A fake supervisor brain: it reads the same summary the real Jev would and
 * returns the verdict the questions' criteria imply. This lets a fixture event
 * stream flow end-to-end through `classifyWorker` to its expected verdict,
 * exactly the content signal a process-liveness supervisor cannot produce.
 */
function gradingJev(): JevClientLike & { calls: StubCall[] } {
  const calls: StubCall[] = [];
  return {
    calls,
    systemone(req) {
      calls.push(req);
      const s = req.state as unknown as WindowSummary;

      let choice: string;
      let needsHuman = 0.1;
      if (s.editsLanded && (s.idleMs ?? 0) >= 300) {
        choice = "done";
      } else if ((s.idleMs ?? 0) >= 1_000 && s.toolCalls <= 1) {
        choice = "idle";
      } else if (s.toolCalls >= 3 && s.topToolShare >= 0.8 && !s.editsLanded) {
        choice = "wedged";
        needsHuman = 0.85; // a repeating failing action will not self-clear
      } else {
        choice = "progressing";
      }

      return Promise.resolve({
        model: "jev-latest",
        answers: {
          worker_state: { type: "choice", choice, confidence: 0.9, probabilities: { [choice]: 0.9 } },
          needs_human: { type: "noul", noul: needsHuman },
        },
        usage: { input_tokens: 120, output_tokens: 4 },
        requestId: "req_sup",
        latencyMs: 22,
      } satisfies SystemOneResult);
    },
  };
}

describe("classifyWorker over fixture streams", () => {
  it("calls a looping worker wedged and flags a human", async () => {
    const c = await classifyWorker(gradingJev(), LOOPING, { now: 170 });
    expect(c.verdict).toBe("wedged");
    expect(c.needsHuman).toBe(true);
  });

  it("calls a finished-diff worker done", async () => {
    const c = await classifyWorker(gradingJev(), FINISHED, { now: 700 });
    expect(c.verdict).toBe("done");
    expect(c.needsHuman).toBe(false);
  });

  it("calls a quiet worker idle", async () => {
    const c = await classifyWorker(gradingJev(), QUIET, { now: 5_000 });
    expect(c.verdict).toBe("idle");
  });

  it("calls an actively-editing worker progressing", async () => {
    const c = await classifyWorker(gradingJev(), PROGRESSING, { now: 155 });
    expect(c.verdict).toBe("progressing");
  });

  it("sends the supervision questions and a content-free summary as state", async () => {
    const jev = gradingJev();
    await classifyWorker(jev, PROGRESSING, { now: 155 });
    const call = jev.calls[0];
    expect(call?.questions).toBe(SUPERVISION_QUESTIONS);
    const state = call?.state as Record<string, unknown>;
    // Only counts/gaps -- nothing that could carry worker output.
    expect(Object.keys(state).sort()).toEqual(
      ["editsLanded", "eventCount", "idleMs", "malformed", "outputTokens", "toolCalls", "toolHistogram", "toolVariety", "topToolShare", "turns"].sort(),
    );
  });
});

// --- the mapping is pure over Jev's answers --------------------------------

function cannedJev(choice: string, confidence: number, needsHuman: number): JevClientLike {
  return {
    systemone: () =>
      Promise.resolve({
        model: "jev-latest",
        answers: {
          worker_state: { type: "choice", choice, confidence, probabilities: { [choice]: confidence } },
          needs_human: { type: "noul", noul: needsHuman },
        },
        usage: { input_tokens: 1, output_tokens: 1 },
        requestId: "req",
        latencyMs: 12,
      } satisfies SystemOneResult),
  };
}

describe("classifyWorker mapping", () => {
  it("passes Jev's verdict, confidence, and latency through unchanged", async () => {
    const c = await classifyWorker(cannedJev("progressing", 0.73, 0.2), []);
    expect(c).toEqual({ verdict: "progressing", confidence: 0.73, needsHuman: false, latencyMs: 12 });
  });

  it("treats needs_human at or above 0.5 as true", async () => {
    expect((await classifyWorker(cannedJev("idle", 0.6, 0.5), [])).needsHuman).toBe(true);
    expect((await classifyWorker(cannedJev("idle", 0.6, 0.49), [])).needsHuman).toBe(false);
  });

  it("throws on a worker_state answer of the wrong shape", async () => {
    const bad: JevClientLike = {
      systemone: () =>
        Promise.resolve({
          model: "jev-latest",
          answers: { worker_state: { type: "noul", noul: 0.5 } },
          usage: { input_tokens: 1, output_tokens: 1 },
          requestId: "req",
          latencyMs: 1,
        } satisfies SystemOneResult),
    };
    await expect(classifyWorker(bad, [])).rejects.toThrow(/wrong shape/);
  });

  it("throws on an out-of-vocabulary verdict", async () => {
    await expect(classifyWorker(cannedJev("exploded", 0.9, 0.1), [])).rejects.toThrow(/wrong shape/);
  });
});
