import { readFileSync } from "node:fs";
import type { AgentConfig, ModelPrior } from "./types.js";

// Optional operator configuration: { "agent": { "whitelist": [...] } }.
export function loadConfig(path?: string): AgentConfig {
  if (!path) return {};
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new Error("GRUNT_CONFIG must name a readable JSON configuration file."); }
  const models = (value as { agent?: { whitelist?: unknown } } | null)?.agent?.whitelist;
  if (!Array.isArray(models) || models.length === 0) throw new Error("Configuration needs a nonempty agent.whitelist.");
  const valid = (n: unknown, min: number, max = Infinity): n is number => typeof n === "number" && Number.isFinite(n) && n >= min && n <= max;
  for (const model of models) {
    const m = model as Partial<ModelPrior> | null;
    if (!m || typeof m.model !== "string" || !m.model.trim() || m.model.trim() !== m.model ||
      !["chat", "code", "research", "writing"].every(k => valid(m.quality?.[k as keyof ModelPrior["quality"]], 0, 1)) ||
      !valid(m.inputUsdPerM, 0) || !valid(m.outputUsdPerM, 0) || !valid(m.contextLength, 1) || !Number.isInteger(m.contextLength) ||
      (m.reliability !== undefined && !valid(m.reliability, 0, 1)) || (m.latencyMs !== undefined && !valid(m.latencyMs, 0))) {
      throw new Error("Invalid model prior in agent.whitelist.");
    }
  }
  if (new Set(models.map(m => (m as ModelPrior).model)).size !== models.length) throw new Error("Duplicate model in agent.whitelist.");
  return { whitelist: models as ModelPrior[] };
}
