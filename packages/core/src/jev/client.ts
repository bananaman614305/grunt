/**
 * HTTP client for the TypeSafe Jev API. Implements `JevClientLike` from
 * `./types.ts`. Never logs or embeds the API key in any error message or
 * property; callers inject `fetch` for testing (see `./fixtures.ts`).
 */

import { ROUTER_LIMITS } from "../types.js";
import type {
  JevClientLike,
  JevModelMetadata,
  SystemOneRequest,
  SystemOneResponse,
  SystemOneResult,
} from "./types.js";
import { JEV_BASE_URL, JEV_DEFAULT_MODEL } from "./types.js";

const REQUEST_ID_HEADER = "x-typesafe-request-id";

export type JevErrorKind = "timeout" | "network" | "http" | "validation";

/** Error thrown by `JevClient`. Never carries the API key. */
export class JevError extends Error {
  readonly kind: JevErrorKind;
  readonly status?: number;
  readonly requestId?: string;

  constructor(
    message: string,
    kind: JevErrorKind,
    opts?: { status?: number; requestId?: string; cause?: unknown },
  ) {
    super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "JevError";
    this.kind = kind;
    if (opts?.status !== undefined) this.status = opts.status;
    if (opts?.requestId !== undefined) this.requestId = opts.requestId;
  }
}

export type JevClientOptions = {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  retries?: number;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetch?: typeof fetch;
};

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function jitterDelay(): Promise<void> {
  const ms = 50 + Math.random() * 100;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

async function safeText(response: Response): Promise<string | undefined> {
  try {
    return await response.text();
  } catch {
    return undefined;
  }
}

/** Sentinel thrown internally to distinguish our own timeout from other aborts. */
class TimeoutAbort extends Error {}
/** Sentinel thrown internally when the caller-supplied signal aborted the request. */
class CallerAbort extends Error {}

export class JevClient implements JevClientLike {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: JevClientOptions) {
    if (!options.apiKey) {
      throw new JevError("apiKey is required", "validation");
    }
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? JEV_BASE_URL).replace(/\/+$/, "");
    this.model = options.model ?? JEV_DEFAULT_MODEL;
    this.timeoutMs = options.timeoutMs ?? ROUTER_LIMITS.jevTimeoutMs;
    this.retries = options.retries ?? ROUTER_LIMITS.jevRetries;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async systemone(
    req: Omit<SystemOneRequest, "model"> & { model?: string },
    opts?: { signal?: AbortSignal },
  ): Promise<SystemOneResult> {
    const body: SystemOneRequest = {
      model: req.model ?? this.model,
      state: req.state,
      questions: req.questions,
    };
    const start = Date.now();
    const { response, requestId } = await this.send(
      "POST",
      `${this.baseUrl}/v1/systemone`,
      JSON.stringify(body),
      opts?.signal,
    );
    const latencyMs = Date.now() - start;
    const parsed = await this.readJson<SystemOneResponse>(response, requestId);
    assertSystemOneResponse(parsed, requestId);
    return { ...parsed, requestId, latencyMs };
  }

  async listModels(): Promise<JevModelMetadata[]> {
    const { response, requestId } = await this.send("GET", `${this.baseUrl}/v1/models`, undefined);
    const parsed = await this.readJson<unknown>(response, requestId);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !Array.isArray((parsed as { models?: unknown }).models)
    ) {
      throw new JevError("expected a { models: [...] } response", "validation", { requestId });
    }
    return (parsed as { models: JevModelMetadata[] }).models;
  }

  /** Sends one logical request, retrying per policy. */
  private async send(
    method: string,
    url: string,
    body: string | undefined,
    callerSignal?: AbortSignal,
  ): Promise<{ response: Response; requestId: string }> {
    let attempt = 0;
    for (;;) {
      attempt++;
      try {
        const response = await this.attempt(method, url, body, callerSignal);
        const requestId = response.headers.get(REQUEST_ID_HEADER) ?? "";
        if (response.ok) {
          return { response, requestId };
        }
        if (attempt <= this.retries && isRetryableStatus(response.status)) {
          await jitterDelay();
          continue;
        }
        await safeText(response);
        throw new JevError(`jev request failed with status ${response.status}`, "http", {
          status: response.status,
          requestId,
        });
      } catch (err) {
        if (err instanceof JevError) throw err;
        if (err instanceof CallerAbort) {
          throw new JevError("jev request aborted by caller", "network", { cause: err });
        }
        if (err instanceof TimeoutAbort) {
          throw new JevError(`jev request timed out after ${this.timeoutMs}ms`, "timeout", {
            cause: err,
          });
        }
        // Unclassified network failure (DNS, connection reset, etc).
        if (attempt <= this.retries) {
          await jitterDelay();
          continue;
        }
        throw new JevError("jev network request failed", "network", { cause: err });
      }
    }
  }

  /** Performs one HTTP attempt with the client's timeout, honoring a caller signal too. */
  private async attempt(
    method: string,
    url: string,
    body: string | undefined,
    callerSignal?: AbortSignal,
  ): Promise<Response> {
    const controller = new AbortController();
    let timedOut = false;
    let callerAborted = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
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
    try {
      const headers: Record<string, string> = {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      };
      const init: RequestInit = { method, headers, signal: controller.signal };
      if (body !== undefined) init.body = body;
      return await this.fetchImpl(url, init);
    } catch (err) {
      if (isAbortError(err)) {
        // A caller signal made with AbortSignal.timeout carries a TimeoutError
        // reason; report that as a timeout, not as a generic abort.
        const reason = callerSignal?.reason as { name?: unknown } | undefined;
        if (callerAborted && reason !== undefined && reason !== null && reason.name === "TimeoutError") {
          throw new TimeoutAbort();
        }
        if (callerAborted) throw new CallerAbort();
        if (timedOut) throw new TimeoutAbort();
      }
      throw err;
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    }
  }

  private async readJson<T>(response: Response, requestId: string): Promise<T> {
    const text = await safeText(response);
    if (text === undefined || text.length === 0) {
      throw new JevError("jev response body was empty or unreadable", "validation", { requestId });
    }
    try {
      return JSON.parse(text) as T;
    } catch (err) {
      throw new JevError("jev response was not valid JSON", "validation", {
        requestId,
        cause: err,
      });
    }
  }
}

function assertSystemOneResponse(value: unknown, requestId: string): asserts value is SystemOneResponse {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as { model?: unknown }).model !== "string" ||
    typeof (value as { answers?: unknown }).answers !== "object" ||
    (value as { answers?: unknown }).answers === null
  ) {
    throw new JevError("jev response did not match the systemone schema", "validation", { requestId });
  }
  const usage = (value as { usage?: unknown }).usage;
  if (
    typeof usage !== "object" ||
    usage === null ||
    typeof (usage as { input_tokens?: unknown }).input_tokens !== "number" ||
    typeof (usage as { output_tokens?: unknown }).output_tokens !== "number"
  ) {
    throw new JevError("jev response was missing usage token counts", "validation", { requestId });
  }
}
