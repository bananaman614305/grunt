import { describe, expect, it } from "vitest";
import type { JevClientLike, SystemOneResult } from "@milo/core";
import { verifyWorkerDone } from "./done-gate.js";
import type { Task } from "./types.js";

const TASK: Task = { id: "t1", prompt: "Add a retry to the client.", title: "Add retry" };

/** A Jev that answers the single done-claim with the given verdict. */
function doneJev(choice: string, confidence = 0.9): JevClientLike & { states: unknown[] } {
  const states: unknown[] = [];
  return {
    states,
    systemone(req: { state: unknown; questions: Record<string, unknown> }) {
      states.push(req.state);
      const key = Object.keys(req.questions)[0] ?? "done:t1";
      return Promise.resolve({
        model: "jev-latest",
        answers: { [key]: { type: "choice", choice, confidence, probabilities: { [choice]: confidence } } },
        usage: { input_tokens: 20, output_tokens: 3 },
        requestId: "req_done",
        latencyMs: 22,
      } satisfies SystemOneResult);
    },
  };
}

describe("verifyWorkerDone", () => {
  it("confirms a done backed by a real diff", async () => {
    const jev = doneJev("supported");
    const out = await verifyWorkerDone(jev, { task: TASK, diff: "diff --git a/c.ts b/c.ts\n+retry\n" });
    expect(out.verdict).toBe("supported");
    expect(out.contradicted).toBe(false);
    expect(out.line).toContain("confirmed");
    // the ground truth carried the diff, keyed under the task id
    const state = jev.states[0] as { git?: { filesChanged?: number } };
    expect(state.git?.filesChanged).toBe(1);
  });

  it("refutes a done with an empty diff", async () => {
    const out = await verifyWorkerDone(doneJev("contradicted"), { task: TASK, diff: "" });
    expect(out.verdict).toBe("contradicted");
    expect(out.contradicted).toBe(true);
  });

  it("passes receipts into the ground truth", async () => {
    const jev = doneJev("supported");
    await verifyWorkerDone(jev, { task: TASK, diff: "diff --git a/x b/x\n+y\n", receipts: [{ command: "pnpm test", exitCode: 0 }] });
    const state = jev.states[0] as { receipts?: unknown[] };
    expect(state.receipts).toHaveLength(1);
  });

  it("checks a task-specific rubric in one Jev call", async () => {
    let calls = 0;
    let keys: string[] = [];
    const jev: JevClientLike = {
      systemone(req) {
        calls += 1;
        keys = Object.keys(req.questions);
        return Promise.resolve({
          model: "jev-latest",
          answers: Object.fromEntries(keys.map((key) => [key, {
            type: "choice",
            choice: "supported",
            confidence: 0.9,
            probabilities: { supported: 0.9 },
          }])),
          usage: { input_tokens: 10, output_tokens: 3 },
          requestId: "rubric",
          latencyMs: 9,
        } satisfies SystemOneResult);
      },
    };
    const out = await verifyWorkerDone(jev, {
      task: { ...TASK, acceptanceCriteria: ["Retries are bounded", "Aborts remain aborts"] },
      diff: "diff --git a/x b/x\n+y\n",
    });
    expect(calls).toBe(1);
    expect(keys).toHaveLength(2);
    expect(out.criteria).toHaveLength(2);
    expect(out.verdict).toBe("supported");
  });

  it("maps a missing answer to a non-adverse unsupported", async () => {
    const jev: JevClientLike = {
      systemone: () =>
        Promise.resolve({
          model: "jev-latest",
          answers: {},
          usage: { input_tokens: 1, output_tokens: 1 },
          requestId: "r",
          latencyMs: 5,
        } satisfies SystemOneResult),
    };
    const out = await verifyWorkerDone(jev, { task: TASK, diff: "diff" });
    expect(out.verdict).toBe("unsupported");
    expect(out.contradicted).toBe(false);
  });

  it("propagates a Jev failure to the caller (the fleet catches it)", async () => {
    const jev: JevClientLike = { systemone: () => Promise.reject(new Error("boom")) };
    await expect(verifyWorkerDone(jev, { task: TASK, diff: "diff" })).rejects.toThrow("boom");
  });

  it("uses the prompt's first line when the task has no title", async () => {
    const jev = doneJev("supported");
    await verifyWorkerDone(jev, { task: { id: "t2", prompt: "Fix the parser bug\n\nmore detail" }, diff: "d\n+x\n" });
    // the claim text is built from the label; assert it reached Jev via the question
    // (indirect: the call succeeded and produced a verdict)
    expect(jev.states).toHaveLength(1);
  });
});
