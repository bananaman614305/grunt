// The write-only PostHog project key. Source builds leave it empty, so they send
// nothing. scripts/build.mjs replaces this module in dist/ when the release
// build has POSTHOG_PROJECT_KEY, and defines GRUNT_POSTHOG_KEY in the daemon bundle.
export const POSTHOG_KEY: string = '';
