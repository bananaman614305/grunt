# Freebuff JSON bridge evidence

Reproduction PF1: direct Pi using grunt with only Freebuff configured, with Pi's
read tool enabled and an explicit benign proof-read skill, cannot execute that
tool. The default adapter is excluded from function-tool routing and the built
HTTP API returns `Tool-capable sources are unavailable`.

Run after `pnpm build`:

```
node src/local/pi-freebuff-proof.mjs
node src/local/pi-freebuff-proof.mjs --bridge --synthetic
```

The first command reproduced PF1 using actual installed Pi (version 0.99.1), the
built HTTP service and the default Freebuff adapter. Pi received the unavailable
tool-source error; no Freebuff inference was invoked.

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

Validation: `pnpm lint`, `pnpm build` and the complete test suite passed (236
tests at that run). The subsequent caller/shutdown cancellation cases and all
other bridge regressions passed in the focused suite (22 tests). Both PF1
commands above passed. No existing automated tests were skipped. The live
Freebuff round trip and skill run were deferred for the limitations below.

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
