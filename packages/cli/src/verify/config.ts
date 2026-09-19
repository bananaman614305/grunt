/**
 * Wiring the ground-truth Stop hook into a harness config (ADR-019), as pure
 * functions over config TEXT so the installer's logic is unit-tested without
 * touching a real config. `commands/verify.ts` is the thin fs glue that reads
 * the file, calls these, and writes the result back.
 *
 * Claude Code's `settings.json` is merged as structured JSON (its Stop-hook
 * schema is stable). Codex (`config.toml`) and Goose (`config.yaml`) are wired
 * with an idempotent, marker-delimited block appended to their config, because
 * merging TOML/YAML text in-tree is not worth a parser here; the block is the
 * v0 wiring and the installer prints what it added.
 */

import { join } from "node:path";

export const HARNESSES = ["claude-code", "codex", "goose"] as const;
export type Harness = (typeof HARNESSES)[number];

export function isHarness(value: string): value is Harness {
  return (HARNESSES as readonly string[]).includes(value);
}

/** Where each harness keeps its config, relative to a root dir. */
const CONFIG_FILE: Record<Harness, string> = {
  "claude-code": "settings.json",
  codex: "config.toml",
  goose: "config.yaml",
};

/** The default config root for a harness under a home directory. */
export function defaultRoot(harness: Harness, home: string): string {
  switch (harness) {
    case "claude-code":
      return join(home, ".claude");
    case "codex":
      return join(home, ".codex");
    case "goose":
      return join(home, ".config", "goose");
  }
}

/** The hook script's filename inside the config root. */
export const HOOK_SCRIPT_NAME = "milo-verify-hook.mjs";

/** The command a harness runs for the Stop hook. */
export function hookCommand(hookScriptPath: string): string {
  return `node ${JSON.stringify(hookScriptPath)}`;
}

const MARKER_BEGIN = "# >>> milo verify (ground-truth Stop hook) >>>";
const MARKER_END = "# <<< milo verify <<<";

type ClaudeHookEntry = { type: string; command: string };
type ClaudeHookGroup = { hooks?: ClaudeHookEntry[]; matcher?: string };

/**
 * Merge the Stop hook into a Claude Code `settings.json` text. Preserves every
 * existing key, adds `hooks.Stop` if absent, and is idempotent: a Stop entry
 * whose command already runs this hook script is not duplicated.
 */
export function mergeClaudeSettings(existing: string | undefined, command: string): string {
  let config: Record<string, unknown> = {};
  if (existing !== undefined && existing.trim() !== "") {
    try {
      const parsed: unknown = JSON.parse(existing);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        config = parsed as Record<string, unknown>;
      }
    } catch {
      // A malformed settings file is not overwritten silently: start clean but
      // keep nothing we cannot parse. The installer warns on this separately.
      config = {};
    }
  }

  const hooks = isRecord(config["hooks"]) ? { ...(config["hooks"] as Record<string, unknown>) } : {};
  const stop: ClaudeHookGroup[] = Array.isArray(hooks["Stop"]) ? [...(hooks["Stop"] as ClaudeHookGroup[])] : [];

  const already = stop.some((group) => (group.hooks ?? []).some((h) => h.command === command));
  if (!already) {
    stop.push({ hooks: [{ type: "command", command }] });
  }
  hooks["Stop"] = stop;
  config["hooks"] = hooks;
  return `${JSON.stringify(config, null, 2)}\n`;
}

/**
 * Append (idempotently) the marker-delimited hook block to a Codex/Goose
 * config text. Re-installing replaces the existing block rather than stacking a
 * second one.
 */
export function appendHookBlock(existing: string | undefined, harness: Harness, command: string): string {
  const base = existing ?? "";
  const withoutBlock = stripBlock(base);
  const body =
    harness === "codex"
      ? `[hooks]\nstop = ${JSON.stringify(command)}`
      : `hooks:\n  stop: ${JSON.stringify(command)}`;
  const block = `${MARKER_BEGIN}\n${body}\n${MARKER_END}\n`;
  const prefix = withoutBlock.trim() === "" ? "" : `${withoutBlock.replace(/\n*$/, "")}\n\n`;
  return `${prefix}${block}`;
}

/** Remove a previously-installed marker block, if present. */
function stripBlock(text: string): string {
  const start = text.indexOf(MARKER_BEGIN);
  if (start === -1) return text;
  const end = text.indexOf(MARKER_END, start);
  if (end === -1) return text.slice(0, start);
  return text.slice(0, start) + text.slice(end + MARKER_END.length).replace(/^\n/, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A computed install: which files to write, and their new contents. */
export type InstallPlan = {
  harness: Harness;
  /** Absolute path of the config root. */
  root: string;
  /** Absolute path of the hook script to write. */
  hookScriptPath: string;
  /** Absolute path of the harness config file. */
  configPath: string;
  /** The command the harness will run. */
  command: string;
  /** The merged config text to write. */
  configText: string;
  notes: string[];
};

/**
 * Compute the whole install for a harness given its root and the existing
 * config text (if any) and the hook script body. Pure: no fs, no side effects.
 */
export function planInstall(
  harness: Harness,
  root: string,
  existingConfig: string | undefined,
): Omit<InstallPlan, "hookScriptPath"> & { hookScriptPath: string } {
  const hookScriptPath = join(root, HOOK_SCRIPT_NAME);
  const configPath = join(root, CONFIG_FILE[harness]);
  const command = hookCommand(hookScriptPath);
  const configText =
    harness === "claude-code"
      ? mergeClaudeSettings(existingConfig, command)
      : appendHookBlock(existingConfig, harness, command);
  const notes = [
    `Wrote the Stop hook script to ${hookScriptPath}`,
    `Wired the Stop hook into ${configPath}`,
    "Set MILO_ENDPOINT and MILO_KEY in the harness environment (the hook needs a Milo endpoint, not a TypeSafe key).",
    "Ground-truth checks WARN by default; set MILO_VERIFY_BLOCK=1 to allow a block on a confident contradiction (at most twice per session).",
  ];
  return { harness, root, hookScriptPath, configPath, command, configText, notes };
}
