/**
 * Pluggable decision backends. The router depends only on `JevClientLike`
 * (`../jev/types.js`), so a backend is swappable without touching the router
 * or the gateway routes. See ADR-004.
 */
export * from "./system-one-open.js";
export * from "./fallback.js";
