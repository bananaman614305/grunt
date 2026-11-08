/**
 * Flattens an OpenAI-style conversation into what a headless CLI takes: one
 * set of instructions and one prompt.
 */

import type { ChatMessage } from "../types.js";

function contentText(content: ChatMessage["content"]): string {
  if (content === null) return "";
  if (typeof content === "string") return content;
  return content
    .map((part) => (typeof part.text === "string" ? part.text : part.type === "text" ? "" : `[${part.type} omitted]`))
    .filter((text) => text !== "")
    .join("\n");
}

export type FlatPrompt = { system?: string; prompt: string };

/**
 * System and developer messages become the instructions. A single user turn
 * is sent as-is; a longer conversation is sent as a labelled transcript
 * ending with the turn to answer, so the CLI answers the last message with
 * the earlier ones as context.
 */
export function toPrompt(messages: ChatMessage[]): FlatPrompt {
  const system = messages
    .filter((m) => m.role === "system" || m.role === "developer")
    .map((m) => contentText(m.content).trim())
    .filter((text) => text !== "")
    .join("\n\n");

  const turns = messages.filter((m) => m.role !== "system" && m.role !== "developer");
  let prompt: string;
  if (turns.length === 1 && turns[0]?.role === "user") {
    prompt = contentText(turns[0].content);
  } else {
    const lines = turns.map((m) => {
      const label = m.role === "assistant" ? "Assistant" : m.role === "tool" ? "Tool result" : "User";
      return `${label}:\n${contentText(m.content)}`;
    });
    prompt =
      "Continue this conversation. Reply only with the assistant's next message, without a label.\n\n" +
      lines.join("\n\n");
  }

  return system === "" ? { prompt } : { system, prompt };
}
