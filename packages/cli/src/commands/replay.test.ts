import { describe, expect, it } from "vitest";
import { createTestDeps } from "../test-support.js";
import { run } from "./replay.js";

describe("milo replay", () => {
  it("requires a positive --sample, because every task spends real quota", async () => {
    for (const args of [[], ["--sample", "0"], ["--sample", "all"]]) {
      const { deps, stderr } = createTestDeps();
      expect(await run(args, deps)).toBe(1);
      expect(stderr.toString()).toContain("--sample <n> is required");
    }
  });

  it("replays through the given gateway and prints the summary", async () => {
    const { deps, stdout } = createTestDeps({
      fetch: async (input) => {
        if (String(input).endsWith("/v1/usage")) return Response.json({ subscriptions: [] });
        return Response.json({ usage: { prompt_tokens: 5, completion_tokens: 1 } }, { headers: { "x-milo-backend": "codex" } });
      },
    });
    expect(await run(["--sample", "2", "--url", "http://127.0.0.1:1"], deps)).toBe(0);
    expect(stdout.toString()).toContain("Replay of 2 of 120 Milo routing tasks through http://127.0.0.1:1");
    expect(stdout.toString()).toContain("codex: 2 tasks");
  });
});
