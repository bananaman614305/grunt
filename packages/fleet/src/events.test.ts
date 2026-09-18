import { describe, expect, it } from "vitest";
import { classifyLine, WorkerEventLog } from "./events.js";

describe("classifyLine", () => {
  it("reads an assistant turn with its output tokens", () => {
    const line = JSON.stringify({
      type: "message_end",
      message: { role: "assistant", usage: { output_tokens: 120 } },
    });
    expect(classifyLine(line, 10)).toEqual({ kind: "turn", at: 10, outputTokens: 120 });
  });

  it("drops a non-assistant message_end", () => {
    const line = JSON.stringify({ type: "message_end", message: { role: "user" } });
    expect(classifyLine(line, 10)).toBeUndefined();
  });

  it("marks an edit-shaped tool call as an edit", () => {
    const line = JSON.stringify({ type: "tool_execution_start", toolName: "edit" });
    expect(classifyLine(line, 5)).toEqual({ kind: "tool", at: 5, tool: "edit", edits: true });
  });

  it("marks a read-shaped tool call as no edit", () => {
    const line = JSON.stringify({ type: "tool_call_start", tool_name: "read_file" });
    expect(classifyLine(line, 5)).toEqual({ kind: "tool", at: 5, tool: "read_file", edits: false });
  });

  it("ignores unrelated events", () => {
    expect(classifyLine(JSON.stringify({ type: "heartbeat" }), 1)).toBeUndefined();
    expect(classifyLine("   ", 1)).toBeUndefined();
  });

  it("marks an unparseable line as malformed", () => {
    expect(classifyLine("not json at all", 7)).toEqual({ kind: "malformed", at: 7 });
  });
});

describe("WorkerEventLog", () => {
  it("keeps events ordered and returns a trailing window", () => {
    const log = new WorkerEventLog();
    log.feedLine(JSON.stringify({ type: "tool_execution_start", toolName: "read" }), 1);
    log.feedLine(JSON.stringify({ type: "tool_execution_start", toolName: "edit" }), 2);
    log.feedLine(JSON.stringify({ type: "message_end", message: { role: "assistant" } }), 3);

    expect(log.list()).toHaveLength(3);
    expect(log.lastActivityAt()).toBe(3);
    expect(log.recent(2).map((e) => e.at)).toEqual([2, 3]);
  });

  it("drops lines that classify to nothing", () => {
    const log = new WorkerEventLog();
    log.feedLine(JSON.stringify({ type: "heartbeat" }), 1);
    expect(log.list()).toHaveLength(0);
    expect(log.lastActivityAt()).toBeUndefined();
  });
});
