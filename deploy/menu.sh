#!/usr/bin/env bash
set -uo pipefail
SOURCE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
source "${SOURCE_DIR}/deploy/install_path.sh"
APP_DIR="$(qronion_install_path)"

if [[ ${EUID} -ne 0 ]]; then
    printf 'Запустите меню через sudo: sudo bash deploy/menu.sh\n' >&2
    exit 1
fi
if [[ ! -t 0 ]]; then
    printf 'Откройте меню в терминале. Не передавайте установщик через pipe.\n' >&2
    exit 1
fi

confirm() {
    local answer
    read -r -p "$1 [д/Н]: " answer
    [[ "${answer}" == д || "${answer}" == Д || "${answer}" == y || "${answer}" == Y ]]
}

restore_database() (
    local backup_dir="${BACKUP_ROOT:-/var/backups/queue/db}" dump
    local -a copies
    shopt -s nullglob
    copies=("${backup_dir}"/*.dump)
    if (( ${#copies[@]} == 0 )); then
        printf 'В %s пока нет копий БД. Создать копию можно в пункте 5.\n' "${backup_dir}"
        return 0
    fi
    printf 'Выберите копию по имени файла. Для отмены введите 0.\n'
    PS3='Номер копии: '
    select dump in "${copies[@]}"; do
        [[ "${REPLY}" != 0 ]] || return 0
        if [[ -z "${dump}" ]]; then
            printf 'Введите номер из списка или 0.\n'
            continue
        fi
        mkdir -p /var/lib/queue-update || return 1
        exec 9>/var/lib/queue-update/lock || return 1
        flock -n 9 || { printf 'Сервер занят установкой или обновлением.\n'; return 1; }
        if [[ -f /var/lib/queue-update/pending.json ]]; then
            printf 'Сначала завершите восстановление обновления через пункт 6.\n'
            return 1
        fi
        bash "${APP_DIR}/deploy/restore_db.sh" "${dump}" --project-dir "${APP_DIR}"
        return $?
    done
)

while true; do
    printf '\nQronion · управление сервером\n\n'
    if [[ -f "${APP_DIR}/.queue-installed" ]]; then
        printf 'Установка: %s\n' "${APP_DIR}"
    else
        printf 'Установка не завершена. Начните с пункта 1.\n'
    fi
    printf '1. Установить на чистую Ubuntu 24.04\n'
    printf '2. Проверить обновления\n3. Обновить очередь\n'
    printf '4. Проверить состояние\n5. Создать резервную копию БД\n'
    printf '6. Восстановить после прерванного обновления\n7. Восстановить БД из копии\n0. Выйти\n\n'
    read -r -p 'Выберите пункт: ' action || exit 0
    result=0
    case "${action}" in
        1)
            if [[ -f "${APP_DIR}/.queue-installed" ]]; then
                printf 'Очередь уже установлена. Для обновления выберите пункт 3.\n'
                continue
            fi
            printf 'Установщик настроит PostgreSQL, Nginx, HTTPS и Grafana. Нужен доступ в интернет.\n'
            read -r -p 'IPv4 сервера (Enter: определить автоматически): ' server_ip
            confirm 'Начать установку?' || continue
            # The same lock protects initial installation and managed updates.
            install -d -m 0755 /var/lib/queue-update
            (
                flock -n 9 || { printf 'Установка или обновление уже выполняется.\n'; exit 1; }
                QUEUE_SERVER_IP="${server_ip}" bash "${SOURCE_DIR}/deploy/install.sh"
            ) 9>/var/lib/queue-update/lock || result=$?
            ;;
        2|3|6)
            if [[ ! -f "${APP_DIR}/.queue-installed" ]]; then
                printf 'Сначала завершите установку.\n'
                continue
            fi
            options=()
            if [[ "${action}" == 2 ]]; then options+=(--check); fi
            if [[ "${action}" == 3 ]]; then
                printf 'На время обновления очередь остановится. Копия БД будет создана автоматически.\n'
                confirm 'Обновить очередь?' || continue
            fi
            if [[ "${action}" == 6 ]]; then
                printf 'Будут возвращены файлы и база до прерванного обновления.\n'
                printf 'Изменения в базе после резервной копии будут потеряны.\n'
                confirm 'Восстановить очередь?' || continue
                options+=(--recover)
            fi
            python3 "${APP_DIR}/deploy/linux_update.py" "${options[@]}" || result=$?
            ;;
        4)
            systemctl --no-pager --full status queue.service nginx postgresql grafana-server || result=$?
            if [[ -x "${APP_DIR}/venv/bin/python" ]]; then
                (cd "${APP_DIR}" && runuser -u queue -- venv/bin/python -m app.schema check) || result=$?
            fi
            if [[ -f /var/lib/queue-update/pending.json ]]; then
                printf '\nЕсть незавершённое обновление. Выберите пункт 6.\n'
            fi
            ;;
        5)
            bash "${APP_DIR}/deploy/backup_db.sh" --project-dir "${APP_DIR}" || result=$?
            ;;
        7)
            restore_database || result=$?
            ;;
        0) exit 0 ;;
        *) printf 'Введите номер пункта.\n'; continue ;;
    esac
    if [[ ${result} -ne 0 ]]; then
        printf '\nОперация не завершена. Причина указана выше. Код: %s\n' "${result}"
    fi
    read -r -p 'Enter: вернуться в меню…' _ || exit 0
done
