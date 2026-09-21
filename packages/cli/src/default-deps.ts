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
 * Reads one line from stdin. `secret` masks the typed value with stars when
 * stdin is a real terminal; an empty line, EOF, or Ctrl-C returns
 * `undefined` so an unattended `milo configure` skips the step instead of
 * hanging. A pipe (CI) never sees masking: the caller already refuses
 * secrets it cannot protect.
 */
function prompt(label: string, secret = false): Promise<string | undefined> {
  if (secret && stdin.isTTY === true) {
    return secretPrompt(label);
  }
  return new Promise((resolve) => {
    const rl = createInterface({ input: stdin, output: stdout, terminal: stdin.isTTY === true });
    rl.question(label, (answer: string) => {
      rl.close();
      const trimmed = answer.trim();
      resolve(trimmed === "" ? undefined : trimmed);
    });
  });
}

/**
 * Raw-mode secret input: prints the label once, then a star per character
 * typed. Deliberately does not use readline, whose line refresh would
 * redraw over (and hide) the standalone label -- the bug this replaces.
 */
function secretPrompt(label: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    stdout.write(label);
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    let input = "";
    const finish = (value: string | undefined) => {
      stdin.setRawMode(wasRaw);
      stdin.off("data", onData);
      stdin.pause();
      // Start the callee's next line fresh instead of appending to the prompt.
      stdout.write("\n");
      resolve(value);
    };
    const onData = (chunk: Buffer) => {
      for (const byte of chunk) {
        if (byte === 10 || byte === 13) {
          finish(input.trim() === "" ? undefined : input.trim());
          return;
        }
        if (byte === 3) {
          // Ctrl-C, which raw mode no longer converts to SIGINT: abort the
          // prompt gracefully instead of leaving the terminal in raw mode.
          finish(undefined);
          return;
        }
        if (byte === 127 || byte === 8) {
          if (input.length > 0) {
            input = input.slice(0, -1);
            stdout.write("\b \b");
          }
          continue;
        }
        if (byte < 32) continue; // other control bytes (arrows, tabs) are ignored
        input += String.fromCharCode(byte);
        stdout.write("*");
      }
    };
    stdin.on("data", onData);
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
    isTTY: stdin.isTTY === true,
    openBillingStore: (url: string) => PgBillingStore.open({ url }),
    createStripeClient: (opts) => createStripeClient(opts),
    createProvisioningClient: () => new OpenRouterProvisioningClient(),
  };
}
