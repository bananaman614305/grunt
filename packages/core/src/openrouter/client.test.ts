import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenRouterClient, OpenRouterError } from "./client.js";
import { OPENROUTER_BASE_URL } from "./forward.js";

const enc = new TextEncoder();

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
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

afterEach(() => {
  vi.useRealTimers();
});

describe("OpenRouterClient.chatCompletions", () => {
  it("posts to the right URL with forwarded headers and returns the Response untouched", async () => {
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    const upstream = new Response(JSON.stringify({ ok: true }), { status: 200 });

    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedInit = init;
      return upstream;
    });

    const client = new OpenRouterClient({ fetch: fetchMock as unknown as typeof fetch, referer: "https://milo.dev", title: "Milo" });

    const headers = new Headers({
      Authorization: "Bearer sk-or-abc",
      "X-Milo-Decision-Id": "should-be-dropped",
      Host: "should-be-dropped.example",
    });

    const response = await client.chatCompletions({
      headers,
      body: { model: "anthropic/claude-sonnet-5", messages: [] },
    });

    expect(capturedUrl).toBe(`${OPENROUTER_BASE_URL}/chat/completions`);
    expect(capturedInit?.method).toBe("POST");
    const sentHeaders = capturedInit?.headers as Headers;
    expect(sentHeaders.get("authorization")).toBe("Bearer sk-or-abc");
    expect(sentHeaders.get("content-type")).toBe("application/json");
    expect(sentHeaders.get("HTTP-Referer")).toBe("https://milo.dev");
    expect(sentHeaders.get("X-Title")).toBe("Milo");
    expect(sentHeaders.has("x-milo-decision-id")).toBe(false);
    expect(sentHeaders.has("host")).toBe(false);
    expect(capturedInit?.body).toBe(JSON.stringify({ model: "anthropic/claude-sonnet-5", messages: [] }));

    expect(response).toBe(upstream);
  });

  it("streams a mocked SSE response byte-for-byte, including a mid-JSON split across chunks", async () => {
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < 22; i++) {
      chunks.push(enc.encode(`data: {"id":"${i}","choices":[{"delta":{"content":"x`));
      chunks.push(enc.encode(`x"}}]}\n\n`));
    }
    const original = concatBytes(chunks);

    const fetchMock = vi.fn(async () => new Response(streamOf(chunks), { status: 200 }));
    const client = new OpenRouterClient({ fetch: fetchMock as unknown as typeof fetch });

    const response = await client.chatCompletions({
      headers: new Headers({ Authorization: "Bearer x" }),
      body: { model: "anthropic/claude-sonnet-5", stream: true },
    });

    expect(response.body).not.toBeNull();
    const received = await collect(response.body as ReadableStream<Uint8Array>);
    expect(received).toEqual(original);
  });

  it("returns a non-2xx upstream response instead of throwing", async () => {
    const upstream = new Response(JSON.stringify({ error: "rate limited" }), { status: 429 });
    const fetchMock = vi.fn(async () => upstream);
    const client = new OpenRouterClient({ fetch: fetchMock as unknown as typeof fetch });

    const response = await client.chatCompletions({
      headers: new Headers({ Authorization: "Bearer x" }),
      body: { model: "anthropic/claude-sonnet-5" },
    });

    expect(response.status).toBe(429);
    expect(response).toBe(upstream);
  });

  it("throws OpenRouterError on a network failure", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });
    const client = new OpenRouterClient({ fetch: fetchMock as unknown as typeof fetch });

    await expect(
      client.chatCompletions({ headers: new Headers(), body: { model: "x/y" } }),
    ).rejects.toBeInstanceOf(OpenRouterError);
    await expect(
      client.chatCompletions({ headers: new Headers(), body: { model: "x/y" } }),
    ).rejects.toThrow(/ECONNRESET/);
  });
});

describe("OpenRouterClient.listModels", () => {
  it("caches the model list for five minutes, keyed by nothing", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "a/a" }] }), { status: 200 }));
    const client = new OpenRouterClient({ fetch: fetchMock as unknown as typeof fetch });

    const first = await client.listModels("Bearer user-key-1");
    expect(first.data).toEqual([{ id: "a/a" }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Different caller/auth value, still within the TTL: served from cache.
    const second = await client.listModels("Bearer user-key-2");
    expect(second.data).toEqual([{ id: "a/a" }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(5 * 60 * 1000 - 1);
    await client.listModels("Bearer user-key-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2);
    await client.listModels("Bearer user-key-1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws OpenRouterError on a non-2xx models response", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: "nope" }), { status: 401 }));
    const client = new OpenRouterClient({ fetch: fetchMock as unknown as typeof fetch });

    await expect(client.listModels("Bearer bad-key")).rejects.toBeInstanceOf(OpenRouterError);
  });
});

describe("OpenRouterClient.proxy", () => {
  it("forwards a generic /v1/* path", async () => {
    let capturedUrl: string | undefined;
    const upstream = new Response(JSON.stringify({ ok: true }), { status: 200 });
    const fetchMock = vi.fn(async (url: string | URL) => {
      capturedUrl = String(url);
      return upstream;
    });
    const client = new OpenRouterClient({ fetch: fetchMock as unknown as typeof fetch });

    const response = await client.proxy({
      method: "GET",
      path: "/generation",
      headers: new Headers({ Authorization: "Bearer x" }),
    });

    expect(capturedUrl).toBe(`${OPENROUTER_BASE_URL}/generation`);
    expect(response).toBe(upstream);
  });

  it("rejects path traversal", async () => {
    const fetchMock = vi.fn();
    const client = new OpenRouterClient({ fetch: fetchMock as unknown as typeof fetch });

    await expect(
      client.proxy({ method: "GET", path: "/../secrets", headers: new Headers() }),
    ).rejects.toBeInstanceOf(OpenRouterError);
    await expect(
      client.proxy({ method: "GET", path: "/models/../../etc/passwd", headers: new Headers() }),
    ).rejects.toBeInstanceOf(OpenRouterError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects absolute URLs and protocol-relative paths", async () => {
    const fetchMock = vi.fn();
    const client = new OpenRouterClient({ fetch: fetchMock as unknown as typeof fetch });

    await expect(
      client.proxy({ method: "GET", path: "https://evil.example/steal", headers: new Headers() }),
    ).rejects.toBeInstanceOf(OpenRouterError);
    await expect(
      client.proxy({ method: "GET", path: "//evil.example/steal", headers: new Headers() }),
    ).rejects.toBeInstanceOf(OpenRouterError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
