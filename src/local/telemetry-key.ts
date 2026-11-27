// An optional build-time PostHog project key. Empty means the built-in
// DEFAULT_POSTHOG_KEY in telemetry.ts. scripts/build.mjs replaces this module in
// dist/ when the build has POSTHOG_PROJECT_KEY, and defines GRUNT_POSTHOG_KEY in
// the daemon bundle.
export const POSTHOG_KEY: string = '';
