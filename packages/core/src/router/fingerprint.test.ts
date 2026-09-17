import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../types.js";
import { fingerprint } from "./fingerprint.js";

const SYSTEM = "You are a sub-agent. Work in the assigned worktree.";

function convo(system: string, firstUser: string, rest: ChatMessage[] = []): ChatMessage[] {
  return [{ role: "system", content: system }, { role: "user", content: firstUser }, ...rest];
}

describe("fingerprint", () => {
  it("is a sha-256 hex digest", () => {
    expect(fingerprint(convo(SYSTEM, "hello"))).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable across whitespace changes in the system prompt and the first user turn", () => {
    const base = fingerprint(convo(SYSTEM, "Rename res to rows in listRecent."));
    const respaced = fingerprint(
      convo("  You are a sub-agent.\n\tWork in the assigned   worktree.  ", "\nRename res to rows   in listRecent.\n"),
    );
    expect(respaced).toBe(base);
  });

  it("does not change as the conversation continues", () => {
    const first = fingerprint(convo(SYSTEM, "Rename res to rows."));
    const later = fingerprint(
      convo(SYSTEM, "Rename res to rows.", [
        { role: "assistant", content: "Done." },
        { role: "user", content: "Now run the tests." },
      ]),
    );
    expect(later).toBe(first);
  });

  it("differs when the first user message differs", () => {
    const a = fingerprint(convo(SYSTEM, "Rename res to rows."));
    const b = fingerprint(convo(SYSTEM, "Rename res to columns."));
    expect(b).not.toBe(a);
  });

  it("differs when the system prompt differs", () => {
    const a = fingerprint(convo(SYSTEM, "Same request."));
    const b = fingerprint(convo("You are a reviewer.", "Same request."));
    expect(b).not.toBe(a);
  });

  it("does not let text slide between the system prompt and the first user turn", () => {
    const a = fingerprint([
      { role: "system", content: "alpha" },
      { role: "user", content: "" },
    ]);
    const b = fingerprint([
      { role: "system", content: "" },
      { role: "user", content: "alpha" },
    ]);
    expect(b).not.toBe(a);
  });

  it("handles array content, null content, and a missing user turn", () => {
    const arrayForm = fingerprint([
      { role: "system", content: [{ type: "text", text: SYSTEM }] },
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ]);
    expect(arrayForm).toBe(fingerprint(convo(SYSTEM, "hello")));

    expect(fingerprint([{ role: "user", content: null }])).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprint([])).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprint([{ role: "system", content: SYSTEM }])).not.toBe(fingerprint([]));
  });

  it("folds developer messages into the system prompt", () => {
    const withDeveloper = fingerprint([
      { role: "system", content: "part one" },
      { role: "developer", content: "part two" },
      { role: "user", content: "go" },
    ]);
    expect(withDeveloper).toBe(fingerprint(convo("part one part two", "go")));
  });

  describe("scope", () => {
    const messages = convo(SYSTEM, "hello");

    it("separates the same conversation sent by two callers", () => {
      // Two keys may be running different rosters (ADR-008), so they must not
      // share a sticky decision.
      expect(fingerprint(messages, "key-a")).not.toBe(fingerprint(messages, "key-b"));
    });

    it("is stable for one caller across turns of the same conversation", () => {
      expect(fingerprint(messages, "key-a")).toBe(fingerprint(convo(SYSTEM, "hello"), "key-a"));
    });

    it("still separates two conversations from one caller", () => {
      expect(fingerprint(convo(SYSTEM, "one"), "key-a")).not.toBe(fingerprint(convo(SYSTEM, "two"), "key-a"));
    });

    it("leaves an unscoped fingerprint exactly as it was", () => {
      expect(fingerprint(messages, undefined)).toBe(fingerprint(messages));
      expect(fingerprint(messages, "")).toBe(fingerprint(messages));
    });

    it("is the same shape, so nothing downstream can tell", () => {
      expect(fingerprint(messages, "key-a")).toMatch(/^[0-9a-f]{64}$/);
      // And it does not leak the scope it was given.
      expect(fingerprint(messages, "key-a")).not.toContain("key-a");
    });
  });
});
