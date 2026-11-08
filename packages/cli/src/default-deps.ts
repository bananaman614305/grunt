/** The real `CliDeps`, wired to the actual gateway, log, env, and network. */
import { serve } from "@hono/node-server";
import { DecisionLog } from "@milo/core";
import { createGateway } from "@milo/gateway";
import type { CliDeps } from "./deps.js";

export function defaultDeps(): CliDeps {
  return {
    createGateway,
    openLog: (url: string) => DecisionLog.open(url),
    env: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
    serve,
    fetch: (input, init) => fetch(input, init),
  };
}
