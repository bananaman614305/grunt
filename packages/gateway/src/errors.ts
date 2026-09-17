/**
 * Error bodies, in both dialects Milo speaks.
 *
 * Milo is a drop-in for an OpenAI client, so its own failures on the OpenAI
 * surface have to look like OpenAI's: `{ "error": { message, type, code } }`.
 * Clients (and the `openai` SDK's error classes) key off `type` and `code`,
 * so both are required here rather than optional.
 *
 * `/v1/messages` is a drop-in for an Anthropic client, so its failures wear
 * Anthropic's envelope instead: `{ "type": "error", "error": { type, message } }`.
 * The `@anthropic-ai/sdk` error classes parse that shape, and Claude Code's
 * retry logic reads the message, so a Milo-minted error has to be shaped like
 * one the SDK expects or the client's recovery path breaks.
 *
 * Nothing built here ever interpolates a request header. An error message
 * that echoed `Authorization` or `x-api-key` back would put the user's
 * OpenRouter key into whatever log the client keeps (ADR-003).
 */

import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export type ErrorType =
  | "authentication_error"
  | "invalid_request_error"
  | "not_found_error"
  | "rate_limit_error"
  /** OpenAI's own type for "this account cannot pay for this call" (ADR-007). */
  | "insufficient_quota"
  | "api_error";

export type OpenAIErrorBody = {
  error: { message: string; type: ErrorType; code: string };
};

export function openAiError(message: string, type: ErrorType, code: string): OpenAIErrorBody {
  return { error: { message, type, code } };
}

/**
 * `headers` exists for the one case that needs it: a refusal that tells the
 * client when to come back (`Retry-After` on a 429 or a 503). Everything else
 * passes four arguments and gets a plain JSON body.
 */
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

// ---------------------------------------------------------------------------
// Anthropic shape, for `/v1/messages`
// ---------------------------------------------------------------------------

/** The subset of Anthropic's error types Milo ever mints itself. */
export type AnthropicErrorType =
  | "invalid_request_error"
  | "authentication_error"
  /** 403: a suspended Milo account, in Anthropic's own wording. */
  | "permission_error"
  /** 402: out of Milo credits. Anthropic's type for a payment problem. */
  | "billing_error"
  | "not_found_error"
  | "rate_limit_error"
  | "api_error";

export type AnthropicErrorBody = {
  type: "error";
  error: { type: AnthropicErrorType; message: string };
};

export function anthropicError(message: string, type: AnthropicErrorType): AnthropicErrorBody {
  return { type: "error", error: { type, message } };
}

export function anthropicErrorResponse(
  c: Context,
  status: ContentfulStatusCode,
  message: string,
  type: AnthropicErrorType,
  headers?: Record<string, string>,
): Response {
  return headers === undefined
    ? c.json(anthropicError(message, type), status)
    : c.json(anthropicError(message, type), status, headers);
}

/** An error's message, for a log line. Never rendered into a response body. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
