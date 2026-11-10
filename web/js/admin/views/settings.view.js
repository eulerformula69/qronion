let ctx;
let settings;
let activeSection = "terminal";

export async function mount(context, section = "terminal") {
    ctx = context;
    activeSection = section;
    settings = await ctx.api.request("/admin/settings");
    render();
}

function render() {
    ctx.view.innerHTML = `
        <form id="settings-form" class="admin-settings-layout admin-settings-layout-single">
            ${renderActiveSection()}
            <div class="admin-settings-actions">
                ${ctx.ui.button("Сохранить изменения", {variant: "primary", action: "save-settings"})}
            </div>
        </form>
    `;
    ctx.view.onclick = handleClick;
}

function renderActiveSection() {
    if (activeSection === "board") return renderBoardSection();
    if (activeSection === "queue") return renderQueueSection();
    return renderTerminalSection();
}

function renderTerminalSection() {
    return `<section class="admin-card admin-form admin-settings-wide">
        <div class="admin-settings-grid">
        ${ctx.ui.field("Печатать талон", ctx.ui.switchField("print_ticket", settings.print_ticket))}
        ${ctx.ui.field("Показывать режим печати", ctx.ui.switchField("show_print_badge", settings.show_print_badge))}
        ${ctx.ui.field("Размер печатного талона, %", ctx.ui.input("ticket_print_scale_percent", settings.ticket_print_scale_percent || 94, "type=\"number\" min=\"50\" max=\"150\" step=\"1\""))}
        ${ctx.ui.field("Услуги без активных операторов", ctx.ui.select("unavailable_services_mode", [
            {value: "hide", label: "Скрывать услуги"},
            {value: "show_inactive", label: "Показывать как неактивные"}
        ], settings.hide_services_without_online_operators ? "hide" : "show_inactive"))}
        ${ctx.ui.field("Показ номера с печатью, секунд", ctx.ui.input("ticket_notice_duration_printed_seconds", settings.ticket_notice_duration_printed_seconds || 7, "type=\"number\" min=\"1\" max=\"300\""))}
        ${ctx.ui.field("Текст при печати талона", ctx.ui.textarea("ticket_notice_printed_text", settings.ticket_notice_printed_text || "Ваш номер: <number>", "maxlength=\"500\""))}
        ${ctx.ui.field("Показ номера без печати, секунд", ctx.ui.input("ticket_notice_duration_unprinted_seconds", settings.ticket_notice_duration_unprinted_seconds || 45, "type=\"number\" min=\"1\" max=\"300\""))}
        ${ctx.ui.field("Текст без печати талона", ctx.ui.textarea("ticket_notice_unprinted_text", settings.ticket_notice_unprinted_text || "Пожалуйста, запомните свой номер:\n<number>", "maxlength=\"500\""))}
        </div>
    </section>`;
}

function renderQueueSection() {
    return `<section class="admin-card admin-form admin-settings-wide">
        <div class="admin-settings-grid">
        ${ctx.ui.field("Автовызов по умолчанию", ctx.ui.switchField("auto_call_enabled", settings.auto_call_enabled))}
        ${ctx.ui.field("До автоматического вызова, секунд", ctx.ui.input("auto_call_delay_seconds", settings.auto_call_delay_seconds ?? 60, "type=\"number\" min=\"0\" max=\"600\" step=\"1\""))}
        ${ctx.ui.field("Статус окна при входе оператора", ctx.ui.select("default_operator_status", [
            {value: "online", label: "Онлайн"}, {value: "break", label: "Перерыв"}, {value: "offline", label: "Офлайн"}
        ], settings.default_operator_status))}
        ${ctx.ui.field("Если оператор вышел с активным тикетом", ctx.ui.select("active_ticket_on_operator_logout", [
            {value: "return_to_queue", label: "Вернуть обратно в очередь"}, {value: "keep_with_operator", label: "Оставить за оператором"}
        ], settings.active_ticket_on_operator_logout))}
        ${ctx.ui.field("Адресное перенаправление оператору на перерыве", ctx.ui.switchField("redirect_allow_break", settings.redirect_allow_break ?? true))}
        ${ctx.ui.field("Адресное перенаправление оператору офлайн", ctx.ui.switchField("redirect_allow_offline", settings.redirect_allow_offline ?? false))}
        ${ctx.ui.field("Максимум перенаправлений одного талона", ctx.ui.input("max_ticket_redirects", settings.max_ticket_redirects ?? 3, "type=\"number\" min=\"1\" max=\"20\" step=\"1\""))}
        ${ctx.ui.field("Текст кнопки подтверждения обновления", ctx.ui.input("operator_changelog_confirm_button_text", settings.operator_changelog_confirm_button_text || "Понятно", "maxlength=\"200\" placeholder=\"Нажимая эту кнопку, я подтверждаю, что прочитал(а) все обновления и теперь в курсе всех изменений в работе очереди\""))}
        ${ctx.ui.field("Минимальная длительность обслуживания, секунд", ctx.ui.input("called_ticket_min_wait_seconds", settings.called_ticket_min_wait_seconds ?? 180, "type=\"number\" min=\"0\" max=\"3600\" step=\"1\""))}
        ${ctx.ui.field("Порог быстрого обслуживания, минут (0 — отключить)", ctx.ui.input("short_service_warning_minutes", settings.short_service_warning_minutes ?? 5, "type=\"number\" min=\"0\" max=\"60\" step=\"1\""))}
        ${ctx.ui.field("Максимум отложенных талонов у оператора", ctx.ui.input("max_deferred_tickets_per_operator", settings.max_deferred_tickets_per_operator ?? 3, "type=\"number\" min=\"1\" max=\"50\" step=\"1\""))}
        ${ctx.ui.field("Балансировка автовызова при низкой нагрузке", ctx.ui.switchField("auto_call_balance_enabled", settings.auto_call_balance_enabled ?? true))}
        ${ctx.ui.field("Балансировка: максимум талонов в очереди", ctx.ui.input("auto_call_balance_queue_threshold", settings.auto_call_balance_queue_threshold ?? 3, "type=\"number\" min=\"1\" max=\"100\" step=\"1\""))}
        ${ctx.ui.field("Балансировка: минимум свободных операторов", ctx.ui.input("auto_call_balance_min_free_operators", settings.auto_call_balance_min_free_operators ?? 2, "type=\"number\" min=\"2\" max=\"100\" step=\"1\""))}
        ${ctx.ui.field("Сообщение об отменённом талоне на табло, секунд", ctx.ui.input("cancelled_ticket_board_display_seconds", settings.cancelled_ticket_board_display_seconds ?? 60, "type=\"number\" min=\"0\" max=\"3600\" step=\"1\""))}
        ${ctx.ui.field("Текст системного сообщения об отмене (<number>, <window>)", ctx.ui.input("cancelled_ticket_board_message_template", settings.cancelled_ticket_board_message_template || "⚠ Талон <number>: вызов отменён оператором окна <window>. Вернулись? Сообщите номер оператору.", "maxlength=\"500\""))}
        <div class="admin-field admin-settings-span"><span>Причины отмены</span><div id="cancel-reason-options">${renderReasonOptions("cancel")}</div>${ctx.ui.button("Добавить причину отмены", {action: "add-reason-option", id: "cancel"})}</div>
        <div class="admin-field admin-settings-span"><span>Причины отложения</span><div id="defer-reason-options">${renderReasonOptions("defer")}</div>${ctx.ui.button("Добавить причину отложения", {action: "add-reason-option", id: "defer"})}</div>
        </div>
    </section>`;
}

function renderBoardSection() {
    return `<section class="admin-card admin-form admin-settings-wide">
        <div class="admin-settings-grid">
        ${ctx.ui.field("Сообщение вызова / озвучки", ctx.ui.input("call_message_template", settings.call_message_template || "Талон <number> подойдите к окну <window>"))}
        ${ctx.ui.field("Отображение вызванного талона", ctx.ui.input("board_ticket_template", settings.board_ticket_template || "Билет <number> -> окно <window>"))}
        <input type="hidden" id="setting-board-ticker-text" name="board_ticker_text" value="${escapeHtml(settings.board_ticker_text || "")}">
        <div class="admin-field admin-settings-span"><span>Тексты бегущей строки</span><div id="board-ticker-messages">${renderBoardTickerMessages()}</div>${ctx.ui.button("Добавить сообщение", {action: "add-ticker-message"})}</div>
        </div>
    </section>`;
}

function getBoardTickerMessages() {
    const messages = Array.isArray(settings.board_ticker_messages)
        ? settings.board_ticker_messages
        : [];
    if (messages.length) return messages;
    return settings.board_ticker_text
        ? [{text: settings.board_ticker_text, enabled: true}]
        : [{text: "", enabled: true}];
}

function renderBoardTickerMessages() {
    return getBoardTickerMessages().map((message, index) => `
        <div class="admin-field" data-ticker-message-row>
            <label class="admin-switch">
                <input type="checkbox" name="board_ticker_message_enabled" ${message.enabled !== false ? "checked" : ""}>
                <span></span>
            </label>
            <textarea class="admin-input admin-textarea" name="board_ticker_message_text" maxlength="500">${escapeHtml(message.text || "")}</textarea>
            ${ctx.ui.button("Удалить", {action: "delete-ticker-message", id: index})}
        </div>
    `).join("");
}

function getReasonOptions(type) {
    const key = `${type}_reason_options`;
    const options = Array.isArray(settings[key]) ? settings[key] : [];
    return options.length ? options : [{text: "", enabled: true}];
}

function renderReasonOptions(type) {
    return getReasonOptions(type).map((reason, index) => `
        <div class="admin-field" data-reason-option-row="${type}">
            <label class="admin-switch">
                <input type="checkbox" name="${type}_reason_enabled" ${reason.enabled !== false ? "checked" : ""}>
                <span></span>
            </label>
            <input class="admin-input" name="${type}_reason_text" maxlength="120" value="${escapeHtml(reason.text || "")}">
            ${ctx.ui.button("Удалить", {action: "delete-reason-option", id: `${type}:${index}`})}
        </div>
    `).join("");
}

async function handleClick(event) {
    const button = event.target.closest("[data-action='save-settings']");
    if (button) {
        await save();
        return;
    }

    const addButton = event.target.closest("[data-action='add-ticker-message']");
    if (addButton) {
        settings.board_ticker_messages = collectBoardTickerMessages();
        settings.board_ticker_messages.push({text: "", enabled: true});
        render();
        return;
    }

    const deleteButton = event.target.closest("[data-action='delete-ticker-message']");
    if (deleteButton) {
        settings.board_ticker_messages = collectBoardTickerMessages()
            .filter((_, index) => index !== Number(deleteButton.dataset.id));
        render();
        return;
    }

    const addReasonButton = event.target.closest("[data-action='add-reason-option']");
    if (addReasonButton) {
        const type = addReasonButton.dataset.id;
        settings[`${type}_reason_options`] = collectReasonOptions(type);
        settings[`${type}_reason_options`].push({text: "", enabled: true});
        render();
        return;
    }

    const deleteReasonButton = event.target.closest("[data-action='delete-reason-option']");
    if (deleteReasonButton) {
        const [type, index] = deleteReasonButton.dataset.id.split(":");
        settings[`${type}_reason_options`] = collectReasonOptions(type)
            .filter((_, itemIndex) => itemIndex !== Number(index));
        render();
    }
}

async function save() {
    const form = document.getElementById("settings-form");
    const data = Object.fromEntries(new FormData(form).entries());
    const payload = {
        ...settings,
        auto_call_enabled: settings.auto_call_enabled === true,
        auto_call_delay_seconds: Number(settings.auto_call_delay_seconds ?? 60),
        board_ticker_messages: settings.board_ticker_messages || [],
        cancel_reason_options: settings.cancel_reason_options || [],
        defer_reason_options: settings.defer_reason_options || []
    };

    if (activeSection === "terminal") applyTerminalForm(payload, data);
    if (activeSection === "queue") applyQueueForm(payload, data);
    if (activeSection === "board") applyBoardForm(payload, data);

    if (activeSection === "terminal" && (!validDuration(payload.ticket_notice_duration_printed_seconds) || !validDuration(payload.ticket_notice_duration_unprinted_seconds))) {
        return ctx.toast("Время показа должно быть целым числом от 1 до 300 секунд", "error");
    }
    if (activeSection === "terminal" && !validTicketPrintScale(payload.ticket_print_scale_percent)) {
        return ctx.toast("Размер печатного талона должен быть от 50 до 150%", "error");
    }
    if (!validAutoCallDelay(payload.auto_call_delay_seconds)) {
        return ctx.toast("Задержка автовызова должна быть целым числом от 0 до 600 секунд", "error");
    }
    if (activeSection === "queue" && !validCalledTicketMinWait(payload.called_ticket_min_wait_seconds)) {
        return ctx.toast("Минимальное ожидание должно быть целым числом от 0 до 3600 секунд", "error");
    }
    if (activeSection === "queue" && (!Number.isInteger(payload.short_service_warning_minutes) || payload.short_service_warning_minutes < 0 || payload.short_service_warning_minutes > 60)) {
        return ctx.toast("Порог быстрого обслуживания должен быть от 0 до 60 минут", "error");
    }
    if (activeSection === "queue" && (!Number.isInteger(payload.max_deferred_tickets_per_operator) || payload.max_deferred_tickets_per_operator < 1 || payload.max_deferred_tickets_per_operator > 50)) {
        return ctx.toast("Лимит отложенных талонов должен быть от 1 до 50", "error");
    }
    if (activeSection === "queue" && (!Number.isInteger(payload.max_ticket_redirects) || payload.max_ticket_redirects < 1 || payload.max_ticket_redirects > 20)) {
        return ctx.toast("Лимит перенаправлений должен быть целым числом от 1 до 20", "error");
    }
    if (activeSection === "queue" && !payload.operator_changelog_confirm_button_text) {
        return ctx.toast("Введите текст кнопки подтверждения обновления", "error");
    }
    if (activeSection === "terminal" && (!payload.ticket_notice_printed_text.includes("<number>") || !payload.ticket_notice_unprinted_text.includes("<number>"))) {
        return ctx.toast("Тексты терминала должны содержать <number>", "error");
    }
    if (activeSection === "board" && (!payload.call_message_template.includes("<number>") || !payload.call_message_template.includes("<window>"))) {
        return ctx.toast("Шаблон озвучки должен содержать <number> и <window>", "error");
    }
    if (activeSection === "board" && (!payload.board_ticket_template.includes("<number>") || !payload.board_ticket_template.includes("<window>"))) {
        return ctx.toast("Шаблон табло должен содержать <number> и <window>", "error");
    }

    settings = await ctx.api.json("/admin/settings", {method: "PUT", body: payload});
    ctx.toast("Настройки сохранены", "success");
    render();
}

function applyTerminalForm(payload, data) {
    Object.assign(payload, {
        print_ticket: Boolean(data.print_ticket),
        show_print_badge: Boolean(data.show_print_badge),
        ticket_print_scale_percent: Number(data.ticket_print_scale_percent),
        hide_services_without_online_operators: data.unavailable_services_mode === "hide",
        ticket_notice_duration_printed_seconds: Number(data.ticket_notice_duration_printed_seconds),
        ticket_notice_printed_text: data.ticket_notice_printed_text.trim(),
        ticket_notice_duration_unprinted_seconds: Number(data.ticket_notice_duration_unprinted_seconds),
        ticket_notice_unprinted_text: data.ticket_notice_unprinted_text.trim()
    });
}

function applyQueueForm(payload, data) {
    Object.assign(payload, {
        auto_call_enabled: Boolean(data.auto_call_enabled),
        auto_call_delay_seconds: Number(data.auto_call_delay_seconds),
        default_operator_status: data.default_operator_status,
        active_ticket_on_operator_logout: data.active_ticket_on_operator_logout,
        redirect_allow_break: Boolean(data.redirect_allow_break),
        redirect_allow_offline: Boolean(data.redirect_allow_offline),
        max_ticket_redirects: Number(data.max_ticket_redirects),
        operator_changelog_confirm_button_text: data.operator_changelog_confirm_button_text.trim(),
        called_ticket_min_wait_seconds: Number(data.called_ticket_min_wait_seconds),
        short_service_warning_minutes: Number(data.short_service_warning_minutes),
        max_deferred_tickets_per_operator: Number(data.max_deferred_tickets_per_operator),
        auto_call_balance_enabled: Boolean(data.auto_call_balance_enabled),
        auto_call_balance_queue_threshold: Number(data.auto_call_balance_queue_threshold),
        auto_call_balance_min_free_operators: Number(data.auto_call_balance_min_free_operators),
        cancelled_ticket_board_display_seconds: Number(data.cancelled_ticket_board_display_seconds),
        cancelled_ticket_board_message_template: data.cancelled_ticket_board_message_template.trim(),
        cancel_reason_options: collectReasonOptions("cancel"),
        defer_reason_options: collectReasonOptions("defer")
    });
}

function applyBoardForm(payload, data) {
    syncLegacyBoardTickerText();
    Object.assign(payload, {
        call_message_template: data.call_message_template.trim(),
        board_ticket_template: data.board_ticket_template.trim(),
        board_ticker_text: document.getElementById("setting-board-ticker-text").value.trim(),
        board_ticker_messages: collectBoardTickerMessages()
    });
}

function validDuration(value) {
    return Number.isInteger(value) && value >= 1 && value <= 300;
}

function validTicketPrintScale(value) {
    return Number.isInteger(value) && value >= 50 && value <= 150;
}

function validAutoCallDelay(value) {
    return Number.isInteger(value) && value >= 0 && value <= 600;
}

function validCalledTicketMinWait(value) {
    return Number.isInteger(value) && value >= 0 && value <= 3600;
}

function collectBoardTickerMessages() {
    return Array.from(document.querySelectorAll("[data-ticker-message-row]"))
        .map(row => ({
            text: row.querySelector("[name='board_ticker_message_text']").value.trim(),
            enabled: row.querySelector("[name='board_ticker_message_enabled']").checked
        }))
        .filter(message => message.text);
}

function collectReasonOptions(type) {
    return Array.from(document.querySelectorAll(`[data-reason-option-row="${type}"]`))
        .map(row => ({
            text: row.querySelector(`[name='${type}_reason_text']`).value.trim(),
            enabled: row.querySelector(`[name='${type}_reason_enabled']`).checked
        }))
        .filter(reason => reason.text);
}

function syncLegacyBoardTickerText() {
    document.getElementById("setting-board-ticker-text").value = collectBoardTickerMessages()
        .filter(message => message.enabled)
        .map(message => message.text)
        .join(" | ");
}

function escapeHtml(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}
