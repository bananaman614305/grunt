/**
 * The compute controller behind the composed `deepseek` benchmark arm
 * (ADR-012 phase 1).
 *
 * The controller itself -- the band gates, the band-to-budget table, and
 * the sizing call -- moved to `@milo/core` (`router/controller.ts`) when the
 * live gateway grew a `"deepseek"` mode, so the bench and the gateway read
 * one copy of the measured semantics. This module re-exports it under the
 * bench's historical names; drawing, ranking, and the adaptive stop still
 * live in `run.ts` next to the best-of-N machinery they reuse.
 */

export {
  computeBand,
  computeBudget,
  sizeCompute,
  DEEPSEEK_BRANCH_MODEL,
  DEEPSEEK_ORCHESTRATOR_MODEL,
  SIZING_BUDGET_MS,
} from "@milo/core";
export type { ComputeBand, ComputeBudget, ComputeSizing } from "@milo/core";
