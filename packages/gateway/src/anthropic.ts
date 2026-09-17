/**
 * Milo's client for OpenRouter's Anthropic-compatible surface.
 *
 * Why this exists rather than `OpenRouterClient` from core: core's
 * `forwardHeaders` allow-lists the headers an OpenAI-shaped request needs, and
 * `anthropic-version` / `anthropic-beta` are not on that list -- they would be
 * dropped on the way out. Core's contracts are frozen for the MVP (CLAUDE.md),
 * so the Anthropic dialect gets a gateway-local client with its own allow-list
 * instead. It is deliberately the same shape as core's: it never reads a body,
 * so a streamed response is piped straight through.
 *
 * Credential handling is the other difference. The Anthropic SDK and Claude
 * Code send the key as `x-api-key`; OpenRouter documents `Authorization:
 * Bearer`. So the caller passes the credential explicitly and this module
 * writes exactly one `authorization` header. `x-api-key` is never in the
 * allow-list, so it cannot survive the hop (ADR-003).
 */

import { OPENROUTER_BASE_URL, OpenRouterError } from "@milo/core";

/**
 * Request headers worth carrying to OpenRouter's messages endpoint.
 * `authorization` is set explicitly by `upstreamHeaders`, never copied, and
 * `x-api-key` is absent on purpose. Everything else -- hop-by-hop headers,
 * `x-forwarded-*`, Milo's own `x-milo-*` -- is dropped by omission.
 */
export const FORWARDED_REQUEST_HEADERS = [
  "content-type",
  "accept",
  // Claude Code's gateway contract asks proxies to forward both verbatim
  // rather than allow-listing individual beta values.
  "anthropic-version",
  "anthropic-beta",
  "user-agent",
];

/**
 * Upstream response headers worth handing back: the content type (so an SSE
 * stream still reads as one) and the request id under both spellings --
 * OpenRouter answers with `x-request-id`, Anthropic's API and its SDK use
 * `request-id`, and a client may look for either.
 */
export const PASS_BACK_RESPONSE_HEADERS = ["content-type", "x-request-id", "request-id"];

export type AnthropicUpstreamOptions = {
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Sent as `HTTP-Referer` for OpenRouter app attribution. */
  referer?: string;
  /** Sent as `X-Title` for OpenRouter app attribution. */
  title?: string;
};

export type AnthropicSendOptions = {
  method: string;
  /** Root-relative path under OpenRouter's `/v1`, e.g. `/messages`. */
  path: string;
  /** The user's OpenRouter key, already in `Bearer <key>` form. */
  authorization: string;
  /** The client's own headers; only the allow-list above is copied. */
  headers: Headers;
  body?: string;
};

/**
 * POSTs to `https://openrouter.ai/api/v1/messages` and friends. Non-2xx
 * responses come back as ordinary `Response` objects so the gateway can pass
 * an upstream refusal through with its own status and body; only a failure to
 * reach OpenRouter at all throws.
 */
export class AnthropicUpstream {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly referer?: string;
  private readonly title?: string;

  constructor(opts: AnthropicUpstreamOptions = {}) {
    this.baseUrl = opts.baseUrl ?? OPENROUTER_BASE_URL;
    this.fetchImpl = opts.fetch ?? fetch;
    if (opts.referer !== undefined) this.referer = opts.referer;
    if (opts.title !== undefined) this.title = opts.title;
  }

  /** `POST /messages` with a prepared body. The caller ran `prepareBody`. */
  async messages(opts: {
    authorization: string;
    headers: Headers;
    body: Record<string, unknown>;
    /** Query string from the client's URL, `?beta=true` and the like. */
    search?: string;
  }): Promise<Response> {
    return this.send({
      method: "POST",
      path: `/messages${opts.search ?? ""}`,
      authorization: opts.authorization,
      headers: opts.headers,
      body: JSON.stringify(opts.body),
    });
  }

  /** Any other `/messages/*` path, forwarded verbatim. */
  async send(opts: AnthropicSendOptions): Promise<Response> {
    if (!isSafePath(opts.path)) {
      throw new OpenRouterError(`Refusing to proxy unsafe path: ${opts.path}`, 400);
    }

    const headers = upstreamHeaders(opts.headers, opts.authorization, {
      ...(this.referer !== undefined ? { referer: this.referer } : {}),
      ...(this.title !== undefined ? { title: this.title } : {}),
    });

    const init: RequestInit = { method: opts.method, headers };
    if (opts.body !== undefined) {
      init.body = opts.body;
      if (!headers.has("content-type")) headers.set("content-type", "application/json");
    }

    try {
      return await this.fetchImpl(`${this.baseUrl}${opts.path}`, init);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new OpenRouterError(`OpenRouter messages request failed: ${message}`, 0);
    }
  }
}

/**
 * The outgoing header set. The credential is written once, as a bearer token,
 * whichever header the client used to send it.
 */
export function upstreamHeaders(
  incoming: Headers,
  authorization: string,
  opts: { referer?: string; title?: string } = {},
): Headers {
  const headers = new Headers();
  for (const [key, value] of incoming.entries()) {
    const lower = key.toLowerCase();
    if (FORWARDED_REQUEST_HEADERS.includes(lower)) headers.set(lower, value);
  }
  headers.set("authorization", authorization);
  if (opts.referer !== undefined) headers.set("HTTP-Referer", opts.referer);
  if (opts.title !== undefined) headers.set("X-Title", opts.title);
  return headers;
}

/** The upstream headers worth handing to the client. */
export function passBackHeaders(upstream: Response): Headers {
  const headers = new Headers();
  for (const name of PASS_BACK_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  return headers;
}

/** Root-relative, no `..` segments, no protocol-relative `//` prefix. */
function isSafePath(path: string): boolean {
  if (!path.startsWith("/") || path.startsWith("//")) return false;
  const pathname = path.split(/[?#]/)[0] ?? path;
  const segments = pathname.split("/");
  return !segments.includes("..") && !segments.includes(".");
}
