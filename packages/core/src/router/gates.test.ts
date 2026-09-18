import { describe, expect, it } from "vitest";
import type { JevClientLike, SystemOneRequest, SystemOneResult } from "../jev/types.js";
import type { ChatMessage } from "../types.js";
import {
  checkCompleteness,
  COMPLETENESS_QUESTIONS,
  GATE_VERDICTS,
  RETRY_TEMPLATES,
  retryMessages,
} from "./gates.js";

const TASK: ChatMessage[] = [
  { role: "system", content: "You are a sub-agent." },
  { role: "user", content: "List the three risks and propose a mitigation for each." },
];

type StubCall = Omit<SystemOneRequest, "model"> & { model?: string };

function verdictJev(choice: string, confidence = 0.82): JevClientLike & { calls: StubCall[] } {
  const calls: StubCall[] = [];
  return {
    calls,
    systemone: (req) => {
      calls.push(req);
      return Promise.resolve({
        model: "jev-latest",
        answers: {
          completeness: { type: "choice", choice, confidence, probabilities: { [choice]: confidence } },
        },
        usage: { input_tokens: 400, output_tokens: 6 },
        requestId: "req_gate",
        latencyMs: 35,
      } satisfies SystemOneResult);
    },
  };
}

describe("checkCompleteness", () => {
  it("sends the rank-style state and the completeness choice, and returns the typed verdict", async () => {
    const jev = verdictJev("incomplete");
    const check = await checkCompleteness(jev, TASK, "Risk one is latency.");

    expect(check.verdict).toBe("incomplete");
    expect(check.confidence).toBe(0.82);

    const call = jev.calls[0];
    expect(call?.questions).toBe(COMPLETENESS_QUESTIONS);
    const state = call?.state as Record<string, unknown>;
    expect(String(state["task"])).toContain("List the three risks");
    expect(String(state["candidate_answer"])).toBe("Risk one is latency.");
  });

  it("accepts every verdict in the vocabulary", async () => {
    for (const verdict of GATE_VERDICTS) {
      const check = await checkCompleteness(verdictJev(verdict), TASK, "answer");
      expect(check.verdict).toBe(verdict);
    }
  });

  it("throws on an unknown choice or a wrongly-typed answer", async () => {
    await expect(checkCompleteness(verdictJev("maybe"), TASK, "answer")).rejects.toThrow(/wrong shape/);

    const noul: JevClientLike = {
      systemone: () =>
        Promise.resolve({
          model: "jev-latest",
          answers: { completeness: { type: "noul", noul: 0.5 } },
          usage: { input_tokens: 1, output_tokens: 1 },
          requestId: "r",
          latencyMs: 1,
        }),
    };
    await expect(checkCompleteness(noul, TASK, "answer")).rejects.toThrow(/wrong shape/);
  });
});

describe("retryMessages", () => {
  it("appends the failure type's fixed template as a final system message, leaving the rest untouched", () => {
    for (const failure of ["incomplete", "off_task", "wrong_format"] as const) {
      const messages = retryMessages(TASK, failure);
      expect(messages).toHaveLength(TASK.length + 1);
      expect(messages.slice(0, TASK.length)).toEqual(TASK);
      const last = messages.at(-1);
      expect(last?.role).toBe("system");
      expect(last?.content).toBe(RETRY_TEMPLATES[failure]);
    }
  });

  it("has a distinct template per failure type, each naming the failure class", () => {
    expect(RETRY_TEMPLATES.incomplete).toContain("omitted");
    expect(RETRY_TEMPLATES.off_task).toContain("did not do what the request actually asked");
    expect(RETRY_TEMPLATES.wrong_format).toContain("format");
    expect(new Set(Object.values(RETRY_TEMPLATES)).size).toBe(3);
  });
});
