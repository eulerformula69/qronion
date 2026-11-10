#!/usr/bin/env bash
set -Eeuo pipefail

SOURCE_PATH="${BASH_SOURCE[0]}"
while [[ -L "${SOURCE_PATH}" ]]; do
    SOURCE_DIR="$(cd -- "$(dirname -- "${SOURCE_PATH}")" && pwd)"
    SOURCE_TARGET="$(readlink -- "${SOURCE_PATH}")"
    if [[ "${SOURCE_TARGET}" == /* ]]; then
        SOURCE_PATH="${SOURCE_TARGET}"
    else
        SOURCE_PATH="${SOURCE_DIR}/${SOURCE_TARGET}"
    fi
done
SCRIPT_DIR="$(cd -- "$(dirname -- "${SOURCE_PATH}")" && pwd)"
# shellcheck source=db_common.sh
source "${SCRIPT_DIR}/db_common.sh"

PROJECT_DIR=""
DUMP_FILE=""
ASSUME_YES=0
SKIP_SAFETY_BACKUP=0

usage() {
    cat <<'EOF'
Восстановление PostgreSQL из дампа электронной очереди.

ВНИМАНИЕ: текущая база будет перезаписана.

Использование:
  sudo bash deploy/restore_db.sh ПУТЬ_К_ДАМПУ [опции]
  sudo queue-restore /var/backups/queue/db/queue_YYYYMMDD_HHMMSS.dump

Опции:
  --project-dir PATH      Каталог проекта
  --yes, -y               Не спрашивать подтверждение
  --skip-safety-backup    Не делать страховочный дамп перед восстановлением
  -h, --help              Показать справку

Примеры:
  sudo queue-restore /var/backups/queue/db/queue_20250624_031500.dump
  sudo queue-restore latest
EOF
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --project-dir)
            PROJECT_DIR="${2:-}"
            shift 2
            ;;
        --yes|-y)
            ASSUME_YES=1
            shift
            ;;
        --skip-safety-backup)
            SKIP_SAFETY_BACKUP=1
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        --*)
            fail "неизвестный аргумент: $1 (см. --help)"
            ;;
        *)
            if [[ -z "${DUMP_FILE}" ]]; then
                DUMP_FILE="$1"
            else
                fail "лишний аргумент: $1 (см. --help)"
            fi
            shift
            ;;
    esac
done

[[ ${EUID} -eq 0 ]] || fail "восстановление выполняйте через sudo"

resolve_project_dir "${PROJECT_DIR}"
require_command pg_restore
require_command python3
load_database_url
ensure_backup_root

if [[ -z "${DUMP_FILE}" ]]; then
    usage
    fail "укажите путь к дампу"
fi

if [[ "${DUMP_FILE}" == "latest" ]]; then
    DUMP_FILE="$(find "${BACKUP_ROOT}" -maxdepth 1 -type f -name 'queue_*.dump' ! -name '*_before_restore.dump' ! -name '*_before_restore_*.dump' -printf '%T@ %p\n' 2>/dev/null \
        | sort -nr \
        | head -n 1 \
        | cut -d' ' -f2-)"
    [[ -n "${DUMP_FILE}" ]] || fail "в ${BACKUP_ROOT} нет дампов queue_*.dump"
fi

if [[ ! -f "${DUMP_FILE}" ]]; then
    fail "файл дампа не найден: ${DUMP_FILE}"
fi

log "Файл дампа: ${DUMP_FILE}"
run_as_app_user pg_restore --list "${DUMP_FILE}" > /dev/null

if [[ ${ASSUME_YES} -ne 1 ]]; then
    printf '\n\033[1;33mВсе текущие данные в базе будут заменены содержимым дампа.\033[0m\n'
    printf 'Продолжить? Введите yes: '
    read -r answer
    [[ "${answer}" == "yes" ]] || fail "восстановление отменено"
fi

service_was_running=0
if service_is_active; then
    service_was_running=1
    log "Останавливаю ${SERVICE_NAME}"
    stop_queue_service
fi

if [[ ${SKIP_SAFETY_BACKUP} -eq 0 ]]; then
    log "Создаю страховочный дамп текущей базы перед восстановлением"
    SAFETY_LABEL="before_restore"
    bash "${SCRIPT_DIR}/backup_db.sh" \
        --project-dir "${APP_DIR}" \
        --output-dir "${BACKUP_ROOT}" \
        --keep-days 0 \
        --label "${SAFETY_LABEL}"
fi

log "Восстанавливаю базу из дампа"

run_as_app_user pg_restore \
    --single-transaction \
    --clean \
    --if-exists \
    --no-owner \
    --no-privileges \
    --dbname="${DATABASE_URL}" \
    "${DUMP_FILE}"

log "Проверяю структуру восстановленной базы"
(cd "${APP_DIR}" && run_as_app_user "${APP_DIR}/venv/bin/python" -m app.schema check)

if [[ ${service_was_running} -eq 1 ]]; then
    log "Запускаю ${SERVICE_NAME}"
    start_queue_service
fi
log "Восстановление завершено успешно"
