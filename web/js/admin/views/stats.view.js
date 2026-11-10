let context;
let loadTimer;

export async function mount(ctx) {
    context = ctx;
    render();
    loadDashboard();
}

export function unmount() {
    clearTimeout(loadTimer);
    context = null;
}

function render() {
    const grafanaUrl = context.ui.escapeHtml(CONFIG.GRAFANA_URL);
    context.view.innerHTML = `
        <div class="admin-stats-page">
            <div class="admin-stats-toolbar">
                <div>
                    <strong>Дашборд очереди</strong>
                    <span>Данные обновляются средствами Grafana</span>
                </div>
                <a class="admin-btn admin-btn-secondary" href="${grafanaUrl}"
                    target="_blank" rel="noopener noreferrer">Открыть в Grafana ↗</a>
            </div>
            <div class="admin-stats-frame-wrap">
                <iframe id="admin-stats-frame" class="admin-stats-frame"
                    title="Статистика очереди в Grafana" loading="eager"></iframe>
                <div id="admin-stats-state" class="admin-stats-state" role="status">
                    <span class="admin-stats-spinner" aria-hidden="true"></span>
                    <strong>Загружаем статистику…</strong>
                    <small>Обычно это занимает несколько секунд</small>
                </div>
            </div>
        </div>
    `;
    context.view.onclick = handleClick;
}

function loadDashboard() {
    const frame = document.getElementById("admin-stats-frame");
    if (!frame || !CONFIG.GRAFANA_URL) {
        showError("Адрес Grafana не настроен");
        return;
    }

    showLoading();
    frame.onload = showDashboard;
    frame.onerror = () => showError("Grafana не ответила");
    frame.src = embeddedGrafanaUrl();

    clearTimeout(loadTimer);
    loadTimer = setTimeout(() => {
        if (document.getElementById("admin-stats-state")?.hidden === false) {
            showError("Не удалось загрузить Grafana за отведённое время");
        }
    }, 15000);
}

function embeddedGrafanaUrl() {
    const url = new URL(CONFIG.GRAFANA_URL, window.location.href);
    url.searchParams.set("kiosk", "");
    return url.toString();
}

function showLoading() {
    const state = document.getElementById("admin-stats-state");
    if (!state) return;
    state.hidden = false;
    state.classList.remove("admin-stats-state-error");
    state.innerHTML = `
        <span class="admin-stats-spinner" aria-hidden="true"></span>
        <strong>Загружаем статистику…</strong>
        <small>Обычно это занимает несколько секунд</small>
    `;
}

function showDashboard() {
    clearTimeout(loadTimer);
    const state = document.getElementById("admin-stats-state");
    if (state) state.hidden = true;
}

function showError(message) {
    clearTimeout(loadTimer);
    const state = document.getElementById("admin-stats-state");
    if (!state || !context) return;
    state.hidden = false;
    state.classList.add("admin-stats-state-error");
    state.innerHTML = `
        <strong>Статистика сейчас недоступна</strong>
        <small>${context.ui.escapeHtml(message)}. Проверьте, запущена ли Grafana.</small>
        <div class="admin-stats-state-actions">
            ${context.ui.button("Повторить", {variant: "primary", action: "retry-stats"})}
            <a class="admin-btn admin-btn-secondary" href="${context.ui.escapeHtml(CONFIG.GRAFANA_URL)}"
                target="_blank" rel="noopener noreferrer">Открыть в Grafana ↗</a>
        </div>
    `;
}

function handleClick(event) {
    if (event.target.closest("[data-action='retry-stats']")) loadDashboard();
}
