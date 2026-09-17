/**
 * Thin client over OpenRouter's `/v1` API. It never buffers or transforms
 * response bodies — callers get the upstream `Response` object back
 * untouched so streaming responses can be piped straight through.
 */

import { forwardHeaders, OPENROUTER_BASE_URL } from "./forward.js";

type FetchLike = typeof fetch;

/**
 * Raised when the client itself fails to reach OpenRouter (network error)
 * or is asked to do something it refuses (an unsafe proxy path). Upstream
 * non-2xx HTTP responses are NOT raised this way — they're returned as a
 * normal `Response` so the gateway can pass them straight through.
 */
export class OpenRouterError extends Error {
  readonly status: number;
  readonly body?: unknown;

  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = "OpenRouterError";
    this.status = status;
    if (body !== undefined) this.body = body;
  }
}

export type OpenRouterClientOptions = {
  baseUrl?: string;
  fetch?: FetchLike;
  /** Sent as `HTTP-Referer` for OpenRouter app attribution. */
  referer?: string;
  /** Sent as `X-Title` for OpenRouter app attribution. */
  title?: string;
};

const MODELS_CACHE_TTL_MS = 5 * 60 * 1000;

type ModelsCacheEntry = { data: unknown[]; expiresAt: number };

export class OpenRouterClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly referer?: string;
  private readonly title?: string;
  private modelsCache?: ModelsCacheEntry;

  constructor(opts: OpenRouterClientOptions = {}) {
    this.baseUrl = opts.baseUrl ?? OPENROUTER_BASE_URL;
    this.fetchImpl = opts.fetch ?? fetch;
    if (opts.referer !== undefined) this.referer = opts.referer;
    if (opts.title !== undefined) this.title = opts.title;
  }

  /**
   * POSTs a prepared chat completions body to OpenRouter and returns the
   * upstream `Response` unread. The caller is responsible for having
   * already run `prepareBody`; this method does not rewrite the model or
   * strip `milo`.
   */
  async chatCompletions(opts: {
    headers: Headers;
    body: Record<string, unknown>;
    signal?: AbortSignal;
  }): Promise<Response> {
    const headers = this.buildHeaders(opts.headers);
    headers.set("content-type", "application/json");

    const init: RequestInit = {
      method: "POST",
      headers,
      body: JSON.stringify(opts.body),
    };
    if (opts.signal) init.signal = opts.signal;

    return this.doFetch(`${this.baseUrl}/chat/completions`, init, "chat completions");
  }

  /**
   * POSTs a prepared Responses API body to OpenRouter's `/responses` and
   * returns the upstream `Response` unread, exactly as `chatCompletions`
   * does. Same contract: the caller has already run `prepareBody`, and a
   * streamed body is never touched here.
   */
  async responses(opts: {
    headers: Headers;
    body: Record<string, unknown>;
    signal?: AbortSignal;
  }): Promise<Response> {
    const headers = this.buildHeaders(opts.headers);
    headers.set("content-type", "application/json");

    const init: RequestInit = {
      method: "POST",
      headers,
      body: JSON.stringify(opts.body),
    };
    if (opts.signal) init.signal = opts.signal;

    return this.doFetch(`${this.baseUrl}/responses`, init, "responses");
  }

  /**
   * Lists OpenRouter's models. Cached for five minutes per client instance,
   * keyed by nothing — the list is the same for every caller, so the
   * `authorization` value used for one call is never stored and never
   * affects the cache key.
   */
  async listModels(authorization: string): Promise<{ data: unknown[] }> {
    const now = Date.now();
    if (this.modelsCache && this.modelsCache.expiresAt > now) {
      return { data: this.modelsCache.data };
    }

    const headers = new Headers();
    headers.set("authorization", authorization);
    headers.set("accept", "application/json");

    const response = await this.doFetch(`${this.baseUrl}/models`, { method: "GET", headers }, "models");

    if (!response.ok) {
      const body = await safeJson(response);
      throw new OpenRouterError(`OpenRouter models request failed with status ${response.status}`, response.status, body);
    }

    const json = (await response.json()) as { data?: unknown[] };
    const data = Array.isArray(json.data) ? json.data : [];
    this.modelsCache = { data, expiresAt: now + MODELS_CACHE_TTL_MS };
    return { data };
  }

  /**
   * Generic passthrough for any `/v1/*` path not handled explicitly
   * elsewhere. `path` must be root-relative (start with `/`); path
   * traversal and absolute URLs are rejected before any network call.
   */
  async proxy(opts: {
    method: string;
    path: string;
    headers: Headers;
    body?: Record<string, unknown> | string | null;
    signal?: AbortSignal;
  }): Promise<Response> {
    if (!isSafeProxyPath(opts.path)) {
      throw new OpenRouterError(`Refusing to proxy unsafe path: ${opts.path}`, 400);
    }

    const headers = this.buildHeaders(opts.headers);
    const init: RequestInit = { method: opts.method, headers };
    if (opts.signal) init.signal = opts.signal;

    if (opts.body !== undefined && opts.body !== null) {
      if (typeof opts.body === "string") {
        init.body = opts.body;
      } else {
        init.body = JSON.stringify(opts.body);
        if (!headers.has("content-type")) headers.set("content-type", "application/json");
      }
    }

    return this.doFetch(`${this.baseUrl}${opts.path}`, init, "proxy");
  }

  private buildHeaders(incoming: Headers): Headers {
    const opts: { referer?: string; title?: string } = {};
    if (this.referer !== undefined) opts.referer = this.referer;
    if (this.title !== undefined) opts.title = this.title;
    return forwardHeaders(incoming, opts);
  }

  private async doFetch(url: string, init: RequestInit, label: string): Promise<Response> {
    try {
      return await this.fetchImpl(url, init);
    } catch (err) {
      throw new OpenRouterError(`OpenRouter ${label} request failed: ${toErrorMessage(err)}`, 0);
    }
  }
}

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

/** Root-relative, no `..` segments, no protocol-relative `//` prefix. */
function isSafeProxyPath(path: string): boolean {
  if (!path.startsWith("/") || path.startsWith("//")) return false;
  const pathname = path.split(/[?#]/)[0] ?? path;
  const segments = pathname.split("/");
  if (segments.includes("..") || segments.includes(".")) return false;
  return true;
}
