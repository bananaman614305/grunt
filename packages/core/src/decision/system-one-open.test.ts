/**
 * `SystemOneOpenClient` against a stub fetch. The happy path replays one
 * exchange recorded live from the public demo
 * (`__fixtures__/router-questions.decide.json`), so the translation is tested
 * against the real wire format rather than a shape invented here.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { JevError } from "../jev/client.js";
import type { JevChoiceQuestion, JevNoulQuestion, JevQuestion, JevScoreQuestion } from "../jev/types.js";
import { ROUTER_QUESTIONS } from "../router/questions.js";
import {
  SystemOneOpenClient,
  SYSTEM_ONE_OPEN_DEFAULT_TIMEOUT_MS,
  foldNoulInstructions,
  legendFor,
  toOpenRequest,
} from "./system-one-open.js";
import type { OpenChoiceQuestion, OpenNoulQuestion, OpenScoreQuestion } from "./system-one-open.js";

const BASE_URL = "https://open.example.test";

type Recorded = {
  request: { state: unknown; questions: unknown[] };
  status: number;
  response: {
    answers: Array<Record<string, unknown>>;
    latency_ms: number;
    passes: number;
    model: string;
  };
};

function recorded(): Recorded {
  const url = new URL("./__fixtures__/router-questions.decide.json", import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as Recorded;
}

type Call = { url: string; init: RequestInit | undefined };

function stubFetch(handler: (call: Call) => Response | Promise<Response>): {
  fetch: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const impl = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : String(input);
    const call: Call = { url, init };
    calls.push(call);
    return handler(call);
  };
  return { fetch: impl as unknown as typeof fetch, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function client(fetchImpl: typeof fetch, timeoutMs?: number): SystemOneOpenClient {
  return new SystemOneOpenClient({
    baseUrl: BASE_URL,
    fetch: fetchImpl,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
}

/** The question set used by most translation tests: one of each type. */
const CHOICE: JevChoiceQuestion = {
  type: "choice",
  instructions: "Which kind of work is this?",
  criteria: { edit: "A bounded change.", feature: null, debug: "  " },
};

const SCORE: JevScoreQuestion = {
  type: "score",
  instructions: "How hard is it?",
  criteria: ["Trivial work.", "Routine work.", "Substantial work.", "Hard work."],
};

const NOUL: JevNoulQuestion = {
  type: "noul",
  instructions: "Does it need step-by-step reasoning?",
  criteria: { true: "It must be derived.", false: "It can be written directly." },
};

const QUESTIONS: Record<string, JevQuestion> = {
  task_type: CHOICE,
  difficulty: SCORE,
  needs_reasoning: NOUL,
};

// ---------------------------------------------------------------------------
// Request translation
// ---------------------------------------------------------------------------

describe("request translation", () => {
  it("turns the questions record into a list carrying each question's id", () => {
    const body = toOpenRequest({ state: "hello", questions: QUESTIONS });

    expect(body.state).toBe("hello");
    expect(body.questions.map((q) => q.id)).toEqual(["task_type", "difficulty", "needs_reasoning"]);
    expect(body.questions.map((q) => q.type)).toEqual(["choice", "score", "noul"]);
  });

  it("maps choice criteria to options, substituting the name for a null or blank description", () => {
    const [choice] = toOpenRequest({ state: "s", questions: { task_type: CHOICE } })
      .questions as [OpenChoiceQuestion];

    expect(choice.options).toEqual({
      edit: "A bounded change.",
      // `null` means "the name is the whole description".
      feature: "feature",
      // A whitespace-only description is no description either.
      debug: "debug",
    });
    expect(choice.instructions).toBe("Which kind of work is this?");
  });

  it("maps score criteria to levels, preserving order", () => {
    const [score] = toOpenRequest({ state: "s", questions: { difficulty: SCORE } })
      .questions as [OpenScoreQuestion];

    expect(score.levels).toEqual(SCORE.criteria);
    // A copy, so mutating the wire body cannot edit the routing prompt.
    expect(score.levels).not.toBe(SCORE.criteria);
  });

  it("folds a noul question's true/false criteria into its instructions", () => {
    const [noul] = toOpenRequest({ state: "s", questions: { needs_reasoning: NOUL } })
      .questions as [OpenNoulQuestion];

    expect(noul.instructions).toBe(
      "Does it need step-by-step reasoning?\n\n" +
        "Answer true when: It must be derived.\n\n" +
        "Answer false when: It can be written directly.",
    );
    expect(noul).not.toHaveProperty("criteria");
  });

  it("folds only the criteria that are present", () => {
    expect(foldNoulInstructions({ type: "noul", instructions: "Just this." })).toBe("Just this.");
    expect(foldNoulInstructions({ type: "noul", criteria: { true: "Only true." } })).toBe(
      "Answer true when: Only true.",
    );
    expect(
      foldNoulInstructions({ type: "noul", instructions: "Q.", criteria: { false: "Only false." } }),
    ).toBe("Q.\n\nAnswer false when: Only false.");
  });

  it("serializes a state that is neither a string nor an object", () => {
    const body = toOpenRequest({ state: [1, 2], questions: {} });
    expect(body.state).toBe("[1,2]");
  });

  it("passes an object state through untouched and drops the jev model field", () => {
    const state = { system: "s", recent_user_turns: ["u"] };
    const body = toOpenRequest({ state, questions: {} });

    expect(body.state).toEqual(state);
    expect(body).not.toHaveProperty("model");
  });

  it("POSTs /decide with a JSON body and no authorization header", async () => {
    const { fetch: fetchImpl, calls } = stubFetch(() =>
      json({ answers: [{ id: "needs_reasoning", type: "noul", noul: 0.5 }], model: "e2b-full" }),
    );

    await client(fetchImpl).systemone({ state: "s", questions: { needs_reasoning: NOUL } });

    const call = calls[0];
    expect(call?.url).toBe(`${BASE_URL}/decide`);
    expect(call?.init?.method).toBe("POST");
    const headers = call?.init?.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain("authorization");
  });

  it("tolerates a trailing slash on the base URL", async () => {
    const { fetch: fetchImpl, calls } = stubFetch(() => json({ answers: [] }));
    const c = new SystemOneOpenClient({ baseUrl: `${BASE_URL}///`, fetch: fetchImpl });

    await c.systemone({ state: "s", questions: {} });

    expect(calls[0]?.url).toBe(`${BASE_URL}/decide`);
  });

  it("rejects an empty base URL as a validation error", () => {
    expect(() => new SystemOneOpenClient({ baseUrl: "" })).toThrow(JevError);
  });
});

// ---------------------------------------------------------------------------
// Response translation
// ---------------------------------------------------------------------------

describe("response translation", () => {
  it("replays the recorded demo exchange into the SystemOneResult shape", async () => {
    const fixture = recorded();
    const { fetch: fetchImpl, calls } = stubFetch(() => json(fixture.response, fixture.status));

    const result = await client(fetchImpl).systemone({
      state: fixture.request.state as Record<string, unknown>,
      questions: ROUTER_QUESTIONS,
    });

    // The request we send is byte-identical to the one that was recorded.
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual(fixture.request);

    expect(result.model).toBe("system-one-open/e2b-full");
    expect(result.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
    expect(result.requestId).toMatch(/^s1o_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);

    expect(Object.keys(result.answers).sort()).toEqual([
      "difficulty",
      "long_output",
      "needs_reasoning",
      "task_type",
    ]);

    const task = result.answers["task_type"];
    expect(task).toMatchObject({ type: "choice", choice: "debug" });

    const difficulty = result.answers["difficulty"];
    expect(difficulty).toMatchObject({ type: "score", score: 1.758479192852974 });

    expect(result.answers["needs_reasoning"]).toEqual({ type: "noul", noul: 0.9727447032928467 });
    expect(result.answers["long_output"]).toEqual({ type: "noul", noul: 0.6209278106689453 });
  });

  it("rebuilds a score legend from the request's criteria and keys probabilities by index", async () => {
    const { fetch: fetchImpl } = stubFetch(() =>
      json({
        model: "e2b-full",
        answers: [
          {
            id: "difficulty",
            type: "score",
            score: 2.06,
            level: "2",
            probabilities: { "0": 0.01, "1": 0.14, "2": 0.62, "3": 0.23 },
            confidence: 0.4,
          },
        ],
      }),
    );

    const result = await client(fetchImpl).systemone({ state: "s", questions: { difficulty: SCORE } });

    expect(result.answers["difficulty"]).toEqual({
      type: "score",
      score: 2.06,
      confidence: 0.4,
      legend: {
        "0": "Trivial work.",
        "1": "Routine work.",
        "2": "Substantial work.",
        "3": "Hard work.",
      },
      probabilities: { "0": 0.01, "1": 0.14, "2": 0.62, "3": 0.23 },
    });
    expect(legendFor(SCORE)["3"]).toBe("Hard work.");
  });

  it("rekeys score probabilities that came back keyed by level text", async () => {
    const { fetch: fetchImpl } = stubFetch(() =>
      json({
        model: "e2b-full",
        answers: [
          {
            id: "difficulty",
            type: "score",
            score: 1,
            probabilities: { "Trivial work.": 0.2, "Routine work.": 0.8 },
            confidence: 0.5,
          },
        ],
      }),
    );

    const result = await client(fetchImpl).systemone({ state: "s", questions: { difficulty: SCORE } });

    expect((result.answers["difficulty"] as { probabilities: unknown }).probabilities).toEqual({
      "0": 0.2,
      "1": 0.8,
    });
  });

  it("carries a choice answer through unchanged", async () => {
    const probabilities = { edit: 0.9, feature: 0.02, debug: 0.08 };
    const { fetch: fetchImpl } = stubFetch(() =>
      json({
        model: "e2b-full",
        answers: [{ id: "task_type", type: "choice", choice: "edit", probabilities, confidence: 0.81 }],
      }),
    );

    const result = await client(fetchImpl).systemone({ state: "s", questions: { task_type: CHOICE } });

    expect(result.answers["task_type"]).toEqual({
      type: "choice",
      choice: "edit",
      confidence: 0.81,
      probabilities,
    });
  });

  it("ignores an answer the request did not ask for", async () => {
    const { fetch: fetchImpl } = stubFetch(() =>
      json({
        model: "e2b-full",
        answers: [
          { id: "needs_reasoning", type: "noul", noul: 0.4 },
          { id: "not_asked", type: "noul", noul: 0.9 },
        ],
      }),
    );

    const result = await client(fetchImpl).systemone({
      state: "s",
      questions: { needs_reasoning: NOUL },
    });

    expect(Object.keys(result.answers)).toEqual(["needs_reasoning"]);
  });

  it("labels the model with modelLabel when one is configured", async () => {
    const { fetch: fetchImpl } = stubFetch(() => json({ model: "e2b-full", answers: [] }));
    const c = new SystemOneOpenClient({ baseUrl: BASE_URL, fetch: fetchImpl, modelLabel: "self-hosted" });

    const result = await c.systemone({ state: "s", questions: {} });

    expect(result.model).toBe("system-one-open/self-hosted");
  });

  it("falls back to `unknown` when the backend reports no model", async () => {
    const { fetch: fetchImpl } = stubFetch(() => json({ answers: [] }));

    const result = await client(fetchImpl).systemone({ state: "s", questions: {} });

    expect(result.model).toBe("system-one-open/unknown");
  });
});

// ---------------------------------------------------------------------------
// Error kinds
// ---------------------------------------------------------------------------

async function kindOf(promise: Promise<unknown>): Promise<{ kind: string; status?: number }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof JevError) {
      return error.status === undefined ? { kind: error.kind } : { kind: error.kind, status: error.status };
    }
    throw error;
  }
  throw new Error("expected the call to reject");
}

describe("error kinds", () => {
  it("reports its own deadline as a timeout", async () => {
    const { fetch: fetchImpl } = stubFetch(
      (call) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = call.init?.signal;
          signal?.addEventListener("abort", () => {
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          });
        }),
    );

    expect(await kindOf(client(fetchImpl, 10).systemone({ state: "s", questions: {} }))).toEqual({
      kind: "timeout",
    });
  });

  it("reports a caller deadline (AbortSignal.timeout) as a timeout", async () => {
    const { fetch: fetchImpl } = stubFetch(
      (call) =>
        new Promise<Response>((_resolve, reject) => {
          call.init?.signal?.addEventListener("abort", () => {
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          });
        }),
    );

    const signal = AbortSignal.timeout(10);
    expect(
      await kindOf(client(fetchImpl, 10_000).systemone({ state: "s", questions: {} }, { signal })),
    ).toEqual({ kind: "timeout" });
  });

  it("reports a caller abort as a network failure, the way JevClient does", async () => {
    const controller = new AbortController();
    const { fetch: fetchImpl } = stubFetch(
      (call) =>
        new Promise<Response>((_resolve, reject) => {
          call.init?.signal?.addEventListener("abort", () => {
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          });
          setTimeout(() => controller.abort(), 1);
        }),
    );

    expect(
      await kindOf(
        client(fetchImpl, 10_000).systemone({ state: "s", questions: {} }, { signal: controller.signal }),
      ),
    ).toEqual({ kind: "network" });
  });

  it("reports a 500 as an http failure carrying the status", async () => {
    const { fetch: fetchImpl } = stubFetch(() => new Response("upstream exploded", { status: 500 }));

    expect(await kindOf(client(fetchImpl).systemone({ state: "s", questions: {} }))).toEqual({
      kind: "http",
      status: 500,
    });
  });

  it("never carries the upstream body into the error message", async () => {
    const { fetch: fetchImpl } = stubFetch(() => new Response("SECRET-UPSTREAM-TEXT", { status: 502 }));

    await expect(client(fetchImpl).systemone({ state: "s", questions: {} })).rejects.toThrow(
      /^system-one-open request failed with status 502$/,
    );
  });

  it("reports a transport error as a network failure", async () => {
    const { fetch: fetchImpl } = stubFetch(() => {
      throw new TypeError("fetch failed");
    });

    expect(await kindOf(client(fetchImpl).systemone({ state: "s", questions: {} }))).toEqual({
      kind: "network",
    });
  });

  it("reports malformed JSON as a validation failure", async () => {
    const { fetch: fetchImpl } = stubFetch(
      () => new Response("{not json", { status: 200, headers: { "content-type": "application/json" } }),
    );

    expect(await kindOf(client(fetchImpl).systemone({ state: "s", questions: {} }))).toEqual({
      kind: "validation",
    });
  });

  it("reports an empty body as a validation failure", async () => {
    const { fetch: fetchImpl } = stubFetch(() => new Response("", { status: 200 }));

    expect(await kindOf(client(fetchImpl).systemone({ state: "s", questions: {} }))).toEqual({
      kind: "validation",
    });
  });

  it("reports a missing answer id as a validation failure, naming the question", async () => {
    const { fetch: fetchImpl } = stubFetch(() =>
      json({ model: "e2b-full", answers: [{ id: "task_type", type: "choice", choice: "edit", probabilities: {}, confidence: 1 }] }),
    );

    const call = client(fetchImpl).systemone({ state: "s", questions: QUESTIONS });

    expect(await kindOf(call)).toEqual({ kind: "validation" });
    await expect(
      client(fetchImpl).systemone({ state: "s", questions: QUESTIONS }),
    ).rejects.toThrow(/missing answer "difficulty"/);
  });

  it("reports an answers field that is not a list as a validation failure", async () => {
    const { fetch: fetchImpl } = stubFetch(() => json({ model: "e2b-full", answers: { task_type: {} } }));

    expect(await kindOf(client(fetchImpl).systemone({ state: "s", questions: QUESTIONS }))).toEqual({
      kind: "validation",
    });
  });

  it("reports an answer of the wrong shape as a validation failure", async () => {
    const { fetch: fetchImpl } = stubFetch(() =>
      json({ model: "e2b-full", answers: [{ id: "needs_reasoning", type: "noul" }] }),
    );

    expect(
      await kindOf(client(fetchImpl).systemone({ state: "s", questions: { needs_reasoning: NOUL } })),
    ).toEqual({ kind: "validation" });
  });
});

// ---------------------------------------------------------------------------
// Warmup
// ---------------------------------------------------------------------------

describe("warmup", () => {
  it("GETs /info and returns what it found", async () => {
    const { fetch: fetchImpl, calls } = stubFetch(() => json({ model: "e2b-full", device: "cuda" }));

    const info = await client(fetchImpl).warmup();

    expect(calls[0]?.url).toBe(`${BASE_URL}/info`);
    expect(calls[0]?.init?.method).toBe("GET");
    expect(calls[0]?.init?.body).toBeUndefined();
    expect(info).toMatchObject({ model: "e2b-full" });
  });

  it("swallows an HTTP failure", async () => {
    const { fetch: fetchImpl } = stubFetch(() => new Response("nope", { status: 503 }));
    await expect(client(fetchImpl).warmup()).resolves.toBeUndefined();
  });

  it("swallows a transport failure", async () => {
    const { fetch: fetchImpl } = stubFetch(() => {
      throw new TypeError("fetch failed");
    });
    await expect(client(fetchImpl).warmup()).resolves.toBeUndefined();
  });

  it("swallows a malformed body", async () => {
    const { fetch: fetchImpl } = stubFetch(() => new Response("{nope", { status: 200 }));
    await expect(client(fetchImpl).warmup()).resolves.toBeUndefined();
  });

  it("accepts a longer budget than a routed call, for a scale-to-zero deployment", async () => {
    const { fetch: fetchImpl } = stubFetch(() => json({ model: "e2b-full" }));

    await expect(client(fetchImpl).warmup({ timeoutMs: 60_000 })).resolves.toMatchObject({
      model: "e2b-full",
    });
    expect(SYSTEM_ONE_OPEN_DEFAULT_TIMEOUT_MS).toBe(1_500);
  });
});
