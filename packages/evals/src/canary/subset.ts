/**
 * Deterministic subset selection for the canary (`docs/PLAN.md`'s "continuous
 * eval canary"): a small, fixed slice of `packages/evals/data/routing.jsonl`
 * cheap enough to run every few minutes from cron or CI, but stratified
 * across difficulty bands so it still catches a real regression rather than
 * noise from one flaky example.
 *
 * `routing.jsonl`'s labels interleave difficulty bands throughout the file
 * (band 0 and band 3 examples are both present in the first ten and the last
 * ten ids), so a plain prefix slice would not sample evenly. Round-robin
 * picking across bands, in id order within each band, does.
 */
import type { RoutingExample } from "../schema.js";

/** Default canary size: within the "~20-30 examples" the plan asks for. */
export const DEFAULT_CANARY_SIZE = 24;

/**
 * Picks `size` examples from `examples`, round-robin across
 * `difficulty_band` (0..3), in ascending `id` order within each band. Always
 * deterministic for a fixed `examples` array: the same input produces the
 * same subset every time, so two canary runs against the same fixture set are
 * comparable.
 *
 * When `size` is at least the total example count, every example is
 * returned (still sorted by id). Throws if `size` is not a positive integer.
 */
export function selectCanarySubset(
  examples: readonly RoutingExample[],
  size: number = DEFAULT_CANARY_SIZE,
): RoutingExample[] {
  if (!Number.isInteger(size) || size <= 0) {
    throw new Error(`selectCanarySubset: size must be a positive integer, got ${size}`);
  }

  const byBand = new Map<number, RoutingExample[]>();
  for (const example of examples) {
    const list = byBand.get(example.difficulty_band);
    if (list === undefined) {
      byBand.set(example.difficulty_band, [example]);
    } else {
      list.push(example);
    }
  }
  for (const list of byBand.values()) {
    list.sort((a, b) => a.id.localeCompare(b.id));
  }
  const bands = [...byBand.keys()].sort((a, b) => a - b);

  const picked: RoutingExample[] = [];
  for (let round = 0; picked.length < size; round += 1) {
    let addedThisRound = false;
    for (const band of bands) {
      if (picked.length >= size) break;
      const list = byBand.get(band) as RoutingExample[];
      const candidate = list[round];
      if (candidate !== undefined) {
        picked.push(candidate);
        addedThisRound = true;
      }
    }
    // Every band is exhausted: `size` exceeded the example count, so stop
    // rather than loop forever.
    if (!addedThisRound) break;
  }

  return picked.sort((a, b) => a.id.localeCompare(b.id));
}
