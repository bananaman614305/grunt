import { describe, expect, it } from "vitest";
import { DEFAULT_WHITELIST, pick } from "./router.js";
import type { Call, ModelPrior } from "./types.js";

const task = { kind: "writing" as const, inputTokens: 1000, outputTokens: 1000 };
const base: ModelPrior = { model: "test/good", quality: { chat: 0.9, code: 0.9, research: 0.9, writing: 0.9 }, inputUsdPerM: 1, outputUsdPerM: 1, contextLength: 10000, reliability: 0.99, latencyMs: 1000 };
const call = (model: string, outcome: Call["outcome"], ts = Date.now()): Call => ({ model, kind: "writing", tokens_in: 100, tokens_out: 50, latency_ms: 1000, outcome, cost: 0, ts });
describe("agent utility router", () => {
  it("only selects whitelist members and refuses configured Google models", () => {
    for (const kind of ["chat", "code", "writing", "research"] as const) expect(DEFAULT_WHITELIST.map(m => m.model)).toContain(pick({ ...task, kind }).model);
    const config = { whitelist: [{ ...base, model: "google/gemini", quality: { chat: 1, code: 1, writing: 1, research: 1 } }, base] };
    expect(pick(task, [], config).candidates.map(m => m.model)).toEqual(["test/good"]);
    expect(() => pick(task, [], { whitelist: [config.whitelist[0]!] })).toThrow(/No whitelisted model/);
  });
  it.each([
    { latencyMs: 9000 }, { reliability: 0.5 }, { inputUsdPerM: 100, outputUsdPerM: 100 },
  ])("penalizes a slower, less reliable or more expensive equal-quality choice: %j", bad => {
    const result = pick(task, [], { whitelist: [{ ...base, ...bad, model: "test/bad" }, base] });
    expect(result.model).toBe(base.model);
    const winner = result.candidates[0]!;
    expect(result.score).toBeCloseTo(winner.reliability * winner.quality - 0.000005 * winner.latency - 0.5 * winner.cost);
    expect(result.reason).toMatch(/reliability.*quality.*latency.*cost/);
  });
  it("filters context overflow and recent 429, and restores a model after cooldown", () => {
    const alternative = { ...base, model: "test/alternative", quality: { chat: 0.8, code: 0.8, research: 0.8, writing: 0.8 } };
    const config = { whitelist: [base, alternative, { ...base, model: "test/tiny", contextLength: 100 }] };
    const now = Date.now();
    expect(pick(task, [call(base.model, "429", now)], config, [], now).model).toBe(alternative.model);
    expect(pick(task, [call(base.model, "429", now - 61000)], config, [], now).candidates.map(m => m.model)).toContain(base.model);
  });
  it("learns reliability and latency from calls", () => {
    const config = { whitelist: [base, { ...base, model: "test/other", reliability: 0.9 }] };
    expect(pick(task, Array.from({ length: 10 }, () => call(base.model, "error")), config).model).toBe("test/other");
  });
});
