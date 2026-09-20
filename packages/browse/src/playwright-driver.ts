/**
 * The real driver stub (ADR-016): a Playwright-over-CDP `Driver`.
 *
 * Nothing here is exercised by `pnpm test` -- the loop and gates are tested
 * against `FakeDriver` -- because this drives a real browser. It is the
 * documented default glue, kept out of the test path exactly like the fleet's
 * `node-runtime.ts`. Milo does NOT ship or fork a browser: this connects to a
 * Playwright session the operator already runs (over the Chrome DevTools
 * Protocol), and Playwright is an OPTIONAL peer the caller installs. The import
 * is intentionally dynamic so `@milo/browse` never hard-depends on Playwright.
 *
 * The one job that matters for Milo's guarantees is `readback`: it must reduce
 * the live DOM to a compact, content-free `ElementCandidate` list -- the
 * accessibility role, a short accessible name, an optional test id, and the
 * bounding box -- and NOTHING ELSE. It must never hand the loop raw innerHTML or
 * a screenshot, because whatever `readback` returns is what a Jev gate may see.
 * The sketch below reads the accessibility tree, which is already the
 * content-free projection Milo wants.
 *
 * A Squire-operate adapter or a computer-use adapter would implement the same
 * `Driver` interface (see `driver.ts`); this file is only the Playwright one.
 */

import type { Driver } from "./driver.js";
import type { ElementCandidate, PageObservation } from "./types.js";

/**
 * The slice of a Playwright `Page` this driver uses. Declared structurally so
 * this file needs no `@types/playwright` at build time; the real object is
 * passed in by the caller who owns the browser session.
 */
export interface PlaywrightPageLike {
  url(): string;
  title(): Promise<string>;
  goto(url: string): Promise<unknown>;
  /** Resolve a Milo ref (a testid or a stable selector) and act on it. */
  click(selector: string): Promise<void>;
  fill(selector: string, value: string): Promise<void>;
  /** The accessibility snapshot -- already a content-free projection of the DOM. */
  accessibility: { snapshot(): Promise<AxNode | null> };
}

/** A node of Playwright's accessibility snapshot (the fields this driver reads). */
export type AxNode = {
  role: string;
  name?: string;
  /** Milo's convention: a driver may stamp a stable ref/testid onto the node. */
  ref?: string;
  testid?: string;
  bbox?: { x: number; y: number; width: number; height: number };
  children?: AxNode[];
};

/** Roles worth offering the loop as candidates. Interactive elements only. */
const ACTIONABLE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "combobox",
  "checkbox",
  "radio",
  "menuitem",
  "tab",
  "switch",
  "option",
]);

/**
 * Flatten an accessibility snapshot into the content-free candidate list. This
 * is the whole privacy contract of the real driver: only role, short name, an
 * optional ref/testid, and a box ever leave this function.
 */
export function candidatesFromSnapshot(root: AxNode | null): ElementCandidate[] {
  const out: ElementCandidate[] = [];
  let auto = 0;
  const walk = (node: AxNode): void => {
    if (ACTIONABLE_ROLES.has(node.role)) {
      const ref = node.ref ?? node.testid ?? `ax-${String(auto++)}`;
      const candidate: ElementCandidate = { ref, role: node.role };
      if (node.name !== undefined && node.name !== "") candidate.text = node.name;
      if (node.testid !== undefined) candidate.testid = node.testid;
      if (node.bbox !== undefined) candidate.bbox = node.bbox;
      out.push(candidate);
    }
    for (const child of node.children ?? []) walk(child);
  };
  if (root !== null) walk(root);
  return out;
}

/**
 * Wrap a live Playwright page as a Milo `Driver`. Untested glue: it is a thin
 * translation from the four Milo primitives to Playwright calls. `ref` is a
 * selector the caller's page understands (a `data-testid`, say); mapping a
 * Milo ref back to a Playwright locator is the caller's convention.
 */
export function playwrightDriver(
  page: PlaywrightPageLike,
  toSelector: (ref: string) => string = (ref) => `[data-testid="${ref}"]`,
): Driver {
  return {
    async navigate(url) {
      await page.goto(url);
    },
    async click(ref) {
      await page.click(toSelector(ref));
    },
    async type(ref, text) {
      // Written straight into the field; never returned or logged by this driver.
      await page.fill(toSelector(ref), text);
    },
    async readback(): Promise<PageObservation> {
      const snapshot = await page.accessibility.snapshot();
      return {
        url: page.url(),
        title: await page.title(),
        elements: candidatesFromSnapshot(snapshot),
      };
    },
  };
}
