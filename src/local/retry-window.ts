// Waits at or below this threshold are treated as short transient rate limits (HTTP 429).
// Longer waits or pools with zero recoverable routes fail fast as global exhaustion (HTTP 402).
// Kept in a module with no imports: routing.ts reads it while modules that import each
// other (provider-error.ts and source.ts) may still be initializing.
export const TRANSIENT_RETRY_WINDOW_SECONDS = 60;
