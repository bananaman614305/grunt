#!/usr/bin/env bash
# Boot smoke-test for a candidate gateway image, run BEFORE the production
# machine is cut over. Milo runs a single machine on a single volume
# (fly.toml: "one app, one machine"), so a rolling deploy that ships a broken
# image has no standby to fall back to -- a boot bug becomes a full outage.
# That is exactly what happened when a pruned dev-only import (@milo/evals,
# via the canary command) crash-looped the gateway on boot (fixed in f28180e).
#
# This runs the freshly-built image in the CI runner with NO app secrets and
# requires /healthz to answer before we touch prod. It exercises the whole
# module-load + server-start path, so an ERR_MODULE_NOT_FOUND (or any boot
# throw) fails the deploy here and leaves the running version serving.
#
# Usage: scripts/fly-smoke.sh <image-ref>
#   e.g. scripts/fly-smoke.sh registry.fly.io/milo-gateway:smoke-<sha>
set -euo pipefail

IMAGE="${1:?usage: fly-smoke.sh <image-ref>}"
NAME="milo-smoke-$$"

# JEV_API_KEY is required under the default "typesafe" transport, and CI has no
# secrets. MILO_JEV_TRANSPORT=openrouter (ADR-022) makes Milo's own Jev key
# unnecessary at boot -- the user's OpenRouter key is per-request -- so the
# gateway boots and serves /healthz with nothing configured. MILO_MODE matches
# prod; MILO_DB is a throwaway file so no volume is needed.
# The pipeline builds the image locally in the runner and smoke-tests it before
# pushing, so prefer an already-present image; only pull if it isn't local
# (e.g. when testing a ref that lives only in a registry).
if docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "smoke: using local image $IMAGE"
else
  echo "smoke: pulling $IMAGE"
  docker pull --quiet "$IMAGE" || { echo "smoke: FAIL -- cannot pull or find image $IMAGE"; exit 1; }
fi

echo "smoke: starting container $NAME"
docker run -d --name "$NAME" \
  -e MILO_MODE=deepseek \
  -e MILO_JEV_TRANSPORT=openrouter \
  -e MILO_DB=file:/tmp/smoke.db \
  "$IMAGE" >/dev/null

cleanup() {
  echo "smoke: --- container logs ---"
  docker logs "$NAME" 2>&1 | sed 's/^/smoke|  /' || true
  echo "smoke: removing container $NAME"
  docker rm -f "$NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Probe /healthz from inside the container, mirroring the image's own
# Dockerfile HEALTHCHECK (node has global fetch; no host port-binding assumed).
PROBE='fetch("http://127.0.0.1:"+(process.env.PORT||8787)+"/healthz").then(r=>r.text()).then(t=>{if(!/"ok"\s*:\s*true/.test(t)){console.error("unexpected /healthz body:",t);process.exit(1);}console.log("smoke: /healthz ->",t);}).catch(e=>{process.exit(1);})'

for i in $(seq 1 45); do
  # Container must still be up; if it crash-looped, exit code != "running".
  status=$(docker inspect -f '{{.State.Status}}' "$NAME" 2>/dev/null || echo gone)
  if [ "$status" != "running" ]; then
    echo "smoke: FAIL -- container is '$status' (boot crashed) after ${i}s"
    exit 1
  fi
  if docker exec "$NAME" node -e "$PROBE" 2>/dev/null; then
    echo "smoke: PASS -- image boots and serves /healthz (after ${i}s)"
    exit 0
  fi
  sleep 1
done

echo "smoke: FAIL -- /healthz never became healthy within 45s"
exit 1
