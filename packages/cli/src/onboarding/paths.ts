/**
 * Gateway URL helpers shared by the onboarding commands. A "gateway root" is
 * a bare origin (`https://milo-gateway.fly.dev`); pi's provider stores the
 * OpenAI-compatible base URL with `/v1` appended.
 */

/** Strips trailing slashes and a trailing `/v1`, so a root is a bare origin. */
export function normalizeGatewayRoot(url: string): string {
  return url.trim().replace(/\/+$/, "").replace(/\/v1$/, "").replace(/\/+$/, "");
}

/** The OpenAI-compatible base URL the pi provider points at: `<root>/v1`. */
export function apiBaseUrl(gatewayRoot: string): string {
  return `${normalizeGatewayRoot(gatewayRoot)}/v1`;
}