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

KEEP_DAYS=14
LABEL=""
INSTALL_CRON=0
PROJECT_DIR=""

usage() {
    cat <<'EOF'
Резервное копирование PostgreSQL для электронной очереди.

Использование:
  sudo bash deploy/backup_db.sh [опции]
  sudo queue-backup [опции]

Опции:
  --project-dir PATH   Каталог проекта (по умолчанию /home/qronion для новой установки)
  --output-dir PATH    Каталог для дампов (по умолчанию /var/backups/queue/db)
  --keep-days N        Хранить дампы N дней (по умолчанию 14, 0 = не удалять старые)
  --label TEXT         Добавить метку к имени файла
  --install-cron       Установить ежедневный cron в 03:15 (нужен root)
  -h, --help           Показать справку

Примеры:
  sudo queue-backup
  sudo queue-backup --keep-days 30
  sudo queue-backup --label before_update
EOF
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --project-dir)
            PROJECT_DIR="${2:-}"
            shift 2
            ;;
        --output-dir)
            BACKUP_ROOT="${2:-}"
            shift 2
            ;;
        --keep-days)
            KEEP_DAYS="${2:-}"
            shift 2
            ;;
        --label)
            LABEL="${2:-}"
            shift 2
            ;;
        --install-cron)
            INSTALL_CRON=1
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            fail "неизвестный аргумент: $1 (см. --help)"
            ;;
    esac
done

resolve_project_dir "${PROJECT_DIR}"
require_command pg_dump
require_command python3
load_database_url
ensure_backup_root

timestamp="$(date +%Y%m%d_%H%M%S)"
if [[ -n "${LABEL}" ]]; then
    safe_label="$(printf '%s' "${LABEL}" | tr -cs '[:alnum:]_-' '_')"
    dump_name="queue_${timestamp}_${safe_label}.dump"
else
    dump_name="queue_${timestamp}.dump"
fi
temporary_dump="$(mktemp "${BACKUP_ROOT}/.queue_XXXXXXXXXX")"
trap 'rm -f -- "${temporary_dump}"' EXIT
dump_path="${BACKUP_ROOT}/${dump_name%.dump}_${temporary_dump##*_}.dump"

log "Создаю дамп: ${dump_path}"
run_as_app_user pg_dump \
    --format=custom \
    --no-owner \
    --no-privileges \
    "${DATABASE_URL}" > "${temporary_dump}"

if [[ ${EUID} -eq 0 ]]; then
    chown root:"${APP_USER}" "${temporary_dump}"
fi
chmod 0640 "${temporary_dump}"
ln -- "${temporary_dump}" "${dump_path}"

dump_size="$(du -h "${dump_path}" | awk '{print $1}')"
log "Готово (${dump_size}): ${dump_path}"

if [[ "${KEEP_DAYS}" =~ ^[0-9]+$ ]] && [[ "${KEEP_DAYS}" -gt 0 ]]; then
    deleted_count=0
    while IFS= read -r old_file; do
        rm -f "${old_file}"
        deleted_count=$((deleted_count + 1))
    done < <(find "${BACKUP_ROOT}" -maxdepth 1 -type f -name 'queue_*.dump' -mtime +"${KEEP_DAYS}" -print)
    if [[ ${deleted_count} -gt 0 ]]; then
        log "Удалено старых дампов: ${deleted_count} (старше ${KEEP_DAYS} дн.)"
    fi
fi

if [[ ${INSTALL_CRON} -eq 1 ]]; then
    [[ ${EUID} -eq 0 ]] || fail "--install-cron можно только от root"

    cron_cmd="${APP_DIR}/deploy/backup_db.sh --keep-days ${KEEP_DAYS}"
    cron_line="15 3 * * * root ${cron_cmd} >> /var/log/queue-db-backup.log 2>&1"

    install -d -m 0755 /etc/cron.d
    printf '%s\n' "${cron_line}" > /etc/cron.d/queue-db-backup
    chmod 0644 /etc/cron.d/queue-db-backup
    touch /var/log/queue-db-backup.log
    chmod 0644 /var/log/queue-db-backup.log

    log "Cron установлен: ежедневно в 03:15, журнал /var/log/queue-db-backup.log"
fi
