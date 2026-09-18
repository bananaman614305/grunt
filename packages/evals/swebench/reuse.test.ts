import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PiEventParser as AgenticParser } from "../agentic/pi-events.js";

/**
 * The SWE-bench harness must REUSE the agentic harness's pi-event parser and
 * decision attribution, not fork its own copy. This guards against a future
 * edit quietly reintroducing a divergent parser.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const generateSrc = readFileSync(join(HERE, "generate.ts"), "utf8");

describe("pi-events reuse", () => {
  it("imports the parser from the agentic harness", () => {
    expect(generateSrc).toContain('from "../agentic/pi-events.js"');
    expect(generateSrc).toContain('from "../agentic/decisions.js"');
  });

  it("does not define its own PiEventParser or event parser", () => {
    expect(generateSrc).not.toMatch(/class\s+PiEventParser/);
    expect(generateSrc).not.toMatch(/function\s+parsePiEvents/);
  });

  it("the imported parser is the real agentic implementation", () => {
    const parser = new AgenticParser();
    parser.feed(JSON.stringify({ type: "message_end", message: { role: "assistant" } }));
    parser.end();
    expect(parser.stats().turns).toBe(1);
  });
});
