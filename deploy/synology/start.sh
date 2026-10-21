#!/bin/sh
# Builds (or rebuilds after an update) and starts OncePlatform on Synology.
#
# DSM → Control Panel → Task Scheduler → Create → Scheduled Task → User-defined script
#   User: root
#   Run command: bash /volume1/docker/onceplatform/deploy/synology/start.sh
# Run the task manually once ("Run"); after that Docker restarts the containers
# by itself after a reboot (restart: unless-stopped).
#
# Progress and errors are appended to start.log next to this script.

export PATH="/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin:$PATH"
DIR="$(cd "$(dirname "$0")" && pwd)"
LOG="$DIR/start.log"
cd "$DIR" || exit 1

{
	echo "===== $(date '+%Y-%m-%d %H:%M:%S') start ====="
	if docker compose version >/dev/null 2>&1; then
		COMPOSE="docker compose"
	elif command -v docker-compose >/dev/null 2>&1; then
		COMPOSE="docker-compose"
	else
		echo "ERROR: neither 'docker compose' nor 'docker-compose' was found. Is the Docker package installed and running?"
		exit 1
	fi
	echo "using: $COMPOSE $($COMPOSE version --short 2>/dev/null)"
	if [ ! -f .env ]; then
		echo "ERROR: .env not found next to docker-compose.yml ($DIR/.env)"
		exit 1
	fi
	$COMPOSE -p onceplatform up -d --build --remove-orphans
	rc=$?
	$COMPOSE -p onceplatform ps
	echo "===== $(date '+%Y-%m-%d %H:%M:%S') finished, exit code $rc ====="
	exit $rc
} >>"$LOG" 2>&1
