# ADR-001: Stack

Status: accepted, 2026-09-17

## Decision

TypeScript on Node 22 with pnpm workspaces. Vitest for tests, ESLint (typescript-eslint) for lint, `tsc -b` for typechecking across project references. SQLite via `@libsql/client` for local storage, behind a repository interface so Neon Postgres can replace it later. Hono for the gateway. Zod for runtime validation. Fly.io for deployment.

## Why

The three integration surfaces (OpenAI-compatible gateway, Claude Code hooks, MCP server) are all most natural in TypeScript, so one language covers everything. SQLite makes local dogfooding zero-setup. Hono streams well and runs on Node and Fly without adapters.

## Consequences

Direct provider adapters and Postgres are later tasks behind existing interfaces. No AGPL dependencies in `packages/core` so the licensing option stays open.
