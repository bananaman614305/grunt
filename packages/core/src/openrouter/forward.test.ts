import { describe, expect, it } from "vitest";
import { extractMilo, forwardHeaders, isStreaming, prepareBody } from "./forward.js";

describe("prepareBody", () => {
  it("replaces model, drops milo, and preserves key order", () => {
    const body = {
      model: "milo/auto",
      messages: [{ role: "user", content: "hi" }],
      milo: { posture: "low" },
      temperature: 0.5,
      stream: true,
    };

    const result = prepareBody(body, "anthropic/claude-sonnet-5");

    expect(Object.keys(result)).toEqual(["model", "messages", "temperature", "stream"]);
    expect(result.model).toBe("anthropic/claude-sonnet-5");
    expect(result.messages).toBe(body.messages);
    expect(result.temperature).toBe(0.5);
    expect(result.stream).toBe(true);
    expect(result).not.toHaveProperty("milo");
    // original body is untouched
    expect(body.model).toBe("milo/auto");
  });

  it("appends model when the body has none", () => {
    const result = prepareBody({ messages: [] }, "anthropic/claude-haiku-4.5");
    expect(result).toEqual({ messages: [], model: "anthropic/claude-haiku-4.5" });
  });

  it("is a no-op copy when there is no milo field", () => {
    const body = { model: "milo/auto", a: 1, b: 2 };
    const result = prepareBody(body, "x/y");
    expect(result).toEqual({ model: "x/y", a: 1, b: 2 });
  });
});

describe("extractMilo", () => {
  it("reports isRouted for milo/auto and not otherwise", () => {
    expect(extractMilo({ model: "milo/auto" }).isRouted).toBe(true);
    expect(extractMilo({ model: "anthropic/claude-sonnet-5" }).isRouted).toBe(false);
    expect(extractMilo({}).isRouted).toBe(false);
  });

  it("extracts a fully valid extension", () => {
    const { extension } = extractMilo({
      model: "milo/auto",
      milo: { posture: "low", candidates: ["a/a", "b/b"], tier: "fast" },
    });
    expect(extension).toEqual({ posture: "low", candidates: ["a/a", "b/b"], tier: "fast" });
  });

  it("extracts a partial extension, keeping only valid fields", () => {
    const { extension } = extractMilo({
      model: "milo/auto",
      milo: { posture: "quality" },
    });
    expect(extension).toEqual({ posture: "quality" });
  });

  it("drops garbage fields without throwing, keeping unknown fields out", () => {
    expect(() =>
      extractMilo({
        model: "milo/auto",
        milo: {
          posture: 123,
          candidates: "not-an-array",
          tier: "bogus-tier",
          somethingElse: "ignored",
        },
      }),
    ).not.toThrow();

    const { extension } = extractMilo({
      model: "milo/auto",
      milo: { posture: 123, candidates: "not-an-array", tier: "bogus-tier", extra: true },
    });
    expect(extension).toEqual({});
  });

  it("returns no extension when milo is absent or not an object", () => {
    expect(extractMilo({ model: "milo/auto" }).extension).toBeUndefined();
    expect(extractMilo({ model: "milo/auto", milo: "nope" }).extension).toBeUndefined();
    expect(extractMilo({ model: "milo/auto", milo: null }).extension).toBeUndefined();
    expect(extractMilo({ model: "milo/auto", milo: ["a"] }).extension).toBeUndefined();
  });

  it("drops a partially-valid candidates array (any non-string entry invalidates it)", () => {
    const { extension } = extractMilo({
      model: "milo/auto",
      milo: { candidates: ["a/a", 42] },
    });
    expect(extension).toEqual({});
  });
});

describe("forwardHeaders", () => {
  it("forwards the allow-listed headers, case-insensitively", () => {
    const incoming = new Headers({
      Authorization: "Bearer sk-or-abc",
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      "User-Agent": "openai-node/4",
    });

    const result = forwardHeaders(incoming);

    expect(result.get("authorization")).toBe("Bearer sk-or-abc");
    expect(result.get("content-type")).toBe("application/json");
    expect(result.get("accept")).toBe("text/event-stream");
    expect(result.get("user-agent")).toBe("openai-node/4");
  });

  it("drops hop-by-hop, forwarding, and x-milo-* headers", () => {
    const incoming = new Headers({
      Authorization: "Bearer sk-or-abc",
      Host: "milo.example.com",
      "Content-Length": "123",
      Connection: "keep-alive",
      "Transfer-Encoding": "chunked",
      "X-Forwarded-For": "1.2.3.4",
      "X-Forwarded-Proto": "https",
      "X-Milo-Decision-Id": "abc123",
      "X-Milo-Anything": "whatever",
    });

    const result = forwardHeaders(incoming);

    expect(result.has("host")).toBe(false);
    expect(result.has("content-length")).toBe(false);
    expect(result.has("connection")).toBe(false);
    expect(result.has("transfer-encoding")).toBe(false);
    expect(result.has("x-forwarded-for")).toBe(false);
    expect(result.has("x-forwarded-proto")).toBe(false);
    expect(result.has("x-milo-decision-id")).toBe(false);
    expect(result.has("x-milo-anything")).toBe(false);
    expect(result.get("authorization")).toBe("Bearer sk-or-abc");
  });

  it("sets attribution headers from opts, independent of incoming headers", () => {
    const result = forwardHeaders(new Headers(), { referer: "https://milo.dev", title: "Milo" });
    expect(result.get("HTTP-Referer")).toBe("https://milo.dev");
    expect(result.get("X-Title")).toBe("Milo");
  });

  it("omits attribution headers when opts are not given", () => {
    const result = forwardHeaders(new Headers({ Authorization: "Bearer x" }));
    expect(result.has("http-referer")).toBe(false);
    expect(result.has("x-title")).toBe(false);
  });
});

describe("isStreaming", () => {
  it("is true only when stream is exactly true", () => {
    expect(isStreaming({ stream: true })).toBe(true);
    expect(isStreaming({ stream: false })).toBe(false);
    expect(isStreaming({ stream: "true" })).toBe(false);
    expect(isStreaming({})).toBe(false);
  });
});
