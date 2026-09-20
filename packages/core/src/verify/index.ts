/**
 * Ground-truth verification (ADR-019): the shared layer that checks an agent's
 * load-bearing claims against read-only git probes and receipts, using Milo's
 * server-side Jev as a cross-family auditor. Reused by the /v1/verify handler
 * (`packages/gateway`), the fleet done-gate (`packages/fleet`), and the
 * completeness gate (`packages/gateway/src/routes/gate.ts`).
 */

export * from "./types.js";
export * from "./claims.js";
export * from "./probes.js";
export * from "./questions.js";
export * from "./verify.js";
export * from "./caselaw.js";
