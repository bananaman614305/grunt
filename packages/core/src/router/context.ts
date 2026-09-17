/**
 * Builds the compact conversation view sent to Jev as `state`.
 *
 * Token accounting uses a documented approximation of **4 characters per
 * token**. That is deliberately crude: the router only needs a hard upper
 * bound on what it ships to Jev (`ROUTER_LIMITS.contextTokenBudget`), and a
 * real tokenizer would cost more than the Jev call it protects. The budget is
 * applied to the JSON serialization of the state, so escaping overhead counts.
 *
 * When the conversation does not fit, the router sheds context in this order:
 *   1. the latest user turn is reserved first and kept intact whenever possible
 *      (it is the actual request being routed);
 *   2. the system/developer prompt is trimmed **from the middle**, keeping its
 *      opening (role, mission) and its closing (the operative instructions);
 *   3. the most recent assistant turn is trimmed from the tail;
 *   4. older user turns are filled newest-first, so the oldest are trimmed and
 *      then dropped first.
 */

import type { ChatMessage } from "../types.js";
import { ROUTER_LIMITS } from "../types.js";

/** Documented approximation: one token is about four characters. */
export const CHARS_PER_TOKEN = 4;

/** Inserted where text was removed, so Jev can see that context is missing. */
export const TRUNCATION_MARKER = " ...[truncated]... ";

/** Share of the post-reservation budget the system prompt may claim. */
const SYSTEM_SHARE = 0.6;

/** Share of what is left after the system prompt that one assistant turn may claim. */
const ASSISTANT_SHARE = 0.5;

export type JevState = {
  /** Concatenated system and developer prompts, possibly middle-trimmed. */
  system: string;
  /** Up to `ROUTER_LIMITS.recentUserTurns` user turns, oldest first. */
  recent_user_turns: string[];
  /** The most recent assistant turn carrying text, or null when there is none. */
  latest_assistant_turn: string | null;
  has_tools: boolean;
  tool_count: number;
  message_count: number;
  user_message_count: number;
  assistant_message_count: number;
};

/** Flattens OpenAI message content (string, content parts, or null) to text. */
export function messageText(content: ChatMessage["content"]): string {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part.text === "string" ? part.text : ""))
      .filter((text) => text.length > 0)
      .join("\n")
      .trim();
  }
  return "";
}

/** Keeps the head and the tail, dropping the middle. */
function middleTrim(text: string, max: number): string {
  if (max <= 0) return "";
  if (text.length <= max) return text;
  if (max <= TRUNCATION_MARKER.length) return text.slice(0, max);
  const keep = max - TRUNCATION_MARKER.length;
  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  return text.slice(0, head) + TRUNCATION_MARKER + (tail > 0 ? text.slice(text.length - tail) : "");
}

/** Keeps the head, dropping the tail. */
function headTrim(text: string, max: number): string {
  if (max <= 0) return "";
  if (text.length <= max) return text;
  if (max <= TRUNCATION_MARKER.length) return text.slice(0, max);
  return text.slice(0, max - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
}

type Extracted = {
  system: string;
  olderUserTurns: string[];
  latestUserTurn: string;
  assistant: string;
  counts: Pick<JevState, "message_count" | "user_message_count" | "assistant_message_count">;
};

function extract(messages: ChatMessage[]): Extracted {
  const systemParts: string[] = [];
  const userTurns: string[] = [];
  let assistant = "";
  let userCount = 0;
  let assistantCount = 0;

  for (const message of messages) {
    const text = messageText(message.content);
    switch (message.role) {
      case "system":
      case "developer":
        if (text.length > 0) systemParts.push(text);
        break;
      case "user":
        userCount += 1;
        if (text.length > 0) userTurns.push(text);
        break;
      case "assistant":
        assistantCount += 1;
        // Keep the newest assistant turn that carries text; a tool-call-only
        // turn has none and must not blank out the field.
        if (text.length > 0) assistant = text;
        break;
      default:
        break;
    }
  }

  const recent = userTurns.slice(-ROUTER_LIMITS.recentUserTurns);
  const latestUserTurn = recent.length > 0 ? (recent[recent.length - 1] as string) : "";

  return {
    system: systemParts.join("\n\n"),
    olderUserTurns: recent.slice(0, -1),
    latestUserTurn,
    assistant,
    counts: {
      message_count: messages.length,
      user_message_count: userCount,
      assistant_message_count: assistantCount,
    },
  };
}

function assemble(parts: Extracted, available: number, toolCount: number): JevState {
  let remaining = Math.max(0, available);

  // 1. The latest user turn is the request being routed: reserve it first.
  const latest = headTrim(parts.latestUserTurn, remaining);
  remaining -= latest.length;

  // 2. The system prompt gets a share of what is left, trimmed from the middle.
  const system = middleTrim(parts.system, Math.floor(remaining * SYSTEM_SHARE));
  remaining -= system.length;

  // 3. One assistant turn, capped so it cannot eat every older user turn.
  const assistant = headTrim(parts.assistant, Math.floor(remaining * ASSISTANT_SHARE));
  remaining -= assistant.length;

  // 4. Older user turns, newest first, so the oldest are shed first.
  const older: string[] = [];
  for (let i = parts.olderUserTurns.length - 1; i >= 0; i -= 1) {
    if (remaining <= 0) break;
    const kept = headTrim(parts.olderUserTurns[i] as string, remaining);
    if (kept.length === 0) break;
    older.unshift(kept);
    remaining -= kept.length;
  }

  return {
    system,
    recent_user_turns: latest.length > 0 ? [...older, latest] : older,
    latest_assistant_turn: assistant.length > 0 ? assistant : null,
    has_tools: toolCount > 0,
    tool_count: toolCount,
    ...parts.counts,
  };
}

/**
 * Builds the Jev `state` for a conversation and reports its approximate size.
 * `approxTokens` never exceeds `ROUTER_LIMITS.contextTokenBudget` unless the
 * scaffolding alone does, which cannot happen for any real conversation.
 */
export function buildJevState(
  messages: ChatMessage[],
  tools?: unknown[],
): { state: Record<string, unknown>; approxTokens: number } {
  const toolCount = Array.isArray(tools) ? tools.length : 0;
  const parts = extract(messages);
  const budgetChars = ROUTER_LIMITS.contextTokenBudget * CHARS_PER_TOKEN;

  // Start from the budget minus the scaffolding (keys, braces, counts), then
  // shrink until the serialized state fits. JSON escaping expands text, so the
  // first estimate can overshoot; each pass subtracts the measured overflow.
  const empty: Extracted = { ...parts, system: "", olderUserTurns: [], latestUserTurn: "", assistant: "" };
  let available = budgetChars - JSON.stringify(assemble(empty, 0, toolCount)).length;
  let state = assemble(parts, available, toolCount);
  let chars = JSON.stringify(state).length;

  for (let pass = 0; pass < 8 && chars > budgetChars && available > 0; pass += 1) {
    available = Math.max(0, available - (chars - budgetChars));
    state = assemble(parts, available, toolCount);
    chars = JSON.stringify(state).length;
  }

  return {
    state: state as unknown as Record<string, unknown>,
    approxTokens: Math.ceil(chars / CHARS_PER_TOKEN),
  };
}
