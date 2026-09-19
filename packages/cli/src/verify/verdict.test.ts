import { describe, expect, it } from "vitest";
import { decideAction, MAX_SESSION_BLOCKS } from "./verdict.js";
import type { VerifyFinding } from "./verdict.js";

const contradicted: VerifyFinding = { finding: "contradicted", blocking: true, line: "1 claim contradicted." };
const unsupported: VerifyFinding = { finding: "unsupported", blocking: false, line: "1 claim unsupported." };
const clean: VerifyFinding = { finding: "clean", blocking: false, line: "all clear" };

describe("decideAction", () => {
  it("says nothing on a clean finding", () => {
    expect(decideAction(clean, { blockEnabled: true, sessionBlocks: 0 }).level).toBe("none");
  });

  it("says nothing when verification was unavailable (fail-open)", () => {
    const finding: VerifyFinding = { finding: "contradicted", blocking: true, line: "x", unavailable: true };
    expect(decideAction(finding, { blockEnabled: true, sessionBlocks: 0 }).level).toBe("none");
  });

  it("warns, never blocks, by default", () => {
    const action = decideAction(contradicted, { blockEnabled: false, sessionBlocks: 0 });
    expect(action.level).toBe("warn");
    expect(action.block).toBe(false);
    expect(action.message).toContain("contradicted");
  });

  it("warns on an unsupported finding even with block enabled (not a confident positive)", () => {
    const action = decideAction(unsupported, { blockEnabled: true, sessionBlocks: 0 });
    expect(action.level).toBe("warn");
    expect(action.block).toBe(false);
  });

  it("blocks on a confident contradiction only when opted in", () => {
    const action = decideAction(contradicted, { blockEnabled: true, sessionBlocks: 0 });
    expect(action.level).toBe("block");
    expect(action.block).toBe(true);
    expect(action.consumedBlock).toBe(true);
  });

  it("stops blocking after the per-session cap and warns instead", () => {
    expect(decideAction(contradicted, { blockEnabled: true, sessionBlocks: MAX_SESSION_BLOCKS }).level).toBe("warn");
    expect(decideAction(contradicted, { blockEnabled: true, sessionBlocks: 1 }).level).toBe("block");
    expect(decideAction(contradicted, { blockEnabled: true, sessionBlocks: 5, maxBlocks: 3 }).block).toBe(false);
  });
});
