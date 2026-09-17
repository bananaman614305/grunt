#!/usr/bin/env node
/** The `milo` binary: wires the real dependencies and dispatches argv. */
import { defaultDeps } from "./default-deps.js";
import { runCli } from "./index.js";

const code = await runCli(process.argv.slice(2), defaultDeps());
if (code !== undefined) {
  process.exitCode = code;
}
