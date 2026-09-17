import { describe, expect, it } from "vitest";
import { teeFirstChunkModel } from "./sse.js";

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

const enc = new TextEncoder();

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      parts.push(value);
      total += value.byteLength;
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

describe("teeFirstChunkModel", () => {
  it("extracts the model from the first chunk", async () => {
    const chunks = [
      enc.encode(`data: {"id":"1","model":"anthropic/claude-sonnet-5","choices":[]}\n\n`),
      enc.encode(`data: [DONE]\n\n`),
    ];
    const { stream, model } = teeFirstChunkModel(streamOf(chunks));

    await expect(model).resolves.toBe("anthropic/claude-sonnet-5");
    const out = await collect(stream);
    expect(out).toEqual(concatBytes(chunks));
  });

  it("passes bytes through identically regardless of parsing", async () => {
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < 25; i++) {
      chunks.push(enc.encode(`data: {"id":"${i}","model":"m","choices":[{"delta":{"content":"x"}}]}\n\n`));
    }
    const { stream, model } = teeFirstChunkModel(streamOf(chunks));

    const out = await collect(stream);
    expect(out).toEqual(concatBytes(chunks));
    await expect(model).resolves.toBe("m");
  });

  it("resolves undefined when the first chunk is [DONE]", async () => {
    const chunks = [enc.encode(`data: [DONE]\n\n`)];
    const { stream, model } = teeFirstChunkModel(streamOf(chunks));

    await expect(model).resolves.toBeUndefined();
    const out = await collect(stream);
    expect(out).toEqual(concatBytes(chunks));
  });

  it("resolves undefined on non-JSON data without throwing", async () => {
    const chunks = [enc.encode(`data: not-json-at-all\n\n`), enc.encode(`data: [DONE]\n\n`)];
    const { stream, model } = teeFirstChunkModel(streamOf(chunks));

    await expect(model).resolves.toBeUndefined();
    const out = await collect(stream);
    expect(out).toEqual(concatBytes(chunks));
  });
});
