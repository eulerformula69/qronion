#!/usr/bin/env bash
set -Eeuo pipefail
if [[ ${EUID} -ne 0 ]]; then
    printf 'Запустите: sudo bash qronion-setup.sh\n' >&2
    exit 1
fi
if [[ ! -t 0 ]]; then
    printf 'Сначала скачайте файл, затем запустите его в терминале.\n' >&2
    exit 1
fi
source /etc/os-release
if [[ ${ID:-} != ubuntu || ${VERSION_ID:-} != 24.04 || $(uname -m) != x86_64 ]]; then
    printf 'Нужна Ubuntu Server 24.04 LTS, x86-64.\n' >&2
    exit 1
fi
if [[ -f /home/queue/queue_project/deploy/menu.sh ]]; then
    exec bash /home/queue/queue_project/deploy/menu.sh
fi
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y git ca-certificates
source_dir="$(mktemp -d /tmp/qronion-setup.XXXXXXXX)"
trap 'rm -rf -- "${source_dir}"' EXIT
printf '\nСкачиваю Qronion…\n'
git clone --depth 1 --branch main \
    https://github.com/eulerformula69/electronicqueue.git "${source_dir}/project"
bash "${source_dir}/project/deploy/menu.sh"
