import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_GATEWAY, DEFAULT_JUDGE_MODEL, DEFAULT_OPENROUTER, main, parseArgs } from "./cli.js";

describe("parseArgs", () => {
  it("has sensible defaults", () => {
    const o = parseArgs([]);
    expect(o.gateway).toBe(DEFAULT_GATEWAY);
    expect(o.openrouter).toBe(DEFAULT_OPENROUTER);
    expect(o.posture).toBe("balanced");
    expect(o.arms).toEqual(["milo", "fast", "mid", "frontier"]);
    expect(o.judge).toBe(true);
    expect(o.judgeModel).toBe(DEFAULT_JUDGE_MODEL);
    expect(o.concurrency).toBe(3);
    expect(o.out.endsWith("reports/bench-latest.md")).toBe(true);
  });

  it("parses every flag and strips trailing slashes off base urls", () => {
    const o = parseArgs([
      "--gateway", "https://gw/v1/",
      "--openrouter", "https://proxy/api/v1/",
      "--posture", "low",
      "--arms", "milo, fast",
      "--no-judge",
      "--judge-model", "j/m",
      "--limit", "5",
      "--ids", "r-001,r-002",
      "--concurrency", "2",
      "--timeout", "1000",
      "--salt", "x",
      "--graders", "custom.jsonl",
      "--out", "o.md",
      "--json", "o.json",
    ]);
    expect(o).toMatchObject({
      gateway: "https://gw/v1",
      openrouter: "https://proxy/api/v1",
      posture: "low",
      arms: ["milo", "fast"],
      judge: false,
      judgeModel: "j/m",
      limit: 5,
      ids: ["r-001", "r-002"],
      concurrency: 2,
      timeoutMs: 1000,
      salt: "x",
      graders: resolve(process.cwd(), "custom.jsonl"),
      out: resolve(process.cwd(), "o.md"),
      json: resolve(process.cwd(), "o.json"),
    });
  });

  it("rejects bad values", () => {
    expect(() => parseArgs(["--posture", "cheap"])).toThrow(/--posture/);
    expect(() => parseArgs(["--arms", "milo,slow"])).toThrow(/--arms/);
    expect(() => parseArgs(["--limit", "0"])).toThrow(/--limit/);
    expect(() => parseArgs(["--bogus"])).toThrow(/unknown argument/);
    expect(() => parseArgs(["--out"])).toThrow(/requires a value/);
  });
});

describe("main", () => {
  it("refuses to run without OPENROUTER_API_KEY and never reads it from anywhere else", async () => {
    await expect(main([], {})).rejects.toThrow(/OPENROUTER_API_KEY/);
  });
});
