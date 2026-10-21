# OncePlatform — short commands for the server. Run from the project directory.
COMPOSE ?= docker compose

.PHONY: help up down restart logs ps backup backups restore update build test web-build

help:
	@echo "make up        — собрать и запустить портал"
	@echo "make down      — остановить все контейнеры (данные сохраняются)"
	@echo "make restart   — перезапустить портал"
	@echo "make logs      — журнал портала в реальном времени (Ctrl+C — выход)"
	@echo "make ps        — состояние контейнеров"
	@echo "make backup    — сделать резервную копию сейчас"
	@echo "make backups   — список резервных копий"
	@echo "make restore FILE=portal-YYYYMMDD-HHMMSS.tar.gz — восстановить из копии"
	@echo "make update    — пересобрать и перезапустить после обновления файлов проекта"

up:
	$(COMPOSE) up -d --build

down:
	$(COMPOSE) down

restart:
	$(COMPOSE) restart app

logs:
	$(COMPOSE) logs -f --tail=200 app

ps:
	$(COMPOSE) ps

backup:
	$(COMPOSE) exec backup /bin/sh /scripts/backup.sh

backups:
	$(COMPOSE) exec backup sh -c 'ls -lh /backups/portal-*.tar.gz 2>/dev/null || echo "Резервных копий пока нет"'

restore:
	@test -n "$(FILE)" || (echo "Укажите архив: make restore FILE=portal-YYYYMMDD-HHMMSS.tar.gz"; exit 1)
	bash scripts/restore.sh "$(FILE)"

update:
	$(COMPOSE) build --pull app
	$(COMPOSE) up -d
	$(COMPOSE) image prune -f

# --- Development ------------------------------------------------------------

web-build:
	cd web && npm ci && npm run build

build: web-build
	go build -o bin/portal ./cmd/server

test:
	go vet ./...
	go test ./...
	cd web && npm run typecheck
