import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { JevClientLike, SystemOneResult } from "@milo/core";
import type { RoutingExample } from "../schema.js";
import { JudgeCache } from "./cache.js";
import { DEEPSEEK_BRANCH_MODEL, DEEPSEEK_ORCHESTRATOR_MODEL } from "./deepseek.js";
import type { GraderRow } from "./graders.js";
import { armOrder, fixedModelsFromRoster, JEV_USD_PER_CALL, providerField, runBench, saltMessages } from "./run.js";
import type { RunBenchOptions } from "./run.js";

function sseResponse(text: string, usage: Record<string, unknown>, headers: Record<string, string> = {}): Response {
  const frames = [
    { id: "gen", model: headers["x-milo-model"] ?? "direct/model", choices: [{ delta: { content: text } }] },
    { id: "gen", choices: [], usage },
  ];
  const body = `${frames.map((f) => `data: ${JSON.stringify(f)}`).join("\n\n")}\n\ndata: [DONE]\n\n`;
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream", ...headers } });
}

const example = (id: string, content: string, extra: Partial<RoutingExample> = {}): RoutingExample => ({
  id,
  messages: [{ role: "user", content }],
  has_tools: false,
  task_type: "classify",
  difficulty_band: 0,
  expected_tier_balanced: "fast",
  notes: "n",
  ...extra,
});

describe("helpers", () => {
  it("saltMessages touches only the first user message", () => {
    const out = saltMessages(
      [
        { role: "system", content: "s" },
        { role: "user", content: "a" },
        { role: "user", content: "b" },
      ],
      "x1",
    );
    expect(out.map((m) => m.content)).toEqual(["s", "a\n\n[bench x1]", "b"]);
    expect(saltMessages([{ role: "user", content: "a" }], undefined)[0]?.content).toBe("a");
  });

  it("providerField pins a known model by its list, and leaves an unknown model unpinned", () => {
    const pins = { "deepseek/deepseek-v4-flash": ["alibaba", "baidu"] };
    expect(providerField("deepseek/deepseek-v4-flash", pins)).toEqual({ provider: { order: ["alibaba", "baidu"], allow_fallbacks: false } });
    expect(providerField("milo/auto", pins)).toEqual({});
    expect(providerField("other/model", pins)).toEqual({});
  });

  it("armOrder is a permutation that varies with the index", () => {
    const arms = ["milo", "fast", "mid", "frontier"] as const;
    const orders = [0, 1, 2, 3].map((i) => armOrder([...arms], i));
    for (const order of orders) expect([...order].sort()).toEqual([...arms].sort());
    expect(new Set(orders.map((o) => o.join(","))).size).toBeGreaterThan(1);
  });

  it("fixedModelsFromRoster takes each tier's first model", () => {
    expect(fixedModelsFromRoster({ fast: ["f1", "f2"], mid: ["m1"], frontier: ["x1"] })).toEqual({ fast: "f1", mid: "m1", frontier: "x1" });
    expect(() => fixedModelsFromRoster({ fast: [], mid: ["m"], frontier: ["x"] })).toThrow(/fast/);
  });
});

describe("runBench", () => {
  it("calls every arm, reads milo headers and the decision record, grades mechanically and by judge", async () => {
    const seen: Array<{ url: string; body: Record<string, unknown> | undefined; auth: string | undefined }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const body = init?.body !== undefined ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
      seen.push({ url, body, auth: headers["Authorization"] });

      if (url.endsWith("/decisions/dec-1")) {
        return new Response(JSON.stringify({ signals: { latencyMs: 123 }, upstream: { latencyMs: 456 } }), { status: 200 });
      }
      if (url.startsWith("http://gw/v1/")) {
        return sseResponse("NEGATIVE", { prompt_tokens: 10, completion_tokens: 2, cost: 0.000001 }, {
          "x-milo-decision-id": "dec-1",
          "x-milo-model": "fast/model",
          "x-milo-tier": "fast",
          "x-milo-sticky": "false",
        });
      }
      if (body?.["model"] === "judge/model") {
        return sseResponse('{"score": 0.9, "pass": true, "reason": "fine"}', { prompt_tokens: 50, completion_tokens: 20, cost: 0.0002 });
      }
      if (body?.["model"] === "frontier/model") {
        return sseResponse("positive", { prompt_tokens: 10, completion_tokens: 3, cost: 0.00004 });
      }
      return sseResponse("negative", { prompt_tokens: 10, completion_tokens: 2, cost: 0.000002 });
    };

    const graders = new Map<string, GraderRow>([
      ["r-1", { id: "r-1", grader: { type: "regex", pattern: "\\bnegative\\b", flags: "i" } }],
      ["r-2", { id: "r-2", grader: { type: "judge", rubric: "any" } }],
    ]);
    const report = await runBench({
      examples: [example("r-1", "Classify: bad."), example("r-2", "Write docs.", { has_tools: true })],
      graders,
      gatewayBaseUrl: "http://gw/v1",
      openRouterBaseUrl: "http://or/api/v1",
      apiKey: "sk-test",
      posture: "balanced",
      arms: ["milo", "fast", "frontier"],
      fixedModels: { fast: "fast/model", mid: "mid/model", frontier: "frontier/model" },
      judgeModel: "judge/model",
      judge: true,
      prices: new Map(),
      baseline: { id: "b", inputUsdPerM: 10, outputUsdPerM: 50 },
      concurrency: 2,
      timeoutMs: 1000,
      providerPins: { "fast/model": ["alibaba"], "frontier/model": ["baseten"], "judge/model": ["azure"] },
      fetchImpl,
      now: () => "2026-09-17T00:00:00.000Z",
    });
    expect(report.providerPins).toEqual({ "fast/model": ["alibaba"], "frontier/model": ["baseten"], "judge/model": ["azure"] });

    expect(report.rows.map((r) => r.id)).toEqual(["r-1", "r-2"]);
    const r1 = report.rows[0];
    const milo = r1?.results.find((r) => r.arm === "milo");
    expect(milo).toMatchObject({ model: "fast/model", tier: "fast", sticky: false, decisionId: "dec-1", jevLatencyMs: 123, upstreamLatencyMs: 456 });
    expect(milo?.grade?.pass).toBe(true);
    expect(r1?.results.find((r) => r.arm === "frontier")?.grade?.pass).toBe(false);
    expect(r1?.results.find((r) => r.arm === "fast")?.grade?.pass).toBe(true);

    const r2 = report.rows[1];
    const judged = r2?.results.find((r) => r.arm === "fast");
    expect(judged?.grade).toEqual({ score: 0.9, pass: true, by: "judge", reason: "fine", judgeCostUsd: 0.0002 });

    // The routed call carried the posture and went to the gateway; direct calls did not carry `milo`.
    const routedCall = seen.find((s) => s.url === "http://gw/v1/chat/completions" && s.body?.["model"] === "milo/auto");
    expect(routedCall?.body?.["milo"]).toEqual({ posture: "balanced" });
    // The milo arm is unpinned (its downstream model is chosen by the gateway).
    expect(routedCall?.body?.["provider"]).toBeUndefined();
    // A fixed arm is pinned to its model's providers.
    const fastCall = seen.find((s) => s.body?.["model"] === "fast/model");
    expect(fastCall?.body?.["provider"]).toEqual({ order: ["alibaba"], allow_fallbacks: false });
    const judgeCall = seen.find((s) => s.body?.["model"] === "judge/model");
    expect(judgeCall?.body?.["provider"]).toEqual({ order: ["azure"], allow_fallbacks: false });
    expect(routedCall?.auth).toBe("Bearer sk-test");
    const direct = seen.filter((s) => s.url === "http://or/api/v1/chat/completions" && s.body?.["model"] !== "judge/model");
    expect(direct.every((s) => s.body?.["milo"] === undefined)).toBe(true);
    // has_tools sends the placeholder tool with tool_choice auto.
    const tooled = seen.find((s) => s.body?.["model"] === "frontier/model" && s.body?.["tools"] !== undefined);
    expect(tooled?.body?.["tool_choice"]).toBe("auto");
    // The judge was asked once per successful arm on r-2.
    expect(seen.filter((s) => s.body?.["model"] === "judge/model")).toHaveLength(3);
  });

  it("records a failed call without grading it and keeps going", async () => {
    const fetchImpl: typeof fetch = async (input) => {
      if (String(input).startsWith("http://gw/")) throw Object.assign(new Error("fetch failed"), { name: "TypeError" });
      return sseResponse("ok", { prompt_tokens: 1, completion_tokens: 1 });
    };
    const report = await runBench({
      examples: [example("r-1", "x")],
      graders: new Map([["r-1", { id: "r-1", grader: { type: "regex", pattern: "ok" } }]]),
      gatewayBaseUrl: "http://gw/v1",
      openRouterBaseUrl: "http://or/api/v1",
      apiKey: "k",
      posture: "low",
      arms: ["milo", "fast"],
      fixedModels: { fast: "f", mid: "m", frontier: "x" },
      judgeModel: "j",
      judge: false,
      prices: new Map(),
      baseline: { id: "b", inputUsdPerM: 1, outputUsdPerM: 1 },
      concurrency: 1,
      timeoutMs: 100,
      providerPins: {},
      fetchImpl,
    });
    const [row] = report.rows;
    expect(row?.results.find((r) => r.arm === "milo")).toMatchObject({ error: "network", status: 0 });
    expect(row?.results.find((r) => r.arm === "milo")?.grade).toBeUndefined();
    expect(row?.results.find((r) => r.arm === "fast")?.grade?.pass).toBe(true);
  });
});

describe("judge cache and audit", () => {
  /** A fake OpenRouter: one fixed answer, and one verdict per judge model, counting judge calls. */
  function judgeFetch(counts: Record<string, number>): typeof fetch {
    return async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const model = body["model"] as string;
      if (model === "judge/cheap") {
        counts["cheap"] = (counts["cheap"] ?? 0) + 1;
        return sseResponse('{"score": 0.9, "pass": true, "reason": "fine"}', { prompt_tokens: 40, completion_tokens: 15, cost: 0.0001 });
      }
      if (model === "judge/strong") {
        counts["strong"] = (counts["strong"] ?? 0) + 1;
        return sseResponse('{"score": 0.4, "pass": false, "reason": "shallow"}', { prompt_tokens: 40, completion_tokens: 15, cost: 0.001 });
      }
      return sseResponse("an answer", { prompt_tokens: 10, completion_tokens: 5, cost: 0.00001 });
    };
  }

  function benchOptions(counts: Record<string, number>, over: Partial<RunBenchOptions> = {}): RunBenchOptions {
    return {
      examples: [example("r-2", "Write docs.")],
      graders: new Map<string, GraderRow>([["r-2", { id: "r-2", grader: { type: "judge", rubric: "any" } }]]),
      gatewayBaseUrl: "http://gw/v1",
      openRouterBaseUrl: "http://or/api/v1",
      apiKey: "k",
      posture: "balanced",
      arms: ["fast"],
      fixedModels: { fast: "fast/model", mid: "mid/model", frontier: "frontier/model" },
      judgeModel: "judge/cheap",
      judge: true,
      prices: new Map(),
      baseline: { id: "b", inputUsdPerM: 1, outputUsdPerM: 1 },
      concurrency: 1,
      timeoutMs: 1000,
      providerPins: {},
      fetchImpl: judgeFetch(counts),
      ...over,
    };
  }

  it("audits at fraction 1: the strong judge re-grades and its verdict rides on the grade", async () => {
    const counts: Record<string, number> = {};
    const report = await runBench(benchOptions(counts, { judgeAuditFraction: 1, auditJudgeModel: "judge/strong" }));
    const grade = report.rows[0]?.results[0]?.grade;
    expect(grade).toMatchObject({ score: 0.9, pass: true, by: "judge", judgeCostUsd: 0.0001 });
    expect(grade?.audit).toEqual({ model: "judge/strong", score: 0.4, pass: false, reason: "shallow", judgeCostUsd: 0.001 });
    expect(counts).toEqual({ cheap: 1, strong: 1 });
    expect(report.judgeAudit).toEqual({ model: "judge/strong", fraction: 1 });
  });

  it("audits nothing at fraction 0, or when the audit judge is the primary judge", async () => {
    const c1: Record<string, number> = {};
    const r1 = await runBench(benchOptions(c1, { judgeAuditFraction: 0, auditJudgeModel: "judge/strong" }));
    expect(r1.rows[0]?.results[0]?.grade?.audit).toBeUndefined();
    expect(c1["strong"]).toBeUndefined();
    expect(r1.judgeAudit).toBeUndefined();

    const c2: Record<string, number> = {};
    const r2 = await runBench(benchOptions(c2, { judgeAuditFraction: 1, auditJudgeModel: "judge/cheap" }));
    expect(r2.rows[0]?.results[0]?.grade?.audit).toBeUndefined();
    expect(c2["cheap"]).toBe(1);
    expect(r2.judgeAudit).toBeUndefined();
  });

  it("serves a rerun from the cache: no judge network calls, no judge cost, hits counted", async () => {
    const cache = new JudgeCache(mkdtempSync(join(tmpdir(), "bench-cache-")));
    const counts: Record<string, number> = {};

    const first = await runBench(benchOptions(counts, { judgeCache: cache, judgeAuditFraction: 1, auditJudgeModel: "judge/strong" }));
    expect(counts).toEqual({ cheap: 1, strong: 1 });
    expect(first.judgeCacheStats).toEqual({ hits: 0, misses: 2 });
    expect(first.rows[0]?.results[0]?.grade?.judgeCostUsd).toBe(0.0001);

    const second = await runBench(benchOptions(counts, { judgeCache: cache, judgeAuditFraction: 1, auditJudgeModel: "judge/strong" }));
    expect(counts).toEqual({ cheap: 1, strong: 1 }); // nothing fresh
    expect(second.judgeCacheStats).toEqual({ hits: 2, misses: 0 });
    const grade = second.rows[0]?.results[0]?.grade;
    expect(grade).toMatchObject({ score: 0.9, pass: true, by: "judge" });
    expect(grade?.judgeCostUsd).toBeUndefined(); // a hit is free
    expect(grade?.audit).toEqual({ model: "judge/strong", score: 0.4, pass: false, reason: "shallow" });
  });

  it("bypasses the cache when none is given: every run calls the judge again and reports no stats", async () => {
    const counts: Record<string, number> = {};
    await runBench(benchOptions(counts));
    const report = await runBench(benchOptions(counts));
    expect(counts["cheap"]).toBe(2);
    expect(report.judgeCacheStats).toBeUndefined();
  });

  it("does not cache a failed judge call, so the next run retries it", async () => {
    const cache = new JudgeCache(mkdtempSync(join(tmpdir(), "bench-cache-")));
    let failures = 0;
    const failingFetch: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (body["model"] === "judge/cheap") {
        failures += 1;
        return new Response("busy", { status: 503 });
      }
      return sseResponse("an answer", { prompt_tokens: 10, completion_tokens: 5 });
    };
    const first = await runBench(benchOptions({}, { judgeCache: cache, fetchImpl: failingFetch }));
    expect(first.rows[0]?.results[0]?.grade).toMatchObject({ pass: false, reason: "judge HTTP 503" });
    expect(failures).toBe(1);

    const counts: Record<string, number> = {};
    const second = await runBench(benchOptions(counts, { judgeCache: cache }));
    expect(counts["cheap"]).toBe(1); // retried, not served from the cache
    expect(second.judgeCacheStats).toEqual({ hits: 0, misses: 1 });
    expect(second.rows[0]?.results[0]?.grade?.pass).toBe(true);
  });
});

describe("the deepseek arm (ADR-012 phase 1)", () => {
  /**
   * A fake Jev that sizes with the given difficulty distribution and ranks
   * each candidate answer by `rankOf`. Sizing calls carry `task_type` in
   * their questions; ranking calls carry `quality`.
   */
  function fakeJev(
    levels: Record<string, number>,
    rankOf: (answer: string) => Record<string, number> | Error = () => ({ "3": 1 }),
  ): JevClientLike & { sizings: number; ranks: number } {
    const jev = {
      sizings: 0,
      ranks: 0,
      systemone: async (req: { state: unknown; questions: Record<string, unknown> }): Promise<SystemOneResult> => {
        if ("task_type" in req.questions) {
          jev.sizings += 1;
          return {
            model: "jev-latest",
            requestId: `size-${jev.sizings}`,
            latencyMs: 20,
            usage: { input_tokens: 10, output_tokens: 1 },
            answers: {
              task_type: { type: "choice", choice: "edit", confidence: 0.9, probabilities: { edit: 0.9 } },
              difficulty: { type: "score", score: 1, confidence: 0.8, legend: {}, probabilities: levels },
              needs_reasoning: { type: "noul", noul: 0.5 },
              long_output: { type: "noul", noul: 0.1 },
            },
          };
        }
        jev.ranks += 1;
        const answer = (req.state as { candidate_answer: string }).candidate_answer;
        const verdict = rankOf(answer);
        if (verdict instanceof Error) throw verdict;
        return {
          model: "jev-latest",
          requestId: `rank-${jev.ranks}`,
          latencyMs: 5,
          usage: { input_tokens: 10, output_tokens: 1 },
          answers: {
            quality: { type: "score", score: 0, confidence: 0.9, legend: {}, probabilities: verdict },
            correct: { type: "noul", noul: 0.5 },
          },
        };
      },
    };
    return jev;
  }

  function options(jev: JevClientLike, fetchImpl: typeof fetch, over: Partial<RunBenchOptions> = {}): RunBenchOptions {
    return {
      examples: [example("r-1", "Do the thing.")],
      graders: new Map<string, GraderRow>([["r-1", { id: "r-1", grader: { type: "regex", pattern: "answer" } }]]),
      gatewayBaseUrl: "http://gw/v1",
      openRouterBaseUrl: "http://or/api/v1",
      apiKey: "k",
      posture: "balanced",
      arms: ["deepseek"],
      fixedModels: { fast: "f", mid: "m", frontier: "x" },
      judgeModel: "j",
      judge: false,
      prices: new Map(),
      baseline: { id: "b", inputUsdPerM: 1, outputUsdPerM: 1 },
      concurrency: 1,
      timeoutMs: 1000,
      providerPins: {},
      jev,
      fetchImpl,
      ...over,
    };
  }

  it("requires a Jev client", async () => {
    const fetchImpl: typeof fetch = async () => sseResponse("x", {});
    await expect(runBench({ ...options(fakeJev({}), fetchImpl), jev: undefined })).rejects.toThrow(/deepseek arm needs a Jev client/);
  });

  it("band 0 makes one v4-flash call, no ranking, and charges one Jev call", async () => {
    const jev = fakeJev({ "0": 0.9, "1": 0.1 });
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return sseResponse("the answer", { prompt_tokens: 10, completion_tokens: 5, cost: 0.001 });
    };
    const report = await runBench(options(jev, fetchImpl));
    const result = report.rows[0]?.results.find((r) => r.arm === "deepseek");
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.["model"]).toBe(DEEPSEEK_BRANCH_MODEL);
    expect(result).toMatchObject({ model: DEEPSEEK_BRANCH_MODEL, status: 200, jevLatencyMs: expect.any(Number) as number });
    expect(result?.grade?.pass).toBe(true);
    expect(result?.costUsd).toBeCloseTo(0.001 + JEV_USD_PER_CALL, 10);
    expect(result?.compute).toMatchObject({ band: 0, budget: 1, completed: 1, aborted: 0, earlyStop: false, pick: 0, jevCalls: 1 });
    expect(jev.ranks).toBe(0);
  });

  it("band 2 draws on v4-flash and the adaptive stop aborts the stragglers after 3 clear ranks", async () => {
    const jev = fakeJev({ "0": 0.1, "1": 0.2, "2": 0.7 }, () => ({ "3": 1 }));
    let calls = 0;
    const fetchImpl: typeof fetch = async (_input, init) => {
      calls += 1;
      if (calls <= 3) return sseResponse(`answer-${calls}`, { prompt_tokens: 10, completion_tokens: 5, cost: 0.001 });
      // Stragglers: never answer, reject only when the runner aborts them.
      return new Promise((_resolve, reject) => {
        const fail = (): void => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        const signal = init?.signal;
        if (signal?.aborted === true) fail();
        else signal?.addEventListener("abort", fail, { once: true });
      });
    };
    const report = await runBench(options(jev, fetchImpl));
    const result = report.rows[0]?.results.find((r) => r.arm === "deepseek");
    expect(result?.status).toBe(200);
    expect(result?.model).toBe(DEEPSEEK_BRANCH_MODEL);
    const compute = result?.compute;
    expect(compute).toMatchObject({ band: 2, budget: 5, completed: 3, aborted: 2, earlyStop: true, jevCalls: 4 });
    expect(compute?.samples).toHaveLength(5);
    expect(compute?.samples.filter((s) => s.error === "aborted").map((s) => s.index)).toEqual([3, 4]);
    expect(jev.sizings).toBe(1);
    expect(jev.ranks).toBe(3);
    // True aggregate cost: three completed samples plus four Jev calls.
    expect(result?.costUsd).toBeCloseTo(0.003 + 4 * JEV_USD_PER_CALL, 10);
    expect(result?.grade?.pass).toBe(true);
  });

  it("band 3 samples the orchestrator model and Jev's best rank picks without an early stop", async () => {
    const jev = fakeJev({ "0": 0.2, "1": 0.3, "2": 0.4, "3": 0.1 }, (answer) => (answer === "answer-3" ? { "2": 1 } : { "1": 1 }));
    let calls = 0;
    const models = new Set<string>();
    const fetchImpl: typeof fetch = async (_input, init) => {
      calls += 1;
      models.add((JSON.parse(String(init?.body)) as { model: string }).model);
      return sseResponse(`answer-${calls}`, { prompt_tokens: 10, completion_tokens: 5, cost: 0.001 });
    };
    const report = await runBench(options(jev, fetchImpl));
    const result = report.rows[0]?.results.find((r) => r.arm === "deepseek");
    expect(models).toEqual(new Set([DEEPSEEK_ORCHESTRATOR_MODEL]));
    expect(result?.compute).toMatchObject({ band: 3, budget: 5, completed: 5, aborted: 0, earlyStop: false, pick: 2, jevCalls: 6 });
    expect(result?.grade?.pass).toBe(true);
  });

  it("falls back to the first success when every rank fails, and says so per sample", async () => {
    // Band 3 (the hard-mass distribution): rank failure only matters where
    // the budget draws several samples, and band 1 is single-call now.
    const jev = fakeJev({ "2": 0.2, "3": 0.8 }, () => new Error("rank down"));
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return sseResponse(`answer-${calls}`, { prompt_tokens: 10, completion_tokens: 5, cost: 0.001 });
    };
    const report = await runBench(options(jev, fetchImpl));
    const result = report.rows[0]?.results.find((r) => r.arm === "deepseek");
    expect(result?.status).toBe(200);
    expect(result?.compute).toMatchObject({ band: 3, budget: 5, pick: 0, jevCalls: 1 });
    expect(result?.compute?.samples.every((s) => s.rankError !== undefined)).toBe(true);
    expect(result?.grade?.pass).toBe(true);
  });

  it("records a sizing failure without drawing a single sample", async () => {
    const jev: JevClientLike = {
      systemone: async () => {
        throw new Error("jev down");
      },
    };
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return sseResponse("x", {});
    };
    const report = await runBench(options(jev, fetchImpl));
    const result = report.rows[0]?.results.find((r) => r.arm === "deepseek");
    expect(result?.error).toMatch(/^sizing /);
    expect(result?.compute).toBeUndefined();
    expect(calls).toBe(0);
  });
});

describe("custom arms", () => {
  it("calls the named model directly, pinned only when the model is in the pins map", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      // The frame echoes the requested model, as OpenRouter's do.
      return sseResponse("negative", { prompt_tokens: 10, completion_tokens: 2, cost: 0.00001 }, { "x-milo-model": String(body["model"]) });
    };
    const report = await runBench({
      examples: [example("r-1", "Classify: bad.")],
      graders: new Map<string, GraderRow>([["r-1", { id: "r-1", grader: { type: "regex", pattern: "negative" } }]]),
      gatewayBaseUrl: "http://gw/v1",
      openRouterBaseUrl: "http://or/api/v1",
      apiKey: "k",
      posture: "balanced",
      arms: ["custom:anthropic/claude-fable-5.1", "custom:acme/unpinned"],
      fixedModels: { fast: "f", mid: "m", frontier: "x" },
      judgeModel: "j",
      judge: false,
      prices: new Map(),
      baseline: { id: "b", inputUsdPerM: 1, outputUsdPerM: 1 },
      concurrency: 1,
      timeoutMs: 1000,
      providerPins: { "anthropic/claude-fable-5.1": ["anthropic"] },
      fetchImpl,
    });
    const row = report.rows[0];
    const fable = row?.results.find((r) => r.arm === "custom:anthropic/claude-fable-5.1");
    expect(fable).toMatchObject({ model: "anthropic/claude-fable-5.1", status: 200 });
    expect(fable?.grade?.pass).toBe(true);
    expect(row?.results.find((r) => r.arm === "custom:acme/unpinned")?.model).toBe("acme/unpinned");
    const pinned = bodies.find((b) => b["model"] === "anthropic/claude-fable-5.1");
    expect(pinned?.["provider"]).toEqual({ order: ["anthropic"], allow_fallbacks: false });
    const unpinned = bodies.find((b) => b["model"] === "acme/unpinned");
    expect(unpinned?.["provider"]).toBeUndefined();
  });
});
