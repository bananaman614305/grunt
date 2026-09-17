# Deploying Milo

Milo ships as a single container image. This doc covers how that image is
built and published, the environment it reads at runtime, and the Fly.io
plan it is meant to run under.

## Building and publishing the image

`Dockerfile` at the repo root is a two-stage build:

1. **`build`** (`node:22-slim`): enables corepack, `pnpm install
   --frozen-lockfile`, `pnpm build` (every workspace package), then prunes
   `node_modules` down to `@milo/cli`'s production dependencies in place
   (`pnpm install --prod --frozen-lockfile --filter "@milo/cli..."`). This
   keeps the pnpm workspace's own symlink layout
   (`packages/cli/node_modules/@milo -> ../../{core,gateway}`) intact
   rather than trying to flatten it, and needs no network beyond what the
   frozen install already fetched. The stage ends by actually running
   `node packages/cli/dist/cli.js --help` as a build-time sanity check.
2. **`runtime`** (`node:22-slim`): copies only the pruned `node_modules`
   plus each package's `dist/` and `package.json` (no `src/`, no test
   files, no devDependencies), runs as the image's built-in non-root `node`
   user, and starts `node packages/cli/dist/cli.js serve`.

`.github/workflows/image.yml` builds and pushes this image to GHCR on every
push to `main` and on tags matching `v*`, tagged `latest` (default branch
only), `sha-<short>`, and the git tag when the push was a tag. It uses
`docker/build-push-action` with GitHub Actions' build cache and needs no
secret beyond the built-in `GITHUB_TOKEN` (`permissions: packages: write,
contents: read`).

**The published package must be made public once.** GHCR packages are
private by default; a private package still requires a pull credential,
which defeats the point of deploying to Fly by API with none. After the
first push, open the package's page on GitHub (organization or user
Packages tab -> `milo` -> Package settings -> Danger Zone -> Change
visibility) and set it to public. Every later push publishes a new version
of the same public package — this is a one-time step, not a per-release one.

Build and inspect it locally the same way CI does:

```
docker build -t milo-gateway .
docker run --rm -e JEV_API_KEY=... -p 8787:8787 milo-gateway
curl http://localhost:8787/healthz
```

## Environment variables

None of these are baked into the image with real values; the image only
sets defaults for `PORT` and `MILO_DB`.

| Variable | Required | Default | Effect |
|---|---|---|---|
| `PORT` | no | `8787` | Port the gateway listens on. `--port` beats `PORT` beats `milo.config.json`'s `port` beats the default. |
| `MILO_DB` | no | `file:/data/decisions.db` (set by the image) | libsql URL for the decision log. `--db` beats `MILO_DB` beats `milo.config.json`'s `decisionLog` beats the default. A `file:` path's parent directory is created automatically, relative or absolute. |
| `JEV_API_KEY` | **yes** | *(unset)* | Milo's own TypeSafe Jev key. Jev is the only decision backend (ADR-005); `milo serve` refuses to start without it. Never put this in the image, a config file, or the workflow — supply it at deploy time (`fly secrets set`, or an injected Squire egress grant). |
| `MILO_DATABASE_URL` | no | *(unset)* | Postgres URL for Milo-issued keys and prepaid credits (ADR-007). Unset means bring-your-own-key only: every `mk_` bearer gets a 401 and nothing else changes. Set it and `MILO_ENCRYPTION_KEY` becomes required. |
| `MILO_ENCRYPTION_KEY` | only with `MILO_DATABASE_URL` | *(unset)* | base64 of 32 random bytes; encrypts each account's OpenRouter sub-key at rest. A Fly secret, never in the image. |
| `MILO_MARGIN` | no | `0.15` | Fraction added to OpenRouter's reported cost when charging a Milo account. |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | no | *(unset)* | Both required together for credit checkout, the customer portal, and the Stripe webhook; without them those routes answer 503. |
| `OPENROUTER_PROVISIONING_KEY` | no | *(unset)* | Mints each account's OpenRouter sub-key and keeps its spend limit equal to the balance. |
| `--config <path>` (flag, not an env var) | no | none (defaults apply) | Path to a `milo.config.json` for the roster, rate limit, or referer/title (`docs/config.md`). Mount one into the container and pass `--config` in a custom `CMD`/`command` override if you need it; the shipped image runs with no config file. |

See `docs/config.md` for the full config-file schema and precedence rules,
and ADR-003/ADR-005 for why the key handling and routing-failure behavior
work this way.

## Fly.io plan

One app, one always-on machine, Jev as the sole decision backend:

- App name `milo-gateway`, primary region `iad`.
- `shared-cpu-1x`, 512 MB memory.
- A 1 GB volume mounted at `/data`, matching `MILO_DB=file:/data/decisions.db`
  baked into the image.
- An HTTP service on port 8787 with health checks against `/healthz`.
- `JEV_API_KEY` set once with `fly secrets set` (or through Fly's GraphQL
  `setSecrets`); the secret takes effect on the next deploy. There is no
  fallback tier, so a missing or exhausted key means routed requests get a
  503 (ADR-005) rather than a silently degraded model choice.

`fly.toml` at the repo root encodes exactly this and works with a plain
`flyctl deploy` (Fly builds the image itself from the `Dockerfile`, so this
path needs no GHCR step at all):

```
fly launch --no-deploy   # first time only, to create the app if it doesn't exist
fly volumes create milo_data --region iad --size 1
fly deploy
```

### Deploying the published image by the Machines API instead

The point of publishing to GHCR is deploying without `flyctl` or a local
Docker build: create (or update) a Machine directly against Fly's Machines
API, pointing at the public image. No registry credentials are needed on
the deploy side because the GHCR package is public (see above).

```
curl -X POST \
  -H "Authorization: Bearer $FLY_API_TOKEN" \
  -H "Content-Type: application/json" \
  "https://api.machines.dev/v1/apps/milo-gateway/machines" \
  -d '{
    "region": "iad",
    "config": {
      "image": "ghcr.io/<owner>/milo:latest",
      "guest": { "cpu_kind": "shared", "cpus": 1, "memory_mb": 512 },
      "mounts": [{ "volume": "<volume-id>", "path": "/data" }],
      "services": [{
        "internal_port": 8787,
        "protocol": "tcp",
        "ports": [{ "port": 443, "handlers": ["tls", "http"] }],
        "checks": [{ "type": "http", "path": "/healthz", "interval": "15s", "timeout": "5s" }]
      }]
    }
  }'
```

`FLY_API_TOKEN` is a Fly API credential, not a registry credential — it
authorizes the Machines API call, not the image pull. The app and volume
still need to exist first (`fly apps create milo-gateway`, `fly volumes
create milo_data --region iad --size 1`), and so does the `JEV_API_KEY`
secret (`fly secrets set JEV_API_KEY=...`, or a Squire egress grant token) —
without it the gateway will not start.
