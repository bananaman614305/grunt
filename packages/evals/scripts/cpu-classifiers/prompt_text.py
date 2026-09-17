"""Builds the text a CPU classifier sees from one `routing.jsonl` row.

Mirrors the selection rule in `packages/core/src/router/context.ts`
(`extract()` / `assemble()`) in spirit, not byte-for-byte:

  - flatten each message's `content` (string, or an array of `{type, text}`
    parts) to plain text, the same way `messageText()` does there;
  - concatenate all `system`/`developer` messages with a blank line between
    them ("system prompt");
  - keep only the last `RECENT_USER_TURNS` (3, matching
    `ROUTER_LIMITS.recentUserTurns`) user turns, oldest first;
  - join system prompt + those user turns with a blank line, in that order.

What is intentionally *not* reproduced: the router's 8,000-token /
4-chars-per-token budget and its shed-context-when-it-doesn't-fit logic
(middle-trimming the system prompt, head-trimming turns, dropping the
oldest first). Every row in `routing.jsonl` is well under that budget (the
longest row in the set is ~2.5k characters, ~630 approximated tokens), so
that machinery would never engage here and would only add branches with no
observable effect on this dataset. If this script is ever pointed at a
different, larger corpus, that trimming should be ported over too.

The most recent assistant turn is deliberately left out: both candidate
classifiers are single-string, no-context classifiers of "the request",
and Milo's own criteria for `task_type` and `difficulty` are explicit that
"the system prompt, tools, and earlier turns are context" while the
request being judged is "the latest user turn" (docs/routing.md). Folding
in assistant text would let the assistant's own words bias the score.
"""

from __future__ import annotations

from typing import Any

RECENT_USER_TURNS = 3


def message_text(content: Any) -> str:
    """Flattens OpenAI message content (string, content-part array, or null)."""
    if content is None:
        return ""
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts = []
        for part in content:
            if isinstance(part, dict) and isinstance(part.get("text"), str):
                parts.append(part["text"])
        return "\n".join(p for p in parts if p).strip()
    return ""


def build_prompt_text(row: dict) -> str:
    """The text a classifier sees for one `routing.jsonl` row."""
    system_parts: list[str] = []
    user_turns: list[str] = []

    for message in row["messages"]:
        role = message.get("role")
        text = message_text(message.get("content"))
        if not text:
            continue
        if role in ("system", "developer"):
            system_parts.append(text)
        elif role == "user":
            user_turns.append(text)

    system = "\n\n".join(system_parts)
    recent = user_turns[-RECENT_USER_TURNS:]

    pieces = [p for p in ([system] + recent) if p]
    return "\n\n".join(pieces)


def load_rows(path: str) -> list[dict]:
    import json

    rows = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


if __name__ == "__main__":
    import sys

    path = sys.argv[1] if len(sys.argv) > 1 else "packages/evals/data/routing.jsonl"
    rows = load_rows(path)
    for row in rows[:3]:
        print("=" * 20, row["id"])
        print(build_prompt_text(row))
