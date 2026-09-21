import { describe, expect, it, vi } from "vitest";
import { HealthProbe } from "./health-probe.js";

function fakeTimer(): {
  setIntervalFn: (handler: () => void, ms: number) => unknown;
  clearIntervalFn: (handle: unknown) => void;
  fire: () => void;
  handles: unknown[];
} {
  let handler: (() => void) | undefined;
  let cleared = false;
  const handles: unknown[] = [];
  return {
    setIntervalFn: (h, _ms) => {
      handler = h;
      const handle = { id: "fake-timer" };
      handles.push(handle);
      return handle;
    },
    clearIntervalFn: () => {
      cleared = true;
      handler = undefined;
    },
    fire: () => {
      if (!cleared) handler?.();
    },
    handles,
  };
}

describe("HealthProbe", () => {
  it("does not start a timer until start() is called", () => {
    const timer = fakeTimer();
    const check = vi.fn().mockResolvedValue(undefined);
    const probe = new HealthProbe({ check, setIntervalFn: timer.setIntervalFn, clearIntervalFn: timer.clearIntervalFn });

    expect(probe.started).toBe(false);
    expect(timer.handles).toHaveLength(0);
  });

  it("runs the check on each timer tick and reports success", async () => {
    const timer = fakeTimer();
    const check = vi.fn().mockResolvedValue("ok");
    const onResult = vi.fn();
    const probe = new HealthProbe({
      check,
      onResult,
      setIntervalFn: timer.setIntervalFn,
      clearIntervalFn: timer.clearIntervalFn,
    });

    probe.start();
    expect(probe.started).toBe(true);
    timer.fire();
    await flush();

    expect(check).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith({ ok: true });
  });

  it("reports failure without throwing when the check rejects", async () => {
    const timer = fakeTimer();
    const err = new Error("unreachable");
    const check = vi.fn().mockRejectedValue(err);
    const onResult = vi.fn();
    const probe = new HealthProbe({
      check,
      onResult,
      setIntervalFn: timer.setIntervalFn,
      clearIntervalFn: timer.clearIntervalFn,
    });

    probe.start();
    timer.fire();
    await flush();

    expect(onResult).toHaveBeenCalledWith({ ok: false, error: err });
  });

  it("stop() clears the timer and start() can be called again", () => {
    const timer = fakeTimer();
    const check = vi.fn().mockResolvedValue(undefined);
    const probe = new HealthProbe({ check, setIntervalFn: timer.setIntervalFn, clearIntervalFn: timer.clearIntervalFn });

    probe.start();
    probe.stop();
    expect(probe.started).toBe(false);
    probe.start();
    expect(probe.started).toBe(true);
  });

  it("start() twice in a row only registers one timer", () => {
    const timer = fakeTimer();
    const check = vi.fn().mockResolvedValue(undefined);
    const probe = new HealthProbe({ check, setIntervalFn: timer.setIntervalFn, clearIntervalFn: timer.clearIntervalFn });

    probe.start();
    probe.start();
    expect(timer.handles).toHaveLength(1);
  });

  it("tick() runs a lazy, on-demand check even without the timer started", async () => {
    const check = vi.fn().mockResolvedValue(undefined);
    const onResult = vi.fn();
    const probe = new HealthProbe({ check, onResult });

    await probe.tick();
    expect(check).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith({ ok: true });
  });

  it("never overlaps two concurrent runs", async () => {
    let resolve!: () => void;
    const gate = new Promise<void>((r) => (resolve = r));
    const check = vi.fn().mockImplementation(() => gate);
    const probe = new HealthProbe({ check });

    const first = probe.tick();
    const second = probe.tick(); // arrives while the first is still in flight
    resolve();
    await Promise.all([first, second]);

    expect(check).toHaveBeenCalledTimes(1);
  });
});

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
