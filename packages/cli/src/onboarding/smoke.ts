/**
 * The smoke verify for `milo on`: after the provider is written, route one
 * `milo/auto` request through the gateway the provider points at and print
 * the `x-milo-model` response header -- proof that Jev classified, policy
 * chose, and OpenRouter answered. The response header is the proof, exactly
 * as `milo configure`'s smoke step uses it.
 */
import { ROUTED_MODEL_ID } from "@milo/core";
import type { CliDeps } from "../deps.js";
import { apiBaseUrl } from "./paths.js";

export async function smokeVerify(
  deps: Pick<CliDeps, "fetch" | "stdout" | "stderr">,
  opts: { gatewayRoot: string; openRouterKey: string },
): Promise<boolean> {
  try {
    const res = await deps.fetch(`${apiBaseUrl(opts.gatewayRoot)}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${opts.openRouterKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: ROUTED_MODEL_ID,
        messages: [{ role: "user", content: "ping" }],
      }),
    });

    const model = res.headers.get("x-milo-model");
    if (res.ok && model !== null) {
      deps.stdout.write(`milo: smoke verify OK — routed to ${model} (x-milo-model: ${model})\n`);
      return true;
    }
    const body = await res.text();
    const excerpt = body.replace(/\s+/g, " ").slice(0, 200);
    deps.stderr.write(
      `milo on: smoke verify failed (HTTP ${res.status})${excerpt === "" ? "" : `: ${excerpt}`}\n`,
    );
  } catch (error) {
    deps.stderr.write(
      `milo on: smoke verify request failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
  return false;
}