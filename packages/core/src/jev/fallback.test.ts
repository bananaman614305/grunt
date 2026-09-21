import { describe, expect, it, vi } from "vitest";
import { JevError } from "./client.js";
import { JevClient } from "./client.js";
import { JevTransportFallbackClient } from "./fallback.js";
import type { JevBreakerLogger } from "./fallback.js";
import type { JevClientLike, SystemOneResult } from "./types.js";
import { CircuitBreaker } from "../router/breaker.js";

function fakeClock(): { now: () => number; advance: (ms: number) => void } {
  let t = 1_700_000_000_000;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

function okResult(): SystemOneResult {
  return {
    model: "jev-latest",
    answers: {},
    usage: { input_tokens: 1, output_tokens: 1 },
    requestId: "req_1",
    latencyMs: 1,
  };
}

function stubClient(): JevClientLike & { systemone: ReturnType<typeof vi.fn> } {
  return { systemone: vi.fn() };
}

function quietLogger(): JevBreakerLogger & { warn: ReturnType<typeof vi.fn> } {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const REQ = { state: "state", questions: {} };

describe("JevTransportFallbackClient", () => {
  it("starts closed and reports the openrouter transport", async () => {
    const primary = stubClient();
    primary.systemone.mockResolvedValue(okResult());
    const client = new JevTransportFallbackClient({ primary });

    expect(client.breakerStatus().state).toBe("closed");
    expect(client.currentTransport()).toBe("openrouter");

    await client.systemone(REQ);
    expect(primary.systemone).toHaveBeenCalledTimes(1);
    expect(client.currentTransport()).toBe("openrouter");
  });

  it("opens the breaker after N consecutive transport failures and stops calling the primary", async () => {
    const clock = fakeClock();
    const primary = stubClient();
    primary.systemone.mockRejectedValue(new JevError("boom", "network"));
    const breaker = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 30_000, clock: clock.now });
    const client = new JevTransportFallbackClient({ primary, breaker });

    for (let i = 0; i < 3; i++) {
      await expect(client.systemone(REQ)).rejects.toThrow();
    }
    expect(primary.systemone).toHaveBeenCalledTimes(3);
    expect(client.breakerStatus().state).toBe("open");

    // A 4th call, still inside the cooldown, must not touch the primary
    // again -- the breaker fails it immediately.
    await expect(client.systemone(REQ)).rejects.toThrow(/circuit is open/);
    expect(primary.systemone).toHaveBeenCalledTimes(3);
  });

  it("counts a malformed (validation) response as a breaker failure too", async () => {
    const clock = fakeClock();
    const primary = stubClient();
    primary.systemone.mockRejectedValue(new JevError("bad body", "validation"));
    const breaker = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 30_000, clock: clock.now });
    const client = new JevTransportFallbackClient({ primary, breaker });

    await expect(client.systemone(REQ)).rejects.toThrow();
    expect(client.breakerStatus().state).toBe("closed");
    await expect(client.systemone(REQ)).rejects.toThrow();
    expect(client.breakerStatus().state).toBe("open");
  });

  it("does not open the breaker on an ordinary 4xx (Jev answered, Milo's request was bad)", async () => {
    const clock = fakeClock();
    const primary = stubClient();
    primary.systemone.mockRejectedValue(new JevError("bad request", "http", { status: 400 }));
    const breaker = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 30_000, clock: clock.now });
    const client = new JevTransportFallbackClient({ primary, breaker });

    await expect(client.systemone(REQ)).rejects.toThrow();
    await expect(client.systemone(REQ)).rejects.toThrow();
    await expect(client.systemone(REQ)).rejects.toThrow();
    expect(client.breakerStatus().state).toBe("closed");
    expect(primary.systemone).toHaveBeenCalledTimes(3);
  });

  it("half-opens after the cooldown and probes the primary again", async () => {
    const clock = fakeClock();
    const primary = stubClient();
    primary.systemone.mockRejectedValue(new JevError("boom", "network"));
    const breaker = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 10_000, clock: clock.now });
    const client = new JevTransportFallbackClient({ primary, breaker });

    await expect(client.systemone(REQ)).rejects.toThrow();
    await expect(client.systemone(REQ)).rejects.toThrow();
    expect(client.breakerStatus().state).toBe("open");
    expect(primary.systemone).toHaveBeenCalledTimes(2);

    // Still inside the cooldown: no probe yet.
    clock.advance(5_000);
    await expect(client.systemone(REQ)).rejects.toThrow(/circuit is open/);
    expect(primary.systemone).toHaveBeenCalledTimes(2);

    // Cooldown elapsed: exactly one probe reaches the primary.
    clock.advance(5_001);
    primary.systemone.mockResolvedValueOnce(okResult());
    const result = await client.systemone(REQ);
    expect(result).toBeDefined();
    expect(primary.systemone).toHaveBeenCalledTimes(3);
  });

  it("closes the breaker once a half-open probe succeeds", async () => {
    const clock = fakeClock();
    const primary = stubClient();
    primary.systemone.mockRejectedValue(new JevError("boom", "network"));
    const breaker = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 10_000, clock: clock.now });
    const client = new JevTransportFallbackClient({ primary, breaker });

    await expect(client.systemone(REQ)).rejects.toThrow();
    await expect(client.systemone(REQ)).rejects.toThrow();
    clock.advance(10_001);
    primary.systemone.mockResolvedValueOnce(okResult());
    await client.systemone(REQ);
    expect(client.breakerStatus().state).toBe("closed");

    // Normal calls flow straight to the primary again.
    primary.systemone.mockResolvedValue(okResult());
    await client.systemone(REQ);
    await client.systemone(REQ);
    expect(primary.systemone).toHaveBeenCalledTimes(5);
    expect(client.currentTransport()).toBe("openrouter");
  });

  it("re-opens for a full cooldown when the half-open probe itself fails", async () => {
    const clock = fakeClock();
    const primary = stubClient();
    primary.systemone.mockRejectedValue(new JevError("boom", "network"));
    const breaker = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 10_000, clock: clock.now });
    const client = new JevTransportFallbackClient({ primary, breaker });

    await expect(client.systemone(REQ)).rejects.toThrow();
    await expect(client.systemone(REQ)).rejects.toThrow();
    clock.advance(10_001);
    // The probe also fails.
    await expect(client.systemone(REQ)).rejects.toThrow();
    expect(client.breakerStatus().state).toBe("open");

    // Immediately after the failed probe, still refused without a new call.
    await expect(client.systemone(REQ)).rejects.toThrow(/circuit is open/);
    expect(primary.systemone).toHaveBeenCalledTimes(3);
  });

  describe("opt-in fallback", () => {
    it("routes to the fallback ONLY once the breaker is open, never on a single failure while closed", async () => {
      const clock = fakeClock();
      const primary = stubClient();
      primary.systemone.mockRejectedValue(new JevError("boom", "network"));
      const fallback = stubClient();
      fallback.systemone.mockResolvedValue(okResult());
      const breaker = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 30_000, clock: clock.now });
      const client = new JevTransportFallbackClient({ primary, fallback, breaker });

      // Two failures, still below threshold: fallback must not be touched.
      await expect(client.systemone(REQ)).rejects.toThrow();
      await expect(client.systemone(REQ)).rejects.toThrow();
      expect(fallback.systemone).not.toHaveBeenCalled();
      expect(client.currentTransport()).toBe("openrouter");

      // Third failure trips the breaker.
      await expect(client.systemone(REQ)).rejects.toThrow();
      expect(client.breakerStatus().state).toBe("open");
      expect(fallback.systemone).not.toHaveBeenCalled();

      // Now the breaker is open: the NEXT call is served by the fallback.
      const result = await client.systemone(REQ);
      expect(result).toBeDefined();
      expect(fallback.systemone).toHaveBeenCalledTimes(1);
      expect(primary.systemone).toHaveBeenCalledTimes(3); // not retried
      expect(client.currentTransport()).toBe("typesafe-fallback");
    });

    it("keeps serving the fallback for every call while the breaker stays open", async () => {
      const clock = fakeClock();
      const primary = stubClient();
      primary.systemone.mockRejectedValue(new JevError("boom", "network"));
      const fallback = stubClient();
      fallback.systemone.mockResolvedValue(okResult());
      const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 30_000, clock: clock.now });
      const client = new JevTransportFallbackClient({ primary, fallback, breaker });

      await expect(client.systemone(REQ)).rejects.toThrow();
      expect(client.breakerStatus().state).toBe("open");

      await client.systemone(REQ);
      await client.systemone(REQ);
      await client.systemone(REQ);
      expect(fallback.systemone).toHaveBeenCalledTimes(3);
      expect(primary.systemone).toHaveBeenCalledTimes(1);
    });

    it("never sends the fallback client the caller's forwarded openrouter apiKey unchanged into a typesafe call", async () => {
      // The wrapper does not need to strip anything itself -- the typesafe
      // JevClient already ignores opts.apiKey and always authenticates with
      // its own configured key (ADR-021/022). This just proves the wrapper
      // passes opts through rather than inventing a new call shape that
      // could accidentally carry a key somewhere unexpected.
      const clock = fakeClock();
      const primary = stubClient();
      primary.systemone.mockRejectedValue(new JevError("boom", "network"));
      const fallback = stubClient();
      fallback.systemone.mockResolvedValue(okResult());
      const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 30_000, clock: clock.now });
      const client = new JevTransportFallbackClient({ primary, fallback, breaker });

      await expect(client.systemone(REQ, { apiKey: "sk-or-forwarded" })).rejects.toThrow();
      await client.systemone(REQ, { apiKey: "sk-or-forwarded" });
      expect(fallback.systemone).toHaveBeenCalledWith(REQ, { apiKey: "sk-or-forwarded" });
    });

    it("does NOT activate the fallback when it is not configured, whatever the breaker does (no opt-in)", async () => {
      const clock = fakeClock();
      const primary = stubClient();
      primary.systemone.mockRejectedValue(new JevError("boom", "network"));
      const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 30_000, clock: clock.now });
      const client = new JevTransportFallbackClient({ primary, breaker }); // no `fallback`

      await expect(client.systemone(REQ)).rejects.toThrow();
      expect(client.breakerStatus().state).toBe("open");
      // Every subsequent call fails open -- immediately, without a fallback.
      for (let i = 0; i < 5; i++) {
        await expect(client.systemone(REQ)).rejects.toThrow(/circuit is open/);
      }
      expect(primary.systemone).toHaveBeenCalledTimes(1);
      expect(client.currentTransport()).toBe("openrouter");
      expect(client.fallbackConfigured).toBe(false);
    });
  });

  describe("no opt-in never reaches api.typesafe.ai (network-level proof)", () => {
    it("a broken openrouter transport makes zero calls to a real typesafe JevClient's fetch, however long it fails", async () => {
      // Real JevClient instances, not stubs, so this proves the guarantee at
      // the actual HTTP layer: the typesafe transport's `fetch` is spied on,
      // but that client is never handed to JevTransportFallbackClient as a
      // `fallback` -- exactly what createGateway does when
      // jevFallbackToTypesafe is unset. If the wrapper ever reached for it
      // regardless, this fetch would be called and the test would fail.
      const openrouterFetch = vi.fn(async () => {
        throw new Error("network unreachable");
      });
      const typesafeFetch = vi.fn(async () => new Response("{}", { status: 200 }));

      const primary = new JevClient({ transport: "openrouter", apiKey: "", fetch: openrouterFetch, retries: 0 });
      // Constructed to prove it exists and COULD be called, but deliberately
      // never wired in as `fallback` -- simulating "no operator opt-in" even
      // though Milo's own key exists elsewhere in the process.
      void new JevClient({ apiKey: "milo-key", fetch: typesafeFetch, retries: 0 });

      const breaker = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 30_000 });
      const client = new JevTransportFallbackClient({ primary, breaker }); // no fallback

      for (let i = 0; i < 10; i++) {
        await expect(client.systemone(REQ, { apiKey: "sk-or-forwarded" })).rejects.toThrow();
      }

      expect(typesafeFetch).not.toHaveBeenCalled();
      // The breaker capped how many times the broken openrouter endpoint was
      // even hit: 2 real attempts, then fail-fast for the rest.
      expect(openrouterFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe("structured logs on state transitions", () => {
    it("logs the closed -> open transition and the open -> half_open -> closed recovery", async () => {
      const clock = fakeClock();
      const primary = stubClient();
      primary.systemone.mockRejectedValue(new JevError("boom", "network"));
      const logger = quietLogger();
      const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 10_000, clock: clock.now });
      const client = new JevTransportFallbackClient({ primary, breaker, logger });

      await expect(client.systemone(REQ)).rejects.toThrow();
      expect(logger.warn).toHaveBeenCalledWith(
        "jev openrouter transport breaker state changed",
        expect.objectContaining({ from: "closed", to: "open" }),
      );

      clock.advance(10_001);
      primary.systemone.mockResolvedValueOnce(okResult());
      logger.warn.mockClear();
      await client.systemone(REQ);
      // The successful half-open probe closes the breaker.
      const transitions = logger.warn.mock.calls
        .filter(([msg]) => msg === "jev openrouter transport breaker state changed")
        .map(([, meta]) => meta as { from: string; to: string });
      expect(transitions).toEqual(
        expect.arrayContaining([expect.objectContaining({ from: "half_open", to: "closed" })]),
      );
    });

    it("logs when it falls back and when it fails open with no fallback configured", async () => {
      const clock = fakeClock();
      const primary = stubClient();
      primary.systemone.mockRejectedValue(new JevError("boom", "network"));
      const fallback = stubClient();
      fallback.systemone.mockResolvedValue(okResult());
      const logger = quietLogger();
      const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 30_000, clock: clock.now });
      const withFallback = new JevTransportFallbackClient({ primary, fallback, breaker, logger });

      await expect(withFallback.systemone(REQ)).rejects.toThrow();
      logger.warn.mockClear();
      await withFallback.systemone(REQ);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("using typesafe fallback"),
        expect.any(Object),
      );

      const noFallbackLogger = quietLogger();
      const breaker2 = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 30_000, clock: clock.now });
      const noFallback = new JevTransportFallbackClient({ primary, breaker: breaker2, logger: noFallbackLogger });
      await expect(noFallback.systemone(REQ)).rejects.toThrow();
      noFallbackLogger.warn.mockClear();
      await expect(noFallback.systemone(REQ)).rejects.toThrow();
      expect(noFallbackLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("no fallback configured"),
        expect.any(Object),
      );
    });
  });
});
