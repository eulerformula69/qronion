let ctx;
let state;

const STATUS_LABELS = {
    waiting: "Ожидает",
    called: "Вызван",
    serving: "Обслуживается",
    deferred: "Отложен",
    finished: "Завершён",
    cancelled: "Отменён"
};
const ACTIVE_STATUSES = new Set(["waiting", "called", "serving", "deferred"]);
const COMPLETION_REASON_LABELS = {
    completed: "Обслуживание завершено",
    redirected: "Перенаправлен",
    cancelled: "Отменён"
};

export async function mount(context) {
    ctx = context;
    state = {
        items: [],
        filters: {},
        sort: {key: "current", direction: "desc"},
        query: {created_from: todayValue()}
    };
    ctx.view.innerHTML = `<div class="admin-loading">Загрузка талонов...</div>`;
    ctx.view.onclick = handleClick;
    ctx.view.onchange = handleFilterChange;
    await loadTickets();
}

export function unmount() {}

async function loadTickets() {
    const params = new URLSearchParams({limit: "500"});
    Object.entries(state.query).forEach(([key, value]) => {
        if (value !== "" && value != null) params.set(key, value);
    });
    if (state.sort.key !== "current") {
        params.set("sort", state.sort.key);
        params.set("direction", state.sort.direction);
    }
    const data = await ctx.api.request(`/admin/tickets?${params}`);
    state.items = data.items;
    state.filters = data.filters;
    state.total = data.total;
    state.loadedAt = new Date();
    render();
}

function render() {
    const headers = [
        ctx.ui.sortHeader("Номер", "number", state.sort),
        ctx.ui.sortHeader("Статус", "status", state.sort),
        ctx.ui.sortHeader("Услуга", "service", state.sort),
        ctx.ui.sortHeader("Оператор", "operator", state.sort),
        ctx.ui.sortHeader("Окно обслуживания", "window", state.sort),
        ctx.ui.sortHeader("Выбрано клиентом", "target_window", state.sort),
        ctx.ui.sortHeader("Создан", "created_at", state.sort),
        ctx.ui.sortHeader("Вызван", "called_at", state.sort),
        ctx.ui.sortHeader("Начат", "service_started_at", state.sort),
        ctx.ui.sortHeader("Завершён", "finished_at", state.sort),
        "Действия"
    ];
    const rows = state.items.map(ticket => `<tr data-ticket-id="${ticket.id}">
        <td><strong>№${ctx.ui.escapeHtml(ticket.number)}</strong></td>
        <td>${statusBadge(ticket.status)}</td>
        <td>${text(ticket.service_name)}</td>
        <td>${text(ticket.operator_name)}</td>
        <td>${text(ticket.window_name)}</td>
        <td>${text(ticket.target_window_name)}</td>
        <td>${formatDate(ticket.created_at)}</td>
        <td>${formatDate(ticket.called_at)}</td>
        <td>${formatDate(ticket.service_started_at)}</td>
        <td>${formatDate(ticket.finished_at)}</td>
        <td class="admin-ticket-actions">
            <div class="admin-ticket-action-list">
                ${ctx.ui.button("Подробнее", {variant: "ghost", action: "details", id: ticket.id})}
                ${ACTIVE_STATUSES.has(ticket.status) ? ctx.ui.button("Отменить", {variant: "danger", action: "cancel", id: ticket.id}) : ""}
            </div>
        </td>
    </tr>`);

    ctx.view.innerHTML = `
        <section class="admin-ticket-page">
            <div class="admin-card admin-ticket-filters">
                ${filterSelect("status", "Статус", [
                    {value: "", label: "Все статусы"},
                    ...Object.entries(STATUS_LABELS).map(([value, label]) => ({value, label}))
                ])}
                ${filterSelect("service_id", "Услуга", entityOptions("services", "Все услуги"))}
                ${filterSelect("operator_id", "Оператор", entityOptions("operators", "Все операторы"))}
                ${filterSelect("window_id", "Окно", entityOptions("windows", "Все окна"))}
                <label class="admin-field"><span>Дата от</span><input class="admin-input" type="date" name="created_from" value="${ctx.ui.escapeHtml(state.query.created_from || "")}"></label>
                <label class="admin-field"><span>Дата до</span><input class="admin-input" type="date" name="created_to" value="${ctx.ui.escapeHtml(state.query.created_to || "")}"></label>
                ${ctx.ui.button("Сбросить", {variant: "secondary", action: "reset-filters"})}
            </div>
            <div class="admin-ticket-toolbar">
                <div class="admin-ticket-count">Показано ${state.items.length} из ${state.total} · обновлено ${formatTime(state.loadedAt)}</div>
                ${ctx.ui.button("↻ Обновить таблицу", {variant: "primary", action: "refresh"})}
            </div>
            ${ctx.ui.table(headers, rows)}
        </section>`;
}

function filterSelect(name, label, options) {
    return `<label class="admin-field"><span>${label}</span>${ctx.ui.select(name, options, state.query[name] || "")}</label>`;
}

function entityOptions(key, emptyLabel) {
    return [{value: "", label: emptyLabel}, ...(state.filters[key] || []).map(item => ({value: item.id, label: item.name}))];
}

async function handleClick(event) {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    if (button.dataset.action === "refresh") {
        await loadTickets();
        ctx.toast("Таблица обновлена", "success");
    }
    if (button.dataset.action === "sort") {
        const key = button.dataset.sortKey;
        state.sort = {key, direction: state.sort.key === key && state.sort.direction === "desc" ? "asc" : "desc"};
        await loadTickets();
    }
    if (button.dataset.action === "reset-filters") {
        state.query = {created_from: todayValue()};
        state.sort = {key: "current", direction: "desc"};
        await loadTickets();
    }
    if (button.dataset.action === "details") await showDetails(Number(button.dataset.id));
    if (button.dataset.action === "cancel") await cancelTicket(Number(button.dataset.id));
}

async function handleFilterChange(event) {
    if (!event.target.name) return;
    state.query[event.target.name] = event.target.value;
    await loadTickets();
}

async function cancelTicket(id) {
    const ticket = state.items.find(item => item.id === id);
    const reason = window.prompt(`Причина отмены талона №${ticket.number}:`, "Отменено администратором");
    if (reason === null) return;
    if (!reason.trim()) {
        ctx.toast("Укажите причину отмены", "error");
        return;
    }
    if (!ctx.ui.confirmAction(`Отменить активный талон №${ticket.number}? Изменение сразу увидят оператор и табло.`)) return;
    await ctx.api.json(`/admin/tickets/${id}/status`, {method: "PATCH", body: {status: "cancelled", reason: reason.trim()}});
    ctx.toast(`Талон №${ticket.number} отменён`, "success");
    await loadTickets();
}

async function showDetails(id) {
    const ticket = await ctx.api.request(`/admin/tickets/${id}`);
    const fields = [
        ["Номер", `№${ticket.number}`], ["Статус", STATUS_LABELS[ticket.status] || ticket.status],
        ["Услуга", ticket.service_name], ["Оператор", ticket.operator_name], ["Окно обслуживания", ticket.window_name],
        ["Выбрано клиентом", ticket.target_window_name],
        ["Исходный талон", ticket.root_ticket_number ? `№${ticket.root_ticket_number}` : null],
        ["Создан", formatDate(ticket.created_at)], ["Вошёл в очередь", formatDate(ticket.queue_entered_at)],
        ["Вызван", formatDate(ticket.called_at)], ["Начало обслуживания", formatDate(ticket.service_started_at)],
        ["Последний повторный вызов", formatDate(ticket.last_recalled_at)], ["Отложен", formatDate(ticket.deferred_at)],
        ["Завершён", formatDate(ticket.finished_at)], ["Возвратов в очередь", ticket.returned_to_queue_count],
        ["Причина отложения", ticket.defer_reason], ["Причина отмены", ticket.cancel_reason],
        ["Причина завершения", COMPLETION_REASON_LABELS[ticket.completion_reason] || ticket.completion_reason]
    ];
    const history = ticket.admin_changes.length ? ticket.admin_changes.map(change => `
        <li><strong>${formatDate(change.changed_at)}</strong> — ${ctx.ui.escapeHtml(change.admin_login)}:
        ${ctx.ui.escapeHtml(STATUS_LABELS[change.previous_status] || change.previous_status)} →
        ${ctx.ui.escapeHtml(STATUS_LABELS[change.new_status] || change.new_status)}
        <small>${ctx.ui.escapeHtml(change.reason || "Без причины")}</small></li>`).join("") : "<li>Ручных изменений не было</li>";
    ctx.openDrawer(`Талон №${ticket.number}`, `
        <dl class="admin-ticket-details">${fields.map(([label, value]) => `<div><dt>${label}</dt><dd>${text(value)}</dd></div>`).join("")}</dl>
        <h3>История изменений</h3><ul class="admin-ticket-history">${history}</ul>`);
}

function statusBadge(status) {
    const tone = {waiting: "blue", called: "warning", serving: "success", deferred: "neutral", finished: "success", cancelled: "danger"}[status] || "neutral";
    return ctx.ui.badge(STATUS_LABELS[status] || status, tone);
}

function formatTime(value) {
    return value ? new Intl.DateTimeFormat("ru-RU", {timeStyle: "medium"}).format(value) : "—";
}

function formatDate(value) {
    if (!value) return "—";
    return new Intl.DateTimeFormat("ru-RU", {dateStyle: "short", timeStyle: "medium"}).format(new Date(value));
}

function text(value) {
    return value === null || value === undefined || value === "" ? "—" : ctx.ui.escapeHtml(value);
}

function todayValue() {
    const now = new Date();
    const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 10);
}
