/**
 * Opt-in live test against the real TypeSafe API. Reads `JEV_API_KEY` from
 * the environment and skips (never fails) when it is absent. Excluded from
 * `pnpm test` by `vitest.config.ts` (`*.live.test.ts`); run explicitly with
 * `vitest run --config vitest.config.ts packages/core/src/jev/client.live.test.ts`
 * or a similar direct invocation, with `JEV_API_KEY` set.
 */
import { describe, expect, it } from "vitest";
import { JevClient } from "./client.js";
import { noul } from "./questions.js";

const apiKey = process.env.JEV_API_KEY;

describe.skipIf(!apiKey)("JevClient (live)", () => {
  it("lists models and answers a tiny systemone call", async () => {
    const client = new JevClient({ apiKey: apiKey! });

    const models = await client.listModels();
    expect(models.length).toBeGreaterThan(0);
    for (const m of models) {
      expect(typeof m.name).toBe("string");
    }

    const result = await client.systemone({
      state: "Is the sky blue?",
      questions: { obvious: noul("Is this question trivial to answer?") },
    });
    expect(result.answers.obvious).toMatchObject({ type: "noul" });
    expect(typeof result.requestId).toBe("string");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });
});
