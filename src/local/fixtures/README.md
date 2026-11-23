Request fixtures recorded on 2026-11-09 by pointing installed harnesses at a
loopback capture server, asking “Reply with exactly: bridge works 42. Do not use
tools.”, and returning a synthetic text completion through Grunt's wire adapter:

- pi 0.99.1: Chat Completions, built-in tools enabled.
- opencode 1.18.31: Chat Completions, `@ai-sdk/openai-compatible` custom provider.
- Claude Code 2.1.319: Messages, custom `ANTHROPIC_BASE_URL` and `--model grunt`.
- Codex 0.167.0: Responses, custom `model_providers` entry and `wire_api=responses`.
  The preinstalled Codex wrapper lacked its optional native dependency; capture
  used the official native package at that version in a temporary directory.

Generated system instructions, user environment context, tool descriptions,
metadata and tool lists are reduced/sanitized. Request field names, representative
tool schemas, content block shapes and stream settings are retained. Codex's native
web_search definition is retained to exercise the delegate path. No auth headers
or account credentials are recorded. Provider IDs and working-directory labels
are normalized to the current Grunt names. Each of the four real clients displayed
“bridge works 42” using the adapter's SSE response (synthetic source, not Freebuff).

freebuff.json is the exact supplied real chat sample from chad; SHA-256:
dd9629852d3c6f45ca6ceabf8f37b24b217c7ed9a96b93bee2a05caf147da498.
The fake TUI reads bracketed paste and writes this same user/ai/text-block format.

claude-title.json was recorded on squire from the real interactive Claude Code
(2.1.319) session through a loopback capture server with a synthetic Source.
The user typed “What is 2 + 2?”. The client sent a separate session-name request
before its normal turn. The captured wire body is retained with the normalization
described above, including nonsecret device/session
metadata (the account identifier is empty). Authentication headers were never
recorded. A headless `claude -p` run emitted only the main request; the interactive
run emitted the title call. The billing and session-naming markers match the
chad excerpt; this installed client identifies itself as the official CLI rather
than the Agent SDK. This records a
real housekeeping call, not a constructed approximation. Other harnesses have
not emitted side calls in the recorded runs.

registry-0.9.7.mjs is the adapter-registry validator from the published
usegrunt 0.9.7 (`src/registry.ts` at 04fdc23), compiled to JavaScript with
esbuild, plus that release's bundled `published` time. Registry API tests run
served documents through it, as installed 0.9.7 clients do on every sync.
