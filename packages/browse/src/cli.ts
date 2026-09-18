#!/usr/bin/env node
/**
 * A thin browse runner (ADR-016): dry-run the gate layer over a scripted page,
 * or print the MCP tool stub. This is live glue -- it talks to the real Jev API
 * -- so it is deliberately NOT covered by `pnpm test`; the loop and gates are
 * tested through injected fakes elsewhere.
 *
 * The dry-run drives a `FakeDriver` built from a screens JSON, so it exercises
 * observe/gate/locate/sensitive/verify against a real Jev without a browser --
 * a browse counterpart to `milo explain`. Wiring a real `PlaywrightDriver`
 * (`playwright-driver.ts`) is the caller's job and out of v0 scope.
 *
 *   JEV_API_KEY=... milo-browse --goal "export the report" --screens page.json --max 6
 *   milo-browse --describe
 *
 * page.json is `{ "screens": [ { "url": "...", "title": "...", "elements": [...] } ] }`.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { JevClient } from "@milo/core";
import { runBrowseTask } from "./browse.js";
import { FakeDriver } from "./driver.js";
import { describeMcpServer } from "./mcp.js";
import type { PageObservation } from "./types.js";

type Args = { goal: string; screens: string; max: number };

function parseArgs(argv: string[]): Args {
  const get = (flag: string, fallback?: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i !== -1 && i + 1 < argv.length ? argv[i + 1] : fallback;
  };
  const goal = get("--goal");
  const screens = get("--screens");
  if (goal === undefined) throw new Error("--goal <text> is required");
  if (screens === undefined) throw new Error("--screens <path> is required");
  return { goal, screens, max: Number(get("--max", "8")) };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--describe")) {
    console.log(JSON.stringify(describeMcpServer(), null, 2));
    return;
  }

  const args = parseArgs(argv);
  const apiKey = process.env["JEV_API_KEY"];
  if (apiKey === undefined || apiKey === "") throw new Error("JEV_API_KEY must be set");

  const raw = JSON.parse(await readFile(resolve(args.screens), "utf8")) as { screens: PageObservation[] };
  const jev = new JevClient({ apiKey });
  const driver = new FakeDriver(raw.screens);

  const result = await runBrowseTask({
    driver,
    jev,
    goal: args.goal,
    maxSteps: args.max,
    onNeedsHuman: (e) => console.log(`[needs-human] ${e.reason} at step ${String(e.step)} (page ${e.pageKind})`),
  });

  console.log(`status: ${result.status} (${String(result.steps)} step(s))`);
  for (const s of result.trace) {
    const bits = [
      `#${String(s.step)}`,
      `kind=${s.pageKind}(${s.observeConfidence.toFixed(2)})`,
      s.located ? `ref=${s.located.ref}(${s.located.confidence.toFixed(2)})` : "ref=-",
      s.action ? `act=${s.action.kind}` : "act=-",
      s.verify ? `ok=${String(s.verify.success)}` : "ok=-",
      s.escalation ?? "",
    ];
    console.log(bits.filter((b) => b !== "").join(" "));
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
