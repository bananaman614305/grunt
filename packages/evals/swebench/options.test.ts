import { describe, expect, it } from "vitest";
import { DEFAULT_GATEWAY, DEFAULT_MODEL_NAME, parseSwebenchArgs } from "./options.js";

const OUT = "/reports";

describe("parseSwebenchArgs", () => {
  it("requires --dataset", () => {
    expect(() => parseSwebenchArgs([], OUT)).toThrow(/--dataset/);
  });

  it("defaults everything else once a dataset is given", () => {
    const options = parseSwebenchArgs(["--dataset", "/data/v.jsonl"], OUT);
    expect(options).toEqual({
      dataset: "/data/v.jsonl",
      instances: "all",
      gateway: DEFAULT_GATEWAY,
      out: OUT,
      timeoutMs: 1_800_000,
      modelName: DEFAULT_MODEL_NAME,
      keep: false,
    });
  });

  it("parses every flag", () => {
    const options = parseSwebenchArgs(
      // prettier-ignore
      ["--dataset", "/data/v.jsonl", "--instances", "b-2,a-1", "--limit", "20", "--repo-cache", "/cache",
        "--gateway", "http://milo.test/v1", "--out", "/tmp/x", "--timeout", "300",
        "--model-name", "milo/auto", "--keep", "--pi-agent-dir", "/tmp/pi"],
      OUT,
    );
    expect(options).toEqual({
      dataset: "/data/v.jsonl",
      instances: ["b-2", "a-1"],
      limit: 20,
      repoCache: "/cache",
      gateway: "http://milo.test/v1",
      out: "/tmp/x",
      timeoutMs: 300_000,
      modelName: "milo/auto",
      keep: true,
      piAgentDir: "/tmp/pi",
    });
  });

  it("rejects unknown flags, missing values, and bad numbers", () => {
    expect(() => parseSwebenchArgs(["--dataset", "d", "--frobnicate"], OUT)).toThrow(/unknown flag/);
    expect(() => parseSwebenchArgs(["--dataset"], OUT)).toThrow(/needs a value/);
    expect(() => parseSwebenchArgs(["--dataset", "d", "--limit", "0"], OUT)).toThrow(/positive integer/);
    expect(() => parseSwebenchArgs(["--dataset", "d", "--timeout", "-5"], OUT)).toThrow(/positive/);
    expect(() => parseSwebenchArgs(["--dataset", "d", "--instances", ","], OUT)).toThrow(/empty list/);
  });
});
