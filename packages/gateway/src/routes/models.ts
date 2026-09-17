/**
 * `GET /v1/models` -- OpenRouter's catalogue with `milo/auto` at the front.
 *
 * Clients that render a model picker read this list, so `milo/auto` has to
 * look like every other entry or it will not show up. It is listed first
 * because it is the reason the user pointed their SDK here.
 */

import type { Hono } from "hono";
import type { Context } from "hono";
import { DEFAULT_ROSTER_INFO, OpenRouterError, ROUTED_MODEL_ID, defaultRosterModels } from "@milo/core";
import type { AppDeps } from "../app.js";
import { authOf } from "../billing.js";
import { errorMessage, errorResponse, openAiError } from "../errors.js";

/**
 * Shaped like an OpenRouter model entry. Pricing is `-1`, the convention
 * OpenRouter itself uses for its auto router: the real price is whichever
 * model the decision lands on. `context_length` is the largest any roster
 * model offers, since the router will not reject a request for length.
 *
 * The description names the roster version and what the defaults optimize
 * for, because a model picker is where most users first meet `milo/auto` and
 * "routes to a model" does not tell them which models.
 */
/**
 * The largest context any default-roster model offers. Read off the roster
 * data rather than written down, so the claim above stays true when the
 * weekly refresh moves the roster.
 */
const ROSTER_MAX_CONTEXT = Math.max(...defaultRosterModels().map((m) => m.contextLength));

export const MILO_AUTO_MODEL = {
  id: ROUTED_MODEL_ID,
  canonical_slug: ROUTED_MODEL_ID,
  name: "Milo auto-router",
  description:
    "Routes to a model chosen by Jev from task type and difficulty. Default roster " +
    `${DEFAULT_ROSTER_INFO.version}: the ${DEFAULT_ROSTER_INFO.topModels} most-used models on ` +
    "OpenRouter for coding, popular-and-cheap, nothing above " +
    `$${DEFAULT_ROSTER_INFO.excludedAbove}/M output. Override per request with milo.candidates; ` +
    "see GET /v1/roster.",
  created: 0,
  context_length: ROSTER_MAX_CONTEXT,
  architecture: {
    modality: "text->text",
    input_modalities: ["text"],
    output_modalities: ["text"],
    tokenizer: "Other",
    instruct_type: null,
  },
  pricing: { prompt: "-1", completion: "-1", request: "-1", image: "-1" },
  top_provider: { context_length: ROSTER_MAX_CONTEXT, max_completion_tokens: null, is_moderated: false },
  per_request_limits: null,
  supported_parameters: ["max_tokens", "temperature", "top_p", "stop", "tools", "tool_choice", "stream"],
} as const;

export function registerModelsRoute(app: Hono, deps: AppDeps): void {
  app.get("/v1/models", async (c) => {
    try {
      const { data } = await deps.openRouter.listModels(authOf(c).openRouterAuthorization);
      return c.json({ data: [MILO_AUTO_MODEL, ...data] });
    } catch (err) {
      deps.logger.error("openrouter models request failed", { error: errorMessage(err) });
      return upstreamFailure(c, err);
    }
  });
}

/**
 * An upstream refusal is the user's to see: a 401 from OpenRouter means their
 * key is bad, and translating that into a generic Milo error would send them
 * looking in the wrong place.
 */
function upstreamFailure(c: Context, err: unknown): Response {
  if (err instanceof OpenRouterError && err.status >= 400 && err.status <= 599) {
    const body = err.body ?? openAiError("OpenRouter rejected the models request.", "api_error", "upstream_error");
    return new Response(JSON.stringify(body), {
      status: err.status,
      headers: { "content-type": "application/json" },
    });
  }
  return errorResponse(c, 502, "Upstream request to OpenRouter failed.", "api_error", "upstream_unavailable");
}
