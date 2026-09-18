import { describe, expect, it } from "vitest";
import { ATTRIBUTION_METHOD, attributeWindow, decisionsUrl, fetchAttribution } from "./decisions.js";

const T0 = Date.parse("2026-09-18T12:00:00.000Z");

const decision = (id: string, createdAt: string, extra: Record<string, unknown> = {}) => ({
  id,
  tier: "fast",
  model: "test/fast",
  createdAt,
  ...extra,
});

describe("decisionsUrl", () => {
  it("strips a trailing /v1 (and slashes) before appending the decisions path", () => {
    expect(decisionsUrl("http://127.0.0.1:8787/v1")).toBe("http://127.0.0.1:8787/v1/decisions?limit=200");
    expect(decisionsUrl("http://127.0.0.1:8787/v1/")).toBe("http://127.0.0.1:8787/v1/decisions?limit=200");
    expect(decisionsUrl("http://milo.test")).toBe("http://milo.test/v1/decisions?limit=200");
  });
});

describe("attributeWindow", () => {
  it("keeps decisions inside the window (with skew), oldest first, and totals cost", () => {
    const records = [
      decision("in-2", "2026-09-18T12:00:30.000Z", { upstream: { status: 200, latencyMs: 1, costUsd: 0.02 }, samples: 3 }),
      decision("in-1", "2026-09-18T12:00:10.000Z", { upstream: { status: 200, latencyMs: 1, costUsd: 0.01 } }),
      decision("before", "2026-09-18T11:58:00.000Z"),
      decision("after", "2026-09-18T12:02:00.000Z"),
      decision("skewed-in", "2026-09-18T12:01:01.500Z"), // 1.5s past end, inside 2s skew
    ];
    const attribution = attributeWindow(records, T0, T0 + 60_000);
    expect(attribution.method).toBe(ATTRIBUTION_METHOD);
    expect(attribution.decisions.map((d) => d.id)).toEqual(["in-1", "in-2", "skewed-in"]);
    expect(attribution.costUsd).toBeCloseTo(0.03, 10);
    expect(attribution.decisions[1]).toEqual({
      id: "in-2",
      tier: "fast",
      model: "test/fast",
      createdAt: "2026-09-18T12:00:30.000Z",
      samples: 3,
      costUsd: 0.02,
    });
  });

  it("defaults samples to 1 and cost to 0, and drops malformed records", () => {
    const attribution = attributeWindow(
      [decision("ok", "2026-09-18T12:00:01.000Z"), { junk: true }, null, "nope"],
      T0,
      T0 + 10_000,
    );
    expect(attribution.decisions).toEqual([
      { id: "ok", tier: "fast", model: "test/fast", createdAt: "2026-09-18T12:00:01.000Z", samples: 1, costUsd: 0 },
    ]);
    expect(attribution.costUsd).toBe(0);
  });
});

describe("fetchAttribution", () => {
  it("calls the decisions endpoint with the bearer and attributes the window", async () => {
    let seenUrl = "";
    let seenAuth = "";
    const fakeFetch = (async (url: unknown, init?: { headers?: Record<string, string> }) => {
      seenUrl = String(url);
      seenAuth = init?.headers?.["authorization"] ?? "";
      return new Response(
        JSON.stringify({ data: [decision("d1", "2026-09-18T12:00:05.000Z", { upstream: { costUsd: 0.5 } })] }),
        { status: 200 },
      );
    }) as typeof fetch;

    const attribution = await fetchAttribution("http://milo.test/v1", "sk-or-test", T0, T0 + 10_000, fakeFetch);
    expect(seenUrl).toBe("http://milo.test/v1/decisions?limit=200");
    expect(seenAuth).toBe("Bearer sk-or-test");
    expect(attribution.error).toBeUndefined();
    expect(attribution.decisions.map((d) => d.id)).toEqual(["d1"]);
    expect(attribution.costUsd).toBe(0.5);
  });

  it("reports a missing key, an HTTP error, and a network error as notes, never throws", async () => {
    const noKey = await fetchAttribution("http://milo.test/v1", undefined, T0, T0 + 1);
    expect(noKey.error).toMatch(/OPENROUTER_API_KEY/);
    expect(noKey.decisions).toEqual([]);

    const http500 = (async () => new Response("boom", { status: 500 })) as typeof fetch;
    expect((await fetchAttribution("http://milo.test/v1", "k", T0, T0 + 1, http500)).error).toMatch(/HTTP 500/);

    const down = (async () => {
      throw new Error("connect ECONNREFUSED");
    }) as typeof fetch;
    expect((await fetchAttribution("http://milo.test/v1", "k", T0, T0 + 1, down)).error).toMatch(/ECONNREFUSED/);
  });
});
