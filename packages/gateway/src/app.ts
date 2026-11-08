/**
 * The local Milo gateway (ADR-031): an OpenAI-compatible surface in front of
 * the user's own `codex` and `claude` subscriptions.
 *
 * `createApp` takes everything it needs as `AppDeps` and constructs nothing,
 * so tests drive the whole surface with fake backends and an in-memory store.
 * `createGateway` in `index.ts` is the only place that wires real CLIs.
 *
 * There is no API key: the gateway is meant to listen on the loopback
 * interface of the machine whose subscriptions it spends.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import { ROUTED_MODEL_ID, isSubscriptionId } from "@milo/core";
import type {
  CapacitySnapshot,
  ChatMessage,
  RouteResult,
  SubscriptionDecision,
  SubscriptionId,
  SubscriptionRouter,
  UsageStore,
  UsageTotals,
} from "@milo/core";
import { errorMessage, errorResponse } from "./errors.js";

/** The OpenAI stream terminator, sent verbatim rather than as JSON. */
const DONE = "[DONE]";

export type Logger = {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
};

export type AppDeps = {
  router: SubscriptionRouter;
  /** Per-backend labels for `/v1/usage` and `/v1/models`. */
  labels: Partial<Record<SubscriptionId, string>>;
  store?: UsageStore;
  logger: Logger;
  now: () => number;
};

/** The model ids Milo answers to, besides `codex/<model>` and `claude/<model>`. */
export function modelIds(available: SubscriptionId[]): string[] {
  return [ROUTED_MODEL_ID, ...available.map((id) => `milo/${id}`)];
}

type Target = { force?: SubscriptionId; model?: string };

/** Maps a request's `model` to a routing target, or `undefined` when Milo does not serve it. */
export function parseModel(model: string): Target | undefined {
  if (model === ROUTED_MODEL_ID || model === "milo") return {};
  const [prefix, ...rest] = model.split("/");
  const suffix = rest.join("/");
  if (prefix === "milo" && isSubscriptionId(suffix)) return { force: suffix };
  if (prefix !== undefined && isSubscriptionId(prefix)) {
    return suffix === "" ? { force: prefix } : { force: prefix, model: suffix };
  }
  return undefined;
}

function capacityHeader(capacity: CapacitySnapshot[]): string {
  return capacity
    .map((s) => {
      const left = s.remainingPercent !== undefined ? `${s.remainingPercent}%` : "unknown";
      return `${s.backend}=${left}${s.limited ? " limited" : ""}${s.source === "cli" ? "" : ` (${s.source})`}`;
    })
    .join(", ");
}

/** `x-milo-*` headers explaining a decision and, as far as known, its outcome. */
export function decisionHeaders(
  decision: SubscriptionDecision,
  attempts: Array<{ backend: SubscriptionId; error?: string }>,
  served: SubscriptionId | undefined,
  model: string | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {
    "x-milo-decision-id": decision.id,
    "x-milo-reason": ascii(decision.reason),
    "x-milo-task-type": decision.classification.taskType,
    "x-milo-difficulty": String(Math.round(decision.classification.difficulty * 100) / 100),
    "x-milo-classifier": decision.classification.source,
    "x-milo-capacity": ascii(capacityHeader(decision.capacity)),
  };
  if (served !== undefined) headers["x-milo-backend"] = served;
  if (model !== undefined) headers["x-milo-model"] = ascii(model);
  const failed = attempts.filter((a) => a.error !== undefined);
  if (failed.length > 0) headers["x-milo-failover"] = failed.map((a) => `${a.backend}:${a.error}`).join(", ");
  return headers;
}

function ascii(value: string): string {
  return value.replace(/[^\x20-\x7e]/g, "?");
}

function attemptsOf(result: RouteResult): Array<{ backend: SubscriptionId; error?: string }> {
  return result.attempts.map((a) => (a.outcome.ok ? { backend: a.backend } : { backend: a.backend, error: a.outcome.error }));
}

type ChatBody = {
  model?: unknown;
  messages?: unknown;
  stream?: unknown;
  stream_options?: { include_usage?: unknown };
  tools?: unknown;
  n?: unknown;
};

function isMessages(value: unknown): value is ChatMessage[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (m) =>
        typeof m === "object" &&
        m !== null &&
        typeof (m as { role?: unknown }).role === "string" &&
        ((m as { content?: unknown }).content === null ||
          typeof (m as { content?: unknown }).content === "string" ||
          Array.isArray((m as { content?: unknown }).content)),
    )
  );
}

function usageBody(result: RouteResult): { prompt_tokens: number; completion_tokens: number; total_tokens: number } {
  const usage = result.outcome.ok ? result.outcome.usage : { inputTokens: 0, outputTokens: 0 };
  return {
    prompt_tokens: usage.inputTokens,
    completion_tokens: usage.outputTokens,
    total_tokens: usage.inputTokens + usage.outputTokens,
  };
}

/** The status and OpenAI error for a request no subscription answered. */
function failureResponse(c: Context, result: RouteResult, headers: Record<string, string>): Response {
  const outcome = result.outcome;
  const allLimited = result.attempts.length > 0 && result.attempts.every((a) => !a.outcome.ok && a.outcome.error === "rate_limited");
  const message = outcome.ok ? "unknown failure" : outcome.message;
  if (allLimited) {
    return errorResponse(c, 429, `Every subscription is rate-limited. Last error: ${message}`, "rate_limit_error", "subscriptions_exhausted", headers);
  }
  if (!outcome.ok && outcome.error === "timeout") {
    return errorResponse(c, 504, message, "api_error", "backend_timeout", headers);
  }
  return errorResponse(c, 502, `No subscription answered. Last error: ${message}`, "api_error", "backend_failed", headers);
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const available = (): SubscriptionId[] => deps.router.available;

  app.get("/healthz", (c) => c.json({ ok: true, backends: available() }));

  app.get("/", (c) => {
    const baseUrl = new URL("/v1", c.req.url).toString();
    return c.json({
      name: "milo",
      description:
        'Local router over your own ChatGPT (codex) and Claude (claude) subscriptions. Point an OpenAI-compatible client at /v1 and use model "milo/auto".',
      baseUrl,
      models: modelIds(available()),
      endpoints: ["/healthz", "/v1/chat/completions", "/v1/models", "/v1/usage"],
    });
  });

  app.get("/v1/models", (c) =>
    c.json({
      object: "list",
      data: modelIds(available()).map((id) => ({ id, object: "model", created: 0, owned_by: "milo" })),
    }),
  );

  app.get("/v1/usage", async (c) => {
    await deps.router.refreshLimits();
    const capacity = deps.router.capacity();
    const now = deps.now();
    const day = new Date(now - 24 * 60 * 60 * 1000).toISOString();
    const week = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
    const [last24h, last7d] = deps.store
      ? await Promise.all([deps.store.totals(day), deps.store.totals(week)])
      : [[], []];
    const pick = (rows: UsageTotals[], id: SubscriptionId): UsageTotals | undefined => rows.find((r) => r.backend === id);
    return c.json({
      object: "usage",
      subscriptions: capacity.map((snapshot) => ({
        backend: snapshot.backend,
        label: deps.labels[snapshot.backend] ?? snapshot.backend,
        capacity: snapshot,
        last24h: pick(last24h, snapshot.backend) ?? null,
        last7d: pick(last7d, snapshot.backend) ?? null,
      })),
    });
  });

  app.post("/v1/chat/completions", async (c) => {
    let body: ChatBody;
    try {
      body = (await c.req.json()) as ChatBody;
    } catch {
      return errorResponse(c, 400, "Request body must be JSON.", "invalid_request_error", "invalid_json");
    }
    const model = typeof body.model === "string" ? body.model : ROUTED_MODEL_ID;
    const target = parseModel(model);
    if (target === undefined) {
      return errorResponse(
        c,
        400,
        `Milo serves ${modelIds(available()).join(", ")}, or codex/<model> and claude/<model>; got "${model}".`,
        "invalid_request_error",
        "model_not_found",
      );
    }
    if (target.force !== undefined && !available().includes(target.force)) {
      return errorResponse(c, 400, `The ${target.force} backend is not enabled.`, "invalid_request_error", "backend_disabled");
    }
    if (!isMessages(body.messages)) {
      return errorResponse(c, 400, "`messages` must be a non-empty array of chat messages.", "invalid_request_error", "invalid_messages");
    }
    if (Array.isArray(body.tools) && body.tools.length > 0) {
      return errorResponse(
        c,
        400,
        "Tool calling is not supported: subscription CLIs answer in text and run no caller-defined tools.",
        "invalid_request_error",
        "tools_unsupported",
      );
    }
    if (typeof body.n === "number" && body.n > 1) {
      return errorResponse(c, 400, "Only n=1 is supported.", "invalid_request_error", "n_unsupported");
    }

    const messages = body.messages;
    const created = Math.floor(deps.now() / 1000);
    const request = {
      messages,
      ...(target.force !== undefined ? { force: target.force } : {}),
      ...(target.model !== undefined ? { model: target.model } : {}),
      signal: c.req.raw.signal,
    };

    if (body.stream !== true) {
      let result: RouteResult;
      try {
        result = await deps.router.complete(request);
      } catch (error) {
        deps.logger.error("route failed", { error: errorMessage(error) });
        return errorResponse(c, 500, "Milo failed to route this request.", "api_error", "internal_error");
      }
      const servedModel = result.outcome.ok ? result.outcome.model : undefined;
      const headers = decisionHeaders(result.decision, attemptsOf(result), result.served, servedModel);
      logResult(deps, result);
      if (!result.outcome.ok) return failureResponse(c, result, headers);
      return c.json(
        {
          id: `chatcmpl-${result.decision.id}`,
          object: "chat.completion",
          created,
          model,
          choices: [{ index: 0, message: { role: "assistant", content: result.outcome.text }, finish_reason: "stop" }],
          usage: usageBody(result),
        },
        200,
        headers,
      );
    }

    return streamCompletion(c, deps, request, model, created, body.stream_options?.include_usage === true);
  });

  app.onError((err, c) => {
    deps.logger.error("unhandled gateway error", { error: err.message });
    return errorResponse(c, 500, "Milo failed to handle this request.", "api_error", "internal_error");
  });

  return app;
}

/**
 * Streams an answer as OpenAI chat-completion chunks. The response (and its
 * headers) is committed only when the first text arrives, so a failover
 * before that point is still reported in `x-milo-failover`; when no backend
 * answers at all, the caller gets an ordinary JSON error instead of a stream.
 */
async function streamCompletion(
  c: Context,
  deps: AppDeps,
  request: Parameters<SubscriptionRouter["complete"]>[0],
  model: string,
  created: number,
  includeUsage: boolean,
): Promise<Response> {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      controller = ctrl;
    },
  });
  let decision: SubscriptionDecision | undefined;
  let current: SubscriptionId | undefined;
  let failed: Array<{ backend: SubscriptionId; error: string }> = [];
  let started = false;
  let resolveFirst!: () => void;
  const firstText = new Promise<void>((resolve) => {
    resolveFirst = resolve;
  });

  const send = (payload: unknown): void => {
    const data = payload === DONE ? DONE : JSON.stringify(payload);
    try {
      controller.enqueue(encoder.encode(`data: ${data}\n\n`));
    } catch {
      // The client went away; the CLI is stopped through the request's abort signal.
    }
  };
  const chunk = (delta: Record<string, unknown>, finish: string | null): Record<string, unknown> => ({
    id: `chatcmpl-${decision?.id ?? ""}`,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  });

  const done = deps.router.complete({
    ...request,
    onDecision: (d) => {
      decision = d;
    },
    onAttempt: (backend, earlier) => {
      failed = earlier.flatMap((a) => (a.outcome.ok ? [] : [{ backend: a.backend, error: a.outcome.error }]));
      current = backend;
    },
    onText: (delta) => {
      if (!started) {
        started = true;
        send(chunk({ role: "assistant", content: "" }, null));
        resolveFirst();
      }
      send(chunk({ content: delta }, null));
    },
  });

  let early: RouteResult | undefined;
  try {
    early = await Promise.race([firstText.then(() => undefined), done]);
  } catch (error) {
    deps.logger.error("route failed", { error: errorMessage(error) });
    return errorResponse(c, 500, "Milo failed to route this request.", "api_error", "internal_error");
  }

  if (early !== undefined && !started) {
    // Finished without producing any text: report it like a buffered request.
    logResult(deps, early);
    const headers = decisionHeaders(early.decision, attemptsOf(early), early.served, early.outcome.ok ? early.outcome.model : undefined);
    if (!early.outcome.ok) return failureResponse(c, early, headers);
    send(chunk({ role: "assistant", content: "" }, null));
    finishStream(send, chunk, early, includeUsage);
    controller.close();
    return new Response(stream, { status: 200, headers: { ...sseHeaders(), ...headers } });
  }

  const headers =
    decision !== undefined
      ? decisionHeaders(
          decision,
          failed,
          current,
          undefined,
        )
      : {};

  void done
    .then((result) => {
      logResult(deps, result);
      if (result.outcome.ok) {
        finishStream(send, chunk, result, includeUsage);
      } else {
        send({ error: { message: result.outcome.message, type: "api_error", code: result.outcome.error } });
      }
    })
    .catch((error: unknown) => {
      deps.logger.error("stream failed", { error: errorMessage(error) });
      send({ error: { message: "Milo failed while streaming.", type: "api_error", code: "internal_error" } });
    })
    .finally(() => {
      try {
        controller.close();
      } catch {
        // The client already went away.
      }
    });

  return new Response(stream, { status: 200, headers: { ...sseHeaders(), ...headers } });
}

function finishStream(
  send: (payload: unknown) => void,
  chunk: (delta: Record<string, unknown>, finish: string | null) => Record<string, unknown>,
  result: RouteResult,
  includeUsage: boolean,
): void {
  send(chunk({}, "stop"));
  if (includeUsage) send({ ...chunk({}, null), choices: [], usage: usageBody(result) });
  send(DONE);
}

function sseHeaders(): Record<string, string> {
  return { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" };
}

function logResult(deps: AppDeps, result: RouteResult): void {
  deps.logger.info("routed", {
    decision: result.decision.id,
    taskType: result.decision.classification.taskType,
    classifier: result.decision.classification.source,
    served: result.served ?? null,
    attempts: result.attempts.map((a) => (a.outcome.ok ? a.backend : `${a.backend}:${a.outcome.error}`)),
    latencyMs: result.attempts.reduce((sum, a) => sum + a.outcome.latencyMs, 0),
  });
}
