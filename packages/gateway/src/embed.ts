/**
 * The embedding client for two-stage fact retrieval (ADR-018), gateway side.
 *
 * Core owns the interface (`EmbedClientLike`) and the pure vector math; this is
 * the one network piece: an OpenAI-compatible `POST /embeddings` call that
 * turns text into a vector. It authenticates with the *caller's forwarded key*
 * -- the same BYOK credential already flowing to the model -- so hosted Milo
 * needs no embedding key of its own and a self-hoster brings none. The default
 * endpoint is the same OpenRouter base URL the completions go to; a deployment
 * whose provider does not serve embeddings can point `baseUrl`/`model` at one
 * that does.
 *
 * Everything here fails SOFT. An embedding is a latency-hidden optimisation,
 * never a correctness dependency: any error -- no key, a non-2xx, a timeout, a
 * malformed body -- resolves to `undefined`, and the retrieval path then falls
 * open to asking Jev about every fact, exactly as it did before ADR-018. So a
 * broken or unsupported embeddings endpoint degrades cost, never answers.
 */

import type { EmbedClientLike, EmbeddingVector } from "@milo/core";
import { errorMessage } from "./errors.js";
import type { Logger } from "./app.js";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** The embeddings model and endpoint a deployment resolves to (ADR-018). */
export type FactRetrievalConfig = {
  /** OpenAI-compatible embeddings model id (e.g. `openai/text-embedding-3-small`). */
  model: string;
  /** Base URL of the completions provider; `/embeddings` is appended. */
  baseUrl: string;
  /** Injected for tests; defaults to global `fetch`. */
  fetch?: FetchLike;
};

/** The default embeddings model: small, cheap, and widely hosted. */
export const DEFAULT_EMBED_MODEL = "openai/text-embedding-3-small";

/** How long a query embedding may take before the gate gives up and fails open. */
export const EMBED_BUDGET_MS = 2_000;

export type OpenRouterEmbedOptions = FactRetrievalConfig & {
  /** The caller's forwarded `Authorization` header, verbatim (`Bearer …`). */
  authorization: string;
};

/**
 * An `EmbedClientLike` bound to one caller's forwarded key. Constructed per
 * request from `deps.factRetrieval` plus the request's `Authorization`, so the
 * key that pays for the completion pays for its embedding and nothing is
 * stored server-side. `embed` batches inputs into one call and returns one
 * vector per input, in order; a failure throws, and callers treat a throw as
 * "no vector" (fail open).
 */
export class OpenRouterEmbedClient implements EmbedClientLike {
  private readonly model: string;
  private readonly url: string;
  private readonly authorization: string;
  private readonly fetchImpl: FetchLike;

  constructor(opts: OpenRouterEmbedOptions) {
    this.model = opts.model;
    this.url = `${opts.baseUrl.replace(/\/+$/, "")}/embeddings`;
    this.authorization = opts.authorization;
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
  }

  async embed(texts: string[], opts?: { signal?: AbortSignal; budgetMs?: number }): Promise<EmbeddingVector[]> {
    if (texts.length === 0) return [];

    const controller = opts?.signal === undefined ? new AbortController() : undefined;
    const budget = opts?.budgetMs ?? EMBED_BUDGET_MS;
    const timer = controller === undefined ? undefined : setTimeout(() => controller.abort(), budget);
    const signal = opts?.signal ?? controller?.signal;

    try {
      const res = await this.fetchImpl(this.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: this.authorization,
        },
        body: JSON.stringify({ model: this.model, input: texts }),
        ...(signal !== undefined ? { signal } : {}),
      });
      if (!res.ok) {
        throw new Error(`embeddings endpoint returned ${res.status}`);
      }
      const json = (await res.json()) as { data?: { embedding?: unknown }[] };
      const data = json.data;
      if (!Array.isArray(data) || data.length !== texts.length) {
        throw new Error("embeddings response shape did not match the request");
      }
      return data.map((row) => {
        const v = row.embedding;
        if (!Array.isArray(v) || v.length === 0 || !v.every((n) => typeof n === "number" && Number.isFinite(n))) {
          throw new Error("embeddings response contained a malformed vector");
        }
        return v as number[];
      });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

/**
 * Builds the embed client for one request, or undefined when retrieval is not
 * configured or the caller sent no bearer key to forward. Undefined means the
 * retrieval pre-filter is skipped and the gate falls open to all facts, so a
 * missing client never blocks or errors a request.
 */
export function embedClientFor(
  config: FactRetrievalConfig | undefined,
  authorization: string,
): EmbedClientLike | undefined {
  if (config === undefined) return undefined;
  if (!/^Bearer\s+\S/i.test(authorization)) return undefined;
  const opts: OpenRouterEmbedOptions = { model: config.model, baseUrl: config.baseUrl, authorization };
  if (config.fetch !== undefined) opts.fetch = config.fetch;
  return new OpenRouterEmbedClient(opts);
}

/**
 * Embeds one text and returns its vector, or undefined on any failure. This is
 * the fail-open seam the whole retrieval path leans on: the query embedding, a
 * fact backfill, everything that turns text into a vector goes through here, so
 * one embeddings outage becomes "fall back to the old all-facts gate", never an
 * error surfaced to the caller.
 */
export async function embedOne(
  embed: EmbedClientLike | undefined,
  text: string,
  logger?: Logger,
): Promise<EmbeddingVector | undefined> {
  if (embed === undefined || text.trim().length === 0) return undefined;
  try {
    const [vec] = await embed.embed([text]);
    return vec;
  } catch (err) {
    logger?.warn("fact embedding failed; falling open", { error: errorMessage(err) });
    return undefined;
  }
}
