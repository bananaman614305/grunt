/**
 * A lightweight, injectable periodic health check.
 *
 * It is generic over what it checks and what it reports to.
 * `JevTransportFallbackClient`'s breaker (`./fallback.ts`) needs no proactive
 * probe of its own for the openrouter transport: the half-open state already
 * lets exactly one real request through as a lazy, zero-extra-cost probe
 * once the cooldown has passed, and Milo holds no standing key it could use
 * to probe the openrouter transport on its own between requests -- every
 * call on that transport is billed to a caller's forwarded key, and probing
 * with no caller present would mean holding one, which is exactly what
 * ADR-022 rules out.
 *
 * Where this earns its keep is checking a backend Milo DOES hold a standing
 * key for, such as the opt-in TypeSafe fallback: a deployment that enables
 * `jevFallbackToTypesafe` can start one of these pinging the fallback client
 * with a cheap call, purely for a logged availability signal, so an operator
 * knows the safety net actually works before the breaker ever needs it. Not
 * started automatically by `createGateway` (a periodic Jev call is real,
 * recurring spend on the operator's own key); a deployment wires it up
 * explicitly when it wants that signal.
 */

export type HealthProbeResult = { ok: true } | { ok: false; error: unknown };

export type HealthProbeOptions = {
  /** The cheap check to run. Resolves = healthy, rejects = unhealthy. */
  check: () => Promise<unknown>;
  /** How often to run it, in ms. Default 60,000. */
  intervalMs?: number;
  /** Called after every run (periodic or manual) with the outcome. */
  onResult?: (result: HealthProbeResult) => void;
  /** Injectable timer, for tests. Defaults to the global `setInterval`. */
  setIntervalFn?: (handler: () => void, ms: number) => unknown;
  /** Injectable timer, for tests. Defaults to the global `clearInterval`. */
  clearIntervalFn?: (handle: unknown) => void;
};

export class HealthProbe {
  private readonly check: () => Promise<unknown>;
  private readonly intervalMs: number;
  private readonly onResult: ((result: HealthProbeResult) => void) | undefined;
  private readonly setIntervalFn: (handler: () => void, ms: number) => unknown;
  private readonly clearIntervalFn: (handle: unknown) => void;
  private handle: unknown;
  /** Guards against an overlapping run if a check is slower than the interval. */
  private running = false;

  constructor(opts: HealthProbeOptions) {
    this.check = opts.check;
    this.intervalMs = opts.intervalMs ?? 60_000;
    this.onResult = opts.onResult;
    this.setIntervalFn = opts.setIntervalFn ?? ((handler, ms) => setInterval(handler, ms));
    this.clearIntervalFn = opts.clearIntervalFn ?? ((handle) => clearInterval(handle as NodeJS.Timeout));
  }

  /** Whether the periodic timer is currently running. */
  get started(): boolean {
    return this.handle !== undefined;
  }

  /** Starts the periodic timer. No-op if already started. */
  start(): void {
    if (this.handle !== undefined) return;
    this.handle = this.setIntervalFn(() => {
      void this.tick();
    }, this.intervalMs);
    // A background probe must never be the reason a process cannot exit.
    const unreffable = this.handle as { unref?: () => void } | undefined;
    unreffable?.unref?.();
  }

  /** Stops the periodic timer. No-op if not started. */
  stop(): void {
    if (this.handle === undefined) return;
    this.clearIntervalFn(this.handle);
    this.handle = undefined;
  }

  /**
   * Runs one check immediately, outside the timer -- for a lazy check on
   * demand. Safe to call whether or not the periodic timer is running. A
   * call that arrives while a run is already in flight is a no-op, so a slow
   * check can never pile up concurrent probes.
   */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.check();
      this.onResult?.({ ok: true });
    } catch (error) {
      this.onResult?.({ ok: false, error });
    } finally {
      this.running = false;
    }
  }
}
