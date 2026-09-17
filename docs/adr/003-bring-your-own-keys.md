# ADR-003: Key handling

Status: accepted, 2026-09-17 (revised same day: users bring only the OpenRouter key)

## Decision

The user brings one key. Their OpenRouter key arrives on each request as `Authorization: Bearer <key>`, is forwarded to OpenRouter unchanged, and is never stored or logged. A request with no OpenRouter key gets 401 from Milo before any upstream call.

Milo supplies the Jev key itself. It lives only in the server process environment as `JEV_API_KEY`. On Fly it is a Squire egress grant token, revocable without rotating the real key. Locally, `milo serve` reads it from env. It never appears in responses, logs, error messages, or the decision log.

Because Jev spend is Milo's, the gateway rate-limits routed requests with a token bucket keyed on a SHA-256 of the OpenRouter key, and caps the Jev context at 8,000 tokens. A rate-limited request is not rejected: it is forwarded to OpenRouter on the `mid` tier with a decision marked degraded, reason "rate limited".

The decision log stores no message content.

## Why

Jev is closed early access, so users cannot obtain a key. The OpenAI SDK already sends `Authorization`, so adopting Milo is one base URL change. Holding the Jev key server-side also makes routing a service Milo provides rather than a feature the user configures, which is the monetization surface.

## Consequences

Milo must be hosted to be useful to anyone but us; local `milo serve` is for development. Jev cost per routed request is about $0.00002, so abuse is a nuisance rather than a risk, but the rate limit exists from day one. When Jev opens up, an optional `X-Jev-Key` header can let users bring their own; that is an additive change.
