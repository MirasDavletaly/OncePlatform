#!/usr/bin/env bash
# Restore the portal from a backup archive created by scripts/backup.sh.
#
#   ./scripts/restore.sh                          list available backups
#   ./scripts/restore.sh portal-20261020-023000.tar.gz   restore a backup from the "backups" volume
#   ./scripts/restore.sh /path/to/portal-....tar.gz      restore an archive file from this server
#   ./scripts/restore.sh <archive> --yes          skip the confirmation question
#
# The current database and uploaded files are REPLACED by the backup.
set -euo pipefail

cd "$(dirname "$0")/.."

ARCHIVE="${1:-}"
CONFIRM="${2:-}"

if [ -z "$ARCHIVE" ]; then
  echo "Доступные резервные копии (том backups):"
  docker compose exec -T backup sh -c 'ls -1t /backups/portal-*.tar.gz 2>/dev/null | xargs -r -n1 basename' || true
  echo
  echo "Использование: $0 <имя-архива или путь к файлу> [--yes]"
  exit 1
fi

docker compose up -d db backup >/dev/null

if [ -f "$ARCHIVE" ]; then
  echo "Копирую $ARCHIVE в контейнер резервного копирования…"
  docker compose cp "$ARCHIVE" backup:/backups/restore-upload.tar.gz
  INNER=/backups/restore-upload.tar.gz
else
  INNER="/backups/$(basename "$ARCHIVE")"
fi

if ! docker compose exec -T backup test -f "$INNER"; then
  echo "Архив не найден: $ARCHIVE" >&2
  exit 1
fi

if [ "$CONFIRM" != "--yes" ]; then
  echo "ВНИМАНИЕ: текущая база данных и все загруженные файлы будут заменены данными из $(basename "$ARCHIVE")."
  read -r -p "Продолжить восстановление? Введите yes: " answer
  if [ "$answer" != "yes" ]; then
    echo "Отменено."
    exit 1
  fi
fi

echo "Останавливаю портал…"
docker compose stop app

echo "Восстанавливаю базу данных и файлы…"
docker compose exec -T backup sh -s -- "$INNER" <<'EOF'
set -eu
A="$1"
W="/tmp/restore-$$"
rm -rf "$W"
mkdir -p "$W"
tar -C "$W" -xzf "$A"
if [ ! -f "$W/db.dump" ]; then
  echo "В архиве нет db.dump — это не резервная копия портала" >&2
  exit 1
fi
psql -v ON_ERROR_STOP=1 -q -d "$PGDATABASE" -c 'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;'
pg_restore --no-owner --exit-on-error --single-transaction -d "$PGDATABASE" "$W/db.dump"
mkdir -p /data/uploads
find /data/uploads -mindepth 1 -delete
if [ -d "$W/uploads" ]; then
  cp -a "$W/uploads/." /data/uploads/
fi
chown -R 10001:10001 /data/uploads
rm -rf "$W"
rm -f /backups/restore-upload.tar.gz
echo "Готово: база и файлы восстановлены."
EOF

echo "Запускаю портал…"
docker compose start app
echo "Восстановление завершено. Проверьте сайт и журнал: docker compose logs -f app"
