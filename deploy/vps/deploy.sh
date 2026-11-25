#!/bin/sh
# Runs on the VPS from the unpacked source (/srv/onceplatform/build/src).
# Builds onceplatform/app:latest and recreates only the app container:
# db, tailscale and backup keep running, data volumes are not touched.
# On a failed health check it rolls back to the previous image by itself.
# Manual rollback:
#   docker tag onceplatform/app:prev onceplatform/app:latest
#   cd /srv/onceplatform && docker compose up -d --no-deps app
set -eu
SRC=$(cd "$(dirname "$0")/../.." && pwd)

docker tag onceplatform/app:latest onceplatform/app:prev
# A failed build leaves :latest on the running image.
# --pull: fresh base images (Go, Alpine) with their security fixes, not the copy cached at the first build
docker build --pull --build-arg VERSION="$(date +%Y.%m.%d-%H%M)" -t onceplatform/app:latest "$SRC"

cd /srv/onceplatform
docker compose up -d --no-deps app

healthy() {
  i=0
  while [ $i -lt 30 ]; do
    docker exec onceplatform-app-1 /app/portal healthcheck >/dev/null 2>&1 && return 0
    i=$((i + 1)); sleep 2
  done
  return 1
}

if healthy; then
  docker image prune -f >/dev/null
  echo "OK: app is running the new image"
  exit 0
fi

echo "FAILED: app is not healthy, rolling back" >&2
docker compose logs --tail=60 app >&2
docker tag onceplatform/app:prev onceplatform/app:latest
docker compose up -d --no-deps app
healthy && echo "Rolled back to the previous image" >&2
exit 1
