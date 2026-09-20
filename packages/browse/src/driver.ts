/**
 * The pluggable driver (ADR-016): the MUSCLE half of Milo browse.
 *
 * Milo's contribution is the gate layer -- the cheap Jev senses in `gates.ts`.
 * The actual observing and clicking is delegated to a `Driver`, which is an
 * INTERFACE, not a browser Milo ships or forks. Three implementations can back
 * it behind the same four methods:
 *
 *   - `PlaywrightDriver` (the default, in `playwright-driver.ts`) -- a
 *     Playwright-over-CDP session Milo drives. Documented glue, never installed
 *     or run in tests.
 *   - a Squire-operate adapter -- Trusty Squire already exposes
 *     observe/act/verify MCP tools over a hosted browser; an adapter would map
 *     `readback`->operate_observe, `click`/`type`->operate_act, and let Squire
 *     handle credential sealing. Described in ADR-016, not implemented here.
 *   - a computer-use adapter -- a screenshot+mouse agent whose accessibility
 *     tree is reduced to the same content-free candidate list.
 *
 * All three satisfy this one interface. The loop and the gates never know which
 * is behind it. Tests inject `FakeDriver` and never touch a real browser.
 *
 * The interface's hard rule (ADR-016): the driver hands UP only a
 * `PageObservation` -- url, title, and a content-free `ElementCandidate` list.
 * It never surfaces raw DOM or a screenshot to the loop, so raw page content
 * cannot reach a Jev gate. The one place secret text flows is DOWN into
 * `type(ref, text)`; that text is written straight into the page and is never
 * echoed back, sent to a gate, or written to the trace.
 */

import type { PageObservation } from "./types.js";

/**
 * What Milo asks the muscle to do. Deliberately tiny: observe the page, and the
 * three primitive moves. Anything richer (drag, upload, wait-for) is a driver
 * concern layered on top, out of v0 scope.
 */
export interface Driver {
  /** Point the page at a url. */
  navigate(url: string): Promise<void>;
  /** Click the element the `ref` resolves to. */
  click(ref: string): Promise<void>;
  /**
   * Type `text` into the element the `ref` resolves to. `text` may be a
   * credential supplied by the caller; the driver writes it into the page and
   * MUST NOT return, log, or otherwise surface it.
   */
  type(ref: string, text: string): Promise<void>;
  /** Read the current page back as a content-free observation. */
  readback(): Promise<PageObservation>;
}

/** One action a `FakeDriver` recorded, for test assertions. Content-free. */
export type RecordedAction = {
  kind: "navigate" | "click" | "type";
  ref?: string;
  url?: string;
  /**
   * Whether a `type` carried non-empty text. The text itself is deliberately
   * NOT stored -- a `FakeDriver` proves by construction that the loop never
   * leaks a typed credential into a recordable place.
   */
  hasText?: boolean;
};

/** How a `FakeDriver` decides which screen an action lands on. */
export type FakeTransition = (index: number, action: RecordedAction) => number;

/**
 * A scriptable driver for tests: a fixed list of `screens` (content-free
 * observations) and a `transition` that says which screen an action moves to.
 * The default transition advances on `navigate`/`click` and holds on `type`,
 * clamped to the last screen, which is enough for a login->dashboard->result
 * walk. It records every action WITHOUT the typed text.
 *
 * This lives in source (not just a test file) so it is a reusable reference
 * driver: the CLI can dry-run a task against a scripted page with no browser.
 */
export class FakeDriver implements Driver {
  private index: number;
  readonly actions: RecordedAction[] = [];
  private readonly transition: FakeTransition;

  constructor(
    private readonly screens: PageObservation[],
    opts: { start?: number; transition?: FakeTransition } = {},
  ) {
    if (screens.length === 0) throw new Error("FakeDriver needs at least one screen");
    this.index = opts.start ?? 0;
    this.transition = opts.transition ?? defaultTransition;
  }

  private apply(action: RecordedAction): void {
    this.actions.push(action);
    const next = this.transition(this.index, action);
    this.index = Math.max(0, Math.min(this.screens.length - 1, next));
  }

  navigate(url: string): Promise<void> {
    this.apply({ kind: "navigate", url });
    return Promise.resolve();
  }

  click(ref: string): Promise<void> {
    this.apply({ kind: "click", ref });
    return Promise.resolve();
  }

  type(ref: string, text: string): Promise<void> {
    // The text is intentionally dropped: only that a type happened is recorded.
    this.apply({ kind: "type", ref, hasText: text.length > 0 });
    return Promise.resolve();
  }

  readback(): Promise<PageObservation> {
    const screen = this.screens[this.index];
    if (screen === undefined) throw new Error("FakeDriver index out of range");
    return Promise.resolve(screen);
  }
}

/** Advance one screen on a move, hold on a type; clamp handled by the caller. */
function defaultTransition(index: number, action: RecordedAction): number {
  return action.kind === "type" ? index : index + 1;
}
