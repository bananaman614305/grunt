/**
 * Defense-in-depth for chat completions: strip provider reasoning traces
 * from the client-visible body when the request did not ask to see them.
 *
 * `applyReasoningExclusion` asks OpenRouter to omit the trace. Providers can
 * still emit `reasoning` / `reasoning_content` / `reasoning_details` /
 * `thinking` on `choices[].message` or `choices[].delta`. The chat route
 * used to forward those fields byte-for-byte; this module removes them so a
 * client cannot surface internal CoT as answer text.
 *
 * Only the chat completions dialect is scrubbed here (the pi /
 * openai-completions surface). Messages and responses keep the outbound
 * exclude default alone.
 */

import type { Body } from "./shared.js";

/** Fields OpenRouter and providers may attach beside answer text. */
export const CHAT_REASONING_KEYS = [
  "reasoning",
  "reasoning_content",
  "reasoning_details",
  "thinking",
] as const;

/**
 * Whether the caller asked to receive a reasoning trace. Matches the
 * visibility choices `applyReasoningExclusion` preserves.
 */
export function wantsVisibleReasoning(body: Body): boolean {
  const reasoning = body["reasoning"];
  if (typeof reasoning === "object" && reasoning !== null && !Array.isArray(reasoning)) {
    if ((reasoning as Record<string, unknown>)["exclude"] === false) return true;
    if ((reasoning as Record<string, unknown>)["exclude"] === true) return false;
  }
  if (body["include_reasoning"] === true) return true;
  if (body["include_reasoning"] === false) return false;
  return false;
}

/** Drop reasoning keys from one message or delta object (in place). */
export function stripChatReasoningFields(obj: Record<string, unknown>): void {
  for (const key of CHAT_REASONING_KEYS) delete obj[key];
}

/**
 * Strip reasoning fields from a chat completion JSON value. Returns a new
 * object when anything changed; otherwise the original reference.
 */
export function stripChatReasoningPayload(payload: unknown): unknown {
  if (!isRecord(payload)) return payload;
  const choices = payload["choices"];
  if (!Array.isArray(choices)) return payload;

  let changed = false;
  const nextChoices = choices.map((choice) => {
    if (!isRecord(choice)) return choice;
    let next = choice;
    for (const part of ["message", "delta"] as const) {
      const value = next[part];
      if (!isRecord(value) || !hasReasoningKey(value)) continue;
      if (next === choice) next = { ...choice };
      const cleaned = { ...value };
      stripChatReasoningFields(cleaned);
      next[part] = cleaned;
      changed = true;
    }
    return next;
  });

  if (!changed) return payload;
  return { ...payload, choices: nextChoices };
}

/** Buffered chat JSON body with reasoning fields removed. */
export function stripChatReasoningBody(text: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  const stripped = stripChatReasoningPayload(parsed);
  if (stripped === parsed) return text;
  return JSON.stringify(stripped);
}

/**
 * SSE transform: rewrite each `data:` JSON frame's choices deltas/messages
 * so reasoning keys never reach the client. Non-JSON frames and `[DONE]`
 * pass through unchanged. Chunks may split mid-line; incomplete lines wait.
 */
export function stripChatReasoningSse(): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        controller.enqueue(encoder.encode(`${rewriteSseLine(line)}\n`));
      }
    },
    flush(controller) {
      pending += decoder.decode();
      if (pending.length > 0) {
        controller.enqueue(encoder.encode(rewriteSseLine(pending)));
      }
    },
  });
}

function rewriteSseLine(line: string): string {
  if (!line.startsWith("data:")) return line;
  const payload = line.slice(5).trimStart();
  if (payload.length === 0 || payload === "[DONE]") return line;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return line;
  }
  const stripped = stripChatReasoningPayload(parsed);
  if (stripped === parsed) return line;
  // Preserve a single space after `data:` when the upstream used one.
  const spacer = line.slice(5).startsWith(" ") ? " " : "";
  return `data:${spacer}${JSON.stringify(stripped)}`;
}

function hasReasoningKey(obj: Record<string, unknown>): boolean {
  return CHAT_REASONING_KEYS.some((key) => key in obj);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
