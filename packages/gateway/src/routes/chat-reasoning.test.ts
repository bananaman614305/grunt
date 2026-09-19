import { describe, expect, it } from "vitest";
import {
  stripChatReasoningBody,
  stripChatReasoningPayload,
  stripChatReasoningSse,
  wantsVisibleReasoning,
} from "./chat-reasoning.js";

describe("wantsVisibleReasoning", () => {
  it("defaults to hidden", () => {
    expect(wantsVisibleReasoning({})).toBe(false);
    expect(wantsVisibleReasoning({ reasoning: { exclude: true } })).toBe(false);
  });

  it("honors explicit visibility choices", () => {
    expect(wantsVisibleReasoning({ reasoning: { exclude: false } })).toBe(true);
    expect(wantsVisibleReasoning({ include_reasoning: true })).toBe(true);
    expect(wantsVisibleReasoning({ include_reasoning: false })).toBe(false);
  });
});

describe("stripChatReasoningPayload", () => {
  it("removes known reasoning keys from message and delta", () => {
    const payload = {
      id: "gen-1",
      choices: [
        {
          message: {
            role: "assistant",
            content: "42",
            reasoning: "secret",
            reasoning_content: "also",
            thinking: "still",
          },
          delta: { content: "4", reasoning_details: [{ text: "x" }] },
        },
      ],
    };
    const out = stripChatReasoningPayload(payload) as typeof payload;
    expect(out.choices[0]?.message).toEqual({ role: "assistant", content: "42" });
    expect(out.choices[0]?.delta).toEqual({ content: "4" });
    expect(payload.choices[0]?.message).toHaveProperty("reasoning");
  });
});

describe("stripChatReasoningBody", () => {
  it("rewrites buffered JSON and leaves garbage alone", () => {
    expect(stripChatReasoningBody("not-json")).toBe("not-json");
    const text = stripChatReasoningBody(
      JSON.stringify({ choices: [{ message: { content: "ok", reasoning: "nope" } }] }),
    );
    expect(JSON.parse(text)).toEqual({ choices: [{ message: { content: "ok" } }] });
  });
});

describe("stripChatReasoningSse", () => {
  it("scrubs reasoning across chunk boundaries", async () => {
    const input =
      'data: {"id":"gen-1","choices":[{"delta":{"reasoning":"secret","content":"4"}}]}\n\n' +
      'data: {"id":"gen-1","choices":[{"delta":{"content":"2"}}]}\n\n' +
      "data: [DONE]\n\n";
    // Split mid-frame so the transform has to reassemble lines.
    const mid = Math.floor(input.length / 2);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode(input.slice(0, mid)));
        controller.enqueue(encoder.encode(input.slice(mid)));
        controller.close();
      },
    });
    const out = await new Response(stream.pipeThrough(stripChatReasoningSse())).text();
    expect(out).toContain('"content":"4"');
    expect(out).toContain('"content":"2"');
    expect(out).toContain("[DONE]");
    expect(out).not.toContain("secret");
    expect(out).not.toMatch(/"reasoning"/);
  });
});
