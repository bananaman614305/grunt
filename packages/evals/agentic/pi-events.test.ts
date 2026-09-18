import { describe, expect, it } from "vitest";
import { parsePiEvents, PiEventParser } from "./pi-events.js";

const usage = (input: number, output: number, total: number) => ({
  input,
  output,
  cacheRead: 5,
  cacheWrite: 2,
  cost: { input: total / 2, output: total / 2, total },
});

const STREAM = [
  JSON.stringify({ type: "agent_start" }),
  JSON.stringify({ type: "message_start", message: { role: "assistant" } }),
  JSON.stringify({ type: "tool_execution_start", toolName: "bash", args: { command: "node test.js" } }),
  JSON.stringify({ type: "tool_execution_end", toolName: "bash" }),
  JSON.stringify({ type: "message_end", message: { role: "assistant", usage: usage(100, 20, 0.001) } }),
  JSON.stringify({ type: "tool_execution_start", toolName: "edit" }),
  JSON.stringify({ type: "tool_execution_start", toolName: "bash" }),
  JSON.stringify({ type: "message_end", message: { role: "assistant", usage: usage(200, 40, 0.002) } }),
  JSON.stringify({ type: "agent_end" }),
].join("\n");

describe("parsePiEvents", () => {
  it("extracts turns, tool calls by name, and summed usage", () => {
    const stats = parsePiEvents(STREAM);
    expect(stats.turns).toBe(2);
    expect(stats.toolCalls).toEqual({ bash: 2, edit: 1 });
    expect(stats.toolCallTotal).toBe(3);
    expect(stats.usage).toEqual({ input: 300, output: 60, cacheRead: 10, cacheWrite: 4, costUsd: 0.003 });
    expect(stats.malformedLines).toBe(0);
  });

  it("reads snake_case usage fields and flat numeric cost", () => {
    const stats = parsePiEvents(
      JSON.stringify({
        type: "message_end",
        message: { role: "assistant", usage: { input_tokens: 7, output_tokens: 3, cost: 0.5 } },
      }),
    );
    expect(stats.usage.input).toBe(7);
    expect(stats.usage.output).toBe(3);
    expect(stats.usage.costUsd).toBe(0.5);
  });

  it("skips non-assistant message_end events", () => {
    const stats = parsePiEvents(JSON.stringify({ type: "message_end", message: { role: "user" } }));
    expect(stats.turns).toBe(0);
  });

  it("counts unparseable lines instead of throwing, and skips blanks", () => {
    const stats = parsePiEvents('not json\n\n{"type":"message_end","message":{}}\n[1,2]\n');
    expect(stats.malformedLines).toBe(2);
    expect(stats.turns).toBe(1);
  });

  it("names a tool 'unknown' when no name field is present", () => {
    const stats = parsePiEvents(JSON.stringify({ type: "tool_execution_start" }));
    expect(stats.toolCalls).toEqual({ unknown: 1 });
  });
});

describe("PiEventParser", () => {
  it("handles chunks split mid-line and a final unterminated line", () => {
    const parser = new PiEventParser();
    const text = STREAM; // no trailing newline: last line only complete at end()
    for (let i = 0; i < text.length; i += 7) parser.feed(text.slice(i, i + 7));
    parser.end();
    const stats = parser.stats();
    expect(stats.turns).toBe(2);
    expect(stats.toolCallTotal).toBe(3);
    expect(stats.malformedLines).toBe(0);
  });

  it("is idempotent across repeated end() calls", () => {
    const parser = new PiEventParser();
    parser.feed(JSON.stringify({ type: "message_end", message: { role: "assistant" } }));
    parser.end();
    parser.end();
    expect(parser.stats().turns).toBe(1);
  });
});
