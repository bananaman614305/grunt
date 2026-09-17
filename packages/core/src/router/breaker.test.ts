import { beforeEach, describe, expect, it } from "vitest";
import {
  BREAKER_COOLDOWN_MS,
  BREAKER_FAILURE_THRESHOLD,
  CircuitBreaker,
  isTransportFailure,
} from "./breaker.js";

function fakeClock(): { now: () => number; advance: (ms: number) => void } {
  let t = 1_700_000_000_000;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

describe("isTransportFailure", () => {
  it("counts a failure to reach or hear back from Jev", () => {
    expect(isTransportFailure("network")).toBe(true);
    expect(isTransportFailure("timeout")).toBe(true);
    expect(isTransportFailure("http", 500)).toBe(true);
    expect(isTransportFailure("http", 503)).toBe(true);
    expect(isTransportFailure("http", 529)).toBe(true);
  });

  it("does not count Jev answering something Milo rejected", () => {
    // A bad question or a bad request is a bug, not an outage: tripping the
    // breaker on it would take routing down over one malformed prompt.
    expect(isTransportFailure("validation")).toBe(false);
    expect(isTransportFailure("http", 400)).toBe(false);
    expect(isTransportFailure("http", 401)).toBe(false);
    expect(isTransportFailure("http", 429)).toBe(false);
    expect(isTransportFailure("rate_limited")).toBe(false);
    expect(isTransportFailure("http")).toBe(false);
  });
});

describe("CircuitBreaker", () => {
  let clock: ReturnType<typeof fakeClock>;
  let breaker: CircuitBreaker;

  beforeEach(() => {
    clock = fakeClock();
    breaker = new CircuitBreaker({ clock: clock.now });
  });

  it("defaults to the documented threshold and cooldown, and starts closed", () => {
    expect(breaker.failureThreshold).toBe(BREAKER_FAILURE_THRESHOLD);
    expect(breaker.failureThreshold).toBe(3);
    expect(breaker.cooldownMs).toBe(BREAKER_COOLDOWN_MS);
    expect(breaker.cooldownMs).toBe(30_000);
    expect(breaker.state()).toEqual({ state: "closed", failures: 0 });
    expect(breaker.tryAcquire()).toEqual({ allowed: true });
  });

  it("stays closed for the first two consecutive transport failures", () => {
    breaker.recordFailure("network");
    expect(breaker.state()).toEqual({ state: "closed", failures: 1 });
    breaker.recordFailure("timeout");
    expect(breaker.state()).toEqual({ state: "closed", failures: 2 });
    expect(breaker.tryAcquire()).toEqual({ allowed: true });
  });

  it("opens on the third, and refuses with the remaining cooldown", () => {
    for (let i = 0; i < 3; i += 1) breaker.recordFailure("network");

    const state = breaker.state();
    expect(state.state).toBe("open");
    expect(state.openedAt).toBe(clock.now());
    expect(state.retryAfterMs).toBe(BREAKER_COOLDOWN_MS);

    expect(breaker.tryAcquire()).toEqual({ allowed: false, retryAfterMs: BREAKER_COOLDOWN_MS });

    clock.advance(10_000);
    expect(breaker.tryAcquire()).toEqual({ allowed: false, retryAfterMs: 20_000 });
    expect(breaker.state().retryAfterMs).toBe(20_000);
  });

  it("a success resets the run, so three failures spread around one success do not open it", () => {
    breaker.recordFailure("network");
    breaker.recordFailure("network");
    breaker.recordSuccess();
    expect(breaker.state()).toEqual({ state: "closed", failures: 0 });

    breaker.recordFailure("network");
    expect(breaker.state().state).toBe("closed");
  });

  it("never opens on failures Jev actually answered", () => {
    for (let i = 0; i < 10; i += 1) {
      breaker.recordFailure("validation");
      breaker.recordFailure("http", 400);
      breaker.recordFailure("rate_limited", 429);
    }
    expect(breaker.state()).toEqual({ state: "closed", failures: 0 });
    expect(breaker.tryAcquire()).toEqual({ allowed: true });
  });

  it("half-opens once the cooldown passes and lets exactly one probe through", () => {
    for (let i = 0; i < 3; i += 1) breaker.recordFailure("network");
    clock.advance(BREAKER_COOLDOWN_MS);

    expect(breaker.state().state).toBe("half_open");
    expect(breaker.state().retryAfterMs).toBe(0);

    expect(breaker.tryAcquire()).toEqual({ allowed: true });
    // The probe slot is taken; a concurrent caller still waits.
    expect(breaker.tryAcquire()).toEqual({ allowed: false, retryAfterMs: BREAKER_COOLDOWN_MS });
  });

  it("a successful probe closes it", () => {
    for (let i = 0; i < 3; i += 1) breaker.recordFailure("network");
    clock.advance(BREAKER_COOLDOWN_MS);

    expect(breaker.tryAcquire().allowed).toBe(true);
    breaker.recordSuccess();

    expect(breaker.state()).toEqual({ state: "closed", failures: 0 });
    expect(breaker.tryAcquire()).toEqual({ allowed: true });
  });

  it("a failed probe re-opens it for a full cooldown from now", () => {
    for (let i = 0; i < 3; i += 1) breaker.recordFailure("network");
    clock.advance(BREAKER_COOLDOWN_MS);

    expect(breaker.tryAcquire().allowed).toBe(true);
    breaker.recordFailure("timeout");

    const state = breaker.state();
    expect(state.state).toBe("open");
    expect(state.openedAt).toBe(clock.now());
    expect(state.retryAfterMs).toBe(BREAKER_COOLDOWN_MS);
  });

  it("a probe that reaches Jev closes it even though the answer was rejected", () => {
    // The breaker asks one question -- "is Jev reachable?" -- and a 400 or a
    // malformed answer is a yes.
    for (let i = 0; i < 3; i += 1) breaker.recordFailure("network");
    clock.advance(BREAKER_COOLDOWN_MS);

    expect(breaker.tryAcquire().allowed).toBe(true);
    breaker.recordFailure("validation");

    expect(breaker.state()).toEqual({ state: "closed", failures: 0 });
  });

  it("cycles open, half-open, open, half-open, closed", () => {
    for (let i = 0; i < 3; i += 1) breaker.recordFailure("http", 503);
    expect(breaker.state().state).toBe("open");

    clock.advance(BREAKER_COOLDOWN_MS);
    expect(breaker.state().state).toBe("half_open");
    expect(breaker.tryAcquire().allowed).toBe(true);
    breaker.recordFailure("http", 503);
    expect(breaker.state().state).toBe("open");

    clock.advance(BREAKER_COOLDOWN_MS - 1);
    expect(breaker.state().state).toBe("open");
    clock.advance(1);
    expect(breaker.state().state).toBe("half_open");

    expect(breaker.tryAcquire().allowed).toBe(true);
    breaker.recordSuccess();
    expect(breaker.state().state).toBe("closed");
  });

  it("honours an injected threshold and cooldown", () => {
    const quick = new CircuitBreaker({ clock: clock.now, failureThreshold: 1, cooldownMs: 5_000 });
    quick.recordFailure("network");
    expect(quick.tryAcquire()).toEqual({ allowed: false, retryAfterMs: 5_000 });
    clock.advance(5_000);
    expect(quick.tryAcquire()).toEqual({ allowed: true });
  });

  it("reset forgets everything", () => {
    for (let i = 0; i < 3; i += 1) breaker.recordFailure("network");
    expect(breaker.state().state).toBe("open");
    breaker.reset();
    expect(breaker.state()).toEqual({ state: "closed", failures: 0 });
  });
});
