/**
 * Small typed builders for Jev questions. See `./types.ts` for the wire
 * shapes these produce (mirrored from the TypeSafe OpenAPI spec).
 */

import type { JevChoiceQuestion, JevNoulQuestion, JevScoreQuestion } from "./types.js";

/** A yes/no question, answered with the probability of yes or true. */
export function noul(
  instructions: string,
  criteria?: { true?: string; false?: string },
): JevNoulQuestion {
  return {
    type: "noul",
    instructions,
    ...(criteria !== undefined ? { criteria } : {}),
  };
}

/** A question that selects one option from named choices. */
export function choice(
  instructions: string,
  criteria: Record<string, string | null>,
): JevChoiceQuestion {
  return { type: "choice", instructions, criteria };
}

/** A question that assigns a score using an ordered rubric. */
export function score(instructions: string, criteria: string[]): JevScoreQuestion {
  return { type: "score", instructions, criteria };
}
