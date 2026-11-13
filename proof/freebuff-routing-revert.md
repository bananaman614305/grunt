# Freebuff routing restoration

Reproduction FT1 uses the built HTTP Chat Completions endpoint with only
Freebuff configured, Pi-style function definitions, and the JSON bridge off.
The stand-in uses real tmux and the existing synthetic Freebuff TUI so routing
can be proved independently of a live Freebuff login or model behavior.

Before the change, `pnpm build` followed by
`node src/local/tool-routing-proof.mjs --before` returned HTTP 503 for both
`freebuff` and `milo`, with sticky routing enabled and disabled. Freebuff was
never invoked. The updated routing regression also failed in both modes with
`Tool-capable sources are unavailable`.

After the change, `pnpm build` followed by
`node src/local/tool-routing-proof.mjs` passed the same FT1 path: all four
requests invoked Freebuff with intact function definitions and returned HTTP
200 with final text. The fake TUI includes earlier deliberation and a tool
block; only final text reaches the caller, preserving PR 45's parsing fix.

`node src/local/pi-freebuff-proof.mjs --synthetic` also passed using actual Pi
and the built service. Pi's tool-bearing request reaches the unbridged delegate
and completes with text. This proves restored eligibility, not live Freebuff
inference or execution of Pi's tools by unbridged Freebuff.

`node src/local/pi-freebuff-proof.mjs --synthetic --bridge` passed using actual
Pi, its skill loader and read tool, the built service and the synthetic Freebuff
TUI. Pi executed read and consumed the real nonce result. PR 46's opt-in JSON
bridge remains intact; live model adherence remains unproven.

Validation: the full suite passed (238 tests), as did lint and build. No tests
were skipped in the full run. Live Freebuff/Pi tool execution was not attempted:
this routing-only proof uses controlled inference and does not require live
credentials. The regression checks both explicit selection against a competing
source and automatic selection with Freebuff alone.
