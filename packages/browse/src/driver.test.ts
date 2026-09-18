import { describe, expect, it } from "vitest";
import { FakeDriver } from "./driver.js";
import { candidatesFromSnapshot, type AxNode } from "./playwright-driver.js";
import type { PageObservation } from "./types.js";

const SCREENS: PageObservation[] = [
  { url: "https://x/login", title: "Sign in", elements: [{ ref: "e3", role: "button", text: "Sign in" }] },
  { url: "https://x/home", title: "Dashboard", elements: [{ ref: "d1", role: "button", text: "Export" }] },
  { url: "https://x/done", title: "Exported", elements: [] },
];

describe("FakeDriver", () => {
  it("reads back the current screen and advances on a click", async () => {
    const d = new FakeDriver(SCREENS);
    expect((await d.readback()).title).toBe("Sign in");
    await d.click("e3");
    expect((await d.readback()).title).toBe("Dashboard");
    await d.click("d1");
    expect((await d.readback()).title).toBe("Exported");
  });

  it("clamps at the last screen", async () => {
    const d = new FakeDriver(SCREENS);
    await d.click("a");
    await d.click("b");
    await d.click("c");
    await d.click("d");
    expect((await d.readback()).title).toBe("Exported");
  });

  it("records a type WITHOUT storing the typed text", async () => {
    const d = new FakeDriver(SCREENS);
    await d.type("e2", "hunter2-super-secret");
    const typed = d.actions.find((a) => a.kind === "type");
    expect(typed).toEqual({ kind: "type", ref: "e2", hasText: true });
    expect(JSON.stringify(d.actions)).not.toContain("hunter2");
  });

  it("holds position on a type", async () => {
    const d = new FakeDriver(SCREENS);
    await d.type("e2", "x");
    expect((await d.readback()).title).toBe("Sign in");
  });

  it("honours a custom transition", async () => {
    const d = new FakeDriver(SCREENS, { start: 2, transition: () => 0 });
    await d.click("z");
    expect((await d.readback()).title).toBe("Sign in");
  });

  it("throws on an empty screen list", () => {
    expect(() => new FakeDriver([])).toThrow(/at least one screen/);
  });
});

describe("candidatesFromSnapshot (Playwright reduction)", () => {
  it("keeps only actionable roles and content-free fields", () => {
    const snapshot: AxNode = {
      role: "WebArea",
      name: "Sign in",
      children: [
        { role: "textbox", name: "Password", testid: "password" },
        { role: "button", name: "Sign in", ref: "e3" },
        { role: "paragraph", name: "Some long paragraph of page prose that must never become a candidate" },
      ],
    };
    const candidates = candidatesFromSnapshot(snapshot);
    expect(candidates).toEqual([
      { ref: "password", role: "textbox", text: "Password", testid: "password" },
      { ref: "e3", role: "button", text: "Sign in" },
    ]);
  });
});
