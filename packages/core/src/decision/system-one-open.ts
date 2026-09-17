/**
 * `JevClientLike` over `mithalouni/system-one-open` (MIT), an open replica of
 * TypeSafe's Jev that serves the same three primitives from a FastAPI
 * `POST /decide`.
 *
 * The router only ever sees `SystemOneRequest` in and `SystemOneResult` out
 * (ADR-004), so everything specific to the open backend lives here: the wire
 * shape (a *list* of questions each carrying its own `id`, rather than Jev's
 * record keyed by name), the folding of a noul question's true/false criteria
 * into one instruction string, and the rebuilding of a score answer's legend,
 * which the open backend does not return.
 *
 * Failures are raised as `JevError` with the same four `kind`s the real Jev
 * client uses, so `classifyFailure` in the router keeps working unchanged and
 * a degraded decision still names the class of failure and never upstream
 * text.
 */

import { ulid } from "ulid";
import { JevError } from "../jev/client.js";
import type {
  JevAnswer,
  JevChoiceAnswer,
  JevChoiceQuestion,
  JevClientLike,
  JevNoulAnswer,
  JevNoulQuestion,
  JevQuestion,
  JevScoreAnswer,
  JevScoreQuestion,
  SystemOneRequest,
  SystemOneResult,
} from "../jev/types.js";

/** The public demo deployment. Scales to zero; the first call after idle is slow. */
export const SYSTEM_ONE_OPEN_DEMO_URL = "https://mithalouni--jev-serve-e2b-full-server-web.modal.run";

/** Default per-call budget. The demo answers in about 850 ms warm. */
export const SYSTEM_ONE_OPEN_DEFAULT_TIMEOUT_MS = 1_500;

/** Prefix on the synthetic request id, since the backend sends none. */
export const SYSTEM_ONE_OPEN_REQUEST_ID_PREFIX = "s1o_";

/** Prefix on the reported model name, so a decision log row says which backend answered. */
export const SYSTEM_ONE_OPEN_MODEL_PREFIX = "system-one-open";

// ---------------------------------------------------------------------------
// Wire shapes of the open backend
// ---------------------------------------------------------------------------

export type OpenChoiceQuestion = {
  id: string;
  type: "choice";
  instructions: string;
  /** Option name -> description. A Jev criterion of `null` becomes the name. */
  options: Record<string, string>;
};

export type OpenScoreQuestion = {
  id: string;
  type: "score";
  instructions: string;
  /** Ordered level descriptions; index is the score. */
  levels: string[];
};

export type OpenNoulQuestion = {
  id: string;
  type: "noul";
  instructions: string;
};

export type OpenQuestion = OpenChoiceQuestion | OpenScoreQuestion | OpenNoulQuestion;

export type OpenDecideRequest = {
  state: string | Record<string, unknown>;
  questions: OpenQuestion[];
};

export type SystemOneOpenInfo = {
  model?: string;
  temperature?: number;
  device?: string;
  primitives?: string[];
  max_single_pass_options?: number;
};

export type SystemOneOpenClientOptions = {
  /** Base URL of the deployment, without a trailing slash (one is tolerated). */
  baseUrl: string;
  /** Per-call budget in ms. Default `SYSTEM_ONE_OPEN_DEFAULT_TIMEOUT_MS` (1500). */
  timeoutMs?: number;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /**
   * Overrides the model name reported by the backend in the `model` field of
   * the result (which is always prefixed `system-one-open/`). Useful when one
   * deployment serves a checkpoint whose own label is not meaningful.
   */
  modelLabel?: string;
};

// ---------------------------------------------------------------------------
// Request translation
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function trimmed(value: string | undefined): string {
  return value === undefined ? "" : value.trim();
}

/**
 * Folds a noul question's `instructions` and its `criteria.true` /
 * `criteria.false` into the single instruction string the open backend
 * accepts, so no part of the routing prompt is lost in translation.
 */
export function foldNoulInstructions(question: JevNoulQuestion): string {
  const parts: string[] = [];
  const instructions = trimmed(question.instructions);
  if (instructions !== "") parts.push(instructions);
  const whenTrue = trimmed(question.criteria?.true);
  if (whenTrue !== "") parts.push(`Answer true when: ${whenTrue}`);
  const whenFalse = trimmed(question.criteria?.false);
  if (whenFalse !== "") parts.push(`Answer false when: ${whenFalse}`);
  return parts.join("\n\n");
}

/** A choice criterion of `null` means "the name is the whole description". */
export function toOpenOptions(question: JevChoiceQuestion): Record<string, string> {
  const options: Record<string, string> = {};
  for (const [name, description] of Object.entries(question.criteria)) {
    const text = trimmed(description ?? undefined);
    options[name] = text === "" ? name : text;
  }
  return options;
}

function toOpenQuestion(id: string, question: JevQuestion): OpenQuestion {
  switch (question.type) {
    case "choice":
      return {
        id,
        type: "choice",
        instructions: trimmed(question.instructions),
        options: toOpenOptions(question),
      };
    case "score":
      return {
        id,
        type: "score",
        instructions: trimmed(question.instructions),
        levels: [...question.criteria],
      };
    case "noul":
      return { id, type: "noul", instructions: foldNoulInstructions(question) };
    default: {
      const exhaustive: never = question;
      throw new JevError(
        `unsupported question type: ${String((exhaustive as { type?: unknown }).type)}`,
        "validation",
      );
    }
  }
}

/**
 * Translates a Jev `SystemOneRequest` into the open backend's `POST /decide`
 * body. The `model` field has no counterpart there and is dropped; a state
 * that is neither a string nor a plain object is serialized, since the
 * backend accepts only those two.
 */
export function toOpenRequest(req: Pick<SystemOneRequest, "state" | "questions">): OpenDecideRequest {
  const state =
    typeof req.state === "string" || isRecord(req.state) ? req.state : JSON.stringify(req.state);
  const questions = Object.entries(req.questions).map(([id, question]) => toOpenQuestion(id, question));
  return { state, questions };
}

// ---------------------------------------------------------------------------
// Response translation
// ---------------------------------------------------------------------------

function probabilityRecord(value: unknown, id: string): Record<string, number> {
  if (!isRecord(value)) {
    throw new JevError(`answer "${id}" is missing probabilities`, "validation");
  }
  const out: Record<string, number> = {};
  for (const [key, probability] of Object.entries(value)) {
    if (!finite(probability)) {
      throw new JevError(`answer "${id}" has a non-numeric probability for "${key}"`, "validation");
    }
    out[key] = probability;
  }
  return out;
}

/** The legend the open backend does not return, rebuilt from the request. */
export function legendFor(question: JevScoreQuestion): Record<string, string> {
  const legend: Record<string, string> = {};
  question.criteria.forEach((text, index) => {
    legend[String(index)] = text;
  });
  return legend;
}

/**
 * Rekeys a score answer's probabilities by level index. The backend keys them
 * by index already when it echoes numeric levels, but keys them by level text
 * when the levels were given as names, so both are normalized here.
 */
function scoreProbabilities(
  raw: Record<string, number>,
  question: JevScoreQuestion,
): Record<string, number> {
  const indexOfLevel = new Map<string, number>();
  question.criteria.forEach((text, index) => indexOfLevel.set(text, index));

  const out: Record<string, number> = {};
  for (const [key, probability] of Object.entries(raw)) {
    const byText = indexOfLevel.get(key);
    out[byText !== undefined ? String(byText) : key] = probability;
  }
  return out;
}

function toJevAnswer(id: string, question: JevQuestion, answer: Record<string, unknown>): JevAnswer {
  switch (question.type) {
    case "choice": {
      const choice = answer["choice"];
      if (typeof choice !== "string") {
        throw new JevError(`answer "${id}" is missing a choice`, "validation");
      }
      const confidence = answer["confidence"];
      const result: JevChoiceAnswer = {
        type: "choice",
        choice,
        confidence: finite(confidence) ? confidence : 0,
        probabilities: probabilityRecord(answer["probabilities"], id),
      };
      return result;
    }
    case "score": {
      const score = answer["score"];
      if (!finite(score)) {
        throw new JevError(`answer "${id}" is missing a score`, "validation");
      }
      const confidence = answer["confidence"];
      const result: JevScoreAnswer = {
        type: "score",
        score,
        confidence: finite(confidence) ? confidence : 0,
        legend: legendFor(question),
        probabilities: scoreProbabilities(probabilityRecord(answer["probabilities"], id), question),
      };
      return result;
    }
    case "noul": {
      const noul = answer["noul"];
      if (!finite(noul)) {
        throw new JevError(`answer "${id}" is missing a noul`, "validation");
      }
      const result: JevNoulAnswer = { type: "noul", noul };
      return result;
    }
    default: {
      const exhaustive: never = question;
      throw new JevError(
        `unsupported question type: ${String((exhaustive as { type?: unknown }).type)}`,
        "validation",
      );
    }
  }
}

/**
 * Turns the open backend's `{ answers: [...] }` list into the record keyed by
 * question name that `SystemOneResponse` declares. An answer the request did
 * not ask for is ignored; a question with no answer is a validation failure,
 * because a router that guesses around a missing signal routes badly.
 */
export function toJevAnswers(
  questions: Record<string, JevQuestion>,
  rawAnswers: unknown,
): Record<string, JevAnswer> {
  if (!Array.isArray(rawAnswers)) {
    throw new JevError("system-one-open response carries no answers array", "validation");
  }

  const byId = new Map<string, Record<string, unknown>>();
  for (const entry of rawAnswers) {
    if (!isRecord(entry)) continue;
    const id = entry["id"];
    if (typeof id === "string") byId.set(id, entry);
  }

  const answers: Record<string, JevAnswer> = {};
  for (const [id, question] of Object.entries(questions)) {
    const raw = byId.get(id);
    if (raw === undefined) {
      throw new JevError(`system-one-open response is missing answer "${id}"`, "validation");
    }
    answers[id] = toJevAnswer(id, question, raw);
  }
  return answers;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

export class SystemOneOpenClient implements JevClientLike {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly modelLabel: string | undefined;

  constructor(options: SystemOneOpenClientOptions) {
    const baseUrl = (options.baseUrl ?? "").replace(/\/+$/, "");
    if (baseUrl === "") {
      throw new JevError("baseUrl is required", "validation");
    }
    this.baseUrl = baseUrl;
    this.timeoutMs = options.timeoutMs ?? SYSTEM_ONE_OPEN_DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetch ?? fetch;
    this.modelLabel = options.modelLabel;
  }

  async systemone(
    req: Omit<SystemOneRequest, "model"> & { model?: string },
    opts?: { signal?: AbortSignal },
  ): Promise<SystemOneResult> {
    const body = JSON.stringify(toOpenRequest(req));
    const start = Date.now();
    const response = await this.send("POST", `${this.baseUrl}/decide`, body, opts?.signal);
    const latencyMs = Date.now() - start;
    const parsed = await this.readJson(response);

    if (!isRecord(parsed)) {
      throw new JevError("system-one-open response was not an object", "validation");
    }

    const answers = toJevAnswers(req.questions, parsed["answers"]);
    const reported = parsed["model"];
    const model = this.modelLabel ?? (typeof reported === "string" && reported !== "" ? reported : "unknown");

    return {
      model: `${SYSTEM_ONE_OPEN_MODEL_PREFIX}/${model}`,
      answers,
      // The backend reports no token counts, and inventing them would put a
      // fiction in the decision log.
      usage: { input_tokens: 0, output_tokens: 0 },
      requestId: `${SYSTEM_ONE_OPEN_REQUEST_ID_PREFIX}${ulid()}`,
      latencyMs,
    };
  }

  /**
   * GETs `/info` and swallows every failure. The demo deployment scales to
   * zero and takes about 35 s to come back, so a server that expects to route
   * through it should call this at startup and not wait on the result.
   */
  async warmup(opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<SystemOneOpenInfo | undefined> {
    try {
      const response = await this.send(
        "GET",
        `${this.baseUrl}/info`,
        undefined,
        opts?.signal,
        opts?.timeoutMs,
      );
      const parsed = await this.readJson(response);
      return isRecord(parsed) ? (parsed as SystemOneOpenInfo) : undefined;
    } catch {
      return undefined;
    }
  }

  private async send(
    method: string,
    url: string,
    body: string | undefined,
    callerSignal?: AbortSignal,
    timeoutMsOverride?: number,
  ): Promise<Response> {
    const timeoutMs = timeoutMsOverride ?? this.timeoutMs;
    const controller = new AbortController();
    let timedOut = false;
    let callerAborted = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onCallerAbort = (): void => {
      callerAborted = true;
      controller.abort();
    };
    if (callerSignal?.aborted) {
      callerAborted = true;
      controller.abort();
    } else {
      callerSignal?.addEventListener("abort", onCallerAbort);
    }

    let response: Response;
    try {
      const init: RequestInit = {
        method,
        headers: { "content-type": "application/json", accept: "application/json" },
        signal: controller.signal,
      };
      if (body !== undefined) init.body = body;
      response = await this.fetchImpl(url, init);
    } catch (err) {
      if (isAbortError(err)) {
        const reason = callerSignal?.reason as { name?: unknown } | undefined;
        // A caller signal built with AbortSignal.timeout carries a
        // TimeoutError reason; that is a timeout, not a generic abort.
        if (callerAborted && isRecord(reason) && reason["name"] === "TimeoutError") {
          throw new JevError("system-one-open request timed out: caller deadline", "timeout", { cause: err });
        }
        if (callerAborted) {
          throw new JevError("system-one-open request aborted by caller", "network", { cause: err });
        }
        if (timedOut) {
          throw new JevError(`system-one-open request timed out after ${timeoutMs}ms`, "timeout", {
            cause: err,
          });
        }
      }
      throw new JevError("system-one-open network request failed", "network", { cause: err });
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    }

    if (!response.ok) {
      // Drain the body so the connection can be reused, and drop it: upstream
      // text never reaches a reason string or the decision log (ADR-003).
      await response.text().catch(() => undefined);
      throw new JevError(`system-one-open request failed with status ${response.status}`, "http", {
        status: response.status,
      });
    }
    return response;
  }

  private async readJson(response: Response): Promise<unknown> {
    let text: string;
    try {
      text = await response.text();
    } catch (err) {
      throw new JevError("system-one-open response body was unreadable", "validation", { cause: err });
    }
    if (text.length === 0) {
      throw new JevError("system-one-open response body was empty", "validation");
    }
    try {
      return JSON.parse(text);
    } catch (err) {
      throw new JevError("system-one-open response was not valid JSON", "validation", { cause: err });
    }
  }
}
