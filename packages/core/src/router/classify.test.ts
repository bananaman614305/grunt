import { describe, expect, it } from "vitest";
import { classifyFailure } from "./router.js";

describe("classifyFailure honours the Jev client's own kind", () => {
  it.each([
    ["timeout", { name: "JevError", kind: "timeout" }],
    ["network", { name: "JevError", kind: "network" }],
    ["http", { name: "JevError", kind: "http", status: 401 }],
    ["validation", { name: "JevError", kind: "validation" }],
  ])("maps kind %s", (expected, err) => {
    expect(classifyFailure(err)).toBe(expected);
  });

  it("still falls back to name and status when kind is absent", () => {
    expect(classifyFailure({ name: "TimeoutError" })).toBe("timeout");
    expect(classifyFailure({ name: "Whatever", status: 503 })).toBe("http");
    expect(classifyFailure(new Error("boom"))).toBe("network");
  });
});
