import { describe, expect, it } from "vitest";
import { loadRoutingSet } from "./schema.js";
import { formatReplayReport, runSubscriptionReplay, stratifiedSample } from "./subscription-replay.js";

describe("stratifiedSample", () => {
  const set = loadRoutingSet();

  it("is capped, deterministic per seed, and spreads across task types", () => {
    const a = stratifiedSample(set, 9, 7);
    expect(a).toHaveLength(9);
    expect(new Set(a.map((e) => e.task_type)).size).toBe(9);
    expect(stratifiedSample(set, 9, 7).map((e) => e.id)).toEqual(a.map((e) => e.id));
    expect(stratifiedSample(set, 9, 8).map((e) => e.id)).not.toEqual(a.map((e) => e.id));
    expect(stratifiedSample(set, 500, 1)).toHaveLength(set.length);
  });
});

describe("runSubscriptionReplay", () => {
  it("posts each sampled task as milo/auto and reports where the work landed and the quota it used", async () => {
    const set = loadRoutingSet();
    const posted: Array<{ model: string }> = [];
    let usageReads = 0;
    let clock = 0;
    const usage = (codexUsed: number, claudeUsd: number) => ({
      subscriptions: [
        { backend: "codex", capacity: { usedPercent: codexUsed, window: "weekly", source: "cli", limited: false }, last7d: null },
        {
          backend: "claude",
          capacity: { usedPercent: 99, window: "seven_day", source: "cli", limited: false },
          last7d: { calls: 1, inputTokens: 1, outputTokens: 1, apiEquivalentUsd: claudeUsd },
        },
      ],
    });

    const report = await runSubscriptionReplay({
      baseUrl: "http://127.0.0.1:8787",
      examples: set,
      sample: 4,
      now: () => (clock += 1000),
      fetch: async (url, init) => {
        if (url.endsWith("/v1/usage")) {
          usageReads += 1;
          return Response.json(usageReads === 1 ? usage(2, 0.5) : usage(3, 0.75));
        }
        const body = JSON.parse(String(init?.body)) as { model: string };
        posted.push(body);
        const n = posted.length;
        if (n === 4) return Response.json({ error: { code: "subscriptions_exhausted" } }, { status: 429 });
        const backend = n === 1 ? "claude" : "codex";
        return Response.json(
          { usage: { prompt_tokens: 100, completion_tokens: 10 } },
          { headers: { "x-milo-backend": backend, "x-milo-task-type": "chat", ...(n === 2 ? { "x-milo-failover": "claude:rate_limited" } : {}) } },
        );
      },
    });

    expect(posted.every((p) => p.model === "milo/auto")).toBe(true);
    expect(report).toMatchObject({ sampled: 4, setSize: 120, served: 3, failures: 1, failedOver: 1 });
    expect(report.byBackend).toEqual([
      expect.objectContaining({ backend: "claude", tasks: 1, promptTokens: 100, usedPercentBefore: 99, usedPercentAfter: 99, apiEquivalentUsd: 0.25 }),
      expect.objectContaining({ backend: "codex", tasks: 2, promptTokens: 200, completionTokens: 20, usedPercentBefore: 2, usedPercentAfter: 3 }),
    ]);
    const text = formatReplayReport(report);
    expect(text).toContain("served 3, failed 1, failed over 1");
    expect(text).toContain("codex: 2 tasks");
    expect(text).toContain("plan used 2% -> 3% (weekly)");
    expect(text).toContain("subscriptions_exhausted");
  });

  it("refuses an uncapped run", async () => {
    await expect(runSubscriptionReplay({ baseUrl: "http://x", examples: [], sample: 0 })).rejects.toThrow(/sample/);
  });
});
