/**
 * The embedding client for two-stage retrieval (ADR-018), gateway side. The
 * point of these tests is the FAIL-OPEN contract: every failure path -- no
 * bearer key, a non-2xx, a malformed body -- turns into "no vector", never an
 * error the request path has to handle. A working call posts the OpenAI
 * embeddings shape with the caller's forwarded key and parses the vectors back.
 */

import { describe, expect, it, vi } from "vitest";
import { DEFAULT_EMBED_MODEL, OpenRouterEmbedClient, embedClientFor, embedOne } from "./embed.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const AUTH = "Bearer sk-or-v1-caller";

describe("OpenRouterEmbedClient", () => {
  it("posts the OpenAI embeddings shape with the forwarded key and parses vectors", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ data: [{ embedding: [0.1, 0.2] }, { embedding: [0.3, 0.4] }] }));
    const client = new OpenRouterEmbedClient({
      model: DEFAULT_EMBED_MODEL,
      baseUrl: "https://openrouter.ai/api/v1",
      authorization: AUTH,
      fetch: fetchMock,
    });

    const vecs = await client.embed(["a", "b"]);
    expect(vecs).toEqual([[0.1, 0.2], [0.3, 0.4]]);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://openrouter.ai/api/v1/embeddings");
    expect((init!.headers as Record<string, string>).authorization).toBe(AUTH);
    expect(JSON.parse(init!.body as string)).toEqual({ model: DEFAULT_EMBED_MODEL, input: ["a", "b"] });
  });

  it("returns [] for an empty batch without calling the network", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}));
    const client = new OpenRouterEmbedClient({ model: "m", baseUrl: "https://x/v1", authorization: AUTH, fetch: fetchMock });
    expect(await client.embed([])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws on a non-2xx, a count mismatch, or a malformed vector", async () => {
    const mk = (r: Response) =>
      new OpenRouterEmbedClient({ model: "m", baseUrl: "https://x/v1", authorization: AUTH, fetch: async () => r });
    await expect(mk(jsonResponse({}, 429)).embed(["a"])).rejects.toThrow(/429/);
    await expect(mk(jsonResponse({ data: [] })).embed(["a"])).rejects.toThrow(/shape/);
    await expect(mk(jsonResponse({ data: [{ embedding: "nope" }] })).embed(["a"])).rejects.toThrow(/malformed/);
  });
});

describe("embedClientFor", () => {
  it("is undefined with no config or no bearer key", () => {
    expect(embedClientFor(undefined, AUTH)).toBeUndefined();
    expect(embedClientFor({ model: "m", baseUrl: "https://x/v1" }, "")).toBeUndefined();
    expect(embedClientFor({ model: "m", baseUrl: "https://x/v1" }, "Basic abc")).toBeUndefined();
  });

  it("builds a client when config and a bearer key are present", () => {
    expect(embedClientFor({ model: "m", baseUrl: "https://x/v1" }, AUTH)).toBeInstanceOf(OpenRouterEmbedClient);
  });
});

describe("embedOne fails open", () => {
  it("returns undefined for a missing client, empty text, or a throwing call", async () => {
    expect(await embedOne(undefined, "hello")).toBeUndefined();
    const throwing = { embed: async () => { throw new Error("boom"); } };
    expect(await embedOne(throwing, "hello")).toBeUndefined();
    const ok = { embed: async () => [[1, 2, 3]] };
    expect(await embedOne(ok, "   ")).toBeUndefined(); // empty text short-circuits
    expect(await embedOne(ok, "hello")).toEqual([1, 2, 3]);
  });
});
