import { describe, expect, it } from "vitest";
import type { ChatMessage, JevClientLike, SystemOneResult, TaskType } from "@milo/core";
import { buildJevState } from "@milo/core";
import { loadRoutingSet } from "../schema.js";
import type { RoutingExample } from "../schema.js";
import { runCanary } from "./run.js";
import { selectCanarySubset } from "./subset.js";

const subset = selectCanarySubset(loadRoutingSet(), 8);
const A_TOOL: unknown[] = [{}];

function stateKey(example: RoutingExample): string {
  const messages = example.messages as ChatMessage[];
  const tools = example.has_tools ? A_TOOL : undefined;
  return JSON.stringify(buildJevState(messages, tools).state);
}

function makeAnswers(opts: { taskType: TaskType; difficulty: number; needsReasoning: number }): SystemOneResult["answers"] {
  return {
    task_type: { type: "choice", choice: opts.taskType, confidence: 0.9, probabilities: { [opts.taskType]: 0.9 } },
    difficulty: { type: "score", score: opts.difficulty, confidence: 0.9, legend: {}, probabilities: {} },
    needs_reasoning: { type: "noul", noul: opts.needsReasoning },
    long_output: { type: "noul", noul: 0.1 },
  };
}

/** Derives a Jev answer straight from one example's own dataset labels, same rule as `../run.test.ts`. */
function labelDerivedAnswers(example: RoutingExample): SystemOneResult["answers"] {
  const needsReasoning = /reason/i.test(example.notes) ? 0.8 : 0.2;
  const difficulty = Math.min(example.difficulty_band + 0.4, 3);
  return makeAnswers({ taskType: example.task_type, difficulty, needsReasoning });
}

function stubJevFor(
  exampleList: RoutingExample[],
  derive: (example: RoutingExample) => SystemOneResult["answers"],
): JevClientLike {
  const byState = new Map(exampleList.map((e) => [stateKey(e), e]));
  return {
    systemone: (req) => {
      const key = JSON.stringify(req.state);
      const example = byState.get(key);
      if (example === undefined) return Promise.reject(new Error("stub: no example matches this Jev state"));
      const result: SystemOneResult = {
        model: "jev-latest",
        requestId: `stub-${example.id}`,
        latencyMs: 33,
        usage: { input_tokens: 100, output_tokens: 10 },
        answers: derive(example),
      };
      return Promise.resolve(result);
    },
  };
}

describe("runCanary", () => {
  it("scores every example in the subset and records the chosen model", async () => {
    const jev = stubJevFor(subset, labelDerivedAnswers);
    const run = await runCanary({ examples: subset, jev });

    expect(run.requestedSize).toBe(subset.length);
    expect(run.results).toHaveLength(subset.length);
    expect(run.results.every((r) => r.kind === "scored")).toBe(true);
    for (const result of run.results) {
      if (result.kind !== "scored") continue;
      expect(result.model.length).toBeGreaterThan(0);
      expect(result.latencyMs).toBe(33);
    }
  });

  it("defaults to the default canary subset when no examples are given", async () => {
    const jev = stubJevFor(loadRoutingSet(), labelDerivedAnswers);
    const run = await runCanary({ jev });
    expect(run.results.length).toBeGreaterThan(0);
    expect(run.results.length).toBe(run.requestedSize);
  });

  it("marks a Jev failure unscored with a classified error, and keeps scoring the rest", async () => {
    let calls = 0;
    const jev: JevClientLike = {
      systemone: () => {
        calls += 1;
        if (calls === 2) return Promise.reject(new Error("simulated jev outage"));
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

    const run = await runCanary({ examples: subset, jev, concurrency: 1 });
    const unscored = run.results.filter((r) => r.kind === "unscored");
    expect(unscored).toHaveLength(1);
    expect((unscored[0] as { errorClass: string }).errorClass.length).toBeGreaterThan(0);
    expect(run.results.length - unscored.length).toBe(subset.length - 1);
  });

  it("scores tier agreement the same way the full eval runner does", async () => {
    const wrongId = subset[0]?.id;
    expect(wrongId).toBeDefined();
    const jev = stubJevFor(subset, (example) => {
      if (example.id === wrongId) {
        return makeAnswers({ taskType: "feature", difficulty: 3, needsReasoning: 0.9 });
      }
      return labelDerivedAnswers(example);
    });

    const run = await runCanary({ examples: subset, jev });
    const forced = run.results.find((r) => r.id === wrongId);
    expect(forced?.kind).toBe("scored");
    if (forced?.kind === "scored") {
      // The forced answer (feature, difficulty 3) routes to frontier; every
      // subset example expects fast, mid, or frontier per its own label, so
      // this only disagrees when the label was not already frontier.
      expect(forced.predictedTier).toBe("frontier");
    }
  });
});
