/**
 * The MCP tool surface (ADR-016): the one tool the frontier agent calls to run
 * a browse task. Same "capability, not agent" contract as the fleet's tools --
 * the frontier agent stays in charge and reaches for this the way it reaches
 * for a shell, handing over one bounded goal and getting back a status plus a
 * content-free trace.
 *
 * The handler is wired to injected deps (a Jev client, a driver factory, an
 * optional input resolver and human-pause hook), so it unit-tests against a
 * `FakeDriver` with no browser and no network. The MCP server TRANSPORT is a
 * documented STUB in v0, exactly like the fleet: `describeMcpServer` states how
 * a host registers the tool; bring your own JSON-RPC transport and forward the
 * call to the handler.
 *
 * SECRETS: the tool takes `inputKeys` -- the NAMES of fields the task may fill
 * -- never their values. The host binds those names to sealed credentials (e.g.
 * via the Squire vault) and passes the values in through `resolveInputs`, so no
 * field value crosses the model or the tool boundary.
 */

import type { JevClientLike } from "@milo/core";
import { runBrowseTask, type NeedsHumanEvent } from "./browse.js";
import type { Driver } from "./driver.js";
import type { BrowseResult, PageKind } from "./types.js";

/** A minimal JSON-Schema tool descriptor, MCP `tools/list` shape. */
export type ToolSchema = {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties: false;
  };
};

/** The single tool a host advertises for browse. */
export const BROWSE_TOOLS: ToolSchema[] = [
  {
    name: "browse_task",
    description:
      "Pursue one plain-language goal on a web page through Milo's Jev decision gates and a pluggable driver. Milo classifies each page, locates the element to act on, checks for captcha/2FA/consent walls and for irreversible actions, acts, and verifies -- pausing for a human on a wall or a sensitive action and escalating when it is unsure. Returns how it ended and a content-free trace. You stay in charge: call this for a bounded objective, then read the trace and decide the next move.",
    inputSchema: {
      type: "object",
      properties: {
        goal: { type: "string", description: "The plain-language objective to pursue on the page." },
        maxSteps: { type: "number", description: "Hard cap on loop iterations." },
        startUrl: { type: "string", description: "Optional url to open before the first observation." },
        inputKeys: {
          type: "array",
          items: { type: "string" },
          description:
            "Names of fields the task may fill (e.g. 'username', 'password'). The host binds these to sealed credentials; VALUES are never passed here.",
        },
        minConfidence: {
          type: "number",
          description: "Locate confidence below which the task escalates instead of acting (default 0.5).",
        },
      },
      required: ["goal", "maxSteps"],
      additionalProperties: false,
    },
  },
];

export type BrowseTaskArgs = {
  goal: string;
  maxSteps: number;
  startUrl?: string;
  inputKeys?: string[];
  minConfidence?: number;
};

export type BrowseToolResult = BrowseResult;

export type BrowseToolHandlers = {
  browse_task: (args: BrowseTaskArgs) => Promise<BrowseToolResult>;
};

/**
 * How the tool gets what it needs: a Jev client, a fresh driver per task (the
 * host owns the browser session), an optional resolver that turns declared
 * input keys into their sealed values, and an optional human-pause hook.
 */
export type BrowseToolDeps = {
  jev: JevClientLike;
  createDriver: (args: BrowseTaskArgs) => Driver;
  /** Turn declared input keys into `{ key: value }`; values never reach the model. */
  resolveInputs?: (keys: string[]) => Record<string, string> | Promise<Record<string, string>>;
  /** Called when a task pauses for a person. */
  onNeedsHuman?: (event: NeedsHumanEvent) => void | Promise<void>;
  /** Optional page-kind that ends a task; defaults to `result`. */
  doneWhen?: (kind: PageKind) => boolean;
};

function validate(args: BrowseTaskArgs): void {
  if (typeof args.goal !== "string" || args.goal === "") {
    throw new Error("browse_task requires a non-empty goal");
  }
  if (typeof args.maxSteps !== "number" || !Number.isInteger(args.maxSteps) || args.maxSteps <= 0) {
    throw new Error("browse_task requires a positive integer maxSteps");
  }
}

/** Build the `browse_task` handler over its deps. Wire into any MCP transport. */
export function createBrowseToolHandlers(deps: BrowseToolDeps): BrowseToolHandlers {
  return {
    async browse_task(args) {
      validate(args);
      const inputs =
        args.inputKeys !== undefined && deps.resolveInputs !== undefined
          ? await deps.resolveInputs(args.inputKeys)
          : {};
      return runBrowseTask({
        driver: deps.createDriver(args),
        jev: deps.jev,
        goal: args.goal,
        maxSteps: args.maxSteps,
        inputs,
        ...(args.startUrl !== undefined ? { startUrl: args.startUrl } : {}),
        ...(args.minConfidence !== undefined ? { minConfidence: args.minConfidence } : {}),
        ...(deps.onNeedsHuman !== undefined ? { onNeedsHuman: deps.onNeedsHuman } : {}),
        ...(deps.doneWhen !== undefined ? { doneWhen: deps.doneWhen } : {}),
      });
    },
  };
}

/**
 * A documented description of how a host wires the stub transport. Returned as
 * data so a CLI can print it; there is no live server in v0.
 */
export function describeMcpServer(): { name: string; version: string; tools: ToolSchema[]; transport: string } {
  return {
    name: "milo-browse",
    version: "0.0.1",
    tools: BROWSE_TOOLS,
    transport:
      "STUB: no live server in v0. Register BROWSE_TOOLS in your MCP host's tools/list and route tools/call to createBrowseToolHandlers(). Bring the browser (a Playwright/CDP session, a Squire-operate handle, or a computer-use loop) and expose it as a Driver via createDriver.",
  };
}
