import { describe, expect, it } from "vitest";
import { MIN_TIER_AGREEMENT, OPEN_BACKEND_TIER_AGREEMENT, parseArgs } from "./cli.js";

describe("pnpm eval argument parsing", () => {
  it("defaults the gate to the Jev target of 0.85", () => {
    expect(parseArgs([]).gate).toBe(MIN_TIER_AGREEMENT);
    expect(MIN_TIER_AGREEMENT).toBe(0.85);
  });

  it("takes a gate from --gate", () => {
    expect(parseArgs(["--gate", "0.8"]).gate).toBe(0.8);
    expect(parseArgs(["--gate", String(OPEN_BACKEND_TIER_AGREEMENT)]).gate).toBe(0.8);
    expect(parseArgs(["--gate", "0"]).gate).toBe(0);
    expect(parseArgs(["--gate", "1"]).gate).toBe(1);
  });

  it("rejects a gate that is not a probability", () => {
    for (const bad of ["1.5", "-0.1", "eighty percent", ""]) {
      expect(() => parseArgs(["--gate", bad])).toThrow(/--gate must be a number between 0 and 1/);
    }
    expect(() => parseArgs(["--gate"])).toThrow(/--gate requires a value/);
  });

  it("leaves the other options alone", () => {
    const options = parseArgs(["--mode", "fixtures", "--posture", "low", "--limit", "5", "--gate", "0.8"]);
    expect(options.mode).toBe("fixtures");
    expect(options.posture).toBe("low");
    expect(options.limit).toBe(5);
    expect(options.gate).toBe(0.8);
  });
});
