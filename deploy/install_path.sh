# Shared installation path for server commands.
qronion_install_path() {
    local preferred=/home/qronion legacy=/home/queue/queue_project
    if [[ ! -f "${preferred}/main.env" && -f "${legacy}/main.env" ]]; then
        printf '%s\n' "${legacy}"
    else
        printf '%s\n' "${preferred}"
    fi
}
