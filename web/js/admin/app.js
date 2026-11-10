import * as api from "./api.js";
import * as ui from "./ui.js";
import { mount as mountServices } from "./views/services.view.js";
import { mount as mountWindows } from "./views/windows.view.js";
import { mount as mountMedia } from "./views/media.view.js";
import { mount as mountSettings } from "./views/settings.view.js";
import { mount as mountStats, unmount as unmountStats } from "./views/stats.view.js";
import { mount as mountMap, unmount as unmountMap } from "./views/map.view.js";
import { mount as mountDocs, unmount as unmountDocs } from "./views/docs.view.js";
import { mount as mountTickets, unmount as unmountTickets } from "./views/tickets.view.js";
import { mount as mountScheduler } from "./views/scheduler.view.js";

const routes = {
    services: {
        label: "Услуги",
        description: "Управление услугами, доступными на терминалах",
        group: "Очередь",
        icon: "services",
        mount: mountServices
    },
    windows: {
        label: "Рабочие места и операторы",
        description: "Назначения операторов, доступность мест и услуги",
        group: "Очередь",
        icon: "windows",
        mount: mountWindows
    },
    tickets: {
        label: "Талоны",
        description: "Текущее состояние очереди и ручное управление талонами",
        group: "Очередь",
        icon: "tickets",
        mount: mountTickets,
        unmount: unmountTickets
    },
    terminalSettings: {
        label: "Терминал",
        description: "Печать талонов и поведение терминала",
        group: "Система",
        icon: "terminal",
        mount: context => mountSettings(context, "terminal")
    },
    boardSettings: {
        label: "Табло",
        description: "Тексты, озвучка и бегущая строка",
        group: "Система",
        icon: "board",
        mount: context => mountSettings(context, "board")
    },
    media: {
        label: "Медиафайлы",
        description: "Загрузка и управление роликами для табло",
        group: "Система",
        icon: "media",
        mount: mountMedia
    },
    queueSettings: {
        label: "Правила",
        description: "Правила работы операторов и обработки талонов",
        group: "Система",
        icon: "queue",
        mount: context => mountSettings(context, "queue")
    },
    scheduler: {
        label: "Планировщик",
        description: "Автоматическое закрытие смены по дням недели",
        group: "Система",
        icon: "scheduler",
        mount: mountScheduler
    },
    map: {
        label: "Карта",
        description: "Редактор карты офиса",
        group: "Общее",
        icon: "map",
        mount: mountMap,
        unmount: unmountMap
    },
    stats: {
        label: "Статистика",
        description: "Показатели очереди и работы операторов",
        group: "Общее",
        icon: "stats",
        mount: mountStats,
        unmount: unmountStats
    },
    docs: {
        label: "Документация",
        description: "Инструкции администратора и оператора",
        group: "Общее",
        icon: "docs",
        mount: mountDocs,
        unmount: unmountDocs
    }
};

let currentRoute = null;
let adminSocket = null;
let heartbeatTimer = null;
let reconnectTimer = null;

const root = document.getElementById("admin-root");
const SIDEBAR_STORAGE_KEY = "admin-sidebar-collapsed";

const icons = {
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    services: '<path d="M4 5.5h16M4 12h16M4 18.5h16"/><circle cx="8" cy="5.5" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="10" cy="18.5" r="1.5"/>',
    windows: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 10h16M10 10v10"/>',
    operators: '<circle cx="12" cy="8" r="3"/><path d="M5.5 20c.5-4 2.7-6 6.5-6s6 2 6.5 6"/>',
    map: '<path d="m4 6 5-2 6 2 5-2v14l-5 2-6-2-5 2Z"/><path d="M9 4v14M15 6v14"/>',
    media: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m10 9 5 3-5 3Z"/>',
    terminal: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 7h6M8 17h8"/><circle cx="12" cy="12" r="2"/>',
    board: '<rect x="3" y="4" width="18" height="14" rx="2"/><path d="M8 22h8M12 18v4M7 9h6M7 13h10"/>',
    queue: '<path d="M6 7h12M6 12h12M6 17h8"/><circle cx="3" cy="7" r=".8"/><circle cx="3" cy="12" r=".8"/><circle cx="3" cy="17" r=".8"/>',
    scheduler: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4M17 3v4M3 10h18M8 14h3v3H8Z"/>',
    tickets: '<path d="M5 4h14v5a3 3 0 0 0 0 6v5H5v-5a3 3 0 0 0 0-6Z"/><path d="M9 8h6M9 12h6M9 16h4"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"/>',
    stats: '<path d="M5 19V9M12 19V5M19 19v-7"/><path d="M3 19h18"/>',
    docs: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H11a3 3 0 0 1 3 3v15a3 3 0 0 0-3-3H4Z"/><path d="M20 5.5A2.5 2.5 0 0 0 17.5 3H14v18a3 3 0 0 1 3-3h3Z"/>'
};

function icon(name) {
    return `<svg class="admin-nav-icon" viewBox="0 0 24 24" aria-hidden="true">${icons[name]}</svg>`;
}

function renderNavigation() {
    let currentGroup = null;
    return Object.entries(routes).map(([key, route]) => {
        const group = route.group !== currentGroup
            ? `<div class="admin-nav-group">${route.group}</div>`
            : "";
        currentGroup = route.group;
        return `${group}
            <a href="${route.externalUrl || `#${key}`}" class="admin-nav-link" data-route="${key}"
                aria-label="${route.label}" title="${route.label}"
                ${route.externalUrl ? 'target="_blank" rel="noopener noreferrer"' : ""}>
                ${icon(route.icon)}
                <span class="admin-nav-label">${route.label}</span>
            </a>`;
    }).join("");
}

function setSidebarCollapsed(collapsed, persist = false) {
    document.body.classList.toggle("admin-sidebar-collapsed", collapsed);
    root.querySelectorAll(".admin-menu-button").forEach(menuButton => {
        menuButton.setAttribute("aria-expanded", String(!collapsed));
        menuButton.setAttribute("aria-label", collapsed ? "Развернуть боковую панель" : "Свернуть боковую панель");
    });
    if (persist) localStorage.setItem(SIDEBAR_STORAGE_KEY, String(collapsed));
}

function renderShell() {
    const isMobile = window.matchMedia("(max-width: 820px)").matches;
    if (isMobile || localStorage.getItem(SIDEBAR_STORAGE_KEY) === "true") {
        document.body.classList.add("admin-sidebar-collapsed");
    }
    const sidebarCollapsed = document.body.classList.contains("admin-sidebar-collapsed");
    root.innerHTML = `
        <div class="admin-shell">
            <aside class="admin-sidebar">
                <div class="admin-sidebar-header">
                    <button class="admin-menu-button" type="button"
                        aria-label="${sidebarCollapsed ? "Развернуть" : "Свернуть"} боковую панель"
                        aria-expanded="${String(!sidebarCollapsed)}">
                        ${icon("menu")}
                    </button>
                </div>
                <nav class="admin-nav">
                    ${renderNavigation()}
                </nav>
            </aside>
            <main class="admin-main">
                <header class="admin-header">
                    <button class="admin-menu-button admin-mobile-menu-button" type="button"
                        aria-label="${sidebarCollapsed ? "Развернуть" : "Свернуть"} боковую панель"
                        aria-expanded="${String(!sidebarCollapsed)}">
                        ${icon("menu")}
                    </button>
                    <div>
                        <h1 id="admin-title">Администрирование</h1>
                        <p id="admin-description"></p>
                    </div>
                    <div class="admin-header-spacer"></div>
                    ${ui.button("Выйти", {variant: "ghost", action: "logout"})}
                </header>
                <section id="admin-view" class="admin-view"></section>
            </main>
        </div>
        <button class="admin-sidebar-scrim" type="button" aria-label="Закрыть меню"></button>
        <aside id="admin-drawer" class="admin-drawer" aria-hidden="true"></aside>
        <div id="admin-toast-host" class="admin-toast-host"></div>
    `;

    root.addEventListener("click", event => {
        const action = event.target.closest("[data-action]")?.dataset.action;
        if (action === "logout") api.logout();
        if (event.target.closest(".admin-menu-button")) {
            const collapsed = !document.body.classList.contains("admin-sidebar-collapsed");
            setSidebarCollapsed(collapsed, !window.matchMedia("(max-width: 820px)").matches);
        }
        if (event.target.closest(".admin-sidebar-scrim")) setSidebarCollapsed(true);
        if (event.target.closest(".admin-nav-link") && window.matchMedia("(max-width: 820px)").matches) {
            setSidebarCollapsed(true);
        }
    });
}

function setHeader(routeKey) {
    const route = routes[routeKey];
    document.getElementById("admin-title").textContent = route.label;
    document.getElementById("admin-description").textContent = route.description;
    document.querySelectorAll(".admin-nav-link").forEach(link => {
        link.classList.toggle("active", link.dataset.route === routeKey);
    });
}

function getView() {
    return document.getElementById("admin-view");
}

let drawerTrigger = null;

function openDrawer(title, content, options = {}) {
    drawerTrigger = document.activeElement;
    const drawer = document.getElementById("admin-drawer");
    drawer.innerHTML = `
        <div class="admin-drawer-header">
            <h2>${ui.escapeHtml(title)}</h2>
            ${ui.button("×", {variant: "icon", action: "close-drawer", title: "Закрыть"})}
        </div>
        <div class="admin-drawer-body">${content}</div>
        ${options.footer ? `<div class="admin-drawer-footer">${options.footer}</div>` : ""}
    `;
    drawer.classList.add("open");
    drawer.setAttribute("aria-hidden", "false");
    drawer.setAttribute("role", "dialog");
    drawer.setAttribute("aria-label", title);
    (drawer.querySelector("input, select, textarea") || drawer.querySelector("button"))?.focus();
    drawer.onkeydown = event => {
        if (event.key === "Escape") { event.preventDefault(); closeDrawer(); }
    };
    drawer.querySelector('[data-action="close-drawer"]')?.addEventListener("click", closeDrawer);
}

function closeDrawer() {
    const drawer = document.getElementById("admin-drawer");
    drawer.classList.remove("open");
    drawer.setAttribute("aria-hidden", "true");
    drawer.innerHTML = "";
    if (drawerTrigger?.isConnected) drawerTrigger.focus();
    drawerTrigger = null;
}

async function navigate() {
    const routeKey = (location.hash || "#services").slice(1);
    const routeAliases = {settings: "terminalSettings", operators: "windows"};
    const normalizedRouteKey = routeAliases[routeKey] || routeKey;
    const key = routes[normalizedRouteKey] ? normalizedRouteKey : "services";
    const route = routes[key];

    closeDrawer();
    if (currentRoute && routes[currentRoute]?.unmount) routes[currentRoute].unmount();
    currentRoute = key;
    setHeader(key);

    const ctx = {
        api,
        ui,
        routes,
        view: getView(),
        setHeader,
        openDrawer,
        closeDrawer,
        toast: ui.showToast
    };

    getView().innerHTML = `<div class="admin-loading">Загрузка...</div>`;
    try {
        await route.mount(ctx);
    } catch (error) {
        if (error?.name === "ApiError") return;
        console.error(error);
        getView().innerHTML = `<div class="admin-error">${ui.escapeHtml(error.message || "Не удалось загрузить раздел")}</div>`;
    }
}

function startWebSocket() {
    clearTimeout(reconnectTimer);
    adminSocket = new WebSocket(CONFIG.WS_TERMINAL_URL);

    adminSocket.onopen = () => sendHeartbeat();
    adminSocket.onmessage = event => {
        const data = JSON.parse(event.data);
        if (data.type === "session_expired") api.redirectToLogin();
        if (data.type === "ticket.updated") {
            window.dispatchEvent(new CustomEvent("admin:ticket-updated", {detail: data}));
        }
    };
    adminSocket.onclose = () => {
        reconnectTimer = setTimeout(startWebSocket, CONFIG.RECONNECT_INTERVAL || 2000);
    };

    clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(sendHeartbeat, 5000);
}

function sendHeartbeat() {
    const sid = api.getSessionId();
    if (!sid || !adminSocket || adminSocket.readyState !== WebSocket.OPEN) return;
    adminSocket.send(JSON.stringify({type: "ping", session_id: sid}));
}

async function bootstrap() {
    const sessionId = api.getSessionId();
    if (!sessionId) {
        api.redirectToLogin();
        return;
    }

    renderShell();
    await api.request("/auth/admin");
    startWebSocket();

    window.addEventListener("hashchange", navigate);
    if (!location.hash) location.hash = "#services";
    await navigate();
}

document.addEventListener("DOMContentLoaded", () => {
    bootstrap().catch(error => {
        if (error?.name === "ApiError") return;
        console.error(error);
        api.redirectToLogin();
    });
});
