# Milo horizon

Not in the MVP. Kept so the MVP's interfaces do not paint us into a corner.

- **Preference memory** (now ADR-011, in build). Structured, scoped, versioned user preferences (verbosity, evidence style, testing depth, risk tolerance) captured from user turns with a Jev classifier, compiled into a bounded brief, and injected into every routed request and every spawned sub-agent. Designed in ADR-011 (the v1 draft predates this repo and was never committed).
- **Output grading.** Jev checks a model's output against the brief's checkable clauses and surfaces violations.
- **Harness integrations.** Claude Code hooks and an MCP server so preferences flow into sub-agent prompts.
- **Billing.** Metering per key, margin on OpenRouter usage, or subscription.
- **Learned policy.** Replace or augment the policy table using the decision log plus outcome signals.
- **Direct provider adapters.** Bypass OpenRouter when a user has direct keys.
- **Alternative decision backends.** Jev is the sole decision backend (ADR-005); no fallback tier, no pluggable backend selection. Revisit this if Jev's terms, pricing, or availability change, or if a second calibrated task/difficulty classifier becomes worth supporting — that would again mean a per-backend policy profile (`docs/routing.md`) and its own eval fixtures, not a return to the ADR-004 shape specifically.
