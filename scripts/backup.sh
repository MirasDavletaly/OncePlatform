#!/bin/sh
# Backup of the portal: PostgreSQL dump + uploaded files in one archive.
#
# Runs inside the "backup" container (docker-compose.yml):
#   backup.sh          make one backup now           (make backup)
#   backup.sh --loop   make a backup every day at BACKUP_TIME (default 02:30)
#
# Archives: /backups/portal-YYYYMMDD-HHMMSS.tar.gz (Docker volume "backups"),
# kept for BACKUP_RETENTION_DAYS days (default 14).
set -u

BACKUP_DIR=${BACKUP_DIR:-/backups}
UPLOADS_DIR=${UPLOADS_DIR:-/data/uploads}
RETENTION=${BACKUP_RETENTION_DAYS:-14}
BACKUP_TIME=${BACKUP_TIME:-02:30}

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') backup: $*"; }

fail() {
	log "ERROR: $*"
	rm -rf "$work" "$archive.partial"
	return 1
}

run_backup() {
	stamp=$(date '+%Y%m%d-%H%M%S')
	work="$BACKUP_DIR/.tmp-$stamp"
	archive="$BACKUP_DIR/portal-$stamp.tar.gz"
	rm -rf "$work"
	mkdir -p "$work" || fail "cannot create $work" || return 1

	log "dumping database $PGDATABASE"
	pg_dump --format=custom --no-owner --file="$work/db.dump" || fail "pg_dump failed" || return 1

	mkdir -p "$UPLOADS_DIR"
	# The symlink is followed by tar -h, so files end up under uploads/ in the archive.
	ln -s "$UPLOADS_DIR" "$work/uploads" || fail "cannot link uploads" || return 1
	{
		echo "created=$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
		echo "database=$PGDATABASE"
		echo "format=onceplatform-backup-v1"
	} > "$work/manifest.txt"

	log "archiving database dump and uploaded files"
	tar -C "$work" -chzf "$archive.partial" manifest.txt db.dump uploads || fail "tar failed" || return 1
	mv "$archive.partial" "$archive" || fail "cannot move archive" || return 1
	rm -rf "$work"
	log "created $archive ($(du -h "$archive" | cut -f1))"

	deleted=$(find "$BACKUP_DIR" -maxdepth 1 -name 'portal-*.tar.gz' -type f -mtime "+$RETENTION" -print -exec rm -f {} \; | wc -l)
	if [ "$deleted" -gt 0 ]; then
		log "removed $deleted archive(s) older than $RETENTION days"
	fi
	return 0
}

mkdir -p "$BACKUP_DIR"

if [ "${1:-}" = "--loop" ]; then
	log "scheduler started: daily at $BACKUP_TIME ($(date '+%Z')), retention $RETENTION days"
	last=""
	while true; do
		now=$(date '+%H:%M')
		today=$(date '+%Y-%m-%d')
		if [ "$now" = "$BACKUP_TIME" ] && [ "$last" != "$today" ]; then
			if run_backup; then
				last="$today"
			else
				log "backup failed, will retry in a minute"
			fi
		fi
		sleep 30
	done
else
	run_backup
fi
