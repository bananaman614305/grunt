/**
 * Opt-in live test against the real `codex` and `claude` CLIs on this
 * machine. Spends a tiny amount of each subscription. Excluded from
 * `pnpm test` (`*.live.test.ts`); run with
 * `MILO_LIVE_CLI=1 pnpm vitest run --config vitest.live.config.ts`.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeBackend } from "./claude.js";
import { CodexBackend } from "./codex.js";

const live = process.env["MILO_LIVE_CLI"] === "1";
const workdir = mkdtempSync(join(tmpdir(), "milo-live-"));

describe.skipIf(!live)("subscription CLIs (live)", () => {
  it("codex answers through `codex exec` and reports plan limits through app-server", async () => {
    const backend = new CodexBackend({ workdir });
    const outcome = await backend.run({ prompt: "Reply with exactly the word: pong" });
    expect(outcome).toMatchObject({ ok: true });
    if (outcome.ok) expect(outcome.text.toLowerCase()).toContain("pong");

    const limits = await backend.readLimits();
    expect(limits?.windows.length).toBeGreaterThan(0);
    expect(typeof limits?.windows[0]?.usedPercent).toBe("number");
  }, 180_000);

  it("claude answers through `claude -p` and reports plan limits in its stream", async () => {
    const backend = new ClaudeBackend({ workdir });
    const outcome = await backend.run({ prompt: "Reply with exactly the word: pong" });
    expect(outcome).toMatchObject({ ok: true });
    if (outcome.ok) {
      expect(outcome.text.toLowerCase()).toContain("pong");
      expect(outcome.limits?.windows.length).toBeGreaterThan(0);
    }
  }, 180_000);
});
