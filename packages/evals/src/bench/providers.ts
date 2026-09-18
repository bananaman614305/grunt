/**
 * Per-model OpenRouter provider pins for the benchmark.
 *
 * OpenRouter routes a model to whichever provider it picks, and providers
 * differ enough in throughput to swing a call's wall time several-fold (the
 * same DeepSeek model runs at 29 tok/s on one provider and 85 on another) and
 * to change the token accounting. A run is only comparable, and best-of-N is
 * only fast, when every model is pinned to a known-fast provider. These lists
 * were chosen from OpenRouter's own `/models/:id/endpoints` latency and
 * throughput data (authenticated), ranked by estimated time for a ~600-token
 * answer (time-to-first-token plus tokens / throughput), filtered to >=95%
 * 30-minute uptime. Refresh with `scripts/rank-providers.ts`.
 *
 * Each list is an OpenRouter `provider.order`, sent with fallbacks off, so the
 * first slug that serves the model wins. A model absent from the map is left
 * to OpenRouter's own choice.
 */

export type ProviderPins = Record<string, string[]>;

export const DEFAULT_PROVIDER_PINS: ProviderPins = {
  "deepseek/deepseek-v4-flash": ["alibaba", "baidu", "phala"],
  "z-ai/glm-5.3-flash": ["baseten", "friendli"],
  "xiaomi/mimo-v2.5": ["xiaomi"],
  "tencent/hy3": ["atlas-cloud", "novita", "phala"],
  "openai/gpt-5.6-luna": ["amazon-bedrock", "openai", "azure"],
  "deepseek/deepseek-v4.1-flash": ["together", "modal", "makora"],
  "minimax/minimax-m3": ["modelrun", "coreweave", "together"],
  "z-ai/glm-5.3": ["baseten", "mistral"],
  "google/gemini-3.8-flash": ["google-ai-studio", "google-vertex"],
  "nvidia/nemotron-3-ultra-550b-a55b": ["baseten", "venice"],
  "anthropic/claude-sonnet-5": ["azure", "google-vertex", "anthropic"]
};

/** The pin list for a model id, or an empty list when it is not pinned. */
export function pinsFor(model: string, pins: ProviderPins): string[] {
  return pins[model] ?? [];
}
