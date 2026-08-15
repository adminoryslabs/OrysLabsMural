#!/usr/bin/env bash
# Deploy OrysLabsMural on the VPS. Invoked by GitHub Actions over SSH.
#
# The registry token arrives on STDIN so it never appears in a command line, a
# process list, or the remote shell history. It is discarded when this exits.
#
#   IMAGE_TAG=<sha> ACTOR=<github-user> bash deploy.sh  < token
set -euo pipefail

: "${IMAGE_TAG:?IMAGE_TAG is required}"
: "${ACTOR:?ACTOR is required}"

cd /opt/apps/mural
export IMAGE_TAG

docker login ghcr.io -u "$ACTOR" --password-stdin
trap 'docker logout ghcr.io >/dev/null 2>&1 || true' EXIT

# Not --quiet on purpose: a silent pull can leave the SSH connection with no
# traffic for minutes, and something in the path between the runner and this
# host drops it. The progress output is what keeps the pipe alive.
echo "==> pulling $IMAGE_TAG"
docker compose pull

# One-shot, and it must succeed before anything serves traffic.
echo "==> migrating"
docker compose run --rm migrate

echo "==> starting app and yjs"
docker compose up -d --remove-orphans app yjs

echo "==> waiting for health"
unhealthy=""
for _ in $(seq 1 30); do
  unhealthy=$(docker compose ps --format '{{.Service}} {{.Health}}' \
    | awk '$1 != "migrate" && $2 != "healthy" {print $1}' | tr '\n' ' ')
  [ -z "$unhealthy" ] && break
  sleep 5
done

if [ -n "$unhealthy" ]; then
  echo "still unhealthy after 150s: $unhealthy"
  docker compose ps
  # shellcheck disable=SC2086
  docker compose logs --tail 40 $unhealthy
  exit 1
fi

docker compose ps --format '{{.Service}}\t{{.Image}}\t{{.Status}}'

# Old image layers accumulate on a 96 GB disk faster than you would think.
docker image prune -f >/dev/null
echo "==> deployed $IMAGE_TAG"
