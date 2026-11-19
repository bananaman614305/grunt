// Opens site/index.html in headless Chrome at phone and desktop sizes and
// checks that every screen of the landing page fits inside the viewport.
// Talks to Chrome over the DevTools protocol with Node's built-in WebSocket,
// so it needs no extra packages. Skips when no Chrome binary is found.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const CHROME = [process.env.CHROME_PATH, "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"]
  .find((p): p is string => !!p && existsSync(p));
const PAGE = new URL("../site/index.html", import.meta.url).href;

const SIZES = [
  { width: 360, height: 740, mobile: true },
  { width: 390, height: 844, mobile: true },
  { width: 412, height: 915, mobile: true },
  { width: 1280, height: 720, mobile: false },
  { width: 1920, height: 1080, mobile: false },
];

type Screen = { name: string; top: number; height: number };
type Measure = { viewport: number; scrollWidth: number; innerWidth: number; screens: Screen[]; stageEscapes: string[] };

// Runs in the page. Each "screen" is one top-level section; the nav belongs to
// the hero screen and the footer to the last screen.
const MEASURE = `(() => {
  const r = (sel) => document.querySelector(sel).getBoundingClientRect();
  const span = (a, b) => ({ top: r(a).top, bottom: r(b).bottom });
  const parts = [
    ["hero", span("nav", ".hero")],
    ["problem", span("#problem", "#problem")],
    ["sources", span("#sources", "#sources")],
    ["cta", span(".cta-end", "footer")],
  ];
  const stage = r(".stage");
  const stageEscapes = [".pileL", ".walker", ".pileR"].filter((sel) => {
    const b = r(sel);
    return b.left < stage.left - 0.5 || b.right > stage.right + 0.5 || b.top < stage.top - 0.5;
  });
  return JSON.stringify({
    viewport: innerHeight,
    innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    screens: parts.map(([name, s]) => ({ name, top: s.top + scrollY, height: Math.round((s.bottom - s.top) * 10) / 10 })),
    stageEscapes,
  });
})()`;

class Cdp {
  private id = 0;
  private waiting = new Map<number, (msg: { result?: unknown; error?: { message: string } }) => void>();
  private events: { method: string; resolve: () => void }[] = [];
  constructor(private ws: WebSocket) {
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id && this.waiting.has(msg.id)) {
        this.waiting.get(msg.id)!(msg);
        this.waiting.delete(msg.id);
      } else if (msg.method) {
        this.events = this.events.filter((e) => (e.method === msg.method ? (e.resolve(), false) : true));
      }
    });
  }
  send<T = Record<string, unknown>>(method: string, params: object = {}, sessionId?: string): Promise<T> {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolve, reject) =>
      this.waiting.set(id, (msg) => (msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result as T))),
    );
  }
  once(method: string): Promise<void> {
    return new Promise((resolve) => this.events.push({ method, resolve }));
  }
}

let chrome: ChildProcess | undefined;
let profile = "";
let cdp: Cdp;
let session = "";

async function open(): Promise<void> {
  profile = mkdtempSync(join(tmpdir(), "site-fit-"));
  chrome = spawn(CHROME!, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--hide-scrollbars",
    `--user-data-dir=${profile}`, "--remote-debugging-port=0", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  const url = await new Promise<string>((resolve, reject) => {
    let err = "";
    chrome!.stderr!.on("data", (d) => {
      err += d;
      const m = err.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) resolve(m[1]);
    });
    chrome!.on("exit", () => reject(new Error(`Chrome exited: ${err}`)));
  });
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  cdp = new Cdp(ws);
  const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
  ({ sessionId: session } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true }));
  await cdp.send("Page.enable", {}, session);
  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] }, session);
}

async function measure(size: (typeof SIZES)[number]): Promise<Measure> {
  await cdp.send("Emulation.setDeviceMetricsOverride", { ...size, deviceScaleFactor: 1 }, session);
  const loaded = cdp.once("Page.loadEventFired");
  await cdp.send("Page.navigate", { url: PAGE }, session);
  await loaded;
  const { result } = await cdp.send<{ result: { value: string } }>("Runtime.evaluate", { expression: MEASURE, returnByValue: true }, session);
  const m = JSON.parse(result.value) as Measure;
  // SITE_FIT_SHOTS=<dir> saves one screenshot per screen, as a visitor sees it.
  const dir = process.env.SITE_FIT_SHOTS;
  if (dir) {
    for (const s of m.screens) {
      const clip = { x: 0, y: s.top, width: size.width, height: size.height, scale: 1 };
      const { data } = await cdp.send<{ data: string }>("Page.captureScreenshot", { clip, captureBeyondViewport: true }, session);
      writeFileSync(join(dir, `${size.width}x${size.height}-${s.name}.png`), Buffer.from(data, "base64"));
    }
  }
  return m;
}

describe.skipIf(!CHROME)("grunt.run fits one screen per section", () => {
  beforeAll(open, 30_000);
  afterAll(async () => {
    if (chrome && chrome.exitCode === null) {
      const exited = new Promise((resolve) => chrome!.once("exit", resolve));
      chrome.kill();
      await exited;
    }
    if (profile) rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
  });

  for (const size of SIZES) {
    it(`${size.width}x${size.height}`, async () => {
      const m = await measure(size);
      if (process.env.SITE_FIT_DEBUG) console.log(size.width, size.height, JSON.stringify(m));
      expect(m.viewport).toBe(size.height);
      expect(m.scrollWidth, "page scrolls sideways").toBeLessThanOrEqual(m.innerWidth);
      expect(m.stageEscapes, "miner scene parts cut off").toEqual([]);
      for (const s of m.screens) expect(s.height, `${s.name} is taller than the screen`).toBeLessThanOrEqual(size.height);
    }, 30_000);
  }
});
