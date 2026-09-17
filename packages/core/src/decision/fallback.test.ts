/**
 * `FallbackDecisionClient`: which failures fall back, which do not, and how
 * the breaker opens, stays open, and half-opens.
 */

import { describe, expect, it } from "vitest";
import { JevError } from "../jev/client.js";
import type { JevClientLike, SystemOneRequest, SystemOneResult } from "../jev/types.js";
import { FallbackDecisionClient } from "./fallback.js";
import type { FallbackInfo } from "./fallback.js";

const REQ: Omit<SystemOneRequest, "model"> = { state: "a brief", questions: {} };

function result(model: string): SystemOneResult {
  return {
    model,
    answers: {},
    usage: { input_tokens: 0, output_tokens: 0 },
    requestId: `req_${model}`,
    latencyMs: 1,
  };
}

/** A scriptable backend that records every call it receives. */
class Backend implements JevClientLike {
  readonly calls: Array<{ signal: AbortSignal | undefined }> = [];
  private readonly script: Array<SystemOneResult | Error>;

  constructor(
    private readonly model: string,
    script: Array<SystemOneResult | Error> = [],
  ) {
    this.script = script;
  }

  get callCount(): number {
    return this.calls.length;
  }

  async systemone(
    _req: Omit<SystemOneRequest, "model"> & { model?: string },
    opts?: { signal?: AbortSignal },
  ): Promise<SystemOneResult> {
    this.calls.push({ signal: opts?.signal });
    const next = this.script.shift();
    if (next instanceof Error) throw next;
    return next ?? result(this.model);
  }
}

function httpError(status = 503): JevError {
  return new JevError(`jev request failed with status ${status}`, "http", { status });
}

function make(
  primary: JevClientLike,
  secondary: JevClientLike,
  overrides: {
    failures?: number;
    cooldownMs?: number;
    now?: () => number;
    onFallback?: (info: FallbackInfo) => void;
  } = {},
): FallbackDecisionClient {
  return new FallbackDecisionClient({
    primary,
    secondary,
    breaker: {
      failures: overrides.failures ?? 3,
      cooldownMs: overrides.cooldownMs ?? 60_000,
    },
    ...(overrides.now !== undefined ? { clock: overrides.now } : {}),
    ...(overrides.onFallback !== undefined ? { onFallback: overrides.onFallback } : {}),
  });
}

describe("primary success", () => {
  it("returns the primary's answer and never touches the secondary", async () => {
    const primary = new Backend("jev-latest");
    const secondary = new Backend("system-one-open/e2b-full");

    const out = await make(primary, secondary).systemone(REQ);

    expect(out.model).toBe("jev-latest");
    expect(primary.callCount).toBe(1);
    expect(secondary.callCount).toBe(0);
  });
});

describe("falling back", () => {
  it("uses the secondary on an http failure and names it as the answering backend", async () => {
    const primary = new Backend("jev-latest", [httpError(503)]);
    const secondary = new Backend("system-one-open/e2b-full");
    const seen: FallbackInfo[] = [];

    const out = await make(primary, secondary, { onFallback: (i) => seen.push(i) }).systemone(REQ);

    expect(out.model).toBe("system-one-open/e2b-full");
    expect(secondary.callCount).toBe(1);
    expect(seen).toEqual([{ cause: "http", usedSecondary: true, breakerOpen: false }]);
  });

  it("falls back on a network failure", async () => {
    const primary = new Backend("jev-latest", [new JevError("boom", "network")]);
    const secondary = new Backend("open");

    await expect(make(primary, secondary).systemone(REQ)).resolves.toMatchObject({ model: "open" });
  });

  it("falls back on a timeout", async () => {
    const primary = new Backend("jev-latest", [new JevError("too slow", "timeout")]);
    const secondary = new Backend("open");
    const seen: FallbackInfo[] = [];

    await make(primary, secondary, { onFallback: (i) => seen.push(i) }).systemone(REQ);

    expect(seen[0]?.cause).toBe("timeout");
  });

  it("does not fall back on a validation failure", async () => {
    const primary = new Backend("jev-latest", [new JevError("bad answer", "validation")]);
    const secondary = new Backend("open");
    const seen: FallbackInfo[] = [];

    await expect(
      make(primary, secondary, { onFallback: (i) => seen.push(i) }).systemone(REQ),
    ).rejects.toThrow(/bad answer/);

    expect(secondary.callCount).toBe(0);
    expect(seen).toEqual([]);
  });

  it("does not fall back on an unclassified error", async () => {
    const primary = new Backend("jev-latest", [new TypeError("router bug")]);
    const secondary = new Backend("open");

    await expect(make(primary, secondary).systemone(REQ)).rejects.toThrow(TypeError);
    expect(secondary.callCount).toBe(0);
  });

  it("surfaces the secondary's own failure when both are down", async () => {
    const primary = new Backend("jev-latest", [httpError(500)]);
    const secondary = new Backend("open", [new JevError("also down", "network")]);

    await expect(make(primary, secondary).systemone(REQ)).rejects.toThrow(/also down/);
  });

  it("a validation failure does not count toward the breaker", async () => {
    const primary = new Backend("jev-latest", [
      new JevError("v1", "validation"),
      new JevError("v2", "validation"),
      new JevError("v3", "validation"),
      httpError(),
    ]);
    const secondary = new Backend("open");
    const client = make(primary, secondary, { failures: 3 });

    for (let i = 0; i < 3; i += 1) {
      await expect(client.systemone(REQ)).rejects.toThrow(/^v[123]$/);
    }
    await client.systemone(REQ);

    expect(client.breakerOpen()).toBe(false);
    expect(primary.callCount).toBe(4);
  });
});

describe("the circuit breaker", () => {
  it("opens after N consecutive failures and then skips the primary entirely", async () => {
    const primary = new Backend("jev-latest", [httpError(), httpError(), httpError()]);
    const secondary = new Backend("open");
    const seen: FallbackInfo[] = [];
    let now = 1_000;
    const client = make(primary, secondary, {
      failures: 3,
      cooldownMs: 60_000,
      now: () => now,
      onFallback: (i) => seen.push(i),
    });

    for (let i = 0; i < 3; i += 1) await client.systemone(REQ);
    expect(primary.callCount).toBe(3);
    expect(client.breakerOpen()).toBe(true);

    // The next two requests never dial the primary at all.
    now += 1_000;
    await client.systemone(REQ);
    await client.systemone(REQ);

    expect(primary.callCount).toBe(3);
    expect(secondary.callCount).toBe(5);
    expect(seen.slice(3)).toEqual([
      { cause: "breaker-open", usedSecondary: true, breakerOpen: true },
      { cause: "breaker-open", usedSecondary: true, breakerOpen: true },
    ]);
    // The third failure is the one that tripped it.
    expect(seen[2]).toEqual({ cause: "http", usedSecondary: true, breakerOpen: true });
  });

  it("half-opens after the cooldown and closes when the probe succeeds", async () => {
    const primary = new Backend("jev-latest", [httpError(), httpError()]);
    const secondary = new Backend("open");
    let now = 1_000;
    const client = make(primary, secondary, { failures: 2, cooldownMs: 60_000, now: () => now });

    await client.systemone(REQ);
    await client.systemone(REQ);
    expect(client.breakerOpen()).toBe(true);

    // Still cooling down: skipped.
    now += 59_999;
    await client.systemone(REQ);
    expect(primary.callCount).toBe(2);

    // Cooldown elapsed: one probe goes through, and it succeeds.
    now += 1;
    expect(client.breakerOpen()).toBe(false);
    const out = await client.systemone(REQ);

    expect(out.model).toBe("jev-latest");
    expect(primary.callCount).toBe(3);
    expect(client.breakerOpen()).toBe(false);

    // Closed again: the next request goes straight to the primary.
    await client.systemone(REQ);
    expect(primary.callCount).toBe(4);
    expect(secondary.callCount).toBe(3);
  });

  it("re-opens for another cooldown when the half-open probe fails", async () => {
    const primary = new Backend("jev-latest", [httpError(), httpError(), httpError()]);
    const secondary = new Backend("open");
    let now = 1_000;
    const client = make(primary, secondary, { failures: 2, cooldownMs: 10_000, now: () => now });

    await client.systemone(REQ);
    await client.systemone(REQ);

    now += 10_000;
    await client.systemone(REQ); // the probe, which fails
    expect(primary.callCount).toBe(3);
    expect(client.breakerOpen()).toBe(true);

    now += 9_999;
    await client.systemone(REQ);
    expect(primary.callCount).toBe(3);
  });

  it("lets only one request probe at a time while half-open", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    /** Fails twice to trip the breaker, then blocks on the gate. */
    class GatedPrimary implements JevClientLike {
      calls = 0;
      async systemone(): Promise<SystemOneResult> {
        this.calls += 1;
        if (this.calls <= 2) throw httpError();
        await gate;
        return result("jev-latest");
      }
    }

    const primary = new GatedPrimary();
    const secondary = new Backend("open");
    let now = 1_000;
    const client = make(primary, secondary, { failures: 2, cooldownMs: 10_000, now: () => now });

    await client.systemone(REQ);
    await client.systemone(REQ);

    now += 10_000;
    const probe = client.systemone(REQ);
    // A second request while the probe is still in flight must not dial the
    // primary as well; it goes to the secondary.
    const parallel = await client.systemone(REQ);
    expect(parallel.model).toBe("open");

    release?.();
    await expect(probe).resolves.toMatchObject({ model: "jev-latest" });
    expect(primary.calls).toBe(3);
  });

  it("uses 3 failures and a 60 s cooldown by default", async () => {
    const primary = new Backend("jev-latest", [httpError(), httpError(), httpError()]);
    const secondary = new Backend("open");
    const client = new FallbackDecisionClient({ primary, secondary });

    await client.systemone(REQ);
    expect(client.breakerOpen()).toBe(false);
    await client.systemone(REQ);
    expect(client.breakerOpen()).toBe(false);
    await client.systemone(REQ);
    expect(client.breakerOpen()).toBe(true);
  });
});

describe("caller abort", () => {
  it("passes the caller's signal to the primary and to the secondary", async () => {
    const controller = new AbortController();
    const primary = new Backend("jev-latest", [httpError()]);
    const secondary = new Backend("open");

    await make(primary, secondary).systemone(REQ, { signal: controller.signal });

    expect(primary.calls[0]?.signal).toBe(controller.signal);
    expect(secondary.calls[0]?.signal).toBe(controller.signal);
  });

  it("propagates a caller abort instead of falling back", async () => {
    const controller = new AbortController();
    const aborted = new JevError("aborted by caller", "network");
    const primary: JevClientLike = {
      async systemone() {
        controller.abort();
        throw aborted;
      },
    };
    const secondary = new Backend("open");
    const seen: FallbackInfo[] = [];

    await expect(
      make(primary, secondary, { onFallback: (i) => seen.push(i) }).systemone(REQ, {
        signal: controller.signal,
      }),
    ).rejects.toBe(aborted);

    expect(secondary.callCount).toBe(0);
    expect(seen).toEqual([]);
  });

  it("a caller abort does not count toward the breaker", async () => {
    const controller = new AbortController();
    const primary: JevClientLike = {
      async systemone() {
        controller.abort();
        throw new JevError("aborted by caller", "network");
      },
    };
    const client = make(primary, new Backend("open"), { failures: 1 });

    await expect(client.systemone(REQ, { signal: controller.signal })).rejects.toThrow();

    expect(client.breakerOpen()).toBe(false);
  });
});
