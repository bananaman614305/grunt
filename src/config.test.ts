import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { DEFAULT_WHITELIST } from "./router.js";

it("loads validated operator priors and rejects malformed configurations", () => {
  const dir = mkdtempSync(join(tmpdir(), "grunt-config-"));
  const file = join(dir, "config.json");
  try {
    expect(loadConfig()).toEqual({});
    writeFileSync(file, JSON.stringify({ agent: { whitelist: DEFAULT_WHITELIST } }));
    expect(loadConfig(file).whitelist).toEqual(DEFAULT_WHITELIST);
    for (const value of [null, {}, { agent: { whitelist: [] } }, { agent: { whitelist: [{ ...DEFAULT_WHITELIST[0], contextLength: -1 }] } }, { agent: { whitelist: [DEFAULT_WHITELIST[0], DEFAULT_WHITELIST[0]] } }]) {
      writeFileSync(file, JSON.stringify(value)); expect(() => loadConfig(file)).toThrow();
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
