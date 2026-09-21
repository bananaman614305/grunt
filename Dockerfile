# Milo gateway container image.
#
# Two stages: `build` compiles the workspace and produces a self-contained
# production tree for @milo/cli via `pnpm deploy`; `runtime` copies only that
# tree onto a bare node:22-slim and runs it as a non-root user. No secrets
# are baked in anywhere -- JEV_API_KEY and friends are supplied at deploy
# time as environment variables (see docs/deploy.md).

FROM node:22-slim AS build
WORKDIR /app

# Corepack ships with node:22-slim; this pins the exact pnpm version from
# package.json's "packageManager" field so the build is reproducible.
RUN corepack enable

# Copy just the manifests first so `pnpm install` is cached across builds
# that only change application code.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/package.json
COPY packages/gateway/package.json packages/gateway/package.json
COPY packages/cli/package.json packages/cli/package.json
COPY packages/evals/package.json packages/evals/package.json
COPY packages/billing/package.json packages/billing/package.json
COPY packages/stripe/package.json packages/stripe/package.json
COPY packages/provisioning/package.json packages/provisioning/package.json
COPY packages/browse/package.json packages/browse/package.json
COPY packages/fleet/package.json packages/fleet/package.json
# Every workspace package must be listed above or pnpm will not link it and
# its build cannot resolve @milo/core.
RUN pnpm install --frozen-lockfile

# Now the rest of the source, and build every workspace package.
COPY tsconfig.json tsconfig.base.json ./
COPY packages ./packages
RUN pnpm build

# Prune devDependencies out of node_modules in place, scoped to @milo/cli
# and the workspace packages it actually depends on (core, gateway). This
# keeps the pnpm workspace's symlink layout (packages/cli/node_modules/@milo
# -> ../../{core,gateway}) intact -- it is just resolved against fewer
# packages -- and needs no network beyond what the frozen install above
# already fetched, since pnpm reuses its local content-addressable store.
# CI=true skips the interactive confirmation pnpm wants before recreating
# node_modules.
RUN CI=true pnpm install --prod --frozen-lockfile --offline --filter "@milo/cli..."

# Sanity check baked into the build: the deployed tree must actually start
# the CLI's help output without touching a network or a real port.
RUN node packages/cli/dist/cli.js --help > /dev/null

FROM node:22-slim AS runtime
ENV NODE_ENV=production
ENV PORT=8787
ENV MILO_DB=file:/data/decisions.db

WORKDIR /app

# Only what @milo/cli needs at runtime: the pruned, production node_modules
# tree (hoisted external deps plus the @milo/* workspace symlinks) and each
# package's own dist/ + package.json. No src/, no test files, no devDeps.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/packages/core/package.json packages/core/package.json
COPY --from=build --chown=node:node /app/packages/core/dist packages/core/dist
COPY --from=build --chown=node:node /app/packages/core/node_modules packages/core/node_modules
COPY --from=build --chown=node:node /app/packages/gateway/package.json packages/gateway/package.json
COPY --from=build --chown=node:node /app/packages/gateway/dist packages/gateway/dist
COPY --from=build --chown=node:node /app/packages/gateway/node_modules packages/gateway/node_modules
COPY --from=build --chown=node:node /app/packages/cli/package.json packages/cli/package.json
COPY --from=build --chown=node:node /app/packages/cli/dist packages/cli/dist
COPY --from=build --chown=node:node /app/packages/cli/node_modules packages/cli/node_modules
# Every workspace package the CLI imports at runtime must be copied here too.
COPY --from=build --chown=node:node /app/packages/billing/package.json packages/billing/package.json
COPY --from=build --chown=node:node /app/packages/billing/dist packages/billing/dist
COPY --from=build --chown=node:node /app/packages/billing/node_modules packages/billing/node_modules
COPY --from=build --chown=node:node /app/packages/stripe/package.json packages/stripe/package.json
COPY --from=build --chown=node:node /app/packages/stripe/dist packages/stripe/dist
COPY --from=build --chown=node:node /app/packages/stripe/node_modules packages/stripe/node_modules
COPY --from=build --chown=node:node /app/packages/provisioning/package.json packages/provisioning/package.json
COPY --from=build --chown=node:node /app/packages/provisioning/dist packages/provisioning/dist
COPY --from=build --chown=node:node /app/packages/provisioning/node_modules packages/provisioning/node_modules

# `GET /skill.md` on the gateway serves this file verbatim (see
# packages/gateway/src/routes/static.ts), so it has to sit at the same
# repo-root-relative path in the image as it does in the source tree.
COPY --chown=node:node skills ./skills

# A Fly volume (or any bind mount) is mounted at /data at deploy time;
# create it here too so `milo serve` has somewhere to write when running
# without a mounted volume (e.g. local `docker run`).
RUN mkdir -p /data && chown node:node /data

USER node
EXPOSE 8787

# node:22-slim has no curl/wget; Node's built-in fetch does the probe.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 8787) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["node", "packages/cli/dist/cli.js", "serve"]
