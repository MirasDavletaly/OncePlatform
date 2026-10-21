#!/bin/sh
# Stops OncePlatform on Synology. Data (database, files, backups, Tailscale
# identity) is kept in Docker volumes; start.sh brings everything back.
#
# DSM Task Scheduler → User-defined script (root):
#   bash /volume1/docker/onceplatform/deploy/synology/stop.sh

export PATH="/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin:$PATH"
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR" || exit 1

{
	echo "===== $(date '+%Y-%m-%d %H:%M:%S') stop ====="
	if docker compose version >/dev/null 2>&1; then
		COMPOSE="docker compose"
	else
		COMPOSE="docker-compose"
	fi
	$COMPOSE -p onceplatform down
	echo "===== finished, exit code $? ====="
} >>"$DIR/start.log" 2>&1
