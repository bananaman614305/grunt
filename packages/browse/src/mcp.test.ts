import { describe, expect, it } from "vitest";
import type { JevClientLike, SystemOneResult } from "@milo/core";
import { FakeDriver } from "./driver.js";
import { BROWSE_TOOLS, createBrowseToolHandlers, describeMcpServer } from "./mcp.js";
import type { PageObservation } from "./types.js";

const RESULT: PageObservation = { url: "https://x/done", title: "Exported", elements: [] };

/** A tiny brain: everything is a result page, so browse_task finishes at once. */
function doneJev(): JevClientLike {
  return {
    systemone(req) {
      const key = Object.keys(req.questions)[0];
      const answers =
        key === "page_kind"
          ? { page_kind: { type: "choice" as const, choice: "result", confidence: 0.9, probabilities: { result: 0.9 } } }
          : {};
      return Promise.resolve({
        model: "jev-latest",
        answers,
        usage: { input_tokens: 1, output_tokens: 1 },
        requestId: "r",
        latencyMs: 1,
      } satisfies SystemOneResult);
    },
  };
}

describe("browse MCP surface", () => {
  it("advertises exactly the browse_task tool with a required goal and maxSteps", () => {
    expect(BROWSE_TOOLS.map((t) => t.name)).toEqual(["browse_task"]);
    expect(BROWSE_TOOLS[0]?.inputSchema.required).toEqual(["goal", "maxSteps"]);
    // The schema exposes input KEYS, never values.
    expect(BROWSE_TOOLS[0]?.inputSchema.properties).toHaveProperty("inputKeys");
    expect(BROWSE_TOOLS[0]?.inputSchema.properties).not.toHaveProperty("inputs");
  });

  it("describes the transport as a documented stub", () => {
    expect(describeMcpServer().transport).toMatch(/STUB/);
  });

  it("runs a task through the handler against a fake driver", async () => {
    const handlers = createBrowseToolHandlers({
      jev: doneJev(),
      createDriver: () => new FakeDriver([RESULT]),
    });
    const result = await handlers.browse_task({ goal: "look at the result", maxSteps: 3 });
    expect(result.status).toBe("done");
  });

  it("rejects a task with no goal", async () => {
    const handlers = createBrowseToolHandlers({ jev: doneJev(), createDriver: () => new FakeDriver([RESULT]) });
    await expect(handlers.browse_task({ goal: "", maxSteps: 3 })).rejects.toThrow(/non-empty goal/);
  });

  it("resolves declared input keys through the host, not the args", async () => {
    let askedFor: string[] = [];
    const handlers = createBrowseToolHandlers({
      jev: doneJev(),
      createDriver: () => new FakeDriver([RESULT]),
      resolveInputs: (keys) => {
        askedFor = keys;
        return { password: "sealed-value" };
      },
    });
    await handlers.browse_task({ goal: "sign in", maxSteps: 1, inputKeys: ["password"] });
    expect(askedFor).toEqual(["password"]);
  });
});
