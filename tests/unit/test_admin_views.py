from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def _read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_workplaces_and_operators_share_one_operational_screen():
    app_source = _read("web/js/admin/app.js")
    view_source = _read("web/js/admin/views/windows.view.js")
    css_source = _read("web/css/admin/workplaces.css")

    assert 'label: "Рабочие места и операторы"' in app_source
    assert 'import { mount as mountOperators }' not in app_source
    assert 'operators: {' not in app_source
    assert 'operators: "windows"' in app_source
    assert 'ctx.api.request("/operators/")' in view_source
    assert 'ctx.api.json(`/windows/${windowId}/operator`' in view_source
    assert "Назначения" in view_source
    assert "Не назначен" in view_source
    assert 'action: "unassign"' in view_source
    assert 'class="workplace-row"' in view_source
    assert ".admin-table" in css_source
    assert "min-width: 780px" in css_source
    assert "white-space: normal;" in css_source
    assert 'button("Добавить оператор",' not in view_source
    assert 'button("Добавить оператора", {variant: "secondary"' in view_source
    assert "показаны одним связанным списком" not in view_source
    assert "@media (max-width: 720px)" in css_source
    assert 'ctx.ui.sortHeader("Рабочее место", "window_name", sortState)' in view_source
    assert 'ctx.ui.sortHeader("Оператор", "operator_name", sortState)' in view_source
    assert "function buildLinkedRows()" in view_source
    assert 'data-action="assign-window"' in view_source


def test_admin_navigation_order_groups_and_long_label_layout():
    app_source = _read("web/js/admin/app.js")
    shell_css = _read("web/css/admin/shell.css")

    services_position = app_source.index("    services: {")
    windows_position = app_source.index("    windows: {")
    tickets_position = app_source.index("    tickets: {")
    assert services_position < windows_position < tickets_position

    map_route = app_source.split("    map: {", 1)[1].split("    },", 1)[0]
    stats_route = app_source.split("    stats: {", 1)[1].split("    },", 1)[0]
    assert 'group: "Общее"' in map_route
    assert 'group: "Общее"' in stats_route

    label_styles = shell_css.split("body.admin-page .admin-nav-label", 1)[1].split("}", 1)[0]
    assert "min-width: 0;" in label_styles
    assert "text-align: left;" in label_styles


def test_operator_admin_table_shows_visible_id_and_keeps_internal_id():
    source = _read("web/js/admin/views/operators.view.js")

    assert "<td>${operator.id}</td>" in source
    assert 'ctx.ui.sortHeader("ID", "id", sortState)' in source
    assert '["id", "name", "login", "window", "auto_call"].includes(parsed.key)' in source
    assert "id: operator.id" in source
    assert "operators.find(item => item.id === Number(button.dataset.id))" in source


def test_workplace_cards_show_ids_and_support_sorting():
    source = _read("web/js/admin/views/windows.view.js")

    assert 'class="workplace-meta">ID ${windowItem.id}</small>' in source
    assert 'data-window-id="${windowItem.id}"' in source
    assert 'action: "edit-window", id: windowItem.id' in source
    assert "windows.find(item => item.id === id)" in source
    assert 'ctx.ui.sortHeader("Рабочее место", "window_name", sortState)' in source
    assert 'ctx.ui.sortHeader("Статус", "status", sortState)' in source
    assert 'ctx.ui.sortHeader("Услуги", "services", sortState)' in source


def test_window_admin_loads_hidden_terminal_services_for_internal_assignment():
    modern_source = _read("web/js/admin/views/windows.view.js")
    legacy_source = _read("web/js/admin/windows.js")
    map_source = _read("web/js/admin/map.js")

    assert 'ctx.api.request("/services/?include_hidden=true")' in modern_source
    assert "fetchJSON(`${API}/services/?include_hidden=true`)" in legacy_source
    assert "fetchJSON(`${API}/services/?limit=500&include_hidden=true`)" in map_source


def test_service_admin_list_hides_visible_id_but_keeps_data_id():
    source = _read("web/js/admin/views/services.view.js")

    assert "admin-service-id" not in source
    assert 'data-service-id="${service.id}"' in source
    assert "draggedServiceId = Number(item.dataset.serviceId)" in source


def test_service_statuses_use_clear_russian_labels_with_terminal_context():
    source = _read("web/js/admin/views/services.view.js")

    assert '"Предоставляется"' in source
    assert 'ctx.ui.switchField("status_active", service.status === "active")' in source
    assert '"Показывается на терминале"' in source
    assert '"Скрыта на терминале"' in source


def test_services_use_separate_short_create_dialogs_without_availability_dashboard():
    source = _read("web/js/admin/views/services.view.js")

    assert 'button("Добавить услугу", {variant: "primary", action: "create-service"})' in source
    assert 'button("Добавить группу", {variant: "secondary", action: "create-group"})' in source
    assert "function openCreateServiceDialog()" in source
    assert "function openCreateGroupDialog()" in source
    assert 'ctx.ui.select("service_group_id", groupOptions(), "")' in source
    assert 'name="service_ids"' in source
    assert "admin-stats-grid" not in source
    assert "statCard(" not in source
    assert "add-inline-group" not in source


def test_service_groups_support_drag_reordering_and_accessible_button_fallback():
    source = _read("web/js/admin/views/services.view.js")

    assert 'class="admin-group-drag-handle" draggable="true"' in source
    assert "async function persistGroupOrder()" in source
    assert 'ctx.api.json("/service-groups/order"' in source
    assert 'action: "group-up"' in source
    assert 'action: "group-down"' in source
    drag_over = source[source.index("function handleDragOver"):source.index("async function handleDrop")]
    assert drag_over.index("event.preventDefault()") < drag_over.index("target === dragged")


def test_service_group_drag_handle_is_centered_beside_name_and_count():
    source = _read("web/js/admin/views/services.view.js")
    css = _read("web/css/admin/services.css")

    assert 'class="admin-service-group-heading"' in source
    assert 'class="admin-service-group-copy"' in source
    heading_styles = css.split("body.admin-page .admin-service-group-heading", 1)[1].split("}", 1)[0]
    assert "display: flex;" in heading_styles
    assert "align-items: center;" in heading_styles
    count_styles = css.split("body.admin-page .admin-service-group-count", 1)[1].split("}", 1)[0]
    assert "display: block;" in count_styles
    assert "margin: 4px 0 0;" in count_styles


def test_admin_views_use_click_sorting_with_direction_toggle():
    source = _read("web/js/admin/views/operators.view.js")
    assert 'button.dataset.action === "sort"' in source
    assert 'sortState.key === key && sortState.direction === "asc" ? "desc" : "asc"' in source

    workplaces = _read("web/js/admin/views/windows.view.js")
    assert 'button.dataset.action === "sort"' in workplaces
    assert 'sortState.key === key && sortState.direction === "asc" ? "desc" : "asc"' in workplaces


def test_admin_views_persist_sort_state():
    source = _read("web/js/admin/views/operators.view.js")
    assert 'const sortStorageKey = "admin.operators.sort"' in source
    assert "sortState = loadSortState(sortState)" in source
    assert "saveSortState(sortState)" in source
    assert "localStorage.setItem(sortStorageKey, JSON.stringify(state))" in source

    workplaces = _read("web/js/admin/views/windows.view.js")
    assert 'const sortStorageKey = "admin.workplaces.sort"' in workplaces
    assert "sortState = loadSortState(sortState)" in workplaces
    assert "localStorage.setItem(sortStorageKey, JSON.stringify(sortState))" in workplaces


def test_table_helper_renders_sortable_headers():
    source = _read("web/js/admin/ui.js")

    assert "export function sortHeader" in source
    assert "headers.map(renderTableHeader)" in source
    assert 'data-action="sort"' in source
    assert 'data-sort-key="${escapeHtml(header.sortKey)}"' in source


def test_media_view_uses_compact_cards_and_opens_video_in_new_tab():
    source = _read("web/js/admin/views/media.view.js")
    css = _read("web/css/admin/media.css")

    assert 'class="admin-media-card admin-media-card-${status}${ready && !included ? " admin-media-card-inactive" : ""}"' in source
    assert 'target="_blank" rel="noopener"' in source
    assert "Открыть видео в новой вкладке" in source
    assert '<video src="${framePath}" preload="metadata" muted playsinline' in source
    assert 'const framePath = `${webPath}#t=0.1`' in source
    assert "admin-media-card-inactive" in source
    assert "admin-media-preview-status" not in source
    assert 'data-action="toggle"' in source
    assert "Удалить с сервера" in source
    assert ".admin-media-card" in css
    assert "repeat(auto-fit, minmax(320px, 1fr))" in css
    assert "margin-top: auto" in css
    assert "filter: grayscale(1)" in css


def test_media_navigation_is_part_of_system_group():
    source = _read("web/js/admin/app.js")
    media_route = source[source.index("media: {"):source.index("map: {")]

    assert 'group: "Система"' in media_route
    assert 'group: "Контент"' not in source


def test_media_playlist_toggle_updates_only_its_card():
    source = _read("web/js/admin/views/media.view.js")
    toggle_source = source[source.index("async function toggle(input)"):source.index("async function deleteFile")]

    assert "updatePlaylistCard(card, checked)" in toggle_source
    assert 'card.classList.toggle("admin-media-card-inactive", !included)' in toggle_source
    assert "await render()" not in toggle_source
    assert "input.checked = !checked" in toggle_source


def test_media_playlist_switch_comes_before_its_label():
    source = _read("web/js/admin/views/media.view.js")
    switch_source = source[source.index("function renderPlaylistSwitch"):source.index("function renderEmptyState")]

    assert switch_source.index('type="checkbox"') < switch_source.index("<span>${included ?")


def test_media_upload_uses_single_entry_button_and_dialog():
    source = _read("web/js/admin/views/media.view.js")
    css = _read("web/css/admin/media.css")

    assert 'button("Загрузить файл", {variant: "primary", action: "open-upload"})' in source
    assert '<h2 id="media-section-title">' not in source
    assert 'aria-label="Управление видеофайлами"' in source
    assert 'dialog.className = "admin-media-dialog"' in source
    assert 'name="display_name"' in source
    assert 'name="process_video" checked' in source
    assert '<option value="custom">Свои параметры — для опытных</option>' in source
    assert 'name="custom_ffmpeg_command"' in source
    assert 'ffmpeg -i "{input}" "{output}"' in source
    assert ".admin-media-custom-command[hidden] { display: none; }" in css
    assert "data-upload-result" in source


def test_sorting_layout_has_stable_column_widths():
    source = _read("web/css/admin/shell.css") + _read("web/css/admin/services.css")

    assert "table-layout: fixed;" in source
    assert "flex: 0 0 12px;" in source
    assert "grid-template-columns: 24px minmax(180px, 1fr) 165px 140px;" in source
    assert ".admin-service-item .admin-badge" in source
    assert "width: 100%;" in source
    assert "white-space: nowrap;" in source


def test_settings_view_renders_and_saves_board_ticker_text():
    source = _read("web/js/admin/views/settings.view.js")

    assert "setting-board-ticker-text" in source
    assert "board_ticker_text" in source
    assert "board_ticker_messages" in source
    assert "collectBoardTickerMessages" in source
    assert "add-ticker-message" in source
    assert "delete-ticker-message" in source
    assert 'document.getElementById("setting-board-ticker-text").value.trim()' in source


def test_settings_view_renders_and_saves_ticket_reason_options():
    modern_source = _read("web/js/admin/views/settings.view.js")
    legacy_source = _read("web/js/admin/settings.js")

    for source in (modern_source, legacy_source):
        assert "Причины отмены" in source
        assert "Причины отложения" in source
        assert "cancel_reason_options" in source
        assert "defer_reason_options" in source
        assert "collectReasonOptions" in source
        assert "deleteReasonOption" in source or "delete-reason-option" in source


def test_settings_view_renders_and_saves_ticket_print_scale_percent():
    source = _read("web/js/admin/views/settings.view.js")
    terminal = _read("web/js/terminal.js")
    terminal_html = _read("web/terminal.html")

    assert "ticket_print_scale_percent" in source
    assert "validTicketPrintScale" in source
    assert "normalizeTicketPrintScalePercent" in terminal
    assert "--ticket-print-scale" in terminal
    assert "scale(var(--ticket-print-scale, 0.94))" in terminal_html


def test_terminal_services_are_paginated_to_fit_the_viewport():
    terminal = _read("web/js/terminal.js")
    terminal_html = _read("web/terminal.html")
    terminal_css = _read("web/css/terminal.css")

    assert "buildServicePages" in terminal
    assert "container.scrollHeight <= container.clientHeight" in terminal
    assert 'window.addEventListener("resize"' in terminal
    assert 'id="service-page-prev"' in terminal_html
    assert 'id="service-page-next"' in terminal_html
    assert "height: 100dvh" in terminal_css
    assert "overflow: hidden" in terminal_css


def test_settings_view_renders_and_saves_auto_call_settings():
    modern_source = _read("web/js/admin/views/settings.view.js")
    legacy_source = _read("web/js/admin/settings.js")

    for source in (modern_source, legacy_source):
        assert "auto_call_enabled" in source
        assert "auto_call_delay_seconds" in source

    assert 'min=\\"0\\"' in modern_source
    assert 'max=\\"600\\"' in modern_source
    assert "validAutoCallDelay" in modern_source


def test_global_auto_call_settings_are_in_rules_not_operators():
    operators_source = _read("web/js/admin/views/operators.view.js")
    settings_source = _read("web/js/admin/views/settings.view.js")

    assert "operator-auto-call-form" not in operators_source
    assert 'ctx.api.request("/admin/settings")' not in operators_source
    queue_section = settings_source[settings_source.index("function renderQueueSection"):settings_source.index("function renderBoardSection")]
    assert 'switchField("auto_call_enabled"' in queue_section
    assert 'input("auto_call_delay_seconds"' in queue_section

def test_settings_views_do_not_expose_legacy_queue_modes():
    for relative_path in (
        "web/js/admin/settings.js",
        "web/js/admin/views/settings.view.js",
    ):
        source = (ROOT / relative_path).read_text(encoding="utf-8")
        assert "queue_mode" not in source
        assert "dynamic_operator_distribution" not in source
        assert "Режим очереди" not in source

def test_services_view_uses_drag_order_without_click_sorting():
    source = _read("web/js/admin/views/services.view.js")

    assert "admin.services.sort" not in source
    assert 'data-action="sort"' not in source
    assert "sortServices(" not in source
    assert "services.filter(service => service.service_group_id === group.id)" in source
    assert "persistDraggedOrder" in source


def test_settings_view_does_not_show_template_hint_caption():
    source = _read("web/js/admin/views/settings.view.js")

    assert "В шаблонах должны остаться параметры" not in source


def test_admin_settings_are_split_into_system_routes():
    app_source = _read("web/js/admin/app.js")
    settings_source = _read("web/js/admin/views/settings.view.js")

    assert 'terminalSettings:' in app_source
    assert 'boardSettings:' in app_source
    assert 'queueSettings:' in app_source
    assert 'mount: context => mountSettings(context, "terminal")' in app_source
    assert 'mount: context => mountSettings(context, "board")' in app_source
    assert 'mount: context => mountSettings(context, "queue")' in app_source
    assert 'export async function mount(context, section = "terminal")' in settings_source
    assert 'if (activeSection === "terminal") applyTerminalForm(payload, data)' in settings_source
    assert 'if (activeSection === "queue") applyQueueForm(payload, data)' in settings_source
    assert 'if (activeSection === "board") applyBoardForm(payload, data)' in settings_source


def test_admin_settings_do_not_repeat_page_heading_inside_card():
    settings_source = _read("web/js/admin/views/settings.view.js")
    settings_css = _read("web/css/admin/settings.css")

    assert '<h2>Терминал</h2>' not in settings_source
    assert '<h2>Оператор и очередь</h2>' not in settings_source
    assert '<h2>Табло и озвучка</h2>' not in settings_source
    assert "grid-template-columns: minmax(0, 1fr);" in settings_css
    assert "grid-template-columns: repeat(2, minmax(0, 1fr));" in settings_css
    assert "admin-settings-grid" in settings_source


def test_admin_settings_nested_rows_stay_compact_and_save_is_pinned():
    settings_css = _read("web/css/admin/settings.css")

    assert ".admin-field:has(> .admin-switch)" in settings_css
    assert "[data-reason-option-row]" in settings_css
    assert "[data-ticker-message-row]" in settings_css
    assert "grid-template-columns: 44px minmax(0, 1fr) auto;" in settings_css
    assert "position: fixed;" in settings_css
    assert "bottom: 24px;" in settings_css


def test_admin_shell_has_only_one_vertical_scroll_container():
    html_source = _read("web/admin.html")
    shell_css = _read("web/css/admin/shell.css")
    responsive_css = _read("web/css/admin/feedback-map-responsive.css")

    assert '<html lang="ru" class="admin-document">' in html_source
    assert "html.admin-document" in shell_css
    assert "height: 100dvh;" in shell_css
    assert "overflow-y: hidden;" in responsive_css
    assert "overflow-y: auto;" in responsive_css


def test_admin_notifications_are_centered_at_the_top():
    responsive_css = _read("web/css/admin/feedback-map-responsive.css")
    toast_styles = responsive_css.split("body.admin-page .admin-toast-host", 1)[1].split("}", 1)[0]

    assert "top: 22px;" in toast_styles
    assert "left: 50%;" in toast_styles
    assert "transform: translateX(-50%);" in toast_styles
    assert "right:" not in toast_styles
    assert "bottom:" not in toast_styles


def test_admin_sidebar_is_unbranded_collapsible_and_keeps_desktop_preference():
    app_source = _read("web/js/admin/app.js")
    shell_css = _read("web/css/admin/shell.css")

    assert 'class="admin-brand"' not in app_source
    assert "Qronion" not in app_source
    assert 'const SIDEBAR_STORAGE_KEY = "admin-sidebar-collapsed"' in app_source
    assert "localStorage.setItem(SIDEBAR_STORAGE_KEY" in app_source
    assert 'aria-label="${route.label}" title="${route.label}"' in app_source
    assert '<div class="admin-sidebar-header">' in app_source
    assert 'class="admin-menu-button admin-mobile-menu-button"' in app_source
    assert 'root.querySelectorAll(".admin-menu-button")' in app_source
    assert "Система доступна" not in app_source
    assert "admin-sidebar-footer" not in app_source
    sidebar_header = shell_css.split("body.admin-page .admin-sidebar-header", 1)[1].split("}", 1)[0]
    assert "justify-content: center;" in sidebar_header
    menu_icon = shell_css.split("body.admin-page .admin-menu-button .admin-nav-icon", 1)[1].split("}", 1)[0]
    assert "left: 50%;" in menu_icon
    assert "transform: translate(-50%, -50%);" in menu_icon


def test_admin_system_routes_follow_operational_order():
    app_source = _read("web/js/admin/app.js")

    route_positions = [
        app_source.index("terminalSettings:"),
        app_source.index("boardSettings:"),
        app_source.index("media:"),
        app_source.index("queueSettings:"),
        app_source.index("map:"),
        app_source.index("stats:"),
    ]
    assert route_positions == sorted(route_positions)
    assert 'label: "Правила"' in app_source
    assert 'description: "Правила работы операторов и обработки талонов"' in app_source


def test_admin_statistics_embed_grafana_with_fallback_actions():
    app_source = _read("web/js/admin/app.js")
    stats_source = _read("web/js/admin/views/stats.view.js")
    admin_css = _read("web/css/admin.css")
    stats_css = _read("web/css/admin/stats.css")

    stats_route = app_source.split("stats: {", 1)[1].split("}", 1)[0]
    assert "externalUrl" not in stats_route
    assert "unmount: unmountStats" in stats_route
    assert "window.open" not in stats_source
    assert 'id="admin-stats-frame"' in stats_source
    assert "Открыть в Grafana" in stats_source
    assert "Загружаем статистику" in stats_source
    assert "Статистика сейчас недоступна" in stats_source
    assert 'data-action="retry-stats"' not in stats_source
    assert 'action: "retry-stats"' in stats_source
    assert '@import url("./admin/stats.css");' in admin_css
    assert ".admin-stats-frame-wrap" in stats_css
    assert "prefers-reduced-motion: reduce" in stats_css


def test_grafana_is_embedded_through_same_origin_https_proxy():
    config_source = _read("web/js/config.js")
    installer_source = _read("deploy/install.sh")

    assert "${window.location.origin}/grafana/d/queue-statistics/queue-statistics" in config_source
    assert "location /grafana/" in installer_source
    assert "proxy_pass http://127.0.0.1:3000;" in installer_source
    assert "proxy_hide_header X-Frame-Options;" in installer_source
    assert "Environment=GF_SECURITY_ALLOW_EMBEDDING=true" in installer_source
    assert "Environment=GF_SERVER_ROOT_URL=https://${SERVER_IP}/grafana/" in installer_source
    assert "Environment=GF_SERVER_SERVE_FROM_SUB_PATH=true" in installer_source
    assert '"https://${SERVER_IP}/grafana/api/health"' in installer_source


def test_focused_grafana_embed_migration_is_available():
    migration = _read("deploy/configure_grafana_embed.sh")

    assert "GF_SECURITY_ALLOW_EMBEDDING=true" in migration
    assert "GF_SERVER_SERVE_FROM_SUB_PATH=true" in migration
    assert "GF_SERVER_HTTP_ADDR=127.0.0.1" in migration
    assert "GF_SERVER_HTTP_PORT=3000" in migration
    assert "location /grafana/" in migration
    assert "proxy_pass http://127.0.0.1:3000;" in migration
    assert "nginx -t" in migration
    assert "journalctl -u grafana-server" in migration


def test_board_status_moves_with_ticker_offset():
    board_css = _read("web/css/board.css")
    media_css = _read("web/css/board-media/main.css")
    lite_css = _read("web/css/board-media/lite.css")

    assert "--board-ticker-offset: 0px;" in board_css
    assert "bottom: calc(10px + var(--board-ticker-offset));" in board_css
    assert "--board-ticker-offset: 0px;" in media_css
    assert "bottom: calc(10px + var(--board-ticker-offset));" in media_css
    assert "--lite-ticker-height: 76px;" in lite_css
    assert "--board-ticker-offset: var(--lite-ticker-height);" in lite_css


def test_lite_media_board_reserves_ticker_height():
    lite_css = _read("web/css/board-media/lite.css")

    assert 'grid-template-areas:\n        "header"\n        "main"\n        "ticker";' in lite_css
    assert "grid-template-rows: var(--lite-header-height) minmax(0, 1fr) var(--lite-ticker-height);" in lite_css
    assert "position: fixed !important;" in lite_css
    assert "bottom: 0 !important;" in lite_css
    assert "grid-template-columns: minmax(0, 1fr) minmax(0, var(--lite-board-width)) !important;" in lite_css
    assert "grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) !important;" in lite_css
    assert "overflow: hidden;" in lite_css


def test_global_credentials_move_with_ticker_offset():
    source = _read("web/css/base.css")

    assert "body::after" in source
    assert "bottom: calc(12px + var(--board-ticker-offset, 0px));" in source
    assert "bottom: calc(10px + var(--board-ticker-offset, 0px));" in source


def test_board_ticker_uses_seamless_repeated_segment():
    script = _read("web/js/board-ticker.js")
    board_css = _read("web/css/board.css")
    media_css = _read("web/css/board-media/main.css")

    assert "repeatCount = Math.max(2, Math.ceil(tickerWidth / setWidth) + 2)" in script
    assert "track.style.setProperty(\"--board-ticker-distance\"" in script
    assert "track.style.setProperty(\"--board-ticker-duration\"" in script
    assert "i < repeatCount * 2" in script
    assert "var(--board-ticker-distance" in board_css
    assert "translateX(-50%)" not in board_css
    assert "var(--board-ticker-distance" in media_css
    assert "translateX(-50%)" not in media_css


def test_board_ticker_splits_multiline_messages_with_separator():
    script = _read("web/js/board-ticker.js")
    board_css = _read("web/css/board.css")
    media_css = _read("web/css/board-media/main.css")

    assert ".split(/\\s+\\|\\s+|\\r?\\n/)" in script
    assert ".filter(Boolean)" in script
    assert "tickerMessages = parseTickerMessages(value)" in script
    assert "appendMessageSet(track, messages" in script
    assert "board-ticker__text--segment-end" in script
    assert 'content: "|";' in board_css
    assert 'content: "";' not in board_css
    assert "margin-left: 72px;" in board_css
    assert 'content: "|";' in media_css
    assert 'content: "";' not in media_css


def test_admin_tickets_use_manual_refresh_and_readable_window_names():
    source = _read("web/js/admin/views/tickets.view.js")

    assert "↻ Обновить таблицу" in source
    assert 'button.dataset.action === "refresh"' in source
    assert "admin:ticket-updated" not in source
    assert "ticket.target_window_name" in source
    assert "ticket.target_window_id" not in source
    assert "ticket.root_ticket_number" in source
    assert "ticket.root_ticket_id" not in source
    assert 'class="admin-ticket-action-list"' in source

    styles = _read("web/css/admin/tickets.css")
    assert "max-width: 100%;" in styles
    assert ".admin-ticket-page .admin-table-scroll" in styles
    assert "overflow-x: auto;" in styles
    assert ".admin-ticket-action-list" in styles
    assert ".admin-ticket-actions { display: flex" not in styles
