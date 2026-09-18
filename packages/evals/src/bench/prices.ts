/**
 * Prices for the benchmark: OpenRouter's public catalogue for the arms, and
 * the Fable rate card for the baseline that is never actually called.
 *
 * The baseline is an estimate by design. Running every prompt through Fable
 * would cost more than the rest of the benchmark put together and would
 * only refine a number that the rate gap already settles. The estimate is
 * prompt tokens at Fable's input price plus completion tokens at Fable's
 * output price, using the compared arm's own token counts. Prompt tokens are
 * the same for every model; completion tokens are the assumption, so the
 * report also prints the figure at twice the observed completion count.
 */

import type { ModelPrice } from "./types.js";

/** The baseline model id on OpenRouter. */
export const BASELINE_MODEL_ID = "anthropic/claude-fable-5.1";

/** Fable 5.1 on OpenRouter, USD per million tokens, read 2026-09-17. Used only if the catalogue fetch fails. */
export const BASELINE_FALLBACK_PRICE: ModelPrice = { id: BASELINE_MODEL_ID, inputUsdPerM: 10, outputUsdPerM: 50 };

export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

type CatalogueEntry = { id: string; pricing?: { prompt?: string | null; completion?: string | null } | null };

/** Parses OpenRouter's `/models` payload into per-million prices for the ids asked for. */
export function pricesFromCatalogue(payload: unknown, ids: string[]): Map<string, ModelPrice> {
  const out = new Map<string, ModelPrice>();
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return out;
  const wanted = new Set(ids);
  for (const raw of data as CatalogueEntry[]) {
    if (!wanted.has(raw.id)) continue;
    const input = perMillion(raw.pricing?.prompt);
    const output = perMillion(raw.pricing?.completion);
    if (input === undefined || output === undefined) continue;
    out.set(raw.id, { id: raw.id, inputUsdPerM: input, outputUsdPerM: output });
  }
  return out;
}

function perMillion(price: string | null | undefined): number | undefined {
  if (price === null || price === undefined || price.trim() === "") return undefined;
  const perToken = Number(price);
  if (!Number.isFinite(perToken) || perToken < 0) return undefined;
  return Math.round(perToken * 1_000_000 * 10_000) / 10_000;
}

/** Fetches prices for `ids` from OpenRouter's public catalogue. No key needed. */
export async function fetchPrices(ids: string[], fetchImpl: typeof fetch = fetch): Promise<Map<string, ModelPrice>> {
  const response = await fetchImpl(OPENROUTER_MODELS_URL);
  if (!response.ok) throw new Error(`OpenRouter catalogue returned HTTP ${response.status}`);
  return pricesFromCatalogue(await response.json(), ids);
}

/** What the same call would have cost on `price`, USD. */
export function estimateCostUsd(
  price: ModelPrice,
  inputTokens: number,
  outputTokens: number,
  outputMultiplier = 1,
): number {
  return (inputTokens * price.inputUsdPerM + outputTokens * outputMultiplier * price.outputUsdPerM) / 1_000_000;
}

/** Cost from token counts on a known price; the fallback when a response reported no `usage.cost`. */
export function costFromTokens(price: ModelPrice | undefined, inputTokens?: number, outputTokens?: number): number | undefined {
  if (price === undefined || inputTokens === undefined || outputTokens === undefined) return undefined;
  return estimateCostUsd(price, inputTokens, outputTokens);
}
