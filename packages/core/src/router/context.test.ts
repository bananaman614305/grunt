import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../types.js";
import { ROUTER_LIMITS } from "../types.js";
import { buildJevState, CHARS_PER_TOKEN, countUserTurns, messageText } from "./context.js";
import type { JevState } from "./context.js";

function asState(state: Record<string, unknown>): JevState {
  return state as unknown as JevState;
}

describe("messageText", () => {
  it("reads a string", () => {
    expect(messageText("  hello  ")).toBe("hello");
  });

  it("reads content parts and joins their text", () => {
    expect(messageText([{ type: "text", text: "first" }, { type: "image_url" }, { type: "text", text: "second" }])).toBe(
      "first\nsecond",
    );
  });

  it("reads null as empty", () => {
    expect(messageText(null)).toBe("");
  });
});

describe("buildJevState", () => {
  it("collects the system and developer prompts, the recent user turns, and the last assistant turn", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "You are a sub-agent." },
      { role: "developer", content: "Use the tools." },
      { role: "user", content: "one" },
      { role: "assistant", content: "first reply" },
      { role: "user", content: "two" },
      { role: "assistant", content: "second reply" },
      { role: "user", content: "three" },
      { role: "user", content: "four" },
    ];

    const state = asState(buildJevState(messages, [{ name: "read" }, { name: "edit" }]).state);

    expect(state.system).toBe("You are a sub-agent.\n\nUse the tools.");
    expect(state.recent_user_turns).toEqual(["two", "three", "four"]);
    expect(state.recent_user_turns).toHaveLength(ROUTER_LIMITS.recentUserTurns);
    expect(state.latest_assistant_turn).toBe("second reply");
    expect(state.has_tools).toBe(true);
    expect(state.tool_count).toBe(2);
    expect(state.message_count).toBe(8);
    expect(state.user_message_count).toBe(4);
    expect(state.assistant_message_count).toBe(2);
  });

  it("handles array content and null content without throwing", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: [{ type: "text", text: "brief" }] },
      { role: "user", content: null },
      { role: "assistant", content: null, tool_calls: [{ id: "call_1" }] },
      { role: "user", content: [{ type: "text", text: "do the thing" }, { type: "image_url" }] },
    ];

    const state = asState(buildJevState(messages).state);

    expect(state.system).toBe("brief");
    expect(state.recent_user_turns).toEqual(["do the thing"]);
    // A tool-call-only assistant turn carries no text, so there is none to show.
    expect(state.latest_assistant_turn).toBeNull();
    expect(state.assistant_message_count).toBe(1);
    expect(state.user_message_count).toBe(2);
    expect(state.has_tools).toBe(false);
    expect(state.tool_count).toBe(0);
  });

  it("reports no tools when the tools array is absent or empty", () => {
    const messages: ChatMessage[] = [{ role: "user", content: "hi" }];
    expect(asState(buildJevState(messages).state).has_tools).toBe(false);
    expect(asState(buildJevState(messages, []).state).has_tools).toBe(false);
  });

  it("keeps the latest user turn intact when everything else must be trimmed", () => {
    const latest = "ROUTE THIS: add a retry with jitter to the Jev client.";
    const messages: ChatMessage[] = [
      { role: "system", content: "S".repeat(200_000) },
      { role: "user", content: "O".repeat(200_000) },
      { role: "user", content: "P".repeat(200_000) },
      { role: "assistant", content: "A".repeat(200_000) },
      { role: "user", content: latest },
    ];

    const { state, approxTokens } = buildJevState(messages);
    const trimmed = asState(state);

    expect(trimmed.recent_user_turns.at(-1)).toBe(latest);
    expect(approxTokens).toBeLessThanOrEqual(ROUTER_LIMITS.contextTokenBudget);
    // The system prompt was trimmed from the middle, so both ends survive.
    expect(trimmed.system.startsWith("S")).toBe(true);
    expect(trimmed.system.endsWith("S")).toBe(true);
    expect(trimmed.system).toContain("truncated");
    expect(trimmed.system.length).toBeLessThan(200_000);
  });

  it("truncates the latest user turn only when it alone blows the budget", () => {
    const messages: ChatMessage[] = [{ role: "user", content: "Z".repeat(500_000) }];
    const { state, approxTokens } = buildJevState(messages);
    const turns = asState(state).recent_user_turns;

    expect(turns).toHaveLength(1);
    expect(turns[0]?.length).toBeLessThan(500_000);
    expect(turns[0]?.startsWith("Z")).toBe(true);
    expect(approxTokens).toBeLessThanOrEqual(ROUTER_LIMITS.contextTokenBudget);
  });

  it("respects the token budget for any conversation shape", () => {
    const shapes: ChatMessage[][] = [
      [],
      [{ role: "user", content: "short" }],
      [
        { role: "system", content: "x".repeat(50_000) },
        { role: "user", content: "y".repeat(50_000) },
        { role: "assistant", content: "z".repeat(50_000) },
        { role: "user", content: "w".repeat(50_000) },
      ],
      // Newlines and quotes are the cases where JSON escaping expands text.
      [
        { role: "system", content: '"\n'.repeat(60_000) },
        { role: "user", content: '"\n'.repeat(60_000) },
      ],
    ];

    for (const messages of shapes) {
      const { state, approxTokens } = buildJevState(messages);
      expect(approxTokens).toBeLessThanOrEqual(ROUTER_LIMITS.contextTokenBudget);
      expect(Math.ceil(JSON.stringify(state).length / CHARS_PER_TOKEN)).toBe(approxTokens);
    }
  });

  it("leaves a conversation that already fits untouched", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "Be brief." },
      { role: "user", content: "What does listRecent return?" },
    ];
    const { state, approxTokens } = buildJevState(messages);
    const kept = asState(state);

    expect(kept.system).toBe("Be brief.");
    expect(kept.recent_user_turns).toEqual(["What does listRecent return?"]);
    expect(approxTokens).toBeLessThan(200);
  });
});

describe("countUserTurns", () => {
  it("counts user messages and nothing else", () => {
    expect(
      countUserTurns([
        { role: "system", content: "You are a sub-agent." },
        { role: "user", content: "Do the thing." },
        { role: "assistant", content: "Done." },
        { role: "user", content: "Now the other thing." },
      ]),
    ).toBe(2);
  });

  it("is unchanged by a tool-result continuation", () => {
    // This is the whole point: an assistant tool call plus its result is the
    // same ask coming back, and must not re-route mid-tool-loop.
    const base = [
      { role: "system", content: "You are a sub-agent." },
      { role: "user", content: "Do the thing." },
    ] as const;

    expect(countUserTurns([...base])).toBe(1);
    expect(
      countUserTurns([
        ...base,
        { role: "assistant", content: null, tool_calls: [{ id: "c1" }] },
        { role: "tool", content: "result", tool_call_id: "c1" },
        { role: "assistant", content: null, tool_calls: [{ id: "c2" }] },
        { role: "tool", content: "result", tool_call_id: "c2" },
      ]),
    ).toBe(1);
  });

  it("counts a user turn that carries no usable text", () => {
    // A turn was still taken, which is what the count is about.
    expect(
      countUserTurns([
        { role: "user", content: "" },
        { role: "user", content: null },
        { role: "user", content: [{ type: "image_url" }] },
      ]),
    ).toBe(3);
  });

  it("is zero for a conversation with no user turn", () => {
    expect(countUserTurns([])).toBe(0);
    expect(countUserTurns([{ role: "system", content: "prompt" }])).toBe(0);
  });

  it("does not count developer or system prompts", () => {
    expect(
      countUserTurns([
        { role: "developer", content: "rules" },
        { role: "system", content: "prompt" },
        { role: "user", content: "ask" },
      ]),
    ).toBe(1);
  });
});
