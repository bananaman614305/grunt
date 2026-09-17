import { describe, expect, it } from "vitest";
import { classifyFailure } from "./router.js";

describe("classifyFailure honours the Jev client's own kind", () => {
  it.each([
    ["timeout", { name: "JevError", kind: "timeout" }],
    ["network", { name: "JevError", kind: "network" }],
    ["http", { name: "JevError", kind: "http", status: 401 }],
    ["validation", { name: "JevError", kind: "validation" }],
  ])("maps kind %s", (expected, err) => {
    expect(classifyFailure(err).cause).toBe(expected);
  });

  it("still falls back to name and status when kind is absent", () => {
    expect(classifyFailure({ name: "TimeoutError" }).cause).toBe("timeout");
    expect(classifyFailure({ name: "Whatever", status: 503 }).cause).toBe("http");
    expect(classifyFailure(new Error("boom")).cause).toBe("network");
  });

  it("reads a rate limit out of a 429, whichever way it is shaped", () => {
    expect(classifyFailure({ name: "JevError", kind: "http", status: 429 }).cause).toBe("rate_limited");
    expect(classifyFailure({ name: "Whatever", status: 429 }).cause).toBe("rate_limited");
  });
});
