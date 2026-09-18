/**
 * One streamed chat completion, measured. Used for every arm so the timing
 * is comparable: time to first byte is the first SSE frame that carries
 * content or reasoning, total is the end of the stream, and usage is read
 * off the last frame that carries one (OpenRouter puts `usage`, including
 * `cost`, on the final chunk when asked to).
 */

import type { CallMeasurement } from "./types.js";

export type ChatCallOptions = {
  baseUrl: string;
  apiKey: string;
  body: Record<string, unknown>;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  /** Injectable clock for tests. */
  now?: () => number;
};

const MILO_HEADERS = {
  decisionId: "x-milo-decision-id",
  model: "x-milo-model",
  tier: "x-milo-tier",
  taskType: "x-milo-task-type",
  difficulty: "x-milo-difficulty",
  sticky: "x-milo-sticky",
} as const;

/** Sends `body` as a streamed chat completion and measures it. Never throws for an HTTP error status. */
export async function measureChatCompletion(options: ChatCallOptions): Promise<CallMeasurement> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => performance.now());
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  const started = now();

  try {
    const response = await fetchImpl(`${options.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({
        ...options.body,
        stream: true,
        stream_options: { include_usage: true },
        usage: { include: true },
      }),
      signal: controller.signal,
    });

    const milo: CallMeasurement["milo"] = {};
    for (const [key, header] of Object.entries(MILO_HEADERS)) {
      const value = response.headers.get(header);
      if (value !== null) milo[key as keyof typeof MILO_HEADERS] = value;
    }

    if (!response.ok || response.body === null) {
      const text = response.body === null ? "" : await response.text();
      const end = now();
      return { status: response.status, ttfbMs: end - started, totalMs: end - started, text, milo };
    }

    const parsed = await readStream(response.body, () => now() - started);
    return { status: response.status, ...parsed, milo };
  } finally {
    clearTimeout(timer);
  }
}

type StreamResult = Omit<CallMeasurement, "status" | "milo">;

/** Assembles a chat SSE stream: text, usage, and the moment the first token arrived. */
export async function readStream(stream: ReadableStream<Uint8Array>, elapsed: () => number): Promise<StreamResult> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buffer = "";
  const result: {
    text: string;
    ttfbMs?: number;
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
    costUsd?: number;
  } = { text: "" };

  const takeFrame = (rawLine: string): void => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (!line.startsWith("data:")) return;
    const data = line.slice("data:".length).trim();
    if (data === "" || data === "[DONE]") return;
    let frame: unknown;
    try {
      frame = JSON.parse(data);
    } catch {
      return;
    }
    if (typeof frame !== "object" || frame === null) return;
    const chunk = frame as {
      model?: unknown;
      choices?: Array<{ delta?: { content?: unknown; reasoning?: unknown } }>;
      usage?: {
        prompt_tokens?: unknown;
        completion_tokens?: unknown;
        cost?: unknown;
        completion_tokens_details?: { reasoning_tokens?: unknown };
      } | null;
    };
    if (typeof chunk.model === "string") result.model = chunk.model;
    for (const choice of chunk.choices ?? []) {
      const content = choice.delta?.content;
      const reasoning = choice.delta?.reasoning;
      if ((typeof content === "string" && content.length > 0) || (typeof reasoning === "string" && reasoning.length > 0)) {
        if (result.ttfbMs === undefined) result.ttfbMs = elapsed();
      }
      if (typeof content === "string") result.text += content;
    }
    const usage = chunk.usage;
    if (usage !== undefined && usage !== null) {
      if (typeof usage.prompt_tokens === "number") result.inputTokens = usage.prompt_tokens;
      if (typeof usage.completion_tokens === "number") result.outputTokens = usage.completion_tokens;
      if (typeof usage.cost === "number") result.costUsd = usage.cost;
      const reasoning = usage.completion_tokens_details?.reasoning_tokens;
      if (typeof reasoning === "number") result.reasoningTokens = reasoning;
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const cut = buffer.lastIndexOf("\n");
      if (cut === -1) continue;
      for (const line of buffer.slice(0, cut).split("\n")) takeFrame(line);
      buffer = buffer.slice(cut + 1);
    }
    takeFrame(buffer);
  } finally {
    reader.releaseLock();
  }

  const totalMs = elapsed();
  return {
    text: result.text,
    ttfbMs: result.ttfbMs ?? totalMs,
    totalMs,
    ...(result.model !== undefined ? { model: result.model } : {}),
    ...(result.inputTokens !== undefined ? { inputTokens: result.inputTokens } : {}),
    ...(result.outputTokens !== undefined ? { outputTokens: result.outputTokens } : {}),
    ...(result.reasoningTokens !== undefined ? { reasoningTokens: result.reasoningTokens } : {}),
    ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}),
  };
}
