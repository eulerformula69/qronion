#!/usr/bin/env bash
# Общие функции для backup_db.sh и restore_db.sh

APP_NAME="${APP_NAME:-queue}"
source "$(dirname -- "${BASH_SOURCE[0]}")/install_path.sh"
if [[ -n "${APP_HOME:-}" ]]; then
    APP_DIR="${APP_DIR:-${APP_HOME}/queue_project}"
else
    APP_DIR="${APP_DIR:-$(qronion_install_path)}"
fi
APP_USER="${APP_USER:-queue}"
SERVICE_NAME="${SERVICE_NAME:-queue.service}"
ENV_FILE="${ENV_FILE:-${APP_DIR}/main.env}"
BACKUP_ROOT="${BACKUP_ROOT:-/var/backups/queue/db}"

log() {
    printf '\n\033[1;34m[QUEUE DB]\033[0m %s\n' "$1"
}

fail() {
    printf '\n\033[1;31m[QUEUE DB] Ошибка:\033[0m %s\n' "$1" >&2
    exit 1
}

require_command() {
    local name="$1"
    command -v "${name}" >/dev/null 2>&1 || fail "команда не найдена: ${name}"
}

resolve_project_dir() {
    local candidate="$1"
    if [[ -n "${candidate}" ]]; then
        APP_DIR="$(cd -- "${candidate}" && pwd)"
        ENV_FILE="${APP_DIR}/main.env"
        return
    fi

    if [[ -f "${ENV_FILE}" ]]; then
        return
    fi

    SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[1]:-${BASH_SOURCE[0]}}")" && pwd)"
    local sibling="${SCRIPT_DIR}/../main.env"
    if [[ -f "${sibling}" ]]; then
        APP_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
        ENV_FILE="${APP_DIR}/main.env"
    fi
}

load_database_url() {
    [[ -f "${ENV_FILE}" ]] || fail "не найден файл настроек: ${ENV_FILE}"

    DATABASE_URL="$(
        python3 - "${ENV_FILE}" <<'PY'
import sys
from pathlib import Path

path = Path(sys.argv[1])
database_url = ""

for raw_line in path.read_text(encoding="utf-8").splitlines():
    line = raw_line.strip()
    if not line or line.startswith("#"):
        continue
    if line.startswith("export "):
        line = line[7:].lstrip()

    key, separator, value = line.partition("=")
    if separator and key.strip() == "DATABASE_URL":
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        database_url = value
        break

if not database_url:
    raise SystemExit("DATABASE_URL не задан в main.env")
print(database_url)
PY
    )" || fail "не удалось прочитать DATABASE_URL из ${ENV_FILE}"

    [[ -n "${DATABASE_URL}" ]] || fail "DATABASE_URL пустой"
}

run_as_app_user() {
    if [[ "$(id -un)" == "${APP_USER}" ]]; then
        "$@"
        return
    fi

    if [[ ${EUID} -eq 0 ]]; then
        runuser -u "${APP_USER}" -- "$@"
        return
    fi

    fail "запустите от root (sudo) или от пользователя ${APP_USER}"
}

ensure_backup_root() {
    local mode owner group
    if [[ ${EUID} -eq 0 ]]; then
        install -d -m 0770 -o root -g "${APP_USER}" "${BACKUP_ROOT}"
    else
        [[ -d "${BACKUP_ROOT}" ]] || fail "каталог бэкапов не существует: ${BACKUP_ROOT} (нужен sudo для создания)"
        [[ -w "${BACKUP_ROOT}" ]] || fail "нет прав на запись в ${BACKUP_ROOT}"
    fi
}

stop_queue_service() {
    if [[ ${EUID} -ne 0 ]]; then
        fail "для остановки службы нужен sudo"
    fi
    systemctl stop "${SERVICE_NAME}"
}

start_queue_service() {
    if [[ ${EUID} -ne 0 ]]; then
        fail "для запуска службы нужен sudo"
    fi
    systemctl start "${SERVICE_NAME}"
}

service_is_active() {
    systemctl is-active --quiet "${SERVICE_NAME}"
}
