import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { AUDIT_JUDGE_MODEL, DEFAULT_GATEWAY, DEFAULT_JUDGE_AUDIT_FRACTION, DEFAULT_JUDGE_MODEL, DEFAULT_OPENROUTER, main, parseArgs } from "./cli.js";
import { DEFAULT_PROVIDER_PINS } from "./providers.js";

describe("parseArgs", () => {
  it("has sensible defaults", () => {
    const o = parseArgs([]);
    expect(o.gateway).toBe(DEFAULT_GATEWAY);
    expect(o.openrouter).toBe(DEFAULT_OPENROUTER);
    expect(o.posture).toBe("balanced");
    expect(o.arms).toEqual(["milo", "fast", "mid", "frontier"]);
    expect(o.judge).toBe(true);
    expect(o.judgeModel).toBe(DEFAULT_JUDGE_MODEL);
    expect(DEFAULT_JUDGE_MODEL).toBe("openai/gpt-5.6-luna");
    expect(AUDIT_JUDGE_MODEL).toBe("anthropic/claude-sonnet-5");
    expect(o.judgeAudit).toBe(DEFAULT_JUDGE_AUDIT_FRACTION);
    expect(DEFAULT_JUDGE_AUDIT_FRACTION).toBe(0.1);
    expect(o.judgeCache).toBe(true);
    expect(o.concurrency).toBe(3);
    expect(o.pins).toBe(DEFAULT_PROVIDER_PINS);
    expect(o.out.endsWith("reports/bench-latest.md")).toBe(true);
  });

  it("--no-pins clears the per-model provider pins", () => {
    expect(parseArgs(["--no-pins"]).pins).toEqual({});
  });

  it("--sample-timeout sets the per-sample cap", () => {
    expect(parseArgs(["--sample-timeout", "60000"]).sampleTimeoutMs).toBe(60000);
  });

  it("--judge-audit takes a fraction, 0 disabling the audit", () => {
    expect(parseArgs(["--judge-audit", "0.25"]).judgeAudit).toBe(0.25);
    expect(parseArgs(["--judge-audit", "0"]).judgeAudit).toBe(0);
    expect(() => parseArgs(["--judge-audit", "1.5"])).toThrow(/--judge-audit/);
    expect(() => parseArgs(["--judge-audit", "lots"])).toThrow(/--judge-audit/);
  });

  it("--no-judge-cache bypasses the verdict cache", () => {
    expect(parseArgs([]).judgeCache).toBe(true);
    expect(parseArgs(["--no-judge-cache"]).judgeCache).toBe(false);
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

  it("--data selects another labeled set", () => {
    expect(parseArgs([]).data.endsWith("data/routing.jsonl")).toBe(true);
    expect(parseArgs(["--data", "packages/evals/data/longhorizon.jsonl"]).data.endsWith("longhorizon.jsonl")).toBe(true);
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

describe("deepseek and custom arms", () => {
  it("accepts deepseek and custom:<model> in --arms", () => {
    expect(parseArgs(["--arms", "deepseek,mid,custom:anthropic/claude-fable-5.1"]).arms).toEqual([
      "deepseek",
      "mid",
      "custom:anthropic/claude-fable-5.1",
    ]);
  });

  it("keeps deepseek out of the default arms", () => {
    expect(parseArgs([]).arms).not.toContain("deepseek");
  });

  it("rejects a bare custom: and unknown names", () => {
    expect(() => parseArgs(["--arms", "custom:"])).toThrow(/--arms/);
    expect(() => parseArgs(["--arms", "deepsek"])).toThrow(/--arms/);
  });
});
