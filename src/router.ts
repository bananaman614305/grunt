import type { AgentConfig, Call, Kind, ModelPrior } from "./types.js";

const prior = (model: string, quality: number, input: number, output: number, latencyMs: number): ModelPrior => ({
  model, quality: { chat: quality, code: quality, research: quality, writing: quality },
  inputUsdPerM: input, outputUsdPerM: output, contextLength: 128_000, reliability: 0.98, latencyMs,
});
// Initial estimates, replaced by measured call averages as traffic arrives.
export const DEFAULT_WHITELIST: ModelPrior[] = [
  prior("deepseek/deepseek-v4.1-flash", 0.85, 0.14, 0.28, 1500),
  prior("z-ai/glm-5.3-flash", 0.84, 0.1, 0.4, 1700),
  prior("z-ai/glm-5.3", 0.91, 0.6, 2, 3500),
  prior("openai/gpt-5.6-luna", 0.95, 2.5, 15, 4500),
  prior("anthropic/claude-opus-5", 0.96, 5, 25, 5000),
];
const weights: Record<Kind, { latency: number; cost: number }> = {
  chat: { latency: 0.0001, cost: 2 }, code: { latency: 0.000005, cost: 0.5 },
  research: { latency: 0.000005, cost: 0.5 }, writing: { latency: 0.000005, cost: 0.5 },
};
export function whitelist(config: AgentConfig = {}): ModelPrior[] {
  return (config.whitelist ?? DEFAULT_WHITELIST).filter(m => !m.model.trim().toLowerCase().startsWith("google/"));
}
export function pick(task: { kind: Kind; inputTokens: number; outputTokens: number }, calls: Call[] = [], config: AgentConfig = {}, excluded: string[] = [], now = Date.now()) {
  const w = weights[task.kind];
  const candidates = whitelist(config).filter(m =>
    !excluded.includes(m.model) && m.contextLength >= task.inputTokens + task.outputTokens &&
    !calls.some(c => c.model === m.model && c.outcome === "429" && now - c.ts < 60_000),
  ).map(m => {
    const history = calls.filter(c => c.model === m.model);
    const reliability = (history.filter(c => c.outcome === "ok").length + (m.reliability ?? 0.98) * 5) / (history.length + 5);
    const latency = (history.reduce((n, c) => n + c.latency_ms, 0) + (m.latencyMs ?? 2000) * 5) / (history.length + 5);
    const cost = (task.inputTokens * m.inputUsdPerM + task.outputTokens * m.outputUsdPerM) / 1e6;
    const quality = m.quality[task.kind];
    const score = reliability * quality - w.latency * latency - w.cost * cost;
    return { model: m.model, score, reliability, quality, latency, cost };
  }).sort((a, b) => b.score - a.score);
  const best = candidates[0];
  if (!best) throw new Error("No whitelisted model fits this task or all models are cooling down.");
  return { model: best.model, score: best.score,
    reason: `Utility ${best.score.toFixed(3)}: reliability ${best.reliability.toFixed(2)}, quality ${best.quality.toFixed(2)}, expected latency ${Math.round(best.latency)}ms, expected cost $${best.cost.toFixed(5)}.`, candidates };
}
