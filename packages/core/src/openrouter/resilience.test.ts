import { describe, expect, it, vi } from "vitest";
import { ConcurrencyLimiter, DEFAULT_RETRY, isRetryableUpstreamStatus, retryFetch } from "./resilience.js";

/** A sleep double that records requested delays and never really waits. */
function recordingSleep(): { sleep: (ms: number) => Promise<void>; calls: number[] } {
  const calls: number[] = [];
  return {
    calls,
    sleep: async (ms: number) => {
      calls.push(ms);
    },
  };
}

/** A fetch double that returns each queued response/throw in turn. */
function scriptedFetch(steps: Array<Response | Error>): () => Promise<Response> {
  let i = 0;
  return async () => {
    const step = steps[Math.min(i, steps.length - 1)];
    i += 1;
    if (step instanceof Error) throw step;
    return step as Response;
  };
}

describe("isRetryableUpstreamStatus", () => {
  it("is true for 429 and any 5xx, false for other 4xx and 2xx", () => {
    expect(isRetryableUpstreamStatus(429)).toBe(true);
    expect(isRetryableUpstreamStatus(500)).toBe(true);
    expect(isRetryableUpstreamStatus(503)).toBe(true);
    expect(isRetryableUpstreamStatus(400)).toBe(false);
    expect(isRetryableUpstreamStatus(404)).toBe(false);
    expect(isRetryableUpstreamStatus(200)).toBe(false);
  });
});

describe("retryFetch", () => {
  it("retries a 429 with backoff and returns the eventual success", async () => {
    const { sleep, calls } = recordingSleep();
    const attempt = vi.fn(scriptedFetch([new Response("", { status: 429 }), new Response("ok", { status: 200 })]));

    const res = await retryFetch(attempt, { retry: { maxAttempts: 4 }, deps: { sleep, random: () => 0.5 } });

    expect(res.status).toBe(200);
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBeGreaterThan(0);
  });

  it("retries a 5xx as well", async () => {
    const { sleep } = recordingSleep();
    const attempt = vi.fn(scriptedFetch([new Response("", { status: 503 }), new Response("ok", { status: 200 })]));
    const res = await retryFetch(attempt, { retry: { maxAttempts: 3 }, deps: { sleep } });
    expect(res.status).toBe(200);
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it("returns the last response once attempts are exhausted", async () => {
    const { sleep, calls } = recordingSleep();
    // A fresh response per attempt: the retry drains each failed one, so the
    // final returned response must be its own object with an unread body.
    const attempt = vi.fn(async () => new Response("nope", { status: 429 }));

    const res = await retryFetch(attempt, { retry: { maxAttempts: 4 }, deps: { sleep } });

    expect(res.status).toBe(429);
    expect(await res.text()).toBe("nope");
    expect(attempt).toHaveBeenCalledTimes(4);
    // One sleep between each of the four attempts.
    expect(calls).toHaveLength(3);
  });

  it("does not retry a non-retryable 4xx", async () => {
    const { sleep } = recordingSleep();
    const attempt = vi.fn(scriptedFetch([new Response("bad", { status: 400 })]));
    const res = await retryFetch(attempt, { retry: { maxAttempts: 4 }, deps: { sleep } });
    expect(res.status).toBe(400);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("honours a numeric Retry-After header instead of the computed backoff", async () => {
    const { sleep, calls } = recordingSleep();
    const attempt = vi.fn(
      scriptedFetch([
        new Response("", { status: 429, headers: { "retry-after": "2" } }),
        new Response("ok", { status: 200 }),
      ]),
    );

    const res = await retryFetch(attempt, { retry: { maxAttempts: 4 }, deps: { sleep, random: () => 0 } });

    expect(res.status).toBe(200);
    expect(calls).toEqual([2000]);
  });

  it("caps a Retry-After at maxDelayMs", async () => {
    const { sleep, calls } = recordingSleep();
    const attempt = vi.fn(
      scriptedFetch([
        new Response("", { status: 429, headers: { "retry-after": "600" } }),
        new Response("ok", { status: 200 }),
      ]),
    );
    await retryFetch(attempt, { retry: { maxAttempts: 2, maxDelayMs: 5000 }, deps: { sleep } });
    expect(calls).toEqual([5000]);
  });

  it("retries a thrown network error, then rethrows once exhausted", async () => {
    const { sleep } = recordingSleep();
    const boom = new Error("ECONNRESET");
    const attempt = vi.fn(scriptedFetch([boom]));

    await expect(retryFetch(attempt, { retry: { maxAttempts: 3 }, deps: { sleep } })).rejects.toThrow("ECONNRESET");
    expect(attempt).toHaveBeenCalledTimes(3);
  });

  it("recovers when a network error is followed by a success", async () => {
    const { sleep } = recordingSleep();
    const attempt = vi.fn(scriptedFetch([new Error("fetch failed"), new Response("ok", { status: 200 })]));
    const res = await retryFetch(attempt, { retry: { maxAttempts: 3 }, deps: { sleep } });
    expect(res.status).toBe(200);
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it("never retries once the caller's signal is aborted", async () => {
    const { sleep } = recordingSleep();
    const controller = new AbortController();
    controller.abort();
    const attempt = vi.fn(scriptedFetch([new Response("ok", { status: 200 })]));

    await expect(
      retryFetch(attempt, { retry: { maxAttempts: 4 }, signal: controller.signal, deps: { sleep } }),
    ).rejects.toBeDefined();
    expect(attempt).not.toHaveBeenCalled();
  });

  it("does not retry a thrown AbortError even without an aborted signal", async () => {
    const { sleep } = recordingSleep();
    const abort = new Error("aborted");
    abort.name = "AbortError";
    const attempt = vi.fn(scriptedFetch([abort]));

    await expect(retryFetch(attempt, { retry: { maxAttempts: 4 }, deps: { sleep } })).rejects.toThrow("aborted");
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("makes exactly one attempt when maxAttempts is 1 (retry disabled)", async () => {
    const { sleep, calls } = recordingSleep();
    const attempt = vi.fn(scriptedFetch([new Response("", { status: 500 })]));
    const res = await retryFetch(attempt, { retry: { maxAttempts: 1 }, deps: { sleep } });
    expect(res.status).toBe(500);
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(0);
  });

  it("defaults to DEFAULT_RETRY.maxAttempts when no policy is given", async () => {
    const { sleep } = recordingSleep();
    const attempt = vi.fn(scriptedFetch([new Response("", { status: 429 })]));
    await retryFetch(attempt, { deps: { sleep } });
    expect(attempt).toHaveBeenCalledTimes(DEFAULT_RETRY.maxAttempts);
  });
});

describe("ConcurrencyLimiter", () => {
  /** A gate whose promise the test resolves by hand. */
  function gate(): { promise: Promise<void>; open: () => void } {
    let open: () => void = () => undefined;
    const promise = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { promise, open };
  }

  it("never runs more than the cap for one key at once", async () => {
    const limiter = new ConcurrencyLimiter(2);
    const gates = [gate(), gate(), gate(), gate()];
    let active = 0;
    let peak = 0;

    const runs = gates.map((g) =>
      limiter.run("m", async () => {
        active += 1;
        peak = Math.max(peak, active);
        await g.promise;
        active -= 1;
      }),
    );

    // Only the first two may have started; the rest are queued.
    await Promise.resolve();
    expect(peak).toBe(2);
    expect(limiter.activeFor("m")).toBe(2);

    // Draining one at a time keeps the ceiling at two throughout.
    for (const g of gates) {
      g.open();
      await Promise.resolve();
      expect(peak).toBeLessThanOrEqual(2);
    }
    await Promise.all(runs);
    expect(peak).toBe(2);
  });

  it("keeps separate keys on separate lanes", async () => {
    const limiter = new ConcurrencyLimiter(1);
    const a = gate();
    const b = gate();
    let running = 0;
    let peak = 0;
    const track = async (g: { promise: Promise<void> }): Promise<void> => {
      running += 1;
      peak = Math.max(peak, running);
      await g.promise;
      running -= 1;
    };

    const runs = [limiter.run("model-a", () => track(a)), limiter.run("model-b", () => track(b))];
    await Promise.resolve();
    // Different models: both run at once despite a per-key cap of one.
    expect(peak).toBe(2);
    a.open();
    b.open();
    await Promise.all(runs);
  });

  it("imposes no limit when constructed with a non-positive cap", async () => {
    const limiter = new ConcurrencyLimiter(0);
    const gates = [gate(), gate(), gate()];
    let running = 0;
    let peak = 0;
    const runs = gates.map((g) =>
      limiter.run("m", async () => {
        running += 1;
        peak = Math.max(peak, running);
        await g.promise;
        running -= 1;
      }),
    );
    await Promise.resolve();
    expect(peak).toBe(3);
    for (const g of gates) g.open();
    await Promise.all(runs);
  });

  it("runs unkeyed work without gating", async () => {
    const limiter = new ConcurrencyLimiter(1);
    const result = await limiter.run(undefined, async () => 42);
    expect(result).toBe(42);
  });
});
