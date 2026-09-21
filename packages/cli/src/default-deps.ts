/** The real `CliDeps`, wired to the actual gateway, log, env, and network. */
import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";
import { serve } from "@hono/node-server";
import { PgBillingStore } from "@milo/billing";
import { DecisionLog } from "@milo/core";
import { createGateway } from "@milo/gateway";
import { OpenRouterProvisioningClient } from "@milo/provisioning";
import { createStripeClient } from "@milo/stripe";
import type { CliDeps } from "./deps.js";

/**
 * Reads one line from stdin. `secret` prints stars instead of the typed
 * value when the terminal supports it; an empty line or EOF returns
 * `undefined` so an unattended `milo configure` skips the step instead of
 * hanging.
 */
function prompt(label: string, secret = false): Promise<string | undefined> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: stdin, output: stdout, terminal: stdin.isTTY === true });
    if (secret && rl.terminal) {
      // The readline echo path is private API, but the star-mute trick is the
      // standard one; guarded by `terminal` so a pipe (CI) is not touched.
      const muted = rl as unknown as { _writeToOutput(chunk: string): void };
      muted._writeToOutput = (chunk: string) =>
        stdout.write(chunk.replace(/[^\n]/g, "*"));
      rl.on("close", () => {
        muted._writeToOutput = (chunk: string) => stdout.write(chunk);
      });
    }
    rl.question(label, (answer: string) => {
      rl.close();
      const trimmed = answer.trim();
      resolve(trimmed === "" ? undefined : trimmed);
    });
  });
}

export function defaultDeps(): CliDeps {
  return {
    createGateway,
    openLog: (url: string) => DecisionLog.open(url),
    env: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
    serve,
    fetch: (input, init) => fetch(input, init),
    prompt,
    openBillingStore: (url: string) => PgBillingStore.open({ url }),
    createStripeClient: (opts) => createStripeClient(opts),
    createProvisioningClient: () => new OpenRouterProvisioningClient(),
  };
}
