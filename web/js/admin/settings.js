import { fetchJSON } from "./api.js";
import { resetOpened, setActiveTab, setForm, setTable } from "./dom.js";

const API = CONFIG.API_URL;
const GRAFANA = CONFIG.GRAFANA_URL;
let currentSettings = {};

export async function loadExtraSettings() {
	resetOpened();
    document.getElementById("form").style.display = "block";
    document.getElementById("table").style.display = "none";
    setTable("");

    const statsContainer = document.getElementById("stats-container");
    if (statsContainer) statsContainer.remove();

    setActiveTab("tab-settings");

    const settings = await fetchJSON(`${API}/admin/settings`);
    if (!settings) return;
    currentSettings = settings;
    const tickerMessages = getBoardTickerMessages(settings);
    const cancelReasonOptions = getReasonOptions(settings, "cancel");
    const deferReasonOptions = getReasonOptions(settings, "defer");

    setForm(`
        <div class="form settings-form">
            <h3 class="settings-title">Общее</h3>

            <section class="settings-section">
                <h4 class="settings-section-title">Терминал</h4>
                <label class="settings-checkbox-row">
                    <input type="checkbox" id="setting-print-ticket" ${settings.print_ticket ? "checked" : ""}>
                    Печатать талон на терминале
                </label>

                <label class="settings-checkbox-row">
                    <input type="checkbox" id="setting-show-print-badge" ${settings.show_print_badge ? "checked" : ""}>
                    Показывать режим печати на терминале
                </label>
                <label class="settings-field-row">
                    <span class="settings-label">Размер печатного талона, %:</span>
                    <input
                        type="number"
                        id="setting-ticket-print-scale"
                        class="settings-input"
                        min="50"
                        max="150"
                        step="1"
                        value="${settings.ticket_print_scale_percent || 94}"
                    >
                </label>
                <label class="settings-field-row">
                    <span class="settings-label">Услуги без активных операторов на терминале:</span>
                    <select id="setting-unavailable-services-mode" class="settings-select settings-select-wide">
                        <option value="hide" ${settings.hide_services_without_online_operators ? "selected" : ""}>Скрывать услуги</option>
                        <option value="show_inactive" ${!settings.hide_services_without_online_operators ? "selected" : ""}>Показывать как неактивные</option>
                    </select>
                </label>

                <label class="settings-field-row">
                    <span class="settings-label">Показ номера с печатью талона, секунд:</span>
                    <input
                        type="number"
                        id="setting-ticket-notice-duration-printed"
                        class="settings-input"
                        min="1"
                        max="300"
                        value="${settings.ticket_notice_duration_printed_seconds || 7}"
                    >
                </label>

                <label class="settings-field-row">
                    <span class="settings-label">Текст на терминале, когда талон печатается:</span>
                    <textarea
                        id="setting-ticket-notice-printed-text"
                        class="settings-input settings-textarea"
                        maxlength="500"
                    >${escapeHtml(settings.ticket_notice_printed_text || "Ваш номер: <number>")}</textarea>
                </label>

                <label class="settings-field-row">
                    <span class="settings-label">Показ номера без печати талона, секунд:</span>
                    <input
                        type="number"
                        id="setting-ticket-notice-duration-unprinted"
                        class="settings-input"
                        min="1"
                        max="300"
                        value="${settings.ticket_notice_duration_unprinted_seconds || 45}"
                    >
                </label>

                <label class="settings-field-row">
                    <span class="settings-label">Текст на терминале, когда талон не печатается:</span>
                    <textarea
                        id="setting-ticket-notice-unprinted-text"
                        class="settings-input settings-textarea"
                        maxlength="500"
                    >${escapeHtml(settings.ticket_notice_unprinted_text || "Пожалуйста, запомните свой номер:\n<number>")}</textarea>
                </label>

                <small class="settings-hint">
                    В обоих текстах оставьте <b>&lt;number&gt;</b> - туда подставится номер талона.
                </small>
            </section>

            <section class="settings-section">
                <h4 class="settings-section-title">Оператор</h4>
                <label class="settings-field-row">
                    <span class="settings-label">Статус окна по умолчанию при входе оператора:</span>
                    <select id="setting-default-operator-status" class="settings-select">
                        <option value="online" ${settings.default_operator_status === "online" ? "selected" : ""}>online</option>
                        <option value="break" ${settings.default_operator_status === "break" ? "selected" : ""}>break</option>
                        <option value="offline" ${settings.default_operator_status === "offline" ? "selected" : ""}>offline</option>
                    </select>
                </label>

                <label class="settings-field-row">
                    <span class="settings-label">Если оператор вышел с активным тикетом:</span>
                    <select id="setting-active-ticket-on-logout" class="settings-select settings-select-wide">
                        <option value="return_to_queue" ${settings.active_ticket_on_operator_logout === "return_to_queue" ? "selected" : ""}>Вернуть обратно в очередь</option>
                        <option value="keep_with_operator" ${settings.active_ticket_on_operator_logout === "keep_with_operator" ? "selected" : ""}>Оставить за оператором</option>
                    </select>
                </label>

                <label class="settings-field-row">
                    <span class="settings-label">Минимальная длительность обслуживания, секунд:</span>
                    <input id="setting-called-ticket-min-wait" class="settings-input" type="number" min="0" max="3600" step="1" value="${settings.called_ticket_min_wait_seconds ?? 180}">
                </label>
                <label class="settings-field-row">
                    <span class="settings-label">Порог быстрого обслуживания, минут (0 — отключить):</span>
                    <input id="setting-short-service-warning-minutes" class="settings-input" type="number" min="0" max="60" step="1" value="${settings.short_service_warning_minutes ?? 5}">
                </label>
                <label class="settings-field-row">
                    <span class="settings-label">Максимум отложенных талонов у оператора:</span>
                    <input id="setting-max-deferred-tickets" class="settings-input" type="number" min="1" max="50" step="1" value="${settings.max_deferred_tickets_per_operator ?? 3}">
                </label>
                <label class="settings-field-row">
                    <span class="settings-label">Максимум перенаправлений одного талона:</span>
                    <input id="setting-max-ticket-redirects" class="settings-input" type="number" min="1" max="20" step="1" value="${settings.max_ticket_redirects ?? 3}">
                </label>
                <label class="settings-field-row"><span class="settings-label">Балансировка автовызова:</span><input id="setting-auto-call-balance-enabled" type="checkbox" ${settings.auto_call_balance_enabled !== false ? "checked" : ""}></label>
                <label class="settings-field-row"><span class="settings-label">Максимум талонов для балансировки:</span><input id="setting-auto-call-balance-threshold" class="settings-input" type="number" min="1" max="100" value="${settings.auto_call_balance_queue_threshold ?? 3}"></label>
                <label class="settings-field-row"><span class="settings-label">Минимум свободных операторов:</span><input id="setting-auto-call-balance-min-operators" class="settings-input" type="number" min="2" max="100" value="${settings.auto_call_balance_min_free_operators ?? 2}"></label>
                <label class="settings-field-row"><span class="settings-label">Отмена на табло, секунд:</span><input id="setting-cancelled-board-seconds" class="settings-input" type="number" min="0" max="3600" value="${settings.cancelled_ticket_board_display_seconds ?? 60}"></label>
                <label class="settings-field-row"><span class="settings-label">Текст отмены на табло:</span><input id="setting-cancelled-board-template" class="settings-input settings-input-wide" maxlength="500" value="${escapeHtml(settings.cancelled_ticket_board_message_template || "⚠ Талон <number>: вызов отменён оператором окна <window>. Вернулись? Сообщите номер оператору.")}"></label>
            </section>
			
		<section class="settings-section">
            <div class="settings-field-row">
                <span class="settings-label">Причины отмены:</span>
                <div id="setting-cancel-reason-options">
                    ${renderReasonOptions(cancelReasonOptions, "cancel")}
                </div>
                <button type="button" onclick="addReasonOption('cancel')">Добавить причину отмены</button>
            </div>
            <div class="settings-field-row">
                <span class="settings-label">Причины отложения:</span>
                <div id="setting-defer-reason-options">
                    ${renderReasonOptions(deferReasonOptions, "defer")}
                </div>
                <button type="button" onclick="addReasonOption('defer')">Добавить причину отложения</button>
            </div>
		</section>


        <section class="settings-section">
            <h4 class="settings-section-title">Табло и озвучка</h4>

            <label class="settings-field-row">
                <span class="settings-label">Сообщение вызова / озвучки:</span>
                <input
                    id="setting-call-message-template"
                    class="settings-input settings-input-wide"
                    value="${settings.call_message_template || "Талон <number> подойдите к окну <window>"}"
                >
            </label>

            <small class="settings-hint">
                Можно менять любой текст, но оставьте <b>&lt;number&gt;</b> и <b>&lt;window&gt;</b>.
                Например: <b>Талон &lt;number&gt;, подойдите к окну &lt;window&gt;</b>
            </small>

            <label class="settings-field-row">
                <span class="settings-label">Отображение вызванного талона на табло:</span>
                <input
                    id="setting-board-ticket-template"
                    class="settings-input settings-input-wide"
                    value="${settings.board_ticket_template || "Билет <number> -> окно <window>"}"
                >
            </label>

            <small class="settings-hint">
                Например: <b>&lt;number&gt; → &lt;window&gt;</b> или <b>Билет &lt;number&gt; / окно &lt;window&gt;</b>
            </small>

            <input type="hidden" id="setting-board-ticker-text" value="${escapeHtml(settings.board_ticker_text || "")}">
            <div class="settings-field-row">
                <span class="settings-label">Тексты бегущей строки на табло:</span>
                <div id="setting-board-ticker-messages">
                    ${renderBoardTickerMessages(tickerMessages)}
                </div>
                <button type="button" onclick="addBoardTickerMessage()">Добавить сообщение</button>
            </div>
        </section>

            <div class="settings-actions">
                <button onclick="saveExtraSettings()">Сохранить настройки</button>
            </div>
        </div>
    `);
}

export async function saveExtraSettings() {
    syncLegacyBoardTickerText();
	const payload = {
		print_ticket: document.getElementById("setting-print-ticket").checked,
		show_print_badge: document.getElementById("setting-show-print-badge").checked,
		ticket_print_scale_percent: Number(document.getElementById("setting-ticket-print-scale").value),
		ticket_notice_duration_printed_seconds: Number(document.getElementById("setting-ticket-notice-duration-printed").value),
		ticket_notice_duration_unprinted_seconds: Number(document.getElementById("setting-ticket-notice-duration-unprinted").value),
		ticket_notice_printed_text: document.getElementById("setting-ticket-notice-printed-text").value.trim(),
		ticket_notice_unprinted_text: document.getElementById("setting-ticket-notice-unprinted-text").value.trim(),
		default_operator_status: document.getElementById("setting-default-operator-status").value,
		active_ticket_on_operator_logout: document.getElementById("setting-active-ticket-on-logout").value,
		hide_services_without_online_operators: document.getElementById("setting-unavailable-services-mode").value === "hide",
        auto_call_enabled: currentSettings.auto_call_enabled === true,
        auto_call_delay_seconds: Number(currentSettings.auto_call_delay_seconds ?? 60),
        called_ticket_min_wait_seconds: Number(document.getElementById("setting-called-ticket-min-wait").value),
        short_service_warning_minutes: Number(document.getElementById("setting-short-service-warning-minutes").value),
        max_deferred_tickets_per_operator: Number(document.getElementById("setting-max-deferred-tickets").value),
        max_ticket_redirects: Number(document.getElementById("setting-max-ticket-redirects").value),
        auto_call_balance_enabled: document.getElementById("setting-auto-call-balance-enabled").checked,
        auto_call_balance_queue_threshold: Number(document.getElementById("setting-auto-call-balance-threshold").value),
        auto_call_balance_min_free_operators: Number(document.getElementById("setting-auto-call-balance-min-operators").value),
        cancelled_ticket_board_display_seconds: Number(document.getElementById("setting-cancelled-board-seconds").value),
        cancelled_ticket_board_message_template: document.getElementById("setting-cancelled-board-template").value.trim(),

		call_message_template: document.getElementById("setting-call-message-template").value.trim(),
		board_ticket_template: document.getElementById("setting-board-ticket-template").value.trim(),
		board_ticker_text: document.getElementById("setting-board-ticker-text").value.trim(),
		board_ticker_messages: collectBoardTickerMessages(),
        cancel_reason_options: collectReasonOptions("cancel"),
        defer_reason_options: collectReasonOptions("defer")
	};

    if (
        !Number.isInteger(payload.ticket_notice_duration_printed_seconds) ||
        !Number.isInteger(payload.ticket_notice_duration_unprinted_seconds) ||
        payload.ticket_notice_duration_printed_seconds < 1 ||
        payload.ticket_notice_duration_printed_seconds > 300 ||
        payload.ticket_notice_duration_unprinted_seconds < 1 ||
        payload.ticket_notice_duration_unprinted_seconds > 300
    ) {
        alert("Время показа номера должно быть целым числом от 1 до 300 секунд");
        return;
    }
    if (
        !Number.isInteger(payload.called_ticket_min_wait_seconds) ||
        payload.called_ticket_min_wait_seconds < 0 ||
        payload.called_ticket_min_wait_seconds > 3600
    ) {
        alert("Минимальное ожидание должно быть целым числом от 0 до 3600 секунд");
        return;
    }
    if (!Number.isInteger(payload.short_service_warning_minutes) || payload.short_service_warning_minutes < 0 || payload.short_service_warning_minutes > 60) {
        alert("Порог быстрого обслуживания должен быть от 0 до 60 минут");
        return;
    }
    if (!Number.isInteger(payload.max_deferred_tickets_per_operator) || payload.max_deferred_tickets_per_operator < 1 || payload.max_deferred_tickets_per_operator > 50) {
        alert("Лимит отложенных талонов должен быть от 1 до 50");
        return;
    }
    if (!Number.isInteger(payload.max_ticket_redirects) || payload.max_ticket_redirects < 1 || payload.max_ticket_redirects > 20) {
        alert("Лимит перенаправлений должен быть целым числом от 1 до 20");
        return;
    }

    if (
        !Number.isInteger(payload.ticket_print_scale_percent) ||
        payload.ticket_print_scale_percent < 50 ||
        payload.ticket_print_scale_percent > 150
    ) {
        alert("Размер печатного талона должен быть от 50 до 150%");
        return;
    }

    if (!payload.ticket_notice_printed_text.includes("<number>") || !payload.ticket_notice_unprinted_text.includes("<number>")) {
        alert("Текст уведомления на терминале должен содержать <number>");
        return;
    }

    if (!payload.call_message_template.includes("<number>") || !payload.call_message_template.includes("<window>")) {
        alert("Шаблон озвучки должен содержать <number> и <window>");
        return;
    }

    if (!payload.board_ticket_template.includes("<number>") || !payload.board_ticket_template.includes("<window>")) {
        alert("Шаблон табло должен содержать <number> и <window>");
        return;
    }

    const res = await fetchJSON(`${API}/admin/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
    });

    if (res) {
        alert("Настройки сохранены");
        loadExtraSettings();
    }
}

export function loadStats() {
    // Открываем Grafana в новой вкладке вместо embedded-режима.
    window.open(GRAFANA, "_blank", "noopener,noreferrer");
    setActiveTab('tab-stats');
}

//////// КАРТА

function escapeHtml(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

function getBoardTickerMessages(settings) {
    if (Array.isArray(settings.board_ticker_messages) && settings.board_ticker_messages.length) {
        return settings.board_ticker_messages;
    }
    return settings.board_ticker_text
        ? [{text: settings.board_ticker_text, enabled: true}]
        : [{text: "", enabled: true}];
}

function renderBoardTickerMessages(messages) {
    return messages.map((message, index) => `
        <div class="settings-field-row" data-ticker-message-row>
            <label class="settings-checkbox-row">
                <input type="checkbox" class="setting-board-ticker-enabled" ${message.enabled !== false ? "checked" : ""}>
                enabled
            </label>
            <textarea class="settings-input settings-textarea setting-board-ticker-message" maxlength="500">${escapeHtml(message.text || "")}</textarea>
            <button type="button" onclick="deleteBoardTickerMessage(${index})">Удалить</button>
        </div>
    `).join("");
}

function getReasonOptions(settings, type) {
    const key = `${type}_reason_options`;
    const options = Array.isArray(settings[key]) ? settings[key] : [];
    return options.length ? options : [{text: "", enabled: true}];
}

function renderReasonOptions(options, type) {
    return options.map((reason, index) => `
        <div class="settings-field-row" data-reason-option-row="${type}">
            <label class="settings-checkbox-row">
                <input type="checkbox" class="setting-${type}-reason-enabled" ${reason.enabled !== false ? "checked" : ""}>
                enabled
            </label>
            <input class="settings-input setting-${type}-reason-text" maxlength="120" value="${escapeHtml(reason.text || "")}">
            <button type="button" onclick="deleteReasonOption('${type}', ${index})">Удалить</button>
        </div>
    `).join("");
}

function collectBoardTickerMessages() {
    return Array.from(document.querySelectorAll("[data-ticker-message-row]"))
        .map(row => ({
            text: row.querySelector(".setting-board-ticker-message").value.trim(),
            enabled: row.querySelector(".setting-board-ticker-enabled").checked
        }))
        .filter(message => message.text);
}

function collectReasonOptions(type) {
    return Array.from(document.querySelectorAll(`[data-reason-option-row="${type}"]`))
        .map(row => ({
            text: row.querySelector(`.setting-${type}-reason-text`).value.trim(),
            enabled: row.querySelector(`.setting-${type}-reason-enabled`).checked
        }))
        .filter(reason => reason.text);
}

function syncLegacyBoardTickerText() {
    document.getElementById("setting-board-ticker-text").value = collectBoardTickerMessages()
        .filter(message => message.enabled)
        .map(message => message.text)
        .join(" | ");
}

window.addBoardTickerMessage = function () {
    const host = document.getElementById("setting-board-ticker-messages");
    const messages = collectBoardTickerMessages();
    messages.push({text: "", enabled: true});
    host.innerHTML = renderBoardTickerMessages(messages);
};

window.addReasonOption = function (type) {
    const host = document.getElementById(`setting-${type}-reason-options`);
    const options = collectReasonOptions(type);
    options.push({text: "", enabled: true});
    host.innerHTML = renderReasonOptions(options, type);
};

window.deleteReasonOption = function (type, indexToDelete) {
    const host = document.getElementById(`setting-${type}-reason-options`);
    const options = collectReasonOptions(type)
        .filter((_, index) => index !== Number(indexToDelete));
    host.innerHTML = renderReasonOptions(options.length ? options : [{text: "", enabled: true}], type);
};

window.deleteBoardTickerMessage = function (indexToDelete) {
    const host = document.getElementById("setting-board-ticker-messages");
    const messages = collectBoardTickerMessages()
        .filter((_, index) => index !== Number(indexToDelete));
    host.innerHTML = renderBoardTickerMessages(messages.length ? messages : [{text: "", enabled: true}]);
};
