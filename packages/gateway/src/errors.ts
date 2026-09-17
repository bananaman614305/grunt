/**
 * OpenAI-shaped error bodies.
 *
 * Milo is a drop-in for an OpenAI client, so its own failures have to look
 * like OpenAI's: `{ "error": { message, type, code } }`. Clients (and the
 * `openai` SDK's error classes) key off `type` and `code`, so both are
 * required here rather than optional.
 *
 * Nothing built here ever interpolates a request header. An error message
 * that echoed `Authorization` back would put the user's OpenRouter key into
 * whatever log the client keeps (ADR-003).
 */

import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export type ErrorType = "authentication_error" | "invalid_request_error" | "not_found_error" | "api_error";

export type OpenAIErrorBody = {
  error: { message: string; type: ErrorType; code: string };
};

export function openAiError(message: string, type: ErrorType, code: string): OpenAIErrorBody {
  return { error: { message, type, code } };
}

export function errorResponse(
  c: Context,
  status: ContentfulStatusCode,
  message: string,
  type: ErrorType,
  code: string,
): Response {
  return c.json(openAiError(message, type, code), status);
}

/** An error's message, for a log line. Never rendered into a response body. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
