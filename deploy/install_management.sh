#!/usr/bin/env bash
set -Eeuo pipefail
SOURCE_DIR="${SOURCE_DIR:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)}"
APP_DIR="${APP_DIR:-/home/queue/queue_project}"
APP_USER="${APP_USER:-queue}"
for name in menu.sh linux_update.py install.sh install_management.sh; do
    if [[ "${SOURCE_DIR}" != "${APP_DIR}" ]]; then
        install -m 0750 "${SOURCE_DIR}/deploy/${name}" "${APP_DIR}/deploy/${name}"
    fi
done
for command in admin close-day backup restore; do
    case "${command}" in
        admin) target="runuser -u ${APP_USER} -- ${APP_DIR}/venv/bin/python ${APP_DIR}/scripts/manageAdmins.py" ;;
        close-day) target="runuser -u ${APP_USER} -- ${APP_DIR}/venv/bin/python ${APP_DIR}/scripts/closeDay.py" ;;
        backup) target="bash ${APP_DIR}/deploy/backup_db.sh" ;;
        restore) target="bash ${APP_DIR}/deploy/restore_db.sh" ;;
    esac
    printf '#!/bin/sh\nexec %s "$@"\n' "${target}" > "/usr/local/bin/queue-${command}"
    chmod 0755 "/usr/local/bin/queue-${command}"
done
printf '#!/bin/sh\nexec bash %s/deploy/menu.sh "$@"\n' "${APP_DIR}" > /usr/local/bin/qronion
printf '#!/bin/sh\nexec python3 %s/deploy/linux_update.py "$@"\n' "${APP_DIR}" > /usr/local/bin/queue-update
chmod 0755 /usr/local/bin/qronion /usr/local/bin/queue-update
