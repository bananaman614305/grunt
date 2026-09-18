import { describe, expect, it } from "vitest";
import type { JevClientLike, SystemOneRequest, SystemOneResult } from "../jev/types.js";
import type { ChatMessage, Roster, RouteDecision } from "../types.js";
import { DEEPSEEK_BRANCH_MODEL, DEEPSEEK_ORCHESTRATOR_MODEL } from "./controller.js";
import {
  checkCompleteness,
  escalationFor,
  COMPLETENESS_QUESTIONS,
  GATE_SUSPECT_QUALITY,
  GATE_TRUST_CONFIDENCE,
  GATE_VERDICTS,
  LOW_CONFIDENCE_FAILURE,
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

describe("the confidence bar", () => {
  it("sits between the two clusters the live run separated, and names a usable-quality floor", () => {
    // Production: suspect `complete` verdicts came in at 0.31-0.57, honest
    // ones at 0.82-0.99. GATE_SUSPECT_QUALITY is the ranking question's
    // "usable as it stands" level.
    expect(GATE_TRUST_CONFIDENCE).toBeGreaterThan(0.57);
    expect(GATE_TRUST_CONFIDENCE).toBeLessThan(0.82);
    expect(GATE_SUSPECT_QUALITY).toBe(2.0);
    expect(RETRY_TEMPLATES[LOW_CONFIDENCE_FAILURE]).toBeDefined();
  });
});

describe("escalationFor", () => {
  const ROSTER: Roster = { fast: ["fast/model"], mid: ["mid/model"], frontier: ["frontier/model"] };

  function sampled(overrides: Partial<RouteDecision> = {}): RouteDecision {
    return {
      id: "01ESCALATE0000000000000000",
      fingerprint: "fp",
      tier: "fast",
      model: "fast/model",
      reason: "edit task, sampled",
      policyVersion: "v4",
      sticky: false,
      createdAt: "2026-09-18T00:00:00.000Z",
      samples: 5,
      unsampledTier: "mid",
      ...overrides,
    };
  }

  it("prefers the unsampled tier over the controller's family step, when the decision names both", () => {
    // The default roster's fast tier leads with the controller's own branch
    // model; a roster-mode sampled decision on it must still escalate to the
    // tier its cell would have bought, not to the family's next model.
    const both = sampled({ model: DEEPSEEK_BRANCH_MODEL, unsampledTier: "frontier" });
    expect(escalationFor(both, ROSTER)).toEqual({ model: "frontier/model", tier: "frontier" });
  });

  it("escalates a sampled decision to its unsampled tier's model", () => {
    expect(escalationFor(sampled(), ROSTER)).toEqual({ model: "mid/model", tier: "mid" });
    expect(escalationFor(sampled({ unsampledTier: "frontier" }), ROSTER)).toEqual({
      model: "frontier/model",
      tier: "frontier",
    });
  });

  it("escalates a controller decision below band 3 to the orchestrator model", () => {
    const controller = sampled({ model: DEEPSEEK_BRANCH_MODEL, unsampledModel: DEEPSEEK_BRANCH_MODEL });
    delete (controller as { unsampledTier?: unknown }).unsampledTier;
    expect(escalationFor(controller, ROSTER)).toEqual({ model: DEEPSEEK_ORCHESTRATOR_MODEL });
  });

  it("has nothing to escalate to at controller band 3, which already runs the orchestrator", () => {
    const band3 = sampled({ model: DEEPSEEK_ORCHESTRATOR_MODEL, unsampledModel: DEEPSEEK_ORCHESTRATOR_MODEL });
    delete (band3 as { unsampledTier?: unknown }).unsampledTier;
    expect(escalationFor(band3, ROSTER)).toBeUndefined();
  });

  it("prefers a decision's own unsampledModel when it differs from what answered", () => {
    const named = sampled({ model: "fast/model", unsampledModel: "named/model" });
    expect(escalationFor(named, ROSTER)).toEqual({ model: "named/model" });
  });

  it("returns undefined for an unsampled decision, and for one whose unsampled tier is no higher", () => {
    const single = sampled();
    delete (single as { samples?: unknown }).samples;
    delete (single as { unsampledTier?: unknown }).unsampledTier;
    expect(escalationFor(single, ROSTER)).toBeUndefined();
    expect(escalationFor(sampled({ tier: "frontier", unsampledTier: "mid" }), ROSTER)).toBeUndefined();
    // Same tier, same model: nothing stronger to move to.
    expect(escalationFor(sampled({ unsampledTier: "fast" }), ROSTER)).toBeUndefined();
  });

  it("honors the request's candidates, and gives up rather than leaving the allow-list", () => {
    expect(escalationFor(sampled(), ROSTER, ["mid/model"])).toEqual({ model: "mid/model", tier: "mid" });
    // The list allows only what already answered, so resolution lands back on
    // it and there is nothing stronger to escalate to.
    expect(escalationFor(sampled(), ROSTER, ["fast/model"])).toBeUndefined();
    const controller = sampled({ model: DEEPSEEK_BRANCH_MODEL });
    delete (controller as { unsampledTier?: unknown }).unsampledTier;
    expect(escalationFor(controller, ROSTER, ["some/other"])).toBeUndefined();
  });

  it("returns undefined rather than throwing when the roster cannot resolve the tier", () => {
    expect(escalationFor(sampled(), { fast: [], mid: [], frontier: [] })).toBeUndefined();
  });
});
