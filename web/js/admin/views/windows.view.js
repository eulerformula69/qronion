let ctx;
let windows = [];
let operators = [];
let services = [];
let windowServices = new Map();
let sortState = {key: "window_id", direction: "asc"};
const sortStorageKey = "admin.workplaces.sort";

const statuses = [
    {value: "online", label: "Работает"},
    {value: "break", label: "Перерыв"},
    {value: "offline", label: "Не работает"}
];

const autoCallModes = [
    {value: "default", label: "По общей настройке"},
    {value: "enabled", label: "Включён"},
    {value: "disabled", label: "Выключен"}
];

export async function mount(context) {
    ctx = context;
    sortState = loadSortState(sortState);
    await load();
    render();
}

async function load() {
    const [windowData, operatorData, serviceData] = await Promise.all([
        ctx.api.request("/windows/"),
        ctx.api.request("/operators/"),
        ctx.api.request("/services/?include_hidden=true")
    ]);
    windows = Array.isArray(windowData) ? windowData : [];
    operators = Array.isArray(operatorData) ? operatorData : [];
    services = Array.isArray(serviceData) ? serviceData : [];
    windowServices = new Map();
    await Promise.all(windows.map(async windowItem => {
        const linked = await ctx.api.request(`/window-services/${windowItem.id}`);
        windowServices.set(windowItem.id, Array.isArray(linked) ? linked : []);
    }));
}

function render() {
    const freeOperators = operators.filter(item => !item.window_id);
    const occupiedCount = windows.filter(item => operatorForWindow(item.id)).length;
    ctx.view.innerHTML = `
        <div class="workplaces-summary" aria-label="Состояние рабочих мест">
            ${summaryCard("Рабочих мест", windows.length)}
            ${summaryCard("Мест с оператором", occupiedCount, "success")}
            ${summaryCard("Мест без оператора", windows.length - occupiedCount, "warning")}
            ${summaryCard("Операторы без места", freeOperators.length, freeOperators.length ? "warning" : "neutral")}
        </div>
        <div class="workplaces-toolbar">
            <div>${ctx.ui.button("Добавить рабочее место", {variant: "primary", action: "create-window"})}${ctx.ui.button("Добавить оператора", {variant: "secondary", action: "create-operator"})}</div>
        </div>
        ${renderLinkedView()}`;
    ctx.view.onclick = handleClick;
    ctx.view.onchange = handleChange;
}

function renderLinkedView() {
    const rows = buildLinkedRows();
    return `<section class="workplaces-section" aria-labelledby="workplaces-title">
        <h2 id="workplaces-title">Назначения</h2>
        ${ctx.ui.table([
            ctx.ui.sortHeader("Рабочее место", "window_name", sortState),
            ctx.ui.sortHeader("Статус", "status", sortState),
            ctx.ui.sortHeader("Услуги", "services", sortState),
            ctx.ui.sortHeader("Оператор", "operator_name", sortState),
            "Действия"
        ], sortRows(rows).map(renderLinkedRow), {title: ""})}
    </section>`;
}

function summaryCard(label, value, tone = "neutral") {
    return `<article class="workplaces-summary-card workplaces-summary-${tone}"><strong>${value}</strong><span>${label}</span></article>`;
}

function buildLinkedRows() {
    const rows = windows.map(windowItem => ({windowItem, operator: operatorForWindow(windowItem.id)}));
    operators.filter(operator => !operator.window_id).forEach(operator => rows.push({windowItem: null, operator}));
    return rows;
}

function renderLinkedRow({windowItem, operator}) {
    const serviceNames = windowItem ? serviceNamesForWindow(windowItem.id) : [];
    return `<tr class="workplace-row">
        <td>${windowItem ? `<strong>${ctx.ui.escapeHtml(windowItem.name)}</strong><small class="workplace-meta">ID ${windowItem.id}</small>` : `<select class="admin-input workplace-assign-select" data-action="assign-window" data-operator-id="${operator.id}" aria-label="Назначить рабочее место оператору ${ctx.ui.escapeHtml(operator.name)}"><option value="">Не назначено</option>${freeWindowOptions()}</select>`}</td>
        <td>${windowItem ? ctx.ui.badge(statusLabel(windowItem.status), statusTone(windowItem.status)) : "—"}</td>
        <td class="workplace-services" title="${ctx.ui.escapeHtml(serviceNames.join(", "))}">${windowItem ? (serviceNames.length ? ctx.ui.escapeHtml(serviceNames.join(", ")) : "Не назначены") : "—"}</td>
        <td>${operator ? `<strong>${ctx.ui.escapeHtml(operator.name)}</strong><small class="workplace-meta">${ctx.ui.escapeHtml(operator.login)} · ID ${operator.id}</small>` : `<select class="admin-input workplace-assign-select" data-action="assign" data-window-id="${windowItem.id}" aria-label="Назначить оператора на ${ctx.ui.escapeHtml(windowItem.name)}"><option value="">Не назначен</option>${freeOperatorOptions()}</select>`}</td>
        <td><div class="workplace-actions">${windowItem && operator ? ctx.ui.button("Снять назначение", {variant: "ghost", action: "unassign", id: windowItem.id}) : ""}${operator ? ctx.ui.button("Изменить оператора", {variant: "link", action: "edit-operator", id: operator.id}) : ""}${windowItem ? ctx.ui.button("Настроить место", {variant: "link", action: "edit-window", id: windowItem.id}) : ""}</div></td>
    </tr>`;
}

function emptyState(message) {
    return `<div class="admin-card admin-empty-state">${ctx.ui.escapeHtml(message)}</div>`;
}

function freeOperatorOptions() {
    return operators.filter(item => !item.window_id).sort(byName).map(item => `<option value="${item.id}">${ctx.ui.escapeHtml(item.name)}</option>`).join("");
}

function freeWindowOptions() {
    return windows.filter(item => !operatorForWindow(item.id)).sort(byName).map(item => `<option value="${item.id}">${ctx.ui.escapeHtml(item.name)}</option>`).join("");
}

function serviceNamesForWindow(windowId) {
    return (windowServices.get(windowId) || []).map(link => services.find(service => service.id === link.service_id)?.name).filter(Boolean);
}

function operatorForWindow(windowId) {
    return operators.find(item => item.window_id === windowId);
}

function byName(a, b) {
    return String(a.name || "").localeCompare(String(b.name || ""), "ru", {numeric: true, sensitivity: "base"});
}

function sortRows(items) {
    return [...items].sort((a, b) => {
        const result = compareValues(sortValue(a), sortValue(b));
        return sortState.direction === "asc" ? result : -result;
    });
}

function sortValue({windowItem, operator}) {
    if (sortState.key === "window_id") return windowItem?.id ?? Number.MAX_SAFE_INTEGER;
    if (sortState.key === "window_name") return windowItem?.name || "Я";
    if (sortState.key === "status") return windowItem ? statusLabel(windowItem.status) : "Я";
    if (sortState.key === "services") return windowItem ? serviceNamesForWindow(windowItem.id).length : Number.MAX_SAFE_INTEGER;
    if (sortState.key === "operator_id") return operator?.id ?? Number.MAX_SAFE_INTEGER;
    if (sortState.key === "login") return operator?.login || "Я";
    return operator?.name || "Я";
}

function compareValues(a, b) {
    if (typeof a === "number" && typeof b === "number") return a - b;
    return String(a ?? "").localeCompare(String(b ?? ""), "ru", {numeric: true, sensitivity: "base"});
}

function setSort(key) {
    sortState = {key, direction: sortState.key === key && sortState.direction === "asc" ? "desc" : "asc"};
    try { localStorage.setItem(sortStorageKey, JSON.stringify(sortState)); } catch (error) { /* Current-page sorting still works. */ }
}

function loadSortState(fallback) {
    try {
        const saved = JSON.parse(localStorage.getItem(sortStorageKey) || "null");
        if (saved && ["window_id", "window_name", "status", "services", "operator_id", "operator_name", "login"].includes(saved.key) && ["asc", "desc"].includes(saved.direction)) return saved;
    } catch (error) { return fallback; }
    return fallback;
}

function statusLabel(status) {
    return statuses.find(item => item.value === status)?.label || status;
}

function statusTone(status) {
    return status === "online" ? "success" : status === "break" ? "warning" : "neutral";
}

async function handleChange(event) {
    const select = event.target;
    if (!select.value || !["assign", "assign-window"].includes(select.dataset.action)) return;
    select.disabled = true;
    try {
        if (select.dataset.action === "assign") await assignOperator(Number(select.dataset.windowId), Number(select.value));
        else await assignOperator(Number(select.value), Number(select.dataset.operatorId));
    } catch (error) {
        select.value = "";
        if (error?.name !== "ApiError") ctx.toast("Не удалось назначить оператора. Попробуйте ещё раз", "error");
    } finally {
        if (select.isConnected) select.disabled = false;
    }
}

async function handleClick(event) {
    const button = event.target.closest("[data-action]");
    if (!button || button.matches("select")) return;
    if (button.dataset.action === "sort") {
        setSort(button.dataset.sortKey);
        render();
        return;
    }
    const id = Number(button.dataset.id);
    if (button.dataset.action === "create-window") openWindowDrawer();
    if (button.dataset.action === "edit-window") openWindowDrawer(windows.find(item => item.id === id));
    if (button.dataset.action === "create-operator") openOperatorDrawer();
    if (button.dataset.action === "edit-operator") openOperatorDrawer(operators.find(item => item.id === id));
    if (button.dataset.action === "unassign") await assignOperator(id, null);
}

async function assignOperator(windowId, operatorId) {
    await ctx.api.json(`/windows/${windowId}/operator`, {method: "PUT", body: {operator_id: operatorId}});
    await refresh(operatorId ? "Оператор назначен" : "Оператор снят с рабочего места");
}

function openWindowDrawer(windowItem = null) {
    const linked = windowItem ? windowServices.get(windowItem.id) || [] : [];
    const priorities = new Map(linked.map(item => [item.service_id, item.priority ?? 1]));
    ctx.openDrawer(windowItem ? "Настроить рабочее место" : "Новое рабочее место", `<form id="window-form" class="admin-form">
        ${ctx.ui.field("Название", ctx.ui.input("name", windowItem?.name || "", "required"))}
        ${windowItem ? ctx.ui.field("Состояние", ctx.ui.select("status", statuses, windowItem.status)) : ""}
        ${windowItem ? `<section class="admin-subsection"><h3>Услуги</h3><p class="admin-muted">Меньшее число означает больший приоритет.</p><div class="admin-check-list">${services.map(service => { const checked = priorities.has(service.id); return `<label class="admin-check-row"><input type="checkbox" name="service_${service.id}" ${checked ? "checked" : ""}><span>${ctx.ui.escapeHtml(service.name)}</span><input class="admin-input admin-priority-input" type="number" min="1" max="100" aria-label="Приоритет услуги ${ctx.ui.escapeHtml(service.name)}" name="priority_${service.id}" value="${priorities.get(service.id) || 1}"></label>`; }).join("")}</div></section>` : ""}
    </form>`, {footer: drawerFooter("window", windowItem?.id)});
    document.getElementById("admin-drawer").onclick = handleDrawerClick;
}

function openOperatorDrawer(operator = null) {
    const isEdit = Boolean(operator);
    ctx.openDrawer(isEdit ? "Редактирование оператора" : "Новый оператор", `<form id="operator-form" class="admin-form">
        ${ctx.ui.field("ФИО", ctx.ui.input("name", operator?.name || "", "required"))}
        ${ctx.ui.field("Логин", ctx.ui.input("login", operator?.login || "", "required"))}
        ${ctx.ui.field("Пароль", ctx.ui.input("password", "", `${isEdit ? "placeholder=\"Оставьте пустым, чтобы не менять\"" : "required"} type="password"`))}
        ${ctx.ui.field("Автовызов", ctx.ui.select("auto_call_mode", autoCallModes, operator?.auto_call_mode || "default"))}
        ${isEdit ? `<p class="admin-muted">Назначение меняется на основном экране.</p>` : ""}
    </form>`, {footer: drawerFooter("operator", operator?.id)});
    document.getElementById("admin-drawer").onclick = handleDrawerClick;
}

function drawerFooter(type, id) {
    return `${ctx.ui.button("Отмена", {variant: "secondary", action: "cancel"})}${id ? ctx.ui.button("Удалить", {variant: "danger", action: `delete-${type}`, id}) : ""}${ctx.ui.button("Сохранить", {variant: "primary", action: `save-${type}`, id: id || ""})}`;
}

async function handleDrawerClick(event) {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const id = Number(button.dataset.id) || null;
    if (button.dataset.action === "cancel") ctx.closeDrawer();
    if (button.dataset.action === "save-window") {
        if (button.disabled) return;
        button.disabled = true;
        try { await saveWindow(id); }
        catch (error) { if (error?.name !== "ApiError") ctx.toast("Не удалось сохранить рабочее место. Попробуйте ещё раз", "error"); }
        finally { if (button.isConnected) button.disabled = false; }
    }
    if (button.dataset.action === "delete-window") await deleteWindow(id);
    if (button.dataset.action === "save-operator") await saveOperator(id);
    if (button.dataset.action === "delete-operator") await deleteOperator(id);
}

async function saveWindow(id) {
    const data = Object.fromEntries(new FormData(document.getElementById("window-form")).entries());
    const name = data.name?.trim();
    if (!name) return ctx.toast("Введите название рабочего места", "error");
    if (!id) await ctx.api.json("/windows/", {method: "POST", body: {name}});
    else {
        const linked = services.filter(service => data[`service_${service.id}`]).map(service => ({service_id: service.id, priority: Number(data[`priority_${service.id}`])}));
        if (linked.some(item => !Number.isInteger(item.priority) || item.priority < 1 || item.priority > 100)) return ctx.toast("Укажите целый приоритет от 1 до 100", "error");
        await ctx.api.json(`/windows/${id}`, {method: "PATCH", body: {name, status: data.status, services: linked}});
    }
    await refresh("Рабочее место сохранено");
}

async function saveOperator(id) {
    const data = Object.fromEntries(new FormData(document.getElementById("operator-form")).entries());
    const name = data.name?.trim();
    const login = data.login?.trim();
    const password = data.password?.trim();
    if (!name || !login || (!id && !password)) return ctx.toast("Заполните имя, логин и пароль", "error");
    if (!id) await ctx.api.json("/operators/", {method: "POST", body: {name, login, password, window_id: null, auto_call_mode: data.auto_call_mode}});
    else {
        const current = operators.find(item => item.id === id);
        if (current && login !== current.login && !password) return ctx.toast("Для смены логина укажите новый пароль", "error");
        await ctx.api.json(`/operators/${id}`, {method: "PATCH", body: {name, auto_call_mode: data.auto_call_mode}});
        if (password) await ctx.api.json(`/operators/${id}/login`, {method: "PUT", body: {login, password}});
    }
    await refresh("Оператор сохранён");
}

async function refresh(message) {
    ctx.closeDrawer();
    await load();
    render();
    ctx.toast(message, "success");
}

async function deleteWindow(id) {
    if (operatorForWindow(id)) return ctx.toast("Сначала снимите оператора с рабочего места", "error");
    if ((windowServices.get(id) || []).length) return ctx.toast("Сначала удалите услуги рабочего места", "error");
    const item = windows.find(windowItem => windowItem.id === id);
    if (!ctx.ui.confirmAction(`Удалить рабочее место «${item?.name || ""}»?`)) return;
    await ctx.api.request(`/windows/${id}`, {method: "DELETE"});
    await refresh("Рабочее место удалено");
}

async function deleteOperator(id) {
    const item = operators.find(operator => operator.id === id);
    if (!ctx.ui.confirmAction(`Удалить оператора ${item?.name || ""}? История обслуживания сохранится.`)) return;
    await ctx.api.request(`/operators/${id}`, {method: "DELETE"});
    await refresh("Оператор удалён");
}
