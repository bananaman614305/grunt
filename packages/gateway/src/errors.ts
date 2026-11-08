/**
 * Error bodies in OpenAI's shape: `{ "error": { message, type, code } }`.
 * Clients (and the `openai` SDK's error classes) key off `type` and `code`,
 * so both are always present. Nothing here echoes a request's content.
 */

import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export type ErrorType = "invalid_request_error" | "not_found_error" | "rate_limit_error" | "api_error";

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
  headers?: Record<string, string>,
): Response {
  return headers === undefined
    ? c.json(openAiError(message, type, code), status)
    : c.json(openAiError(message, type, code), status, headers);
}

/** An error's message, for a log line. Never rendered into a response body. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
