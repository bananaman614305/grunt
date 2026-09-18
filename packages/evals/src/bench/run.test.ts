import { describe, expect, it } from "vitest";
import type { RoutingExample } from "../schema.js";
import type { GraderRow } from "./graders.js";
import { armOrder, fixedModelsFromRoster, providerField, runBench, saltMessages } from "./run.js";

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

  it("providerField pins with fallbacks off, or is absent", () => {
    expect(providerField(["streamlake", "openai"])).toEqual({ provider: { order: ["streamlake", "openai"], allow_fallbacks: false } });
    expect(providerField([])).toEqual({});
    expect(providerField(undefined)).toEqual({});
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
      providers: ["streamlake", "openai"],
      fetchImpl,
      now: () => "2026-09-17T00:00:00.000Z",
    });
    expect(report.providers).toEqual(["streamlake", "openai"]);

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
    expect(routedCall?.body?.["provider"]).toEqual({ order: ["streamlake", "openai"], allow_fallbacks: false });
    expect(seen.every((s) => s.body === undefined || s.body["provider"] !== undefined)).toBe(true);
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
      fetchImpl,
    });
    const [row] = report.rows;
    expect(row?.results.find((r) => r.arm === "milo")).toMatchObject({ error: "network", status: 0 });
    expect(row?.results.find((r) => r.arm === "milo")?.grade).toBeUndefined();
    expect(row?.results.find((r) => r.arm === "fast")?.grade?.pass).toBe(true);
  });
});
