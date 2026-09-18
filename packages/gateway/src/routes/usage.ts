/**
 * Reading OpenRouter's usage numbers back off a response, in the three
 * dialects Milo serves.
 *
 * Two readers are needed per dialect, because the numbers live in different
 * places depending on how the response came back:
 *
 *   - a buffered JSON body carries them in a top-level `usage` object;
 *   - a stream carries them in one particular frame near the end.
 *
 * The field names differ per dialect and the frame differs per dialect, which
 * is the whole reason this file exists rather than one function:
 *
 *   | dialect              | buffered                        | streamed                                        |
 *   | -------------------- | ------------------------------- | ----------------------------------------------- |
 *   | `/v1/chat/completions` | `usage.prompt_tokens`, `usage.completion_tokens`, `usage.cost` | the same `usage` object, on the last chunk that carries one |
 *   | `/v1/responses`      | `usage.input_tokens`, `usage.output_tokens`, `usage.cost` | `response.completed` -> `response.usage`        |
 *   | `/v1/messages`       | `usage.input_tokens`, `usage.output_tokens`, `usage.cost` | `message_start` -> `message.usage` (input), then `message_delta` -> `usage` (output) |
 *
 * `usage.cost` is OpenRouter's own extension in every dialect: what the call
 * cost the key that made it, in USD. It is the number Milo bills from
 * (ADR-007); the token counts are what the decision log records and what the
 * roster-price fallback in `billing.ts` uses when no cost came back.
 *
 * Nothing here ever holds a whole response in memory: the stream reader keeps
 * one partial line and the newest usage it has seen.
 */

import type { Upstream } from "./shared.js";

/** Which dialect a response is in. */
export type Surface = "chat" | "responses" | "messages";

/** What one response said about itself. Every field is absent when unreported. */
export type UpstreamUsage = {
  /** The upstream response id, for a ledger reference on a passthrough call. */
  id?: string;
  inputTokens?: number;
  outputTokens?: number;
  /** OpenRouter's `usage.cost`, in USD. */
  costUsd?: number;
};

/**
 * Sums two usage readings into one: fields absent on both stay absent, and
 * the first reading's response id (the served answer's) is kept. Used where
 * one decision spends more than one upstream call -- a sampled fan-out, or
 * the completeness gate's retry (ADR-013) -- and bills one aggregate row.
 */
export function addUsage(a: UpstreamUsage, b?: UpstreamUsage): UpstreamUsage {
  if (b === undefined) return a;
  const sum: UpstreamUsage = {};
  if (a.id !== undefined) sum.id = a.id;
  const inputs = [a.inputTokens, b.inputTokens].filter((v): v is number => v !== undefined);
  const outputs = [a.outputTokens, b.outputTokens].filter((v): v is number => v !== undefined);
  const costs = [a.costUsd, b.costUsd].filter((v): v is number => v !== undefined);
  if (inputs.length > 0) sum.inputTokens = inputs.reduce((x, y) => x + y, 0);
  if (outputs.length > 0) sum.outputTokens = outputs.reduce((x, y) => x + y, 0);
  if (costs.length > 0) sum.costUsd = costs.reduce((x, y) => x + y, 0);
  return sum;
}

/** The subset of a usage reading the decision log stores. */
export function toUpstreamRecord(usage: UpstreamUsage): Partial<Upstream> {
  const record: Partial<Upstream> = {};
  if (usage.inputTokens !== undefined) record.inputTokens = usage.inputTokens;
  if (usage.outputTokens !== undefined) record.outputTokens = usage.outputTokens;
  if (usage.costUsd !== undefined) record.costUsd = usage.costUsd;
  return record;
}

// ---------------------------------------------------------------------------
// Buffered bodies
// ---------------------------------------------------------------------------

/** Usage off a non-streamed response body. `{}` if the body says nothing. */
export function readBodyUsage(surface: Surface, text: string): UpstreamUsage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  if (!isRecord(parsed)) return {};

  const usage: UpstreamUsage = {};
  if (typeof parsed["id"] === "string") usage.id = parsed["id"];
  mergeUsageObject(surface, usage, parsed["usage"]);
  return usage;
}

// ---------------------------------------------------------------------------
// Streams
// ---------------------------------------------------------------------------

/**
 * Drains an SSE stream and returns what its frames said about usage. Meant to
 * be run on one branch of a `tee()`, so the client's copy of the bytes is
 * neither delayed nor altered by the reading.
 *
 * Frames are parsed as they arrive and only the newest usage is kept, so a
 * long stream costs one partial line of memory rather than the whole body. A
 * frame that is not JSON, or carries no usage, is skipped in silence: a
 * stream is allowed to end without ever saying what it cost, and the caller
 * decides what that means (it charges nothing and warns).
 */
export async function usageFromStream(surface: Surface, stream: ReadableStream<Uint8Array>): Promise<UpstreamUsage> {
  const usage: UpstreamUsage = {};
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Everything up to the last newline is whole lines; the rest is a frame
      // still arriving and waits for the next chunk.
      const cut = buffer.lastIndexOf("\n");
      if (cut === -1) continue;
      for (const line of buffer.slice(0, cut).split("\n")) readFrame(surface, usage, line);
      buffer = buffer.slice(cut + 1);
    }
    readFrame(surface, usage, buffer);
  } finally {
    reader.releaseLock();
  }

  return usage;
}

/** One SSE line. Only `data:` lines carry anything; `event:` names are ignored. */
function readFrame(surface: Surface, usage: UpstreamUsage, rawLine: string): void {
  const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
  if (!line.startsWith("data:")) return;

  const data = line.slice("data:".length).trim();
  if (data === "" || data === "[DONE]") return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return;
  }
  if (!isRecord(parsed)) return;

  switch (surface) {
    case "chat": {
      // Every chunk carries the generation id; the last one carries `usage`.
      if (typeof parsed["id"] === "string") usage.id = parsed["id"];
      mergeUsageObject(surface, usage, parsed["usage"]);
      return;
    }
    case "responses": {
      // Usage arrives once, on `response.completed`; there is no `[DONE]`.
      if (parsed["type"] !== "response.completed") return;
      const response = parsed["response"];
      if (!isRecord(response)) return;
      if (typeof response["id"] === "string") usage.id = response["id"];
      mergeUsageObject(surface, usage, response["usage"]);
      return;
    }
    case "messages": {
      // Input tokens land on `message_start`, output tokens on `message_delta`.
      if (parsed["type"] === "message_start") {
        const message = parsed["message"];
        if (!isRecord(message)) return;
        if (typeof message["id"] === "string") usage.id = message["id"];
        mergeUsageObject(surface, usage, message["usage"]);
        return;
      }
      if (parsed["type"] === "message_delta") mergeUsageObject(surface, usage, parsed["usage"]);
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Field names
// ---------------------------------------------------------------------------

/**
 * Copies whatever a `usage` object reports onto `usage`. Later readings win,
 * which is what makes the Anthropic dialect's two-frame split work: the
 * output count in `message_delta` lands on top of the input count from
 * `message_start` without clearing it.
 */
function mergeUsageObject(surface: Surface, usage: UpstreamUsage, source: unknown): void {
  if (!isRecord(source)) return;

  const input = surface === "chat" ? source["prompt_tokens"] : source["input_tokens"];
  const output = surface === "chat" ? source["completion_tokens"] : source["output_tokens"];

  if (typeof input === "number") usage.inputTokens = input;
  if (typeof output === "number") usage.outputTokens = output;
  if (typeof source["cost"] === "number") usage.costUsd = source["cost"];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
