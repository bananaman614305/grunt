/**
 * How `milo on` gets the caller's OpenRouter key. The provider block in
 * models.json only ever references the key by environment-variable name, so
 * an exported `OPENROUTER_API_KEY` is never written anywhere. When the
 * environment is empty and stdin is a real terminal, the key is prompted for
 * (masked) and stored in pi's own credential store (`~/.pi/agent/auth.json`).
 * Unattended runs with no key get a refused `absent` result and print the
 * export instruction instead of blocking on a prompt.
 */
import type { CliDeps } from "../deps.js";

export const KEY_ENV = "OPENROUTER_API_KEY";
const PROMPT_LABEL = "Paste your OpenRouter API key (sk-or-...); input is hidden";

export type KeyResolution =
  | { kind: "env"; key: string }
  | { kind: "prompted"; key: string }
  | { kind: "cancelled" }
  | { kind: "absent" };

/** `isTTY` may be unset (older deps) and is then treated as not a terminal. */
export type KeyDeps = Pick<CliDeps, "env" | "prompt"> & { isTTY: boolean | undefined };

export async function resolveKey(deps: KeyDeps): Promise<KeyResolution> {
  const envKey = deps.env[KEY_ENV];
  if (envKey !== undefined && envKey !== "") {
    return { kind: "env", key: envKey };
  }
  if (deps.isTTY === true) {
    const entered = await deps.prompt(PROMPT_LABEL, true);
    if (entered === undefined || entered === "") {
      return { kind: "cancelled" };
    }
    return { kind: "prompted", key: entered };
  }
  return { kind: "absent" };
}