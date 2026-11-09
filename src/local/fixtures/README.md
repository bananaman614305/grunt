Request fixtures recorded on 2026-11-09 by pointing installed harnesses at a
loopback capture server, asking “Reply with exactly: bridge works 42. Do not use
tools.”, and returning a synthetic text completion through Milo's wire adapter:

- pi 0.99.1: Chat Completions, built-in tools enabled.
- opencode 1.18.31: Chat Completions, `@ai-sdk/openai-compatible` custom provider.
- Claude Code 2.1.319: Messages, custom `ANTHROPIC_BASE_URL` and `--model milo`.
- Codex 0.167.0: Responses, custom `model_providers` entry and `wire_api=responses`.
  The preinstalled Codex wrapper lacked its optional native dependency; capture
  used the official native package at that version in a temporary directory.

Generated system instructions, user environment context, tool descriptions,
metadata and tool lists are reduced/sanitized. Request field names, representative
tool schemas, content block shapes and stream settings are retained. Codex's native
web_search definition is retained to exercise the delegate path. No auth headers
or account credentials are recorded. Each of the four real clients displayed
“bridge works 42” using the adapter's SSE response (synthetic source, not Freebuff).

freebuff.json is the exact supplied real chat sample from chad; SHA-256:
dd9629852d3c6f45ca6ceabf8f37b24b217c7ed9a96b93bee2a05caf147da498.
The fake TUI reads bracketed paste and writes this same user/ai/text-block format.
