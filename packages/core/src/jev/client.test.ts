import { describe, expect, it, vi } from "vitest";
import { JevClient, JevError } from "./client.js";
import { fixtureFetch } from "./fixtures.js";
import { choice, noul, score } from "./questions.js";

const FIXTURES_DIR = new URL("./__fixtures__", import.meta.url).pathname;
const SECRET_KEY = "sk-jev-do-not-leak-this-9f2e1c";

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("JevClient", () => {
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
    expect(models).toEqual([
      {
        name: "jev-latest",
        description: "General-purpose system one model, tuned for balanced accuracy and latency.",
        release_date: "2026-08-01",
      },
      {
        name: "jev-preview",
        description: "Preview model with the newest calibration; may change without notice.",
        release_date: "2026-09-10",
      },
    ]);
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
    const result = await client.systemone({ state: "hi", questions: { a: noul("q?") } });
    expect(result.requestId).toBe("");
  });

  it("times out per the configured budget and does not retry", async () => {
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
      retries: 1,
      fetch: fetchFn as unknown as typeof fetch,
    });

    const start = Date.now();
    await expect(client.systemone({ state: "hi", questions: { a: noul("q?") } })).rejects.toMatchObject({
      name: "JevError",
      kind: "timeout",
    });
    expect(Date.now() - start).toBeLessThan(200);
    expect(fetchFn).toHaveBeenCalledTimes(1); // timeout is not retried
  });

  it("retries once on a 503 and succeeds on the second attempt", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(503, { detail: "temporarily unavailable" }))
      .mockResolvedValueOnce(
        jsonResponse(
          200,
          {
            model: "jev-latest",
            answers: { a: { type: "noul", noul: 0.5 } },
            usage: { input_tokens: 1, output_tokens: 1 },
          },
          { "x-typesafe-request-id": "req_retry_ok" },
        ),
      );
    const client = new JevClient({ apiKey: SECRET_KEY, retries: 1, fetch: fetchFn as unknown as typeof fetch });

    const result = await client.systemone({ state: "hi", questions: { a: noul("q?") } });
    expect(result.requestId).toBe("req_retry_ok");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("does not retry on a 400", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(400, { detail: "bad request" }));
    const client = new JevClient({ apiKey: SECRET_KEY, retries: 2, fetch: fetchFn as unknown as typeof fetch });

    await expect(client.systemone({ state: "hi", questions: { a: noul("q?") } })).rejects.toMatchObject({
      name: "JevError",
      kind: "http",
      status: 400,
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("never includes the API key in an error's message or properties", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse(401, { detail: { error_type: "authentication_error", message: "bad key" } }),
    );
    const client = new JevClient({ apiKey: SECRET_KEY, fetch: fetchFn as unknown as typeof fetch });

    let caught: unknown;
    try {
      await client.systemone({ state: "hi", questions: { a: noul("q?") } });
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
});
