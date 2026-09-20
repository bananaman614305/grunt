import { describe, expect, it, vi } from "vitest";
import { ROUTER_LIMITS } from "../types.js";
import {
  isRetryableStatus,
  JevClient,
  JevError,
  parseRetryAfter,
  RETRY_BASE_MS,
  RETRY_FACTOR,
} from "./client.js";
import { fixtureFetch } from "./fixtures.js";
import { choice, noul, score } from "./questions.js";
import { JEV_DEFAULT_MODEL, JEV_OPENROUTER_MODEL } from "./types.js";

const FIXTURES_DIR = new URL("./__fixtures__", import.meta.url).pathname;
const SECRET_KEY = "sk-jev-do-not-leak-this-9f2e1c";

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function okResponse(requestId = "req_ok"): Response {
  return jsonResponse(
    200,
    {
      model: "jev-latest",
      answers: { a: { type: "noul", noul: 0.5 } },
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    { "x-typesafe-request-id": requestId },
  );
}

/**
 * A fake clock plus a `sleep` that advances it, so a backoff is measured
 * rather than waited out. Records every sleep the client asked for.
 */
function fakeTimers(): {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  slept: number[];
  advance: (ms: number) => void;
} {
  let t = 1_700_000_000_000;
  const slept: number[] = [];
  return {
    now: () => t,
    slept,
    advance: (ms: number) => void (t += ms),
    sleep: (ms: number) => {
      slept.push(ms);
      t += ms;
      return Promise.resolve();
    },
  };
}

const ask = { state: "hi", questions: { a: noul("q?") } };

describe("isRetryableStatus", () => {
  it("retries the statuses that mean 'not now'", () => {
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(529)).toBe(true);
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(502)).toBe(true);
  });

  it("never retries a 4xx other than 429", () => {
    for (const status of [400, 401, 403, 404, 409, 422]) {
      expect(isRetryableStatus(status)).toBe(false);
    }
  });
});

describe("parseRetryAfter", () => {
  const now = Date.parse("2026-09-17T12:00:00Z");

  it("reads delay-seconds", () => {
    expect(parseRetryAfter("5", now)).toBe(5_000);
    expect(parseRetryAfter("0", now)).toBe(0);
    expect(parseRetryAfter("  12  ", now)).toBe(12_000);
  });

  it("reads an HTTP date", () => {
    expect(parseRetryAfter("Thu, 17 Sep 2026 12:00:30 GMT", now)).toBe(30_000);
  });

  it("reads a date already in the past as zero, not as a negative wait", () => {
    expect(parseRetryAfter("Thu, 17 Sep 2026 11:59:00 GMT", now)).toBe(0);
  });

  it("returns undefined for an absent or unparseable header", () => {
    expect(parseRetryAfter(null, now)).toBeUndefined();
    expect(parseRetryAfter("", now)).toBeUndefined();
    expect(parseRetryAfter("soon", now)).toBeUndefined();
    expect(parseRetryAfter("-5", now)).toBeUndefined();
  });
});

describe("JevClient", () => {
  it("asks jev-latest by default, never the preview model", () => {
    expect(JEV_DEFAULT_MODEL).toBe("jev-latest");
  });

  it("systemone succeeds against the recorded fixture and captures requestId + latencyMs", async () => {
    const client = new JevClient({ apiKey: SECRET_KEY, fetch: fixtureFetch(FIXTURES_DIR) });
    const result = await client.systemone({
      state:
        "User: The payment webhook handler throws a null pointer exception intermittently. Fix the bug and add a regression test.",
      questions: {
        needs_reasoning: noul("Does answering this well require multi-step reasoning?"),
        task_type: choice("What kind of task is this?", {
          chat: null,
          edit: null,
          feature: null,
          debug: "Fixing a bug or unexpected behavior",
          research: null,
          review: null,
          docs: null,
          ops: null,
          classify: null,
        }),
        difficulty: score("How difficult is this task?", ["trivial", "easy", "moderate", "hard"]),
      },
    });

    expect(result.model).toBe("jev-latest");
    expect(result.answers.task_type).toMatchObject({ type: "choice", choice: "debug" });
    expect(result.answers.difficulty).toMatchObject({ type: "score" });
    expect(result.answers.needs_reasoning).toMatchObject({ type: "noul" });
    expect(result.requestId).toBe("req_01a0af00000000000000000000000002");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("listModels succeeds against the recorded fixture", async () => {
    const client = new JevClient({ apiKey: SECRET_KEY, fetch: fixtureFetch(FIXTURES_DIR) });
    const models = await client.listModels();
    expect(models.map((m) => m.name)).toContain("jev-latest");
    expect(models.find((m) => m.name === "jev-latest")).toMatchObject({
      description: "General-purpose system one model, tuned for balanced accuracy and latency.",
      release_date: "2026-08-01",
    });
  });

  it("captures the empty string as requestId when the header is absent", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse(200, {
        model: "jev-latest",
        answers: { a: { type: "noul", noul: 0.5 } },
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
    const client = new JevClient({ apiKey: SECRET_KEY, fetch: fetchFn as unknown as typeof fetch });
    const result = await client.systemone(ask);
    expect(result.requestId).toBe("");
  });
});

describe("JevClient: retries", () => {
  it("retries a 503 and succeeds on the second attempt", async () => {
    const timers = fakeTimers();
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(503, { detail: "temporarily unavailable" }))
      .mockResolvedValueOnce(okResponse("req_retry_ok"));
    const client = new JevClient({
      apiKey: SECRET_KEY,
      fetch: fetchFn as unknown as typeof fetch,
      ...timers,
    });

    const result = await client.systemone(ask);
    expect(result.requestId).toBe("req_retry_ok");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("retries a 429 and a 529 too", async () => {
    for (const status of [429, 529]) {
      const timers = fakeTimers();
      const fetchFn = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(status, { detail: "not now" }))
        .mockResolvedValueOnce(okResponse());
      const client = new JevClient({
        apiKey: SECRET_KEY,
        fetch: fetchFn as unknown as typeof fetch,
        ...timers,
      });

      await expect(client.systemone(ask)).resolves.toBeDefined();
      expect(fetchFn).toHaveBeenCalledTimes(2);
    }
  });

  it("retries a network error", async () => {
    const timers = fakeTimers();
    const fetchFn = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(okResponse("req_after_network"));
    const client = new JevClient({
      apiKey: SECRET_KEY,
      fetch: fetchFn as unknown as typeof fetch,
      ...timers,
    });

    await expect(client.systemone(ask)).resolves.toMatchObject({ requestId: "req_after_network" });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("gives up after the configured number of retries and reports the last failure", async () => {
    const timers = fakeTimers();
    const fetchFn = vi.fn(async () => jsonResponse(503, { detail: "still down" }));
    const client = new JevClient({
      apiKey: SECRET_KEY,
      retries: 3,
      timeoutMs: 60_000,
      fetch: fetchFn as unknown as typeof fetch,
      ...timers,
    });

    await expect(client.systemone(ask)).rejects.toMatchObject({
      name: "JevError",
      kind: "http",
      status: 503,
    });
    // One first attempt plus three retries.
    expect(fetchFn).toHaveBeenCalledTimes(4);
  });

  it("defaults to the retry count in ROUTER_LIMITS", async () => {
    const timers = fakeTimers();
    const fetchFn = vi.fn(async () => jsonResponse(503, {}));
    const client = new JevClient({
      apiKey: SECRET_KEY,
      timeoutMs: 60_000,
      fetch: fetchFn as unknown as typeof fetch,
      ...timers,
    });

    await expect(client.systemone(ask)).rejects.toMatchObject({ kind: "http" });
    expect(ROUTER_LIMITS.jevRetries).toBe(3);
    expect(fetchFn).toHaveBeenCalledTimes(ROUTER_LIMITS.jevRetries + 1);
  });

  it("never retries a 4xx other than 429", async () => {
    for (const status of [400, 401, 403, 404]) {
      const timers = fakeTimers();
      const fetchFn = vi.fn(async () => jsonResponse(status, { detail: "no" }));
      const client = new JevClient({
        apiKey: SECRET_KEY,
        retries: 3,
        fetch: fetchFn as unknown as typeof fetch,
        ...timers,
      });

      await expect(client.systemone(ask)).rejects.toMatchObject({ kind: "http", status });
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(timers.slept).toEqual([]);
    }
  });
});

describe("JevClient: backoff", () => {
  it("backs off exponentially with full jitter: each window is base * factor^n", async () => {
    const timers = fakeTimers();
    const fetchFn = vi.fn(async () => jsonResponse(503, {}));
    // random() pinned just under 1 so each sleep sits at the top of its
    // window, which is what makes the window itself observable.
    const client = new JevClient({
      apiKey: SECRET_KEY,
      retries: 3,
      timeoutMs: 60_000,
      random: () => 0.999_999,
      fetch: fetchFn as unknown as typeof fetch,
      now: timers.now,
      sleep: timers.sleep,
    });

    await expect(client.systemone(ask)).rejects.toMatchObject({ kind: "http" });

    expect(RETRY_BASE_MS).toBe(200);
    expect(RETRY_FACTOR).toBe(2);
    expect(timers.slept).toEqual([199, 399, 799]);
  });

  it("is full jitter, not equal delays: random() scales the whole window", async () => {
    const timers = fakeTimers();
    const fetchFn = vi.fn(async () => jsonResponse(503, {}));
    const client = new JevClient({
      apiKey: SECRET_KEY,
      retries: 3,
      timeoutMs: 60_000,
      random: () => 0,
      fetch: fetchFn as unknown as typeof fetch,
      now: timers.now,
      sleep: timers.sleep,
    });

    await expect(client.systemone(ask)).rejects.toMatchObject({ kind: "http" });
    // A herd that all retried at once would wait the same fixed delay;
    // full jitter lets a draw of 0 go immediately.
    expect(timers.slept).toEqual([0, 0, 0]);
  });

  it("keeps every sleep inside its window for any draw", async () => {
    for (const draw of [0, 0.25, 0.5, 0.75, 0.999]) {
      const timers = fakeTimers();
      const fetchFn = vi.fn(async () => jsonResponse(503, {}));
      const client = new JevClient({
        apiKey: SECRET_KEY,
        retries: 3,
        timeoutMs: 60_000,
        random: () => draw,
        fetch: fetchFn as unknown as typeof fetch,
        now: timers.now,
        sleep: timers.sleep,
      });
      await expect(client.systemone(ask)).rejects.toMatchObject({ kind: "http" });

      timers.slept.forEach((ms, attempt) => {
        expect(ms).toBeGreaterThanOrEqual(0);
        expect(ms).toBeLessThan(RETRY_BASE_MS * RETRY_FACTOR ** attempt);
      });
    }
  });
});

describe("JevClient: Retry-After", () => {
  it("waits exactly what a delay-seconds header asks for, not the computed backoff", async () => {
    const timers = fakeTimers();
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, { detail: "slow down" }, { "retry-after": "2" }))
      .mockResolvedValueOnce(okResponse("req_after_wait"));
    const client = new JevClient({
      apiKey: SECRET_KEY,
      timeoutMs: 60_000,
      random: () => 0.999_999,
      fetch: fetchFn as unknown as typeof fetch,
      now: timers.now,
      sleep: timers.sleep,
    });

    await expect(client.systemone(ask)).resolves.toMatchObject({ requestId: "req_after_wait" });
    // 2000, not the 199 the jitter window would have chosen.
    expect(timers.slept).toEqual([2_000]);
  });

  it("honours an HTTP-date header", async () => {
    const timers = fakeTimers();
    const when = new Date(timers.now() + 3_000).toUTCString();
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(503, {}, { "retry-after": when }))
      .mockResolvedValueOnce(okResponse());
    const client = new JevClient({
      apiKey: SECRET_KEY,
      timeoutMs: 60_000,
      fetch: fetchFn as unknown as typeof fetch,
      now: timers.now,
      sleep: timers.sleep,
    });

    await expect(client.systemone(ask)).resolves.toBeDefined();
    // toUTCString drops sub-second precision, so allow the rounding.
    expect(timers.slept[0]).toBeGreaterThanOrEqual(2_000);
    expect(timers.slept[0]).toBeLessThanOrEqual(3_000);
  });

  it("surfaces retryAfterMs on the error when it gives up", async () => {
    const timers = fakeTimers();
    const fetchFn = vi.fn(async () => jsonResponse(429, {}, { "retry-after": "7" }));
    const client = new JevClient({
      apiKey: SECRET_KEY,
      retries: 0,
      fetch: fetchFn as unknown as typeof fetch,
      ...timers,
    });

    const err = (await client.systemone(ask).catch((e: unknown) => e)) as JevError;
    expect(err).toBeInstanceOf(JevError);
    expect(err.kind).toBe("http");
    expect(err.status).toBe(429);
    expect(err.retryAfterMs).toBe(7_000);
  });

  it("leaves retryAfterMs undefined when the server sent no header", async () => {
    const timers = fakeTimers();
    const fetchFn = vi.fn(async () => jsonResponse(503, {}));
    const client = new JevClient({
      apiKey: SECRET_KEY,
      retries: 0,
      fetch: fetchFn as unknown as typeof fetch,
      ...timers,
    });

    const err = (await client.systemone(ask).catch((e: unknown) => e)) as JevError;
    expect(err.retryAfterMs).toBeUndefined();
  });
});

describe("JevClient: the total budget", () => {
  it("stops retrying rather than sleeping past the caller's budget", async () => {
    const timers = fakeTimers();
    const fetchFn = vi.fn(async () => jsonResponse(503, {}, { "retry-after": "60" }));
    const client = new JevClient({
      apiKey: SECRET_KEY,
      retries: 3,
      fetch: fetchFn as unknown as typeof fetch,
      ...timers,
    });

    // The server asked for a minute; the caller will wait three seconds.
    await expect(client.systemone(ask, { budgetMs: 3_000 })).rejects.toMatchObject({
      kind: "http",
      status: 503,
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(timers.slept).toEqual([]);
  });

  it("a per-call budget overrides the client's default", async () => {
    const timers = fakeTimers();
    const fetchFn = vi.fn(async () => jsonResponse(503, {}, { "retry-after": "10" }));
    const client = new JevClient({
      apiKey: SECRET_KEY,
      retries: 3,
      timeoutMs: 60_000,
      fetch: fetchFn as unknown as typeof fetch,
      ...timers,
    });

    // With the client's own 60s budget there is room for the 10s wait...
    await expect(client.systemone(ask)).rejects.toMatchObject({ kind: "http" });
    expect(fetchFn).toHaveBeenCalledTimes(4);

    // ...but a 3s per-call budget leaves none.
    fetchFn.mockClear();
    await expect(client.systemone(ask, { budgetMs: 3_000 })).rejects.toMatchObject({ kind: "http" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("defaults the budget to ROUTER_LIMITS.jevTimeoutMs", () => {
    expect(ROUTER_LIMITS.jevTimeoutMs).toBe(3_000);
  });

  it("reports a timeout when the budget is already spent", async () => {
    const timers = fakeTimers();
    const fetchFn = vi.fn(async () => {
      timers.advance(5_000);
      return jsonResponse(503, {});
    });
    const client = new JevClient({
      apiKey: SECRET_KEY,
      retries: 3,
      fetch: fetchFn as unknown as typeof fetch,
      ...timers,
    });

    await expect(client.systemone(ask, { budgetMs: 1_000 })).rejects.toMatchObject({ kind: "http" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("times out per the budget and does not retry", async () => {
    const fetchFn = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        }),
    );
    const client = new JevClient({
      apiKey: SECRET_KEY,
      timeoutMs: 20,
      retries: 3,
      fetch: fetchFn as unknown as typeof fetch,
    });

    const start = Date.now();
    await expect(client.systemone(ask)).rejects.toMatchObject({ name: "JevError", kind: "timeout" });
    expect(Date.now() - start).toBeLessThan(500);
    // A timeout means the budget is gone, so there is nothing left to retry in.
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe("JevClient: the API key never leaks", () => {
  it("never includes the API key in an error's message or properties", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse(401, { detail: { error_type: "authentication_error", message: "bad key" } }),
    );
    const client = new JevClient({ apiKey: SECRET_KEY, fetch: fetchFn as unknown as typeof fetch });

    let caught: unknown;
    try {
      await client.systemone(ask);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(JevError);
    const err = caught as JevError;
    expect(err.message).not.toContain(SECRET_KEY);
    expect(JSON.stringify(err)).not.toContain(SECRET_KEY);
    expect(Object.values(err).join(" ")).not.toContain(SECRET_KEY);
    // Also verify the outgoing request actually carried the key (sanity: we
    // are testing that it doesn't leak back out, not that auth is broken).
    const sentInit = fetchFn.mock.calls[0]?.[1] as RequestInit | undefined;
    const headers = sentInit?.headers as Record<string, string> | undefined;
    expect(headers?.authorization).toBe(`Bearer ${SECRET_KEY}`);
  });

  it("never carries an upstream error body into the error it throws", async () => {
    const timers = fakeTimers();
    const fetchFn = vi.fn(async () =>
      jsonResponse(500, { detail: `internal: Bearer ${SECRET_KEY} rejected by upstream` }),
    );
    const client = new JevClient({
      apiKey: SECRET_KEY,
      retries: 0,
      fetch: fetchFn as unknown as typeof fetch,
      ...timers,
    });

    const err = (await client.systemone(ask).catch((e: unknown) => e)) as JevError;
    const serialized = `${err.message} ${JSON.stringify(err)}`;
    expect(serialized).not.toContain(SECRET_KEY);
    expect(serialized).not.toContain("Bearer");
  });
});

describe("JevClient: OpenRouter transport (ADR-021)", () => {
  const FORWARDED_KEY = "sk-or-v1-forwarded-user-key-abc123";

  /** Captures the url, auth header and JSON body of each fetch call. */
  function capturingFetch(response: Response): {
    fetch: typeof fetch;
    calls: Array<{ url: string; authorization: string | undefined; body: unknown }>;
  } {
    const calls: Array<{ url: string; authorization: string | undefined; body: unknown }> = [];
    const fn = vi.fn(async (input: unknown, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push({
        url: String(input),
        authorization: headers.get("authorization") ?? undefined,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      return response;
    });
    return { fetch: fn as unknown as typeof fetch, calls };
  }

  function decisionResponse(body: Record<string, unknown>, headers: Record<string, string> = {}): Response {
    return jsonResponse(
      200,
      {
        model: "typesafe/jev-1.13-20260917",
        answers: { a: { type: "noul", noul: 0.7 } },
        usage: { input_tokens: 393, output_tokens: 72, cost: 0.0000165 },
        provider: "TypeSafe",
        ...body,
      },
      headers,
    );
  }

  it("POSTs to /api/alpha/decisions with the tilde slug and the forwarded key", async () => {
    const cap = capturingFetch(
      decisionResponse({ id: "gen-dec-1" }, { "x-generation-id": "gen-dec-1" }),
    );
    const client = new JevClient({ apiKey: "", transport: "openrouter", fetch: cap.fetch });

    const result = await client.systemone(ask, { apiKey: FORWARDED_KEY });

    expect(cap.calls).toHaveLength(1);
    expect(cap.calls[0]?.url).toBe("https://openrouter.ai/api/alpha/decisions");
    expect(cap.calls[0]?.authorization).toBe(`Bearer ${FORWARDED_KEY}`);
    expect((cap.calls[0]?.body as { model?: string }).model).toBe(JEV_OPENROUTER_MODEL);
    expect(result.requestId).toBe("gen-dec-1");
  });

  it("rewrites a bare jev-latest model to the tilde slug", async () => {
    const cap = capturingFetch(decisionResponse({}, { "x-generation-id": "gen-dec-2" }));
    const client = new JevClient({ apiKey: "", transport: "openrouter", fetch: cap.fetch });

    await client.systemone({ ...ask, model: JEV_DEFAULT_MODEL }, { apiKey: FORWARDED_KEY });

    expect((cap.calls[0]?.body as { model?: string }).model).toBe(JEV_OPENROUTER_MODEL);
  });

  it("reads the request id from the body's id when the header is absent", async () => {
    const cap = capturingFetch(decisionResponse({ id: "gen-dec-body" }));
    const client = new JevClient({ apiKey: "", transport: "openrouter", fetch: cap.fetch });

    const result = await client.systemone(ask, { apiKey: FORWARDED_KEY });

    expect(result.requestId).toBe("gen-dec-body");
  });

  it("prefers the per-call key over any configured one", async () => {
    const cap = capturingFetch(decisionResponse({}, { "x-generation-id": "g" }));
    const client = new JevClient({ apiKey: "configured", transport: "openrouter", fetch: cap.fetch });

    await client.systemone(ask, { apiKey: FORWARDED_KEY });

    expect(cap.calls[0]?.authorization).toBe(`Bearer ${FORWARDED_KEY}`);
  });

  it("rejects a call with neither a per-call nor a configured key", async () => {
    const cap = capturingFetch(decisionResponse({}, { "x-generation-id": "g" }));
    const client = new JevClient({ apiKey: "", transport: "openrouter", fetch: cap.fetch });

    const err = (await client.systemone(ask).catch((e: unknown) => e)) as JevError;
    expect(err).toBeInstanceOf(JevError);
    expect(err.kind).toBe("validation");
    expect(cap.calls).toHaveLength(0);
  });

  it("allows construction without a key (the key arrives per call)", () => {
    expect(() => new JevClient({ transport: "openrouter" })).not.toThrow();
  });
});

describe("JevClient: the TypeSafe transport ignores a forwarded key", () => {
  it("uses the configured Jev key and the /v1/systemone path, never the forwarded key", async () => {
    const calls: Array<{ url: string; authorization: string | undefined }> = [];
    const fetchFn = vi.fn(async (input: unknown, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push({ url: String(input), authorization: headers.get("authorization") ?? undefined });
      return okResponse();
    });
    const client = new JevClient({ apiKey: SECRET_KEY, fetch: fetchFn as unknown as typeof fetch });

    // A forwarded OpenRouter key is offered but MUST be ignored by TypeSafe.
    await client.systemone(ask, { apiKey: "sk-or-v1-should-never-be-sent-to-typesafe" });

    expect(calls[0]?.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(calls[0]?.authorization).toBe(`Bearer ${SECRET_KEY}`);
    expect(calls[0]?.authorization).not.toContain("sk-or-v1");
  });
});
