/**
 * @milo/browse -- Milo's browser-automation capability (ADR-016).
 *
 * A capability the frontier agent (or a fleet worker) CALLS: it hands over one
 * plain-language goal, and Milo drives a page toward it through a layer of
 * cheap, calibrated Jev decision gates -- the "senses" -- while a PLUGGABLE
 * driver does the actual clicking -- the "muscle". Milo ships no browser and
 * forks no third-party tool. The default driver is Playwright over CDP; a
 * Squire-operate or computer-use adapter can implement the same interface.
 * See docs/browser.md.
 */

export * from "./types.js";
export * from "./driver.js";
export * from "./questions.js";
export * from "./gates.js";
export * from "./browse.js";
export * from "./mcp.js";
export * from "./playwright-driver.js";
