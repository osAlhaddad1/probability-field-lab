#!/usr/bin/env bash
# Runs on the VPS as the `deploy` user, fed to `bash -s` over SSH by
# .github/workflows/deploy.yml. Pins IMAGE to the commit-SHA tag, restarts the
# stack, and rolls back to the previous image if the healthcheck never goes green.
set -euo pipefail

: "${APP_DIR:?APP_DIR is required}"
: "${IMAGE:?IMAGE is required}"
: "${CONTAINER:=probability-field-lab}"

cd "$APP_DIR"

if [ -n "${GHCR_TOKEN:-}" ]; then
  printf '%s' "$GHCR_TOKEN" | docker login ghcr.io --username "${GHCR_USER:?GHCR_USER is required}" --password-stdin
fi

previous=""
if [ -f .env ]; then
  previous="$(sed -n 's/^IMAGE=//p' .env | tail -n 1)"
fi

write_env() {
  printf 'IMAGE=%s\n' "$1" > .env
}

start() {
  write_env "$1"
  docker compose pull --quiet
  docker compose up -d --remove-orphans
}

healthy() {
  for attempt in $(seq 1 30); do
    status="$(docker inspect --format '{{.State.Health.Status}}' "$CONTAINER" 2>/dev/null || echo starting)"
    case "$status" in
      healthy) return 0 ;;
      unhealthy) return 1 ;;
    esac
    sleep 3
  done
  return 1
}

echo "Deploying $IMAGE"
start "$IMAGE"

if healthy; then
  echo "Deployed release is healthy."
  docker image prune --force --filter "until=168h" > /dev/null || true
  exit 0
fi

echo "Healthcheck never went green for $IMAGE."
docker compose logs --tail 50 app || true

if [ -n "$previous" ] && [ "$previous" != "$IMAGE" ]; then
  echo "Rolling back to $previous"
  start "$previous"
  healthy && echo "Rollback is healthy." || echo "Rollback is also unhealthy — needs a look."
fi
exit 1
