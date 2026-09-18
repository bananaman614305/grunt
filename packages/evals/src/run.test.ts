import { describe, expect, it } from "vitest";
import type { ChatMessage, JevClientLike, SystemOneResult, TaskType } from "@milo/core";
import { buildJevState } from "@milo/core";
import { runRoutingEval } from "./run.js";
import { loadRoutingSet } from "./schema.js";
import type { RoutingExample } from "./schema.js";

const examples = loadRoutingSet();

/** A tool list of the same length the runner uses for `has_tools: true`, since
 * `buildJevState` only reads `tools.length`. */
const A_TOOL: unknown[] = [{}];

/** The exact Jev `state` the runner will send for `example`, used to map a
 * stub's incoming request back to the example that produced it. */
function stateKey(example: RoutingExample): string {
  const messages = example.messages as ChatMessage[];
  const tools = example.has_tools ? A_TOOL : undefined;
  return JSON.stringify(buildJevState(messages, tools).state);
}

function makeAnswers(opts: {
  taskType: TaskType;
  difficulty: number;
  needsReasoning: number;
}): SystemOneResult["answers"] {
  return {
    task_type: {
      type: "choice",
      choice: opts.taskType,
      confidence: 0.9,
      probabilities: { [opts.taskType]: 0.9 },
    },
    difficulty: { type: "score", score: opts.difficulty, confidence: 0.9, legend: {}, probabilities: {} },
    needs_reasoning: { type: "noul", noul: opts.needsReasoning },
    long_output: { type: "noul", noul: 0.1 },
  };
}

/** Derives a Jev answer straight from one example's own dataset labels: the
 * band becomes the difficulty score (offset so it lands mid-band, capped at
 * the top of the scale), a mention of "reason" in `notes` becomes a high
 * `needs_reasoning`, and the dataset's `task_type` label is echoed back. */
function labelDerivedAnswers(example: RoutingExample): SystemOneResult["answers"] {
  const needsReasoning = /reason/i.test(example.notes) ? 0.8 : 0.2;
  const difficulty = Math.min(example.difficulty_band + 0.4, 3);
  return makeAnswers({ taskType: example.task_type, difficulty, needsReasoning });
}

/** A stub `JevClientLike` over `exampleList`, answering via `derive`. Throws
 * if a request's state does not match any known example (it always should). */
function stubJevFor(
  exampleList: RoutingExample[],
  derive: (example: RoutingExample) => SystemOneResult["answers"],
): JevClientLike {
  const byState = new Map(exampleList.map((e) => [stateKey(e), e]));
  return {
    systemone: (req) => {
      const key = JSON.stringify(req.state);
      const example = byState.get(key);
      if (example === undefined) {
        return Promise.reject(new Error("stub: no example matches this Jev state"));
      }
      const result: SystemOneResult = {
        model: "jev-latest",
        requestId: `stub-${example.id}`,
        latencyMs: 42,
        usage: { input_tokens: 100, output_tokens: 10 },
        answers: derive(example),
      };
      return Promise.resolve(result);
    },
  };
}

describe("runRoutingEval: label-derived stub", () => {
  it("scores every example with a 4-row band breakdown and counts that add up", async () => {
    const jev = stubJevFor(examples, labelDerivedAnswers);
    const report = await runRoutingEval({ examples, jev });

    expect(report.scored.length).toBe(examples.length);
    expect(report.unscored.length).toBe(0);
    expect(report.scored.length + report.unscored.length).toBe(examples.length);

    const bandsPresent = new Set(report.scored.map((e) => e.difficultyBand));
    expect([...bandsPresent].sort()).toEqual([0, 1, 2, 3]);

    for (const band of [0, 1, 2, 3] as const) {
      const n = report.scored.filter((e) => e.difficultyBand === band).length;
      expect(n, `band ${band} should have scored examples`).toBeGreaterThan(0);
    }

    const agree = report.scored.filter((e) => e.agree).length;
    // Not asserted to be perfect: the stub's derivation is a simple, documented
    // heuristic, not a reimplementation of the policy. Logged so the resulting
    // agreement number is visible without re-deriving it by hand.
    console.log(`label-derived stub agreement: ${agree}/${report.scored.length}`);
    expect(agree).toBeGreaterThan(0);
  });
});

describe("runRoutingEval: intermittent Jev failures", () => {
  it("marks every third example unscored with an error class, and scores the rest", async () => {
    let calls = 0;
    const jev: JevClientLike = {
      systemone: () => {
        calls += 1;
        if (calls % 3 === 0) {
          return Promise.reject(new Error("simulated jev outage"));
        }
        const result: SystemOneResult = {
          model: "jev-latest",
          requestId: `req-${calls}`,
          latencyMs: 10,
          usage: { input_tokens: 1, output_tokens: 1 },
          answers: makeAnswers({ taskType: "chat", difficulty: 0, needsReasoning: 0.1 }),
        };
        return Promise.resolve(result);
      },
    };

    // concurrency: 1 makes the "every third call fails" stub deterministic.
    const report = await runRoutingEval({ examples, jev, concurrency: 1 });

    expect(report.scored.length + report.unscored.length).toBe(examples.length);
    expect(report.unscored.length).toBe(Math.floor(examples.length / 3));
    expect(report.scored.length).toBe(examples.length - Math.floor(examples.length / 3));

    for (const example of report.unscored) {
      expect(example.errorClass.length).toBeGreaterThan(0);
    }
  });
});

describe("runRoutingEval: forced wrong tier for known ids", () => {
  it("lists the forced ids among the disagreements", async () => {
    const wrongIds = new Set(["r-001", "r-002"]);
    const jev = stubJevFor(examples, (example) => {
      if (wrongIds.has(example.id)) {
        // Both r-001 and r-002 are labeled "fast"; forcing a hard, uncapped
        // task type at top difficulty guarantees a frontier prediction.
        return makeAnswers({ taskType: "feature", difficulty: 3, needsReasoning: 0.9 });
      }
      return labelDerivedAnswers(example);
    });

    const report = await runRoutingEval({ examples, jev });

    const disagreeing = new Set(report.scored.filter((e) => !e.agree).map((e) => e.id));
    for (const id of wrongIds) {
      expect(disagreeing.has(id), `${id} should be a disagreement`).toBe(true);
    }
  });
});

describe("runRoutingEval: sampled decisions (ADR-010)", () => {
  it("scores agreement on the unsampled tier, not the fast execution tier", async () => {
    // An edit example labeled mid: policy v4 resolves it to best-of-5 on
    // fast, and the gate must still measure the mid choice underneath.
    const editMid = examples.find((e) => e.task_type === "edit" && e.expected_tier_balanced === "mid");
    expect(editMid).toBeDefined();
    const chosen = editMid as RoutingExample;

    const jev: JevClientLike = {
      systemone: () => {
        const answers = makeAnswers({ taskType: "edit", difficulty: 1.1, needsReasoning: 0.3 });
        // A mid-band distribution: P1+ 0.50 clears the fast gate, and neither
        // frontier gate fires, so the unsampled tier is mid.
        answers["difficulty"] = {
          type: "score",
          score: 0.69,
          confidence: 0.9,
          legend: {},
          probabilities: { "0": 0.5, "1": 0.35, "2": 0.11, "3": 0.04 },
        };
        const result: SystemOneResult = {
          model: "jev-latest",
          requestId: "req-sampled",
          latencyMs: 42,
          usage: { input_tokens: 100, output_tokens: 10 },
          answers,
        };
        return Promise.resolve(result);
      },
    };

    const report = await runRoutingEval({ examples: [chosen], jev });
    expect(report.unscored).toHaveLength(0);
    const scored = report.scored[0];
    expect(scored?.predictedTier).toBe("mid");
    expect(scored?.agree).toBe(true);
    // The reason still shows that the decision itself sampled.
    expect(scored?.reason).toContain("best-of-5");
  });
});
