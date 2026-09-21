import { createHash } from "node:crypto";
import { DecisionLog } from "@milo/core";
import type { DecisionRecord } from "@milo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  TenantLimits,
  applyTenantHeaders,
  bodyTooLarge,
  checkShape,
  estimateRequestTokens,
  messageCount,
} from "./tenant-limits.js";

const keyA = createHash("sha256").update("caller-a").digest("hex");
const keyB = createHash("sha256").update("caller-b").digest("hex");

function record(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    id: overrides.id ?? "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    fingerprint: "fp",
    tier: "fast",
    model: "deepseek/deepseek-v4-flash",
    reason: "test",
    policyVersion: "v4",
    sticky: false,
    createdAt: "2026-09-17T00:00:00.000Z",
    ...overrides,
  };
}

function at(times: { now: number }): () => number {
  return () => times.now;
}

// ---------------------------------------------------------------------------
// Defaults: an unconfigured TenantLimits changes nothing
// ---------------------------------------------------------------------------

describe("TenantLimits defaults", () => {
  it("leaves every check off when no config is given", async () => {
    const limits = new TenantLimits({});
    expect(limits.checkRequestRate(keyA)).toBeUndefined();
    expect(limits.checkTokenRate(keyA, 100_000)).toBeUndefined();
    expect(limits.spendCapEnabled).toBe(false);

    const log = await DecisionLog.open(":memory:");
    try {
      expect(await limits.checkSpend(log, keyA)).toBeUndefined();
    } finally {
      await log.close();
    }

    expect(checkShape({ messages: new Array(10_000).fill({ role: "user", content: "hi" }) }, {})).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Request-rate bucket
// ---------------------------------------------------------------------------

describe("TenantLimits.checkRequestRate", () => {
  it("allows exactly the configured burst, then refuses", () => {
    const times = { now: 0 };
    const limits = new TenantLimits({ requestsPerMinute: 3 }, { clock: at(times) });
    expect([1, 2, 3].map(() => limits.checkRequestRate(keyA)?.allowed)).toEqual([true, true, true]);
    const refused = limits.checkRequestRate(keyA);
    expect(refused?.allowed).toBe(false);
    expect(refused?.retryAfterMs).toBeGreaterThan(0);
  });

  it("refills continuously", () => {
    const times = { now: 0 };
    const limits = new TenantLimits({ requestsPerMinute: 60 }, { clock: at(times) });
    for (let i = 0; i < 60; i++) expect(limits.checkRequestRate(keyA)?.allowed).toBe(true);
    expect(limits.checkRequestRate(keyA)?.allowed).toBe(false);
    times.now = 1_000; // one second: one token back at 60/min
    expect(limits.checkRequestRate(keyA)?.allowed).toBe(true);
  });

  it("isolates one key's bucket from another's", () => {
    const limits = new TenantLimits({ requestsPerMinute: 1 }, { clock: () => 0 });
    expect(limits.checkRequestRate(keyA)?.allowed).toBe(true);
    expect(limits.checkRequestRate(keyA)?.allowed).toBe(false);
    expect(limits.checkRequestRate(keyB)?.allowed).toBe(true);
  });

  it("reports limit and remaining", () => {
    const limits = new TenantLimits({ requestsPerMinute: 5 }, { clock: () => 0 });
    const first = limits.checkRequestRate(keyA);
    expect(first).toEqual({ limit: 5, remaining: 4, retryAfterMs: 0, allowed: true });
  });
});

// ---------------------------------------------------------------------------
// Token-rate bucket
// ---------------------------------------------------------------------------

describe("TenantLimits.checkTokenRate", () => {
  it("spends the requested weight and refuses once exhausted", () => {
    const limits = new TenantLimits({ tokensPerMinute: 1000 }, { clock: () => 0 });
    expect(limits.checkTokenRate(keyA, 600)?.allowed).toBe(true);
    expect(limits.checkTokenRate(keyA, 500)?.allowed).toBe(false);
    expect(limits.checkTokenRate(keyA, 300)?.allowed).toBe(true);
  });

  it("is independent of the request-rate bucket", () => {
    const limits = new TenantLimits({ requestsPerMinute: 100, tokensPerMinute: 10 }, { clock: () => 0 });
    expect(limits.checkTokenRate(keyA, 8)?.allowed).toBe(true);
    // Only 2 tokens left in a 10-token bucket: 5 more does not fit.
    expect(limits.checkTokenRate(keyA, 5)?.allowed).toBe(false);
    // The request bucket, checked separately, is untouched by the token refusal.
    expect(limits.checkRequestRate(keyA)?.allowed).toBe(true);
  });

  it("clamps a single request's weight to the bucket's capacity rather than refusing it forever", () => {
    // A request whose own estimate is larger than the whole per-minute
    // budget can never fit if it had to be spent in full -- every future
    // call of the same size would refuse permanently. Clamping to capacity
    // spends the whole bucket instead, so the request succeeds once and the
    // key is rate-limited from there, rather than wedged shut.
    const limits = new TenantLimits({ tokensPerMinute: 10 }, { clock: () => 0 });
    expect(limits.checkTokenRate(keyA, 500)?.allowed).toBe(true);
    expect(limits.checkTokenRate(keyA, 1)?.allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Spend cap
// ---------------------------------------------------------------------------

describe("TenantLimits.checkSpend", () => {
  let log: DecisionLog;

  beforeEach(async () => {
    log = await DecisionLog.open(":memory:");
  });

  afterEach(async () => {
    await log.close();
  });

  async function seed(id: string, keyHash: string, costUsd: number, createdAt: string): Promise<void> {
    await log.insert(record({ id, createdAt, upstream: { status: 200, latencyMs: 1, costUsd } }));
    await log.setKeyHash(id, keyHash);
  }

  it("enforces the cap from decision-log cost seeded ahead of time", async () => {
    const now = Date.parse("2026-09-20T12:00:00.000Z");
    await seed("s1", keyA, 4, "2026-09-20T00:00:00.000Z");
    await seed("s2", keyA, 4.5, "2026-09-20T06:00:00.000Z");

    const limits = new TenantLimits({ spendCapUsd: 10, spendWindowHours: 24 }, { clock: () => now });
    const status = await limits.checkSpend(log, keyA);
    expect(status).toEqual({ capUsd: 10, spendUsd: 8.5, allowed: true });

    await seed("s3", keyA, 2, "2026-09-20T11:00:00.000Z");
    limits.clearSpendCache(keyA);
    const over = await limits.checkSpend(log, keyA);
    expect(over?.spendUsd).toBeCloseTo(10.5, 6);
    expect(over?.allowed).toBe(false);
  });

  it("does not count spend outside the rolling window or another key's spend", async () => {
    const now = Date.parse("2026-09-20T12:00:00.000Z");
    await seed("old", keyA, 9, "2026-09-18T00:00:00.000Z"); // over 24h old
    await seed("other", keyB, 9, "2026-09-20T11:00:00.000Z");

    const limits = new TenantLimits({ spendCapUsd: 1, spendWindowHours: 24 }, { clock: () => now });
    const status = await limits.checkSpend(log, keyA);
    expect(status).toEqual({ capUsd: 1, spendUsd: 0, allowed: true });
  });

  it("caches the total rather than re-reading the log on every call", async () => {
    const times = { now: Date.parse("2026-09-20T12:00:00.000Z") };
    await seed("s1", keyA, 1, "2026-09-20T11:00:00.000Z");

    const limits = new TenantLimits({ spendCapUsd: 100 }, { clock: at(times) });
    const first = await limits.checkSpend(log, keyA);
    expect(first?.spendUsd).toBe(1);

    // Spend more, but stay inside the TTL: the cached figure still answers.
    await seed("s2", keyA, 50, "2026-09-20T11:30:00.000Z");
    const cached = await limits.checkSpend(log, keyA);
    expect(cached?.spendUsd).toBe(1);

    // Past the TTL: the next check re-reads and sees the new total.
    times.now += 6_000;
    const fresh = await limits.checkSpend(log, keyA);
    expect(fresh?.spendUsd).toBe(51);
  });
});

// ---------------------------------------------------------------------------
// Request shape
// ---------------------------------------------------------------------------

describe("bodyTooLarge / checkShape / estimateRequestTokens", () => {
  it("flags a Content-Length over the ceiling", () => {
    expect(bodyTooLarge("2000000", 1_000_000)).toBe(true);
    expect(bodyTooLarge("500", 1_000_000)).toBe(false);
    expect(bodyTooLarge(undefined, 1_000_000)).toBe(false);
    expect(bodyTooLarge("not-a-number", 1_000_000)).toBe(false);
  });

  it("counts messages and input arrays", () => {
    expect(messageCount({ messages: [{ role: "user", content: "hi" }, { role: "user", content: "again" }] })).toBe(
      2,
    );
    expect(messageCount({ input: [1, 2, 3] })).toBe(3);
    expect(messageCount({})).toBe(0);
  });

  it("rejects a body over the configured message count", () => {
    const body = { messages: new Array(5).fill({ role: "user", content: "hi" }) };
    expect(checkShape(body, { maxMessages: 4 })).toEqual({ limit: "messages", count: 5, max: 4 });
    expect(checkShape(body, { maxMessages: 5 })).toBeUndefined();
  });

  it("rejects a body over the configured token estimate", () => {
    // A single string field, so the estimate is exactly length / 4 with no
    // other string leaves (role labels, types) adding to the count.
    const body = { prompt: "a".repeat(4000) };
    expect(estimateRequestTokens(body)).toBe(1000);
    expect(checkShape(body, { maxRequestTokens: 999 })).toEqual({ limit: "tokens", count: 1000, max: 999 });
    expect(checkShape(body, { maxRequestTokens: 1000 })).toBeUndefined();
  });

  it("sums every string leaf, content arrays and role labels alike", () => {
    // Deliberately not a precise tokenizer (see estimateRequestTokens'
    // docstring): `role: "user"` and `type: "text"` are string leaves too,
    // so they count. "user"+"text"+"abcd"+"text"+"efgh" = 20 chars / 4.
    const body = {
      messages: [{ role: "user", content: [{ type: "text", text: "abcd" }, { type: "text", text: "efgh" }] }],
    };
    expect(estimateRequestTokens(body)).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------

describe("applyTenantHeaders", () => {
  it("sets rate headers, with a reset only when refused", () => {
    const headers = new Headers();
    applyTenantHeaders(headers, { requests: { limit: 10, remaining: 3, retryAfterMs: 0, allowed: true } });
    expect(headers.get("x-milo-ratelimit-limit")).toBe("10");
    expect(headers.get("x-milo-ratelimit-remaining")).toBe("3");
    expect(headers.get("x-milo-ratelimit-reset")).toBeNull();

    const refused = new Headers();
    applyTenantHeaders(refused, { requests: { limit: 10, remaining: 0, retryAfterMs: 4500, allowed: false } });
    expect(refused.get("x-milo-ratelimit-reset")).toBe("5");
  });

  it("sets spend headers with six decimal places", () => {
    const headers = new Headers();
    applyTenantHeaders(headers, { spend: { capUsd: 10, spendUsd: 3.14159265, allowed: true } });
    expect(headers.get("x-milo-spend-usd")).toBe("3.141593");
    expect(headers.get("x-milo-spend-cap-usd")).toBe("10.000000");
  });

  it("sets nothing when status carries no checks", () => {
    const headers = new Headers();
    applyTenantHeaders(headers, {});
    expect([...headers.keys()]).toEqual([]);
  });
});
