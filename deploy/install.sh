#!/usr/bin/env bash
set -Eeuo pipefail

APP_NAME="queue"
APP_HOME="/home/${APP_NAME}"
APP_USER="queue"
DB_NAME="queue"
DB_USER="queue_app"
GRAFANA_DB_USER="queue_grafana"
SERVICE_NAME="queue.service"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
source "${SCRIPT_DIR}/install_path.sh"
APP_DIR="$(qronion_install_path)"
TLS_DIR="/etc/nginx/tls"
MKCERT_CA_DIR="/var/lib/queue-mkcert"
ROOT_CA_EXPORT="/root/queue-rootCA.pem"
FIRST_INSTALL=0
CERT_RENEWED=0
CA_CREATED=0
INSTALL_USER=""
INSTALL_HOME=""
INSTALL_GROUP=""

log() {
    printf '\n\033[1;34m[QUEUE]\033[0m %s\n' "$1"
}

fail() {
    printf '\n\033[1;31m[QUEUE] Ошибка:\033[0m %s\n' "$1" >&2
    exit 1
}

backup_file() {
    local source="$1"
    local destination_name="$2"
    if [[ -f "${source}" ]]; then
        cp -a "${source}" "${BACKUP_DIR}/${destination_name}"
    fi
}

set_env_value() {
    local env_file="$1"
    local key="$2"
    local value="$3"
    python3 - "${env_file}" "${key}" "${value}" <<'PY'
import sys
from pathlib import Path

path = Path(sys.argv[1])
key = sys.argv[2]
value = sys.argv[3]
prefix = f"{key}="
lines = path.read_text(encoding="utf-8").splitlines()
result = []
replaced = False
for line in lines:
    if line.startswith(prefix):
        if not replaced:
            result.append(f"{prefix}{value}")
            replaced = True
    else:
        result.append(line)
if not replaced:
    result.append(f"{prefix}{value}")
path.write_text("\n".join(result) + "\n", encoding="utf-8")
PY
}

set_env_default() {
    local env_file="$1"
    local key="$2"
    local value="$3"
    if ! grep -q "^${key}=" "${env_file}"; then
        printf '%s=%s\n' "${key}" "${value}" >> "${env_file}"
    fi
}

if [[ ${EUID} -ne 0 ]]; then
    fail "запустите установщик командой: sudo bash deploy/install.sh"
fi

if [[ -n "${SUDO_USER:-}" && "${SUDO_USER}" != "root" ]] && id "${SUDO_USER}" >/dev/null 2>&1; then
    INSTALL_USER="${SUDO_USER}"
    INSTALL_HOME="$(getent passwd "${INSTALL_USER}" | cut -d: -f6)"
    INSTALL_GROUP="$(id -gn "${INSTALL_USER}")"
fi

if [[ ! -f "${SOURCE_DIR}/main.py" || ! -d "${SOURCE_DIR}/web" ]]; then
    fail "в корне проекта должны находиться main.py и папка web"
fi

if [[ ! -f /etc/os-release ]]; then
    fail "поддерживается Ubuntu 24.04 LTS"
fi

# shellcheck disable=SC1091
source /etc/os-release
if [[ ${ID:-} != "ubuntu" || ${VERSION_ID:-} != "24.04" || $(uname -m) != "x86_64" ]]; then
    fail "поддерживается Ubuntu 24.04 LTS (обнаружено: ${PRETTY_NAME:-неизвестно})"
fi

export DEBIAN_FRONTEND=noninteractive

log "Устанавливаю системные компоненты"
rm -f /etc/apt/sources.list.d/grafana.list
apt-get update
apt-get install -y \
    python3 python3-venv python3-pip postgresql nginx rsync curl iproute2 git \
    mkcert libnss3-tools openssl acl ffmpeg

SERVER_IP="${QUEUE_SERVER_IP:-}"
if [[ -z "${SERVER_IP}" ]]; then
    SERVER_IP="$(ip -4 route get 1.1.1.1 2>/dev/null \
        | awk '{for (i=1; i<=NF; i++) if ($i == "src") {print $(i+1); exit}}' \
        || true)"
fi
if [[ -z "${SERVER_IP}" ]]; then
    SERVER_IP="$(hostname -I | awk '{print $1}')"
fi
python3 - "${SERVER_IP}" <<'PY' || fail "не удалось определить корректный IPv4; задайте QUEUE_SERVER_IP"
import ipaddress
import sys

address = ipaddress.ip_address(sys.argv[1])
if address.version != 4 or address.is_loopback or address.is_unspecified:
    raise ValueError("server address must be a non-loopback IPv4")
PY
log "Использую адрес сервера ${SERVER_IP}"

if ! id "${APP_USER}" >/dev/null 2>&1; then
    useradd --create-home --home-dir "${APP_HOME}" --shell /bin/bash "${APP_USER}"
fi

install -d -o "${APP_USER}" -g "${APP_USER}" "${APP_DIR}"
install -d -o "${APP_USER}" -g "${APP_USER}" "${APP_DIR}/deploy"
install -d -o "${APP_USER}" -g "${APP_USER}" "${APP_DIR}/scripts"

BACKUP_DIR="/var/backups/queue-install/$(date +%Y%m%d-%H%M%S)"
install -d -m 0700 "${BACKUP_DIR}"
backup_file "${APP_DIR}/main.env" "main.env"
backup_file "/etc/systemd/system/${SERVICE_NAME}" "queue.service"
backup_file "/etc/nginx/sites-available/queue" "nginx-queue.conf"

if [[ ! -f "${APP_DIR}/main.env" ]] \
    || ! grep -q "^DATABASE_URL=postgresql://${DB_USER}:" "${APP_DIR}/main.env"; then
    FIRST_INSTALL=1
fi

if systemctl cat "${SERVICE_NAME}" >/dev/null 2>&1; then
    systemctl stop "${SERVICE_NAME}"
fi

log "Копирую приложение"
install -m 0644 "${SOURCE_DIR}/main.py" "${APP_DIR}/main.py"
install -d -o "${APP_USER}" -g "${APP_USER}" "${APP_DIR}/app"
rsync -a --delete \
    --exclude '__pycache__/' \
    "${SOURCE_DIR}/app/" "${APP_DIR}/app/"
install -m 0644 "${SOURCE_DIR}/requirements.txt" "${APP_DIR}/requirements.txt"
install -m 0644 "${SOURCE_DIR}/alembic.ini" "${APP_DIR}/alembic.ini"
install -d "${APP_DIR}/migrations"
rsync -a --delete --exclude '__pycache__/' "${SOURCE_DIR}/migrations/" "${APP_DIR}/migrations/"
install -m 0750 "${SOURCE_DIR}/scripts/manageAdmins.py" "${APP_DIR}/scripts/manageAdmins.py"
install -m 0750 "${SOURCE_DIR}/scripts/closeDay.py" "${APP_DIR}/scripts/closeDay.py"
install -m 0644 "${SOURCE_DIR}/scripts/grafana_dashboard.py" "${APP_DIR}/scripts/grafana_dashboard.py"
install -m 0750 "${SOURCE_DIR}/scripts/normalizeGrafanaDashboard.py" "${APP_DIR}/scripts/normalizeGrafanaDashboard.py"
install -m 0750 "${SOURCE_DIR}/deploy/update_from_git.py" "${APP_DIR}/deploy/update_from_git.py"
install -m 0750 "${SOURCE_DIR}/deploy/configure_grafana_embed.sh" "${APP_DIR}/deploy/configure_grafana_embed.sh"
install -m 0640 "${SOURCE_DIR}/deploy/exclude_from_update.txt" "${APP_DIR}/deploy/exclude_from_update.txt"
install -m 0644 "${SOURCE_DIR}/deploy/bootstrap_users.py" "${APP_DIR}/deploy/bootstrap_users.py"
install -m 0644 "${SOURCE_DIR}/deploy/install_path.sh" "${APP_DIR}/deploy/install_path.sh"
install -m 0750 "${SOURCE_DIR}/deploy/db_common.sh" "${APP_DIR}/deploy/db_common.sh"
install -m 0750 "${SOURCE_DIR}/deploy/backup_db.sh" "${APP_DIR}/deploy/backup_db.sh"
install -m 0750 "${SOURCE_DIR}/deploy/restore_db.sh" "${APP_DIR}/deploy/restore_db.sh"
install -d -m 0770 -o root -g "${APP_USER}" /var/backups/queue/db
install -d -o "${APP_USER}" -g "${APP_USER}" "${APP_DIR}/web" "${APP_DIR}/queue/tts"
rsync -a --delete "${SOURCE_DIR}/web/" "${APP_DIR}/web/"
rsync -a --exclude 'cache/' "${SOURCE_DIR}/queue/tts/" "${APP_DIR}/queue/tts/"
install -d -o "${APP_USER}" -g "${APP_USER}" \
    "${APP_DIR}/queue/media" "${APP_DIR}/queue/tts/cache"

systemctl enable --now postgresql

if [[ ${FIRST_INSTALL} -eq 1 ]]; then
    log "Создаю локальную базу данных"
    DB_PASSWORD="$(python3 -c 'import secrets; print(secrets.token_urlsafe(24))')"
    GRAFANA_DB_PASSWORD="$(python3 -c 'import secrets; print(secrets.token_urlsafe(24))')"

    if ! runuser -u postgres -- psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='${DB_USER}'" | grep -q 1; then
        runuser -u postgres -- psql -v ON_ERROR_STOP=1 \
            -c "CREATE ROLE ${DB_USER} LOGIN PASSWORD '${DB_PASSWORD}'"
    else
        runuser -u postgres -- psql -v ON_ERROR_STOP=1 \
            -c "ALTER ROLE ${DB_USER} PASSWORD '${DB_PASSWORD}'"
    fi

    if ! runuser -u postgres -- psql -tAc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1; then
        runuser -u postgres -- createdb --owner="${DB_USER}" "${DB_NAME}"
    fi
    runuser -u postgres -- psql -v ON_ERROR_STOP=1 \
        -c "ALTER DATABASE ${DB_NAME} OWNER TO ${DB_USER}"

    cat > "${APP_DIR}/main.env" <<EOF
DATABASE_URL=postgresql://${DB_USER}:${DB_PASSWORD}@127.0.0.1:5432/${DB_NAME}
GRAFANA_DB_PASSWORD=${GRAFANA_DB_PASSWORD}
CORS_ORIGINS=http://${SERVER_IP},https://${SERVER_IP},http://localhost,http://127.0.0.1
SESSION_TIMEOUT_SECONDS=300
OPERATOR_SESSION_AUTO_CLEANUP_ENABLED=true
CLOSE_DAY_WS_URL=ws://127.0.0.1:8000/ws/terminal
PIPER_PATH=${APP_DIR}/venv/bin/piper
PIPER_MODEL=queue/tts/ru_RU-irina-medium.onnx
TTS_CACHE_DIR=queue/tts/cache
TTS_LENGTH_SCALE=1.25
TTS_NOISE_SCALE=0.65
TTS_NOISE_W_SCALE=0.75
TTS_OUTPUT_SAMPLE_RATE=48000
MAX_FILE_SIZE_MB=300
FFMPEG_PATH=/usr/bin/ffmpeg
MEDIA_TRANSCODE_CRF=23
MEDIA_TRANSCODE_PRESET=medium
MEDIA_TRANSCODE_MAX_WIDTH=1920
MEDIA_TRANSCODE_FPS=30
MEDIA_TRANSCODE_KEEP_AUDIO=false
EOF
    chmod 0600 "${APP_DIR}/main.env"

    ADMIN_PASSWORD="$(python3 -c 'import secrets; print(secrets.token_urlsafe(12))')"
    TERMINAL_PASSWORD="$(python3 -c 'import secrets; print(secrets.token_urlsafe(12))')"
    GRAFANA_ADMIN_PASSWORD="$(python3 -c 'import secrets; print(secrets.token_urlsafe(12))')"
    install -m 0600 /dev/null /root/queue-credentials.txt
    cat > /root/queue-credentials.txt <<EOF
Панель администратора: admin
Пароль администратора: ${ADMIN_PASSWORD}

Терминал: terminal
Пароль терминала: ${TERMINAL_PASSWORD}

Grafana: admin
Пароль Grafana: ${GRAFANA_ADMIN_PASSWORD}
EOF
fi

set_env_value "${APP_DIR}/main.env" "CORS_ORIGINS" \
    "http://${SERVER_IP},https://${SERVER_IP},http://localhost,http://127.0.0.1"
set_env_default "${APP_DIR}/main.env" "MAX_FILE_SIZE_MB" "300"
set_env_default "${APP_DIR}/main.env" "FFMPEG_PATH" "/usr/bin/ffmpeg"
set_env_default "${APP_DIR}/main.env" "MEDIA_TRANSCODE_CRF" "23"
set_env_default "${APP_DIR}/main.env" "MEDIA_TRANSCODE_PRESET" "medium"
set_env_default "${APP_DIR}/main.env" "MEDIA_TRANSCODE_MAX_WIDTH" "1920"
set_env_default "${APP_DIR}/main.env" "MEDIA_TRANSCODE_FPS" "30"
set_env_default "${APP_DIR}/main.env" "MEDIA_TRANSCODE_KEEP_AUDIO" "false"

GRAFANA_DB_PASSWORD="$(sed -n 's/^GRAFANA_DB_PASSWORD=//p' "${APP_DIR}/main.env")"
if [[ -z "${GRAFANA_DB_PASSWORD}" ]]; then
    GRAFANA_DB_PASSWORD="$(python3 -c 'import secrets; print(secrets.token_urlsafe(24))')"
    printf 'GRAFANA_DB_PASSWORD=%s\n' "${GRAFANA_DB_PASSWORD}" >> "${APP_DIR}/main.env"
fi
if ! runuser -u postgres -- psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='${GRAFANA_DB_USER}'" | grep -q 1; then
    runuser -u postgres -- psql -v ON_ERROR_STOP=1 \
        -c "CREATE ROLE ${GRAFANA_DB_USER} LOGIN PASSWORD '${GRAFANA_DB_PASSWORD}'"
else
    runuser -u postgres -- psql -v ON_ERROR_STOP=1 \
        -c "ALTER ROLE ${GRAFANA_DB_USER} PASSWORD '${GRAFANA_DB_PASSWORD}'"
fi

log "Устанавливаю Python-зависимости"
if [[ ! -x "${APP_DIR}/venv/bin/python" ]]; then
    python3 -m venv "${APP_DIR}/venv"
fi
"${APP_DIR}/venv/bin/python" -m pip install --upgrade pip
"${APP_DIR}/venv/bin/python" -m pip install -r "${APP_DIR}/requirements.txt"

chown -R "${APP_USER}:${APP_USER}" "${APP_DIR}"
chmod 0600 "${APP_DIR}/main.env"

source "${SOURCE_DIR}/deploy/install_management.sh"

log "Проверяю подключение к базе данных"
runuser -u "${APP_USER}" -- "${APP_DIR}/venv/bin/python" - "${APP_DIR}/main.env" <<'PY'
import sys

from dotenv import dotenv_values
from sqlalchemy import create_engine, text

database_url = dotenv_values(sys.argv[1])["DATABASE_URL"]
engine = create_engine(database_url)
with engine.connect() as connection:
    connection.execute(text("SELECT 1"))
PY

log "Готовлю структуру базы данных"
if [[ ${FIRST_INSTALL} -ne 1 ]]; then
    bash "${APP_DIR}/deploy/backup_db.sh" --project-dir "${APP_DIR}" --label before_migration
fi
(cd "${APP_DIR}" && runuser -u "${APP_USER}" -- "${APP_DIR}/venv/bin/python" -m app.schema upgrade)

log "Настраиваю автоматический запуск"
cat > "/etc/systemd/system/${SERVICE_NAME}" <<EOF
[Unit]
Description=Electronic queue
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
Type=simple
User=${APP_USER}
Group=${APP_USER}
WorkingDirectory=${APP_DIR}
ExecStart=${APP_DIR}/venv/bin/uvicorn main:app --host 127.0.0.1 --port 8000 --workers 1 --proxy-headers
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "${SERVICE_NAME}"
systemctl restart "${SERVICE_NAME}"

log "Создаю начальные учётные записи"
if [[ -f /root/queue-credentials.txt ]]; then
    ADMIN_PASSWORD="$(sed -n 's/^Пароль администратора: //p' /root/queue-credentials.txt)"
    TERMINAL_PASSWORD="$(sed -n 's/^Пароль терминала: //p' /root/queue-credentials.txt)"
else
    ADMIN_PASSWORD="$(python3 -c 'import secrets; print(secrets.token_urlsafe(12))')"
    TERMINAL_PASSWORD="$(python3 -c 'import secrets; print(secrets.token_urlsafe(12))')"
    install -m 0600 /dev/null /root/queue-credentials.txt
    cat > /root/queue-credentials.txt <<EOF
Панель администратора: admin
Пароль администратора: ${ADMIN_PASSWORD}

Терминал: terminal
Пароль терминала: ${TERMINAL_PASSWORD}
EOF
fi

GRAFANA_ADMIN_PASSWORD="$(sed -n 's/^Пароль Grafana: //p' /root/queue-credentials.txt 2>/dev/null || true)"
if [[ -z "${GRAFANA_ADMIN_PASSWORD}" ]]; then
    GRAFANA_ADMIN_PASSWORD="$(python3 -c 'import secrets; print(secrets.token_urlsafe(12))')"
    cat >> /root/queue-credentials.txt <<EOF

Grafana: admin
Пароль Grafana: ${GRAFANA_ADMIN_PASSWORD}
EOF
    chmod 0600 /root/queue-credentials.txt
fi

(
    cd "${APP_DIR}"
    QUEUE_ADMIN_PASSWORD="${ADMIN_PASSWORD}" QUEUE_TERMINAL_PASSWORD="${TERMINAL_PASSWORD}" \
        runuser -u "${APP_USER}" -- "${APP_DIR}/venv/bin/python" "${APP_DIR}/deploy/bootstrap_users.py"
)

log "Устанавливаю и настраиваю Grafana"
rm -f /etc/apt/sources.list.d/grafana.list
if ! dpkg-query -W -f='${Status}' grafana 2>/dev/null | grep -q 'install ok installed'; then
    GRAFANA_DEB="/tmp/grafana_11.5.1_amd64.deb"
    rm -f "${GRAFANA_DEB}"
    curl --fail --show-error --location --retry 3 \
        --output "${GRAFANA_DEB}" \
        https://dl.grafana.com/oss/release/grafana_11.5.1_amd64.deb \
        || fail "не удалось скачать Grafana с dl.grafana.com"
    dpkg-deb --info "${GRAFANA_DEB}" >/dev/null \
        || fail "загруженный пакет Grafana повреждён"
    apt-get install -y "${GRAFANA_DEB}"
    rm -f "${GRAFANA_DEB}"
fi

runuser -u postgres -- psql -v ON_ERROR_STOP=1 -d "${DB_NAME}" <<EOF
GRANT CONNECT ON DATABASE ${DB_NAME} TO ${GRAFANA_DB_USER};
GRANT USAGE ON SCHEMA public TO ${GRAFANA_DB_USER};
GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${GRAFANA_DB_USER};
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO ${GRAFANA_DB_USER};
ALTER DEFAULT PRIVILEGES FOR ROLE ${DB_USER} IN SCHEMA public
    GRANT SELECT ON TABLES TO ${GRAFANA_DB_USER};
EOF

install -d -m 0755 /etc/grafana/provisioning/datasources
install -d -m 0755 /etc/grafana/provisioning/dashboards
install -d -m 0755 /var/lib/grafana/dashboards

cat > /etc/grafana/provisioning/datasources/queue.yaml <<EOF
apiVersion: 1
datasources:
  - name: Queue PostgreSQL
    uid: queue-postgres
    type: postgres
    access: proxy
    url: 127.0.0.1:5432
    user: ${GRAFANA_DB_USER}
    secureJsonData:
      password: ${GRAFANA_DB_PASSWORD}
    jsonData:
      database: ${DB_NAME}
      sslmode: disable
      postgresVersion: 1600
      timescaledb: false
    isDefault: true
    editable: false
EOF
chmod 0640 /etc/grafana/provisioning/datasources/queue.yaml
chown root:grafana /etc/grafana/provisioning/datasources/queue.yaml

cat > /etc/grafana/provisioning/dashboards/queue.yaml <<'EOF'
apiVersion: 1
providers:
  - name: Queue
    orgId: 1
    folder: Queue
    type: file
    disableDeletion: true
    allowUiUpdates: true
    updateIntervalSeconds: 30
    options:
      path: /var/lib/grafana/dashboards
EOF

DASHBOARD_SOURCE="${SOURCE_DIR}/data/statistics.json"
if [[ ! -f "${DASHBOARD_SOURCE}" ]]; then
    DASHBOARD_SOURCE="$(find "${SOURCE_DIR}" -maxdepth 1 -type f -name 'Статистика для очереди*.json' -print -quit)"
fi
[[ -n "${DASHBOARD_SOURCE}" && -f "${DASHBOARD_SOURCE}" ]] \
    || fail "не найден JSON-дашборд Grafana в папке проекта"
python3 "${APP_DIR}/scripts/normalizeGrafanaDashboard.py" \
    "${DASHBOARD_SOURCE}" /var/lib/grafana/dashboards/queue-statistics.json \
    || fail "не удалось нормализовать JSON-дашборд Grafana"
chown -R grafana:grafana /var/lib/grafana/dashboards

install -d -m 0755 /etc/systemd/system/grafana-server.service.d
cat > /etc/systemd/system/grafana-server.service.d/queue.conf <<EOF
[Service]
Environment=GF_SECURITY_ALLOW_EMBEDDING=true
Environment=GF_AUTH_ANONYMOUS_ENABLED=true
Environment="GF_AUTH_ANONYMOUS_ORG_NAME=Main Org."
Environment=GF_AUTH_ANONYMOUS_ORG_ROLE=Viewer
Environment=GF_AUTH_DISABLE_LOGIN_FORM=false
Environment=GF_USERS_DEFAULT_THEME=light
Environment=GF_SERVER_HTTP_ADDR=127.0.0.1
Environment=GF_SERVER_HTTP_PORT=3000
Environment=GF_SERVER_DOMAIN=${SERVER_IP}
Environment=GF_SERVER_ROOT_URL=https://${SERVER_IP}/grafana/
Environment=GF_SERVER_SERVE_FROM_SUB_PATH=true
EOF

systemctl daemon-reload
systemctl enable --now grafana-server
systemctl restart grafana-server

for _ in {1..30}; do
    if curl --fail --silent --output /dev/null http://127.0.0.1:3000/api/health; then
        break
    fi
    sleep 1
done
if ! curl --fail --silent --output /dev/null http://127.0.0.1:3000/api/health; then
    journalctl -u grafana-server -n 30 --no-pager >&2
    fail "Grafana не запустилась перед созданием администратора"
fi
if command -v grafana >/dev/null 2>&1; then
    grafana cli --homepath /usr/share/grafana --config /etc/grafana/grafana.ini \
        admin reset-admin-password "${GRAFANA_ADMIN_PASSWORD}" >/dev/null
elif command -v grafana-cli >/dev/null 2>&1; then
    grafana-cli --homepath /usr/share/grafana --config /etc/grafana/grafana.ini \
        admin reset-admin-password "${GRAFANA_ADMIN_PASSWORD}" >/dev/null
else
    fail "не найдена команда управления Grafana"
fi

log "Настраиваю локальный центр сертификации и HTTPS"
if [[ ! -s "${MKCERT_CA_DIR}/rootCA.pem" || ! -s "${MKCERT_CA_DIR}/rootCA-key.pem" ]]; then
    CA_CREATED=1
    rm -f "${MKCERT_CA_DIR}/rootCA.pem" "${MKCERT_CA_DIR}/rootCA-key.pem"
fi
install -d -m 0700 "${MKCERT_CA_DIR}"
env CAROOT="${MKCERT_CA_DIR}" mkcert -install
chmod 0600 "${MKCERT_CA_DIR}/rootCA-key.pem"
chmod 0644 "${MKCERT_CA_DIR}/rootCA.pem"
install -m 0644 "${MKCERT_CA_DIR}/rootCA.pem" "${ROOT_CA_EXPORT}"

install -d -m 0700 "${TLS_DIR}"
if [[ ${CA_CREATED} -eq 1 ]] \
    || [[ ! -s "${TLS_DIR}/queue.pem" ]] \
    || [[ ! -s "${TLS_DIR}/queue-key.pem" ]] \
    || ! openssl verify -CAfile "${MKCERT_CA_DIR}/rootCA.pem" "${TLS_DIR}/queue.pem" >/dev/null 2>&1 \
    || ! openssl x509 -in "${TLS_DIR}/queue.pem" -noout -checkend 2592000 >/dev/null 2>&1 \
    || ! openssl x509 -in "${TLS_DIR}/queue.pem" -noout -checkip "${SERVER_IP}" >/dev/null 2>&1; then
    CERT_RENEWED=1
    rm -f "${TLS_DIR}/queue.pem" "${TLS_DIR}/queue-key.pem"
    env CAROOT="${MKCERT_CA_DIR}" mkcert \
        -cert-file "${TLS_DIR}/queue.pem" \
        -key-file "${TLS_DIR}/queue-key.pem" \
        "${SERVER_IP}" localhost 127.0.0.1
fi
chown root:root "${TLS_DIR}/queue.pem" "${TLS_DIR}/queue-key.pem"
chmod 0644 "${TLS_DIR}/queue.pem"
chmod 0600 "${TLS_DIR}/queue-key.pem"
openssl x509 -in "${TLS_DIR}/queue.pem" -noout -checkip "${SERVER_IP}" >/dev/null \
    || fail "выпущенный сертификат не содержит IP ${SERVER_IP}"
openssl verify -CAfile "${MKCERT_CA_DIR}/rootCA.pem" "${TLS_DIR}/queue.pem" >/dev/null \
    || fail "сертификат Nginx не подписан текущим локальным центром сертификации"

log "Настраиваю веб-доступ HTTP + HTTPS"
cat > /etc/nginx/sites-available/queue <<'EOF'
server {
    listen 80 default_server;
    listen [::]:80 default_server;

    listen 443 ssl default_server;
    listen [::]:443 ssl default_server;

    server_name _;

    ssl_certificate /etc/nginx/tls/queue.pem;
    ssl_certificate_key /etc/nginx/tls/queue-key.pem;
    ssl_protocols TLSv1.2 TLSv1.3;

    client_max_body_size 305m;

    location /grafana/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Prefix /grafana;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_hide_header X-Frame-Options;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_buffering off;
    }
}
EOF

rm -f /etc/nginx/sites-enabled/default
ln -sfn /etc/nginx/sites-available/queue /etc/nginx/sites-enabled/queue
nginx -t
systemctl enable --now nginx
systemctl reload nginx

if command -v ufw >/dev/null 2>&1 && ufw status | grep -q '^Status: active'; then
    ufw allow 'Nginx Full'
    ufw allow 3000/tcp
fi

log "Проверяю запуск"
for _ in {1..30}; do
    if curl --fail --silent --output /dev/null http://127.0.0.1:8000/login.html; then
        break
    fi
    sleep 1
done

if ! curl --fail --silent --output /dev/null http://127.0.0.1:8000/login.html; then
    journalctl -u "${SERVICE_NAME}" -n 30 --no-pager >&2
    fail "приложение не ответило. Выше показан журнал ошибки"
fi

HTTP_STATUS="$(curl --silent --noproxy '*' --output /dev/null --write-out '%{http_code}' \
    "http://${SERVER_IP}/login.html" || true)"
[[ "${HTTP_STATUS}" == "200" ]] \
    || fail "Nginx по HTTP вернул код ${HTTP_STATUS} вместо 200"

HTTPS_STATUS="$(curl --silent --insecure --noproxy '*' --output /dev/null --write-out '%{http_code}' \
    "https://${SERVER_IP}/login.html" || true)"
[[ "${HTTPS_STATUS}" == "200" ]] \
    || fail "Nginx по HTTPS вернул код ${HTTPS_STATUS} вместо 200"

GRAFANA_PROXY_STATUS="$(curl --silent --insecure --noproxy '*' --output /dev/null --write-out '%{http_code}' \
    "https://${SERVER_IP}/grafana/api/health" || true)"
[[ "${GRAFANA_PROXY_STATUS}" == "200" ]] \
    || fail "Grafana через HTTPS-прокси вернула код ${GRAFANA_PROXY_STATUS} вместо 200"

if ! openssl s_client -connect 127.0.0.1:443 -servername "${SERVER_IP}" </dev/null 2>/dev/null \
    | openssl x509 -noout -checkip "${SERVER_IP}" >/dev/null; then
    fail "Nginx отдаёт сертификат без IP ${SERVER_IP}"
fi

for _ in {1..30}; do
    if curl --fail --silent --output /dev/null http://127.0.0.1:3000/api/health; then
        break
    fi
    sleep 1
done

if ! curl --fail --silent --output /dev/null http://127.0.0.1:3000/api/health; then
    journalctl -u grafana-server -n 30 --no-pager >&2
    fail "Grafana не ответила. Выше показан журнал ошибки"
fi

if git -C "${SOURCE_DIR}" rev-parse --verify HEAD >/dev/null 2>&1; then
    SOURCE_REVISION="$(git -C "${SOURCE_DIR}" rev-parse --short=12 HEAD)"
    PYTHONPATH="${SOURCE_DIR}/deploy" python3 - "${APP_DIR}" "${SOURCE_REVISION}" <<'PY'
import sys
from pathlib import Path
from update_from_git import write_installed_revision

write_installed_revision(Path(sys.argv[1]), sys.argv[2])
PY
    chown "${APP_USER}:${APP_USER}" "${APP_DIR}/release.json"
fi

touch "${APP_DIR}/.queue-installed"
chown "${APP_USER}:${APP_USER}" "${APP_DIR}/.queue-installed"

if [[ -n "${INSTALL_USER}" && -n "${INSTALL_HOME}" ]]; then
    log "Открываю доступ пользователю ${INSTALL_USER}"
    usermod -aG "${APP_USER}" "${INSTALL_USER}"
    setfacl -m "u:${INSTALL_USER}:rx" "${APP_HOME}"
    setfacl -R -m "u:${INSTALL_USER}:rwX" "${APP_DIR}"
    find "${APP_DIR}" -type d -exec setfacl -m "d:u:${INSTALL_USER}:rwx" {} +

    install -o "${INSTALL_USER}" -g "${INSTALL_GROUP}" -m 0644 \
        "${ROOT_CA_EXPORT}" "${INSTALL_HOME}/queue-rootCA.pem"
    install -o "${INSTALL_USER}" -g "${INSTALL_GROUP}" -m 0600 \
        /root/queue-credentials.txt "${INSTALL_HOME}/queue-credentials.txt"
fi

printf '\n\033[1;32mУстановка завершена.\033[0m\n'
printf 'HTTP:       http://%s/login.html\n' "${SERVER_IP}"
printf 'HTTPS:      https://%s/login.html\n' "${SERVER_IP}"
printf 'Терминал:   http://%s/terminal.html\n' "${SERVER_IP}"
printf 'Табло:      http://%s/board.html?screen=media\n' "${SERVER_IP}"
printf 'Статистика: https://%s/grafana/d/queue-statistics/queue-statistics\n' "${SERVER_IP}"
if [[ -n "${INSTALL_USER}" && -n "${INSTALL_HOME}" ]]; then
    printf 'Проект:     %s (доступ для %s)\n' "${APP_DIR}" "${INSTALL_USER}"
    printf 'Открыть:    cd %s\n' "${APP_DIR}"
    printf 'Пароли:     %s/queue-credentials.txt\n' "${INSTALL_HOME}"
    printf 'Сертификат: %s/queue-rootCA.pem\n' "${INSTALL_HOME}"
    printf '\nКоманда для любого Windows-компьютера (источник — эта ВМ):\n'
    printf 'scp %s@%s:%s/queue-rootCA.pem .\\queue-rootCA.pem\n' \
        "${INSTALL_USER}" "${SERVER_IP}" "${INSTALL_HOME}"
    printf 'certutil -addstore -f Root .\\queue-rootCA.pem\n'
else
    printf 'Пароли:     sudo cat /root/queue-credentials.txt\n'
    printf 'Сертификат: %s\n' "${ROOT_CA_EXPORT}"
fi
printf 'Управление сервером: sudo qronion\n'
printf 'Резервная копия: %s\n' "${BACKUP_DIR}"
printf 'Grafana:    просмотр без пароля; редактирование через admin\n'
if [[ ${CA_CREATED} -eq 1 ]]; then
    if [[ -n "${INSTALL_USER}" && -n "${INSTALL_HOME}" ]]; then
        printf '\033[1;33mУстановите %s/queue-rootCA.pem на каждый компьютер и табло.\033[0m\n' "${INSTALL_HOME}"
    else
        printf '\033[1;33mУстановите %s на каждый компьютер и табло.\033[0m\n' "${ROOT_CA_EXPORT}"
    fi
elif [[ ${CERT_RENEWED} -eq 1 ]]; then
    printf 'Сертификат сервера обновлён для IP %s; корневой сертификат не изменился.\n' "${SERVER_IP}"
fi
if [[ ${FIRST_INSTALL} -ne 1 ]]; then
    printf 'Настройки и пользовательские данные сохранены.\n'
fi
