import { describe, expect, it } from "vitest";
import { measureChatCompletion, readStream } from "./sse.js";

function sse(frames: unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const lines = frames.map((f) => (f === "[DONE]" ? "data: [DONE]" : `data: ${JSON.stringify(f)}`));
  const text = `${lines.join("\n\n")}\n\n`;
  // Split mid-line to prove partial frames are buffered across reads.
  const cut = Math.floor(text.length / 2);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text.slice(0, cut)));
      controller.enqueue(encoder.encode(text.slice(cut)));
      controller.close();
    },
  });
}

describe("readStream", () => {
  it("assembles text, times the first content frame, and reads usage off the last chunk", async () => {
    let tick = 0;
    const elapsed = (): number => {
      tick += 10;
      return tick;
    };
    const stream = sse([
      { id: "gen-1", model: "deepseek/deepseek-v4-flash", provider: "StreamLake", choices: [{ delta: { role: "assistant", content: "" } }] },
      { id: "gen-1", choices: [{ delta: { reasoning: "thinking" } }] },
      { id: "gen-1", choices: [{ delta: { content: "Hi " } }] },
      { id: "gen-1", choices: [{ delta: { content: "there" } }] },
      {
        id: "gen-1",
        choices: [],
        usage: { prompt_tokens: 12, completion_tokens: 30, cost: 0.00001, completion_tokens_details: { reasoning_tokens: 20 } },
      },
      "[DONE]",
    ]);
    const result = await readStream(stream, elapsed);
    expect(result.text).toBe("Hi there");
    expect(result.model).toBe("deepseek/deepseek-v4-flash");
    expect(result.provider).toBe("StreamLake");
    // The empty first delta does not count; the reasoning frame does.
    expect(result.ttfbMs).toBe(10);
    expect(result.totalMs).toBe(20);
    expect(result).toMatchObject({ inputTokens: 12, outputTokens: 30, reasoningTokens: 20, costUsd: 0.00001 });
  });

  it("falls back to total time when nothing streamed", async () => {
    const result = await readStream(sse(["[DONE]"]), () => 42);
    expect(result.text).toBe("");
    expect(result.ttfbMs).toBe(42);
  });
});

describe("measureChatCompletion", () => {
  it("posts a streaming body with the bearer, reads milo headers, and never throws on an error status", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      return new Response(JSON.stringify({ error: { message: "nope" } }), {
        status: 401,
        headers: { "x-milo-tier": "fast", "x-milo-model": "m", "x-milo-sticky": "false" },
      });
    };
    const measured = await measureChatCompletion({
      baseUrl: "http://gw/v1/",
      apiKey: "sk-test",
      body: { model: "milo/auto", messages: [] },
      timeoutMs: 1000,
      fetchImpl,
    });
    expect(measured.status).toBe(401);
    expect(measured.milo).toEqual({ tier: "fast", model: "m", sticky: "false" });
    expect(calls[0]?.url).toBe("http://gw/v1/chat/completions");
    const sent = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(sent["stream"]).toBe(true);
    expect(sent["stream_options"]).toEqual({ include_usage: true });
    expect((calls[0]?.init.headers as Record<string, string>)["Authorization"]).toBe("Bearer sk-test");
  });
});
