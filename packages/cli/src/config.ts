/**
 * `milo.config.json` schema and loader.
 *
 * Every field is optional; a missing file (when the caller did not ask for
 * one explicitly) means every default applies. An explicit `--config` path
 * that cannot be read, or a file that fails validation, is an error -- the
 * CLI never silently ignores a config the user pointed at.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z, type ZodError } from "zod";

export const DEFAULT_PORT = 8787;
export const DEFAULT_DECISION_LOG_URL = "file:./.milo/decisions.db";
export const DEFAULT_CONFIG_FILENAME = "milo.config.json";

const modelId = z.string().trim().min(1, "model id must not be empty");
const modelIdList = z.array(modelId).min(1, "must list at least one model id");

/**
 * Mirrors `Roster` from `@milo/core` (`Record<Tier, string[]>`). Written out
 * rather than derived from `TIERS` so every tier is a required key with its
 * own error path when it is missing.
 */
const rosterSchema = z
  .object({
    fast: modelIdList,
    mid: modelIdList,
    frontier: modelIdList,
  })
  .strict();

const rateLimitSchema = z
  .object({
    routedPerMinute: z.number().int().positive(),
  })
  .strict();

/**
 * Tenant guardrails: per-key request/token rate limits, a rolling-window USD
 * spend cap read from the decision log's own cost figures, and request-shape
 * bounds. Every field is independently optional and unset (unlimited/off) by
 * default, so a deployment turns on only what it wants bounded -- unlike
 * `rateLimit` above, which is Milo's own Jev-spend limiter on the routed path
 * only (ADR-003), this bounds every metered surface and every caller's own
 * spend, not just Milo's.
 */
const tenantLimitsSchema = z
  .object({
    requestsPerMinute: z.number().int().positive().optional(),
    tokensPerMinute: z.number().int().positive().optional(),
    maxBodyBytes: z.number().int().positive().optional(),
    maxMessages: z.number().int().positive().optional(),
    maxRequestTokens: z.number().int().positive().optional(),
    spendCapUsd: z.number().positive().optional(),
    spendWindowHours: z.number().positive().optional(),
  })
  .strict();

/**
 * Best-of-N sampling (ADR-010). `enabled` defaults to true -- sampling is a
 * routing outcome, on by default for the cells the policy names; the cells
 * themselves are fixed in code for now. `sampleTimeoutMs` caps each sample's
 * wall clock (gateway default: 60,000 ms). `minRanked` is how many ranked
 * samples the fan-out waits for before returning a clear winner early and
 * aborting the still-streaming rest (gateway default: 3).
 */
const adaptiveSamplingSchema = z
  .object({
    enabled: z.boolean().default(false),
    minSamples: z.number().int().positive().optional(),
    maxSamples: z.number().int().positive().optional(),
    qualityBar: z.number().min(0).max(3).optional(),
    leadMargin: z.number().min(0).max(3).optional(),
  })
  .strict();

const samplingSchema = z
  .object({
    enabled: z.boolean().default(true),
    sampleTimeoutMs: z.number().int().positive().optional(),
    minRanked: z.number().int().positive().optional(),
    // Adaptive-N and cache-friendly framings (ADR-024). Both default off:
    // they are benchmark-gated prompt/compute changes, validated with
    // `milo canary`/`pnpm bench` before a deployment turns them on.
    adaptive: adaptiveSamplingSchema.optional(),
    cacheFriendlyVariants: z.boolean().optional(),
  })
  .strict();

/**
 * Context pruning (ADR-014, ADR-013 phase C). Off by default: `enabled`
 * (default false) lets the gate run on every routed request over the token
 * floor, and a request can still opt in per call with `milo: { prune: true }`
 * even when it is off. `minContextTokens` (default 40,000) is the floor a
 * conversation must exceed before pruning is considered; `contextWindowTokens`
 * (default 128,000) is the fill-ratio denominator for a model whose context
 * window is unknown.
 */
const pruningSchema = z
  .object({
    enabled: z.boolean().default(false),
    minContextTokens: z.number().int().positive().optional(),
    contextWindowTokens: z.number().int().positive().optional(),
  })
  .strict();

/**
 * Speculative routing (ADR-024). Off by default: `enabled` (default false)
 * starts the single cheapest fast-tier call in parallel with the Jev
 * classification on the OpenAI chat surface, to hide its latency. The result
 * is used only when the real Jev decision resolves to that same single call,
 * and aborted otherwise, so routing is never changed -- only latency, at the
 * cost of one cheap wasted call per miss. `maxPromptChars` (default 2,000)
 * tunes the probably-easy heuristic below which a request is a speculation
 * candidate.
 */
const speculationSchema = z
  .object({
    enabled: z.boolean().default(false),
    maxPromptChars: z.number().int().positive().optional(),
  })
  .strict();

/**
 * Two-stage fact retrieval (ADR-018). `enabled` (default true) turns on the
 * embedding pre-filter that narrows a caller's stored facts before the Jev
 * relevance gate; it only ever runs when fact memory is on (billing and an
 * encryption key configured). `model` is the OpenAI-compatible embeddings
 * model (default `openai/text-embedding-3-small`); `baseUrl` is the embeddings
 * endpoint, defaulting to the OpenRouter completions base URL. The caller's
 * forwarded key pays for the embedding, so no server-side embedding key is
 * needed, and any embedding failure falls open to the all-facts gate.
 */
const factRetrievalSchema = z
  .object({
    enabled: z.boolean().default(true),
    model: z.string().trim().min(1).optional(),
    baseUrl: z.string().trim().min(1).optional(),
  })
  .strict();

/**
 * Upstream rate-limit resilience for OpenRouter calls. All fields are
 * optional and fall back to safe defaults in the gateway.
 * `maxConcurrentPerModel` bounds concurrent in-flight requests per upstream
 * model so a burst cannot self-inflict a 429 (default 8; 0 means no limit).
 * `retry` tunes the 429/5xx backoff-and-jitter retry: `maxAttempts` (default
 * 4, counting the first try), `baseDelayMs` (default 250) and `maxDelayMs`
 * (default 8000, also the cap on a honoured `Retry-After`).
 */
const upstreamSchema = z
  .object({
    maxConcurrentPerModel: z.number().int().nonnegative().optional(),
    retry: z
      .object({
        maxAttempts: z.number().int().positive().optional(),
        baseDelayMs: z.number().int().positive().optional(),
        maxDelayMs: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/**
 * Routing mode (ADR-012). `"roster"` is the shipped default: policy v4 over
 * the tier-to-model roster, unchanged. `"deepseek"` is the experimental
 * compute controller: the difficulty band buys a compute budget over the
 * DeepSeek family instead of a roster tier, and per-key rosters are
 * ignored. `MILO_MODE` in the server environment overrides this field.
 */
const modeSchema = z.enum(["roster", "deepseek"]);

/**
 * Jev transport (ADR-021, ADR-022). `"typesafe"` (the default) calls TypeSafe
 * directly with Milo's `JEV_API_KEY`. `"openrouter"` routes EVERY Jev call --
 * the classification call AND every auxiliary feature (ranking, the
 * completeness gate, verification, pruning, fact capture and relevance,
 * preference capture) -- through OpenRouter's Decisions endpoint on the
 * caller's own forwarded OpenRouter key, so all Jev spend lands on the user's
 * key and a Milo-key outage cannot stop routing. `MILO_JEV_TRANSPORT` in the
 * environment overrides this field. Under `"openrouter"`, `JEV_API_KEY` is
 * unused and need not be set (ADR-022); under `"typesafe"` it is required.
 */
const jevTransportSchema = z.enum(["typesafe", "openrouter"]);

/**
 * The Jev classification cache (ADR-023). `enabled` (default true) skips a
 * repeat Jev call for the exact same fingerprint and user-turn count, at a
 * short TTL, complementing stickiness rather than replacing it (see
 * `RouterOptions.classificationCache` in `@milo/core`). `ttlMs` (default five
 * minutes) is deliberately shorter than stickiness' thirty: a stale cached
 * *classification* only costs an occasionally-outdated difficulty guess,
 * never a wrong user or conversation. `maxEntries` (default 5,000) bounds
 * memory.
 */
const classificationCacheSchema = z
  .object({
    enabled: z.boolean().default(true),
    ttlMs: z.number().int().positive().optional(),
    maxEntries: z.number().int().positive().optional(),
  })
  .strict();

/**
 * Circuit breaker tuning for the `"openrouter"` Jev transport (ADR-023).
 * Both optional; unset means `CircuitBreaker`'s own defaults (3 consecutive
 * failures, 30s cooldown). Ignored under `"typesafe"`.
 */
const jevBreakerSchema = z
  .object({
    failureThreshold: z.number().int().positive().optional(),
    cooldownMs: z.number().int().positive().optional(),
  })
  .strict();

export const configSchema = z
  .object({
    port: z.number().int().positive().default(DEFAULT_PORT),
    hostname: z.string().trim().min(1).optional(),
    mode: modeSchema.default("roster"),
    jevTransport: jevTransportSchema.default("typesafe"),
    /**
     * The operator's explicit opt-in to a TypeSafe safety net for the
     * `"openrouter"` Jev transport (ADR-023): while its circuit breaker is
     * open, a request falls back to the direct TypeSafe transport on Milo's
     * own `JEV_API_KEY` instead of failing. Default `false`: a broken
     * `"openrouter"` transport then fails open per call once its breaker
     * trips and never reaches for Milo's key, exactly as ADR-022 always
     * specified. Setting this WITHOUT `JEV_API_KEY` configured does nothing
     * but log a warning -- it is never a silent no-op that looks like a
     * working fallback. Ignored under `"typesafe"`, which has no second
     * transport to fall back to.
     */
    jevFallbackToTypesafe: z.boolean().default(false),
    /** Breaker tuning for `jevFallbackToTypesafe`'s circuit breaker. */
    jevBreaker: jevBreakerSchema.optional(),
    roster: rosterSchema.optional(),
    rateLimit: rateLimitSchema.optional(),
    tenantLimits: tenantLimitsSchema.optional(),
    upstream: upstreamSchema.optional(),
    decisionLog: z.string().trim().min(1).default(DEFAULT_DECISION_LOG_URL),
    referer: z.string().trim().min(1).optional(),
    title: z.string().trim().min(1).optional(),
    /** Jev budget in ms per routed request. Default ROUTER_LIMITS.jevTimeoutMs (800). */
    jevTimeoutMs: z.number().int().positive().optional(),
    sampling: samplingSchema.optional(),
    speculation: speculationSchema.optional(),
    pruning: pruningSchema.optional(),
    factRetrieval: factRetrievalSchema.optional(),
    classificationCache: classificationCacheSchema.optional(),
  })
  .strict();

export type MiloConfig = z.infer<typeof configSchema>;

export type ConfigSource = { kind: "file"; path: string } | { kind: "default" };

export type LoadedConfig = {
  config: MiloConfig;
  source: ConfigSource;
};

function formatZodError(error: ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `  - ${path}: ${issue.message}`;
    })
    .join("\n");
}

/**
 * Loads and validates `milo.config.json`.
 *
 * - `path` explicit and unreadable: throws.
 * - `path` explicit and present but invalid: throws with every issue listed.
 * - `path` omitted and no file at `<cwd>/milo.config.json`: returns defaults.
 * - `cwd` is injectable for tests; defaults to `process.cwd()`.
 */
export function loadConfig(path?: string, cwd: string = process.cwd()): LoadedConfig {
  const explicit = path !== undefined;
  const resolvedPath = resolve(cwd, path ?? DEFAULT_CONFIG_FILENAME);

  let raw: string;
  try {
    raw = readFileSync(resolvedPath, "utf8");
  } catch (error) {
    if (!explicit) {
      return { config: configSchema.parse({}), source: { kind: "default" } };
    }
    throw new Error(
      `milo config: could not read "${resolvedPath}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `milo config: "${resolvedPath}" is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const result = configSchema.safeParse(json);
  if (!result.success) {
    throw new Error(`milo config: "${resolvedPath}" is invalid:\n${formatZodError(result.error)}`);
  }

  return { config: result.data, source: { kind: "file", path: resolvedPath } };
}
