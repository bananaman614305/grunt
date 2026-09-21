import { describe, expect, it } from "vitest";
import { checkCandidate, expectsJsonResponse } from "./candidate-check.js";

const fence = "```";

describe("checkCandidate", () => {
  it("passes a plain, complete answer", () => {
    const r = checkCandidate({ text: "The capital of France is Paris.", finishReason: "stop" });
    expect(r.ok).toBe(true);
    expect(r.flaws).toEqual([]);
  });

  it("does not police stray brackets in prose", () => {
    // Prose routinely has unbalanced parens (smileys, asides); never a defect.
    const r = checkCandidate({ text: "Use foo( to open, and note :) is common. See item [3.", finishReason: "stop" });
    expect(r.ok).toBe(true);
  });

  it("flags a length-truncated response", () => {
    const r = checkCandidate({ text: "Here is the answer and it keeps going", finishReason: "length" });
    expect(r.flaws).toContain("truncated_length");
    expect(r.ok).toBe(false);
  });

  it("flags an unterminated code fence", () => {
    const text = `Here is code:\n${fence}js\nconst x = 1;\n`; // opened, never closed
    const r = checkCandidate({ text, finishReason: "stop" });
    expect(r.flaws).toContain("unterminated_code_fence");
  });

  it("passes a balanced, closed code block", () => {
    const text = `${fence}js\nfunction f(a) { return [a]; }\n${fence}`;
    const r = checkCandidate({ text, finishReason: "stop" });
    expect(r.ok).toBe(true);
  });

  it("flags unbalanced delimiters inside a closed code block", () => {
    const text = `${fence}js\nfunction f(a) { return [a; }\n${fence}`; // missing ]
    const r = checkCandidate({ text, finishReason: "stop" });
    expect(r.flaws).toContain("unbalanced_delimiters");
  });

  it("ignores brackets inside string literals in code", () => {
    const text = `${fence}js\nconst s = "a ) not real ]";\nconst t = [1, 2];\n${fence}`;
    const r = checkCandidate({ text, finishReason: "stop" });
    expect(r.ok).toBe(true);
  });

  it("flags an answer that ends on a dangling escape", () => {
    const r = checkCandidate({ text: "path is C:\\\\Users\\", finishReason: "stop" });
    expect(r.flaws).toContain("truncated_token");
  });

  it("flags invalid JSON in a fenced json block", () => {
    const text = `${fence}json\n{ "a": 1, "b": }\n${fence}`;
    const r = checkCandidate({ text, finishReason: "stop" });
    expect(r.flaws).toContain("invalid_json");
  });

  it("passes valid JSON in a fenced json block", () => {
    const text = `${fence}json\n{ "a": 1, "b": [2, 3] }\n${fence}`;
    const r = checkCandidate({ text, finishReason: "stop" });
    expect(r.ok).toBe(true);
  });

  it("flags invalid raw JSON when the request expected JSON", () => {
    const r = checkCandidate({ text: '{ "a": 1, ', finishReason: "stop", expectJson: true });
    expect(r.flaws).toContain("invalid_json");
  });

  it("passes valid raw JSON when the request expected JSON", () => {
    const r = checkCandidate({ text: '{ "a": 1, "b": 2 }', finishReason: "stop", expectJson: true });
    expect(r.ok).toBe(true);
  });

  it("does not demand JSON when the request did not ask and there is no json fence", () => {
    const r = checkCandidate({ text: "just some prose, not json", finishReason: "stop" });
    expect(r.ok).toBe(true);
  });

  it("passes a well-formed unified diff", () => {
    const text = ["@@ -1,3 +1,4 @@", " a", "-b", "+b2", "+c", " d"].join("\n");
    const r = checkCandidate({ text, finishReason: "stop" });
    expect(r.ok).toBe(true);
  });

  it("flags a unified diff whose hunk line counts do not match the header", () => {
    // Header claims 3 old / 4 new, body provides 2 old / 2 new.
    const text = ["@@ -1,3 +1,4 @@", " a", "+b"].join("\n");
    const r = checkCandidate({ text, finishReason: "stop" });
    expect(r.flaws).toContain("malformed_diff");
  });

  it("flags a dangling hunk header with no body", () => {
    const text = ["--- a/x", "+++ b/x", "@@ -1,2 +1,2 @@"].join("\n");
    const r = checkCandidate({ text, finishReason: "stop" });
    expect(r.flaws).toContain("malformed_diff");
  });
});

describe("expectsJsonResponse", () => {
  it("is true for response_format json_object", () => {
    expect(expectsJsonResponse({ response_format: { type: "json_object" } })).toBe(true);
  });
  it("is true for response_format json_schema", () => {
    expect(expectsJsonResponse({ response_format: { type: "json_schema", json_schema: {} } })).toBe(true);
  });
  it("is false when absent or another type", () => {
    expect(expectsJsonResponse({})).toBe(false);
    expect(expectsJsonResponse({ response_format: { type: "text" } })).toBe(false);
  });
});
