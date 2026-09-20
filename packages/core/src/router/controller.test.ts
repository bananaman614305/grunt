import { describe, expect, it } from "vitest";
import type { JevClientLike, SystemOneResult } from "../jev/types.js";
import type { ChatMessage, RouteRequest, RouteSignals, Roster } from "../types.js";
import {
  DEEPSEEK_BRANCH_MODEL,
  DEEPSEEK_VISION_MODEL,
  NEMOTRON_OMNI_MODEL,
  modalityBudget,
} from "./controller.js";
import { fingerprint } from "./fingerprint.js";
import { Router } from "./router.js";

const ROSTER: Roster = {
  fast: ["fast-model"],
  mid: ["mid-model"],
  frontier: ["frontier-model"],
};

/** A full, valid Jev answer set that resolves to a given difficulty shape. */
function answers(probabilities: Record<string, number>, score: number): SystemOneResult["answers"] {
  return {
    task_type: { type: "choice", choice: "chat", confidence: 0.9, probabilities: { chat: 1 } },
    difficulty: { type: "score", score, confidence: 0.9, legend: {}, probabilities },
    needs_reasoning: { type: "noul", noul: 0.2 },
    long_output: { type: "noul", noul: 0.1 },
  };
}

/** Difficulty that lands off the hard-mass gate: one v4-flash call, band 0. */
const EASY = answers({ "0": 0.9, "1": 0.1, "2": 0, "3": 0 }, 0);
/** Difficulty that trips the hard-mass gate: band 3. */
const HARD = answers({ "0": 0.1, "1": 0.2, "2": 0.2, "3": 0.5 }, 3);

function stubJev(a: SystemOneResult["answers"]): JevClientLike {
  return {
    systemone: () =>
      Promise.resolve({
        model: "jev-latest",
        answers: a,
        usage: { input_tokens: 1200, output_tokens: 24 },
        requestId: "req_stub",
        latencyMs: 64,
      }),
  };
}

function deepseekRouter(a: SystemOneResult["answers"]): Router {
  return new Router({ jev: stubJev(a), roster: ROSTER, mode: "deepseek" });
}

function request(content: ChatMessage["content"], overrides: Partial<RouteRequest> = {}): RouteRequest {
  const messages: ChatMessage[] = [{ role: "user", content }];
  return { messages, posture: "balanced", fingerprint: fingerprint(messages), ...overrides };
}

const IMAGE: ChatMessage["content"] = [{ type: "text", text: "what is this?" }, { type: "image_url" }];
const AUDIO: ChatMessage["content"] = [{ type: "input_audio" }];
const VIDEO: ChatMessage["content"] = [{ type: "video_url" }];

function signals(overrides: Partial<RouteSignals> = {}): RouteSignals {
  return {
    taskType: "chat",
    difficulty: 0,
    difficultyLevels: [],
    needsReasoning: 0,
    longOutput: 0,
    confidences: {},
    jevRequestId: "req_stub",
    jevModel: "jev-latest",
    latencyMs: 10,
    ...overrides,
  };
}

describe("modality constants", () => {
  it("pins the verified vision and omni model ids", () => {
    expect(DEEPSEEK_VISION_MODEL).toBe("deepseek/deepseek-v4.1-flash");
    expect(NEMOTRON_OMNI_MODEL).toBe("nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free");
  });
});

describe("modalityBudget", () => {
  it("leaves text to the band budget", () => {
    expect(modalityBudget("text", signals())).toBeUndefined();
  });

  it("pins the vision model at a single call for an image that is not hard", () => {
    expect(modalityBudget("image", signals({ difficultyLevels: [0.9, 0.1, 0, 0] }))).toEqual({
      model: DEEPSEEK_VISION_MODEL,
      samples: 1,
      hard: false,
    });
  });

  it("escalates a hard visual task to the band-3 sampling budget", () => {
    expect(modalityBudget("image", signals({ difficultyLevels: [0.1, 0.2, 0.2, 0.5], difficulty: 3 }))).toEqual({
      model: DEEPSEEK_VISION_MODEL,
      samples: 5,
      hard: true,
    });
  });

  it("routes audio to the free omni model at one call", () => {
    expect(modalityBudget("audio", signals())).toEqual({ model: NEMOTRON_OMNI_MODEL, samples: 1, hard: false });
  });

  it("routes video to the free omni model at one call", () => {
    expect(modalityBudget("video", signals())).toEqual({ model: NEMOTRON_OMNI_MODEL, samples: 1, hard: false });
  });
});

describe("the deepseek controller's multimodal gate", () => {
  it("leaves a text request on the branch model, unchanged", async () => {
    const decision = await deepseekRouter(EASY).route(request("Rename res to rows."));
    expect(decision.model).toBe(DEEPSEEK_BRANCH_MODEL);
    expect(decision.modality).toBeUndefined();
    expect(decision.samples).toBeUndefined();
  });

  it("pins an image request to the vision model with a single call", async () => {
    const decision = await deepseekRouter(EASY).route(request(IMAGE));
    expect(decision.model).toBe(DEEPSEEK_VISION_MODEL);
    expect(decision.modality).toBe("image");
    expect(decision.samples).toBeUndefined();
    expect(decision.reason).toContain("not hard");
  });

  it("escalates a hard image to best-of-5 on the vision model", async () => {
    const decision = await deepseekRouter(HARD).route(request(IMAGE));
    expect(decision.model).toBe(DEEPSEEK_VISION_MODEL);
    expect(decision.modality).toBe("image");
    expect(decision.samples).toBe(5);
    expect(decision.unsampledModel).toBe(DEEPSEEK_VISION_MODEL);
    expect(decision.reason).toContain("best-of-5");
    expect(decision.reason).toContain("hard");
  });

  it("routes audio to the omni model", async () => {
    const decision = await deepseekRouter(EASY).route(request(AUDIO));
    expect(decision.model).toBe(NEMOTRON_OMNI_MODEL);
    expect(decision.modality).toBe("audio");
    expect(decision.samples).toBeUndefined();
  });

  it("routes video to the omni model", async () => {
    const decision = await deepseekRouter(EASY).route(request(VIDEO));
    expect(decision.model).toBe(NEMOTRON_OMNI_MODEL);
    expect(decision.modality).toBe("video");
  });

  it("routes image+audio to the omni model (any non-image modality wins)", async () => {
    const decision = await deepseekRouter(EASY).route(request([{ type: "image_url" }, { type: "input_audio" }]));
    expect(decision.model).toBe(NEMOTRON_OMNI_MODEL);
    expect(decision.modality).toBe("audio");
  });

  it("keeps an unknown media part off the blind branch model", async () => {
    const decision = await deepseekRouter(EASY).route(request([{ type: "input_file" }]));
    expect(decision.model).not.toBe(DEEPSEEK_BRANCH_MODEL);
    expect(decision.model).toBe(NEMOTRON_OMNI_MODEL);
    expect(decision.modality).toBe("video");
  });

  it("never samples the free omni model, even under a samples override", async () => {
    const decision = await deepseekRouter(EASY).route(request(AUDIO, { samples: 5 }));
    expect(decision.model).toBe(NEMOTRON_OMNI_MODEL);
    expect(decision.samples).toBeUndefined();
  });

  it("lets milo.samples=1 collapse a hard image back to a single call", async () => {
    const decision = await deepseekRouter(HARD).route(request(IMAGE, { samples: 1 }));
    expect(decision.model).toBe(DEEPSEEK_VISION_MODEL);
    expect(decision.samples).toBeUndefined();
  });

  it("respects an explicit candidate allow-list that excludes the forced model", async () => {
    const decision = await deepseekRouter(EASY).route(request(IMAGE, { candidates: ["fast-model"] }));
    // The caller pinned a model that is not the vision model, so the gate steps
    // aside and the request resolves against the roster instead.
    expect(decision.model).toBe("fast-model");
    expect(decision.modality).toBeUndefined();
  });

  it("does not run in roster mode", async () => {
    const router = new Router({ jev: stubJev(EASY), roster: ROSTER });
    const decision = await router.route(request(IMAGE));
    expect(decision.modality).toBeUndefined();
    expect(decision.model).toBe("fast-model");
  });
});
