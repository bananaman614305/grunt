# Freebuff JSON bridge evidence

Historical reproduction PF1 before routing restoration: direct Pi using grunt with only Freebuff configured, with Pi's
read tool enabled and an explicit benign proof-read skill, cannot execute that
tool. At that revision the default adapter was excluded from function-tool routing and the built
HTTP API returned `Tool-capable sources are unavailable`.

Run after `pnpm build`:

```
node src/local/pi-freebuff-proof.mjs --synthetic
node src/local/pi-freebuff-proof.mjs --bridge --synthetic
```

Before routing restoration, the first command reproduced PF1 using actual installed Pi (version 0.99.1), the
built HTTP service and the default Freebuff adapter. Pi received the unavailable
tool-source error; no Freebuff inference was invoked.

After routing restoration, the unbridged synthetic command returns final text
through Freebuff instead of a routing error. It does not prove Pi tool execution.
See [FT1 routing evidence](#freebuff-routing-restoration). The bridge command still
exercises Pi's own tool loop.

The second command demonstrated PF1 passing using actual Pi and its real read
tool and skill loader, the built HTTP service, actual tmux, and a synthetic
Freebuff TUI speaking Freebuff's persisted chat format. Pi expanded the explicit
proof-read skill, requested `read` for nonce.txt, executed it, sent the real tool
result back through the bridge, and completed with `PI_TOOL_ROUNDTRIP_7391`.
This proves the direct Pi wire path and skill/result plumbing, not live Freebuff
model adherence. The synthetic TUI deliberately requests the read call.

The regression suite covers entire-envelope rejection, malformed JSON, unknown
tools, invalid arguments, unsupported schemas, fabricated result envelopes,
correlation, duplicate calls/results, stable repeated-request IDs, differing
contexts, cancellation, bounded repair, fallback, context preservation, tool
result injection serialization, fresh conversations, and native-tool rejection.
Prompt injection resistance of a live model has not been established.

Validation after the validator lifetime fix: `pnpm lint`, `pnpm build` and the
complete test suite passed (238 tests). The PF1 bridge/skill command above passed
again. No existing automated tests were skipped. The live Freebuff round trip
and skill run were deferred for the limitations below.

## Validator lifetime regression

Reproduction PF-memory: successive bridge requests compile fresh schema objects
into a shared Ajv instance, whose cache retains them after the request finishes.
The independent reviewer measured retained heap growth (about 77 MB over 3000
requests with seven tools) before the fix.

Ajv now belongs to each bridge request, so its schema cache can be collected with
that request. A deterministic regression constructs bridges from fresh identical
schema objects and verifies they do not share the retaining compiler. It failed
before the fix (one shared compiler across 30 requests) and passes afterward.

A built-module measurement with Node `--expose-gc`, seven synthetic tool schemas,
100 warm-up requests, and explicit collection before and after 3000 additional
requests measured heap from 8,354,688 bytes to 8,050,072 bytes (a decrease of
304,616 bytes). This sample confirms the reported retention pattern is gone;
absolute heap size depends on the runtime and workload. It does not establish
live Freebuff behavior.

## Live limitations

On November 13, 2026 UTC, `freebuff doctor` in this corner reported CLI 0.2.36,
`Not signed in`, and checks passing (eight). Its passing-check count does not
establish authentication. The delivered host sign-in handback reported a
successful login elsewhere; the corner has an isolated user/config environment.
No credential files were opened or copied. Squire's Freebuff vault metadata
lookup returned no credentials; Connectors reported Freebuff still connecting.
The earlier delivered browser observation also mentioned country verification;
that browser condition has not been independently rechecked here.

The official CLI help lists login, doctor, continue, cwd and trust-agents, with
no native-tool deny switch. Native execution therefore remains outside this
bridge's enforcement boundary. Detection from chat blocks is retrospective.

The official [terms](https://freebuff.com/terms-of-service), effective November
12, 2026, restrict relaying access to applications and automated operation
without written permission. The [tool architecture documentation](https://github.com/CodebuffAI/freebuff/blob/main/docs/agents-and-tools.md)
describes native runtime tooling, not a supported no-tools CLI mode. Written
permission or an explicitly supported integration is still needed before an
automated live trial; no endpoint, country, login or approval bypass was used.

Live Freebuff tool-result round trip and skill completion remain unresolved.
The bridge stays opt-in and must not be advertised as supported. Next step:
establish supported integration permission, authenticate the official CLI in the
execution environment, resolve any legitimate eligibility verification, then
run the same proof with `--bridge` in a restricted host environment while the
person remains present. Independent review is required before merge. No deploy.

## Freebuff routing restoration

Reproduction FT1 uses the built HTTP Chat Completions endpoint with only
Freebuff configured, Pi-style function definitions, and the JSON bridge off.
The stand-in uses real tmux and the existing synthetic Freebuff TUI so routing
can be proved independently of a live Freebuff login or model behavior.

Before the change, `pnpm build` followed by
`node src/local/tool-routing-proof.mjs --before` returned HTTP 503 for both
`freebuff` and `grunt`, with sticky routing enabled and disabled. Freebuff was
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
