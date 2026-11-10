// Автоматическая проверка авторизации при загрузке
document.addEventListener("DOMContentLoaded", async () => {
    const savedLogin = localStorage.getItem("terminal_credential_login");
    const savedPass = localStorage.getItem("terminal_credential_pass");

    if (savedLogin && savedPass) {
        // Если данные есть, пробуем войти в фоне
        await performTerminalLogin(savedLogin, savedPass, true);
    } else {
        // Если данных нет, показываем окно входа
        document.getElementById("terminal-auth-overlay").style.display = "flex";
    }
});

// Функция входа
async function performTerminalLogin(login, password, isAuto = false) {
    const errorEl = document.getElementById("term-auth-error");
    try {
        const response = await fetch(`${CONFIG.API_URL}/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ login, password })
        });

        const data = await response.json();

        // Проверяем, что это именно терминал
        if (response.ok && data.role === "terminal") {
            // Сохраняем сессию для текущей работы
            localStorage.setItem("session_id", data.session_id);          
            // Сохраняем логин/пароль "навечно" для авто-входа
            localStorage.setItem("terminal_credential_login", login);
            localStorage.setItem("terminal_credential_pass", password);          
            // Скрываем окно и загружаем данные терминала
            document.getElementById("terminal-auth-overlay").style.display = "none" 
            // Стандартные функции инициализации
            loadServices();
            loadTerminalSettings();
        } else {
            throw new Error(data.detail || "Доступ запрещен или это не терминал");
        }
    } catch (err) {
        console.error("Auth error:", err);
        if (isAuto) {
            // Если авто-вход не сработал (например, пароль изменили), сбрасываем и просим ввод
            localStorage.removeItem("terminal_credential_login");
            localStorage.removeItem("terminal_credential_pass");
        }
        document.getElementById("terminal-auth-overlay").style.display = "flex";
        errorEl.textContent = err.message;
    }
}

// Вызывается при нажатии на кнопку в форме
async function handleTerminalManualLogin() {
    const login = document.getElementById("term-login").value;
    const pass = document.getElementById("term-password").value;
    const btn = document.getElementById("vkb-login-btn") || document.getElementById("term-auth-btn");
    
    if (btn) btn.disabled = true;
    await performTerminalLogin(login, pass);
    if (btn) btn.disabled = false;
}


function connectSocket() {
    // Используем URL из конфига
    const socket = new WebSocket(CONFIG.WS_TERMINAL_URL);
    socket.onopen = () => console.log("WS connected");
    socket.onclose = () => {
        console.log("WS reconnecting...");
        // Используем интервал из конфига
        setTimeout(connectSocket, CONFIG.RECONNECT_INTERVAL);
    };

    socket.onmessage = function(event) {
        const data = JSON.parse(event.data);
        if (data.type === "services_updated") {
            loadServices();
            loadTerminalSettings();
        }
        if (data.type === "settings_updated") {
            loadTerminalSettings();
        }
    };

    return socket;
}

let socket = connectSocket();
let terminalSettings = {
    print_ticket: true,
    show_print_badge: true,
    ticket_print_scale_percent: 94,
    ticket_notice_duration_printed_seconds: 7,
    ticket_notice_duration_unprinted_seconds: 45,
    ticket_notice_printed_text: "Ваш номер: <number>",
    ticket_notice_unprinted_text: "Пожалуйста, запомните свой номер:\n<number>"
};

let terminalServiceGroups = [];
let terminalUngroupedServices = [];
let terminalServicePages = [];
let terminalServicePage = 0;
let terminalServiceResizeTimer = null;

const TERMINAL_SERVICE_GESTURE = {
    corners: ["top-left", "top-right", "bottom-right", "bottom-left"],
    hitSize: 120,
    timeoutMs: 6000,
    step: 0,
    startedAt: 0
};

function detectTerminalCorner(event) {
    const point = event.changedTouches ? event.changedTouches[0] : event;
    const x = point.clientX;
    const y = point.clientY;
    const width = window.innerWidth;
    const height = window.innerHeight;
    const hit = TERMINAL_SERVICE_GESTURE.hitSize;

    if (x <= hit && y <= hit) return "top-left";
    if (x >= width - hit && y <= hit) return "top-right";
    if (x >= width - hit && y >= height - hit) return "bottom-right";
    if (x <= hit && y >= height - hit) return "bottom-left";
    return null;
}

function resetTerminalServiceGesture() {
    TERMINAL_SERVICE_GESTURE.step = 0;
    TERMINAL_SERVICE_GESTURE.startedAt = 0;
}

function handleTerminalServiceGesture(event) {
    if (document.getElementById("terminal-service-overlay")?.style.display === "flex") {
        return;
    }

    const corner = detectTerminalCorner(event);
    if (!corner) {
        resetTerminalServiceGesture();
        return;
    }

    const now = Date.now();
    const expected = TERMINAL_SERVICE_GESTURE.corners[TERMINAL_SERVICE_GESTURE.step];

    if (
        TERMINAL_SERVICE_GESTURE.step > 0 &&
        now - TERMINAL_SERVICE_GESTURE.startedAt > TERMINAL_SERVICE_GESTURE.timeoutMs
    ) {
        resetTerminalServiceGesture();
    }

    if (corner === TERMINAL_SERVICE_GESTURE.corners[0] && TERMINAL_SERVICE_GESTURE.step === 0) {
        TERMINAL_SERVICE_GESTURE.startedAt = now;
        TERMINAL_SERVICE_GESTURE.step = 1;
        return;
    }

    if (corner !== expected) {
        resetTerminalServiceGesture();
        return;
    }

    TERMINAL_SERVICE_GESTURE.step += 1;

    if (TERMINAL_SERVICE_GESTURE.step >= TERMINAL_SERVICE_GESTURE.corners.length) {
        resetTerminalServiceGesture();
        openTerminalServiceModal();
    }
}

function ensureTerminalServiceModal() {
    let overlay = document.getElementById("terminal-service-overlay");
    if (overlay) return overlay;

    overlay = document.createElement("div");
    overlay.id = "terminal-service-overlay";
    overlay.className = "terminal-service-overlay";
    overlay.style.display = "none";
    overlay.innerHTML = `
        <div class="terminal-service-modal" role="dialog" aria-modal="true">
            <h2>\u0421\u0435\u0440\u0432\u0438\u0441\u043d\u043e\u0435 \u043c\u0435\u043d\u044e</h2>
            <div class="terminal-service-actions">
                <button type="button" class="terminal-service-refresh">\u041e\u0431\u043d\u043e\u0432\u0438\u0442\u044c \u0432\u043a\u043b\u0430\u0434\u043a\u0443</button>
                <button type="button" class="terminal-service-test-print">\u0422\u0435\u0441\u0442\u043e\u0432\u0430\u044f \u043f\u0435\u0447\u0430\u0442\u044c \u0442\u0430\u043b\u043e\u043d\u0430</button>
                <button type="button" class="terminal-service-reprint">\u041f\u0435\u0447\u0430\u0442\u044c \u0440\u0430\u043d\u0435\u0435 \u0432\u044b\u0434\u0430\u043d\u043d\u043e\u0433\u043e \u0442\u0430\u043b\u043e\u043d\u0430</button>
                <button type="button" class="terminal-service-cancel">\u041e\u0442\u043c\u0435\u043d\u0430</button>
            </div>
        </div>
    `;

    overlay.querySelector(".terminal-service-refresh").addEventListener("click", () => {
        window.location.reload();
    });
    overlay.querySelector(".terminal-service-test-print").addEventListener("click", printTestTicket);
    overlay.querySelector(".terminal-service-reprint").addEventListener("click", () => {
        if (typeof openReprintTicketPanel === "function") openReprintTicketPanel();
    });
    overlay.querySelector(".terminal-service-cancel").addEventListener("click", closeTerminalServiceModal);
    overlay.addEventListener("click", (event) => {
        if (event.target === overlay) closeTerminalServiceModal();
    });

    document.body.appendChild(overlay);
    return overlay;
}

function openTerminalServiceModal() {
    const overlay = ensureTerminalServiceModal();
    overlay.style.display = "flex";
}

function closeTerminalServiceModal() {
    const overlay = document.getElementById("terminal-service-overlay");
    if (overlay) overlay.style.display = "none";
}

document.addEventListener("pointerup", handleTerminalServiceGesture, true);

function renderPrintModeBadge() {
    const badge = document.getElementById("print-mode-badge");
    if (!badge) return;

    if (!terminalSettings.show_print_badge) {
        badge.style.display = "none";
        return;
    }

    badge.style.display = "block";
    if (terminalSettings.print_ticket) {
        badge.textContent = "Печать: ВКЛ";
        badge.style.background = "rgba(40, 167, 69, 0.92)";
    } else {
        badge.textContent = "Печать: ВЫКЛ";
        badge.style.background = "rgba(108, 117, 125, 0.92)";
    }
}

function normalizeTicketPrintScalePercent(value) {
    const percent = Number(value);
    if (!Number.isFinite(percent)) return 94;
    return Math.min(150, Math.max(50, Math.round(percent)));
}

function applyTicketPrintScale() {
    const percent = normalizeTicketPrintScalePercent(terminalSettings.ticket_print_scale_percent);
    document.documentElement.style.setProperty("--ticket-print-scale", String(percent / 100));
}

async function loadTerminalSettings() {
    try {
        const res = await fetch(`${CONFIG.API_URL}/settings/public`);
        if (!res.ok) {
            applyTicketPrintScale();
            renderPrintModeBadge();
            return;
        }
        const data = await res.json();
        terminalSettings.print_ticket = data.print_ticket !== false;
        terminalSettings.show_print_badge = data.show_print_badge !== false;
        terminalSettings.ticket_print_scale_percent =
            normalizeTicketPrintScalePercent(data.ticket_print_scale_percent);
        terminalSettings.ticket_notice_duration_printed_seconds =
            Number(data.ticket_notice_duration_printed_seconds) || 7;
        terminalSettings.ticket_notice_duration_unprinted_seconds =
            Number(data.ticket_notice_duration_unprinted_seconds) || 45;
        terminalSettings.ticket_notice_printed_text =
            data.ticket_notice_printed_text || "Ваш номер: <number>";
        terminalSettings.ticket_notice_unprinted_text =
            data.ticket_notice_unprinted_text || "Пожалуйста, запомните свой номер:\n<number>";
        applyTicketPrintScale();
        renderPrintModeBadge();
    } catch (error) {
        console.warn("Не удалось загрузить публичные настройки терминала:", error);
        applyTicketPrintScale();
        renderPrintModeBadge();
    }
}

// --- Загрузка услуг ---
async function loadServices() {
    try {
        console.log("Loading grouped services from:", `${CONFIG.API_URL}/services/terminal-groups`);
        const res = await fetch(`${CONFIG.API_URL}/services/terminal-groups`);
        if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
        const data = await res.json();
        terminalServiceGroups = Array.isArray(data.groups) ? data.groups : [];
        terminalUngroupedServices = Array.isArray(data.ungrouped_services)
            ? data.ungrouped_services
            : [];
        renderServiceGroups();
        return;

    } catch (error) {
        console.error("Ошибка загрузки услуг:", error);
        const container = document.getElementById("services");
        container.innerHTML = `<p style="color: red;">Ошибка загрузки услуг (ОШИБКА: ${error.message})</p>`;
    }
}

function renderServiceGroups() {
    const container = document.getElementById("services");
    container.innerHTML = "";

    if (terminalServiceGroups.length === 0 && terminalUngroupedServices.length === 0) {
        container.innerHTML = "<p>Нет доступных услуг</p>";
        return;
    }

    terminalServicePages = buildServicePages();
    terminalServicePage = Math.min(terminalServicePage, terminalServicePages.length - 1);
    renderCurrentServicePage();
}

function getTerminalServiceSections() {
    const sections = terminalServiceGroups
        .filter(group => Array.isArray(group.services) && group.services.length)
        .map(group => ({ title: group.name, services: group.services }));

    if (terminalUngroupedServices.length) {
        sections.push({ title: "Без группы", services: terminalUngroupedServices });
    }

    return sections;
}

function buildServicePages() {
    const container = document.getElementById("services");
    const pages = [];
    let page = [];

    getTerminalServiceSections().forEach(section => {
        section.services.forEach(service => {
            const pageSection = page.find(item => item.title === section.title);
            if (pageSection) {
                pageSection.services.push(service);
            } else {
                page.push({ title: section.title, services: [service] });
            }

            renderServicePage(page);
            if (container.scrollHeight <= container.clientHeight + 1) return;

            const overflowingSection = page.find(item => item.title === section.title);
            overflowingSection.services.pop();
            page = page.filter(item => item.services.length);

            if (page.length) pages.push(page);
            page = [{ title: section.title, services: [service] }];
        });
    });

    if (page.length) pages.push(page);
    return pages.length ? pages : [[]];
}

function renderCurrentServicePage() {
    renderServicePage(terminalServicePages[terminalServicePage] || []);

    const pagination = document.getElementById("service-pagination");
    const hasMultiplePages = terminalServicePages.length > 1;
    pagination.classList.toggle("visible", hasMultiplePages);
    document.getElementById("service-page-prev").disabled = terminalServicePage === 0;
    document.getElementById("service-page-next").disabled =
        terminalServicePage >= terminalServicePages.length - 1;
    document.getElementById("service-page-status").textContent =
        hasMultiplePages ? `${terminalServicePage + 1} / ${terminalServicePages.length}` : "";
}

function renderServicePage(sections) {
    const container = document.getElementById("services");
    container.innerHTML = "";
    sections.forEach(section => {
        renderServiceSection(container, section.title, section.services);
    });
}

function renderServiceSection(container, title, services) {
    if (!services.length) return;

    const section = document.createElement("section");
    section.className = "terminal-service-section";

    const heading = document.createElement("h2");
    heading.className = "terminal-service-section-title";
    heading.textContent = title;

    const list = document.createElement("div");
    list.className = "terminal-service-section-list";

    services.forEach(service => {
        const btn = document.createElement("button");
        btn.classList.add("service-btn");

        if (service.status === "inactive") {
            btn.textContent = `${service.name} (сейчас не активна)`;
            btn.classList.add("unavailable");
            btn.onclick = () => {
                showNotice("В данный момент нет доступных специалистов. Услуга недоступна", CONFIG.NOTICE_DURATION);
            };
        } else {
            btn.textContent = service.name;
            btn.onclick = () => {
                if (service.operator_choice_enabled) {
                    chooseOperator(service.id, service.name);
                } else {
                    createTicket(service.id, service.name);
                }
            };
        }
        list.appendChild(btn);
    });

    section.append(heading, list);
    container.appendChild(section);
}

function ensureOperatorChoiceModal() {
    let overlay = document.getElementById("operator-choice-overlay");
    if (overlay) return overlay;

    overlay = document.createElement("div");
    overlay.id = "operator-choice-overlay";
    overlay.className = "operator-choice-overlay";
    overlay.style.display = "none";

    overlay.innerHTML = `
        <div class="operator-choice-modal" role="dialog" aria-modal="true" aria-labelledby="operator-choice-title">
            <button type="button" class="operator-choice-close" onclick="closeOperatorChoiceModal()" aria-label="Закрыть">×</button>
            <h2 id="operator-choice-title">Выберите оператора</h2>
            <div id="operator-choice-service" class="operator-choice-service"></div>
            <select id="operator-choice-select" class="operator-choice-select"></select>
            <div id="operator-choice-error" class="operator-choice-error"></div>
            <div id="operator-choice-list" class="operator-choice-list"></div>
            <div id="operator-choice-offline" class="operator-choice-offline" hidden>
                <h3>Оператор сейчас не работает</h3>
                <p>Вы получите талон к выбранному оператору. Обслуживание начнётся только после его возвращения. Ожидание может быть долгим.</p>
            </div>
            <div class="operator-choice-actions">
                <button type="button" class="operator-choice-confirm" onclick="confirmOperatorChoice()">Получить талон</button>
                <button type="button" class="operator-choice-cancel" onclick="backFromOperatorChoice()">Назад</button>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);
    return overlay;
}

function closeOperatorChoiceModal() {
    const overlay = document.getElementById("operator-choice-overlay");
    if (overlay) overlay.style.display = "none";
    window.pendingOperatorChoice = null;
    window.selectedOperatorWindowId = null;
    window.selectedOperatorStatus = null;
}

async function chooseOperator(serviceId, serviceName) {
    const currentSession = localStorage.getItem("session_id");

    if (!currentSession) {
        showNotice("Ошибка: Сессия не найдена. Войдите заново.", 5);
        document.getElementById("terminal-auth-overlay").style.display = "flex";
        return;
    }

    const overlay = ensureOperatorChoiceModal();
    resetOperatorChoiceConfirmation();
    const select = document.getElementById("operator-choice-select");
    const errorEl = document.getElementById("operator-choice-error");
    const serviceEl = document.getElementById("operator-choice-service");
    const list = document.getElementById("operator-choice-list");
    const confirmBtn = overlay.querySelector(".operator-choice-confirm");

    window.pendingOperatorChoice = { serviceId, serviceName };
    window.selectedOperatorWindowId = null;
    window.selectedOperatorStatus = null;
    serviceEl.textContent = serviceName;
    errorEl.textContent = "";
    list.innerHTML = "";
    select.innerHTML = `<option value="">Загрузка операторов...</option>`;
    select.disabled = true;
    confirmBtn.disabled = true;
    overlay.style.display = "flex";

    try {
        const res = await fetch(`${CONFIG.API_URL}/services/${serviceId}/operators`, {
            headers: { "session-id": currentSession }
        });

        const operators = await res.json().catch(() => []);

        if (!res.ok) {
            errorEl.textContent = operators.detail || "Не удалось загрузить операторов";
            select.innerHTML = `<option value="">Нет доступных операторов</option>`;
            return;
        }

        if (!Array.isArray(operators) || operators.length === 0) {
            errorEl.textContent = "Нет доступных операторов для этой услуги";
            select.innerHTML = `<option value="">Нет доступных операторов</option>`;
            return;
        }

list.innerHTML = "";
select.innerHTML = "";
select.style.display = "none";

confirmBtn.disabled = true;

operators.forEach(operator => {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "operator-choice-card";
    const statusLabels = {
        online: "На линии",
        break: "На перерыве – временно недоступен",
        offline: "Не на линии – ожидание может быть долгим"
    };
    const title = document.createElement("strong");
    title.textContent = `${operator.operator_name} · ${operator.window_name}`;
    const status = document.createElement("span");
    status.className = `operator-choice-status status-${operator.status}`;
    status.textContent = statusLabels[operator.status] || operator.status;
    const details = document.createElement("span");
    details.className = "operator-choice-details";
    details.append(title, status);
    const mark = document.createElement("span");
    mark.className = "operator-choice-mark";
    mark.setAttribute("aria-hidden", "true");
    card.setAttribute("aria-pressed", "false");
    card.append(details, mark);

    card.onclick = () => {
        list.querySelectorAll(".operator-choice-card").forEach(el => {
            el.classList.remove("selected");
            el.setAttribute("aria-pressed", "false");
        });

        card.classList.add("selected");
        card.setAttribute("aria-pressed", "true");
        confirmBtn.disabled = false;
        window.selectedOperatorWindowId = operator.window_id;
        window.selectedOperatorStatus = operator.status;
    };

    list.appendChild(card);
});


    } catch (error) {
        console.error("Ошибка загрузки операторов:", error);
        errorEl.textContent = "Сбой связи с сервером.";
        select.innerHTML = `<option value="">Ошибка загрузки</option>`;
    }
}

function resetOperatorChoiceConfirmation() {
    document.getElementById("operator-choice-offline").hidden = true;
    document.getElementById("operator-choice-list").hidden = false;
    document.querySelector(".operator-choice-confirm").textContent = "Получить талон";
    document.querySelector(".operator-choice-cancel").textContent = "Назад";
}

function backFromOperatorChoice() {
    if (!document.getElementById("operator-choice-offline").hidden) {
        resetOperatorChoiceConfirmation();
        document.querySelector(".operator-choice-card.selected").focus();
        return;
    }
    closeOperatorChoiceModal();
}

function confirmOperatorChoice() {
    const pending = window.pendingOperatorChoice;
    const errorEl = document.getElementById("operator-choice-error");

    if (!pending) return;

    const windowId = window.selectedOperatorWindowId;
    if (!windowId) {
        errorEl.textContent = "Выберите оператора";
        return;
    }

    const warning = document.getElementById("operator-choice-offline");
    if (window.selectedOperatorStatus === "offline" && warning.hidden) {
        warning.hidden = false;
        document.getElementById("operator-choice-list").hidden = true;
        const confirm = document.querySelector(".operator-choice-confirm");
        confirm.textContent = "Всё равно получить талон";
        document.querySelector(".operator-choice-cancel").textContent = "Выбрать другого";
        confirm.focus();
        return;
    }

    closeOperatorChoiceModal();
    createTicket(pending.serviceId, pending.serviceName, Number(windowId));
}

// --- Создание талона ---
async function createTicket(serviceId, serviceName, windowId = null) {
    const buttons = document.querySelectorAll(".service-btn");
    buttons.forEach(btn => btn.disabled = true);
    // Достаем токен сессии
	const currentSession = localStorage.getItem("session_id");

    if (!currentSession) {
        showNotice("Ошибка: Сессия не найдена. Войдите заново.", 5);
        document.getElementById("terminal-auth-overlay").style.display = "flex";
        return;
    }

    try {
        const { response, data } = await submitTicketRequest(
            serviceId, windowId, serviceName, currentSession
        );
        // Обработка ошибок 
        if (!response.ok) {
            if (response.status === 401) {
                showNotice("Сессия истекла. Требуется повторный вход.", 5);
                // Можно вызвать логаут или показать форму входа
                return;
            }
            const errorMsg = data.detail || data.error || "Ошибка создания талона";
            showNotice(errorMsg, 3);
            return; 
        }
        fillTicketReceipt(data, serviceName);
        // Печать, если включена в админке
        if (terminalSettings.print_ticket) {
            printTicket();
        }      
        // Уведомляем другие модули через сокет
        if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: "queue_updated" }));
        }
        if (terminalSettings.print_ticket) {
            showNotice(
                renderTicketNoticeText(terminalSettings.ticket_notice_printed_text, data.number),
                terminalSettings.ticket_notice_duration_printed_seconds
            );
        } else {
            showNotice(
                renderTicketNoticeText(terminalSettings.ticket_notice_unprinted_text, data.number),
                terminalSettings.ticket_notice_duration_unprinted_seconds
            );
        }

    } catch (error) {
        console.error("Ошибка при создании билета:", error);
        showNotice(error.message || "Сбой связи с сервером.", 6);
    } finally {
        // Разблокировка кнопок
        buttons.forEach(btn => {
            if (!btn.classList.contains("unavailable")) {
                btn.disabled = false;
            }
        });
    }
}

function renderTicketNoticeText(template, ticketNumber) {
    return String(template || "<number>").replaceAll("<number>", String(ticketNumber));
}

function showNotice(message, duration) {
    const notice = document.getElementById("ticket-notice");
    const timerEl = document.getElementById("ticket-timer");
    const messageEl = document.getElementById("ticket-message");
    // Останавливаем предыдущие таймеры, если они были
    if (window.noticeInterval) clearInterval(window.noticeInterval);

    messageEl.textContent = message;
    let secondsLeft = duration;
    
    timerEl.textContent = secondsLeft;
    notice.style.display = "flex";

    window.noticeInterval = setInterval(() => {
        secondsLeft--;
        timerEl.textContent = secondsLeft;

        if (secondsLeft <= 0) {
            clearInterval(window.noticeInterval);
            notice.style.display = "none";
        }
    }, 1000);
}

function closeNotice() {
    if (window.noticeInterval) {
        clearInterval(window.noticeInterval);
        window.noticeInterval = null;
    }
    document.getElementById("ticket-notice").style.display = "none";
}

document.getElementById("ticket-notice-close").addEventListener("click", closeNotice);

function formatReceiptDate(date = new Date()) {
    const dateOptions = {
        timeZone: CONFIG.TIME_ZONE,
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    };

    return date.toLocaleString('ru-RU', dateOptions).replace(' \u0433.', '\u0433.');
}

function fillTicketReceipt(data, fallbackServiceName = "") {
    document.getElementById("receipt-number").textContent = data.number;
    document.getElementById("receipt-service").textContent = data.service_name || fallbackServiceName;
    document.getElementById("receipt-date").textContent = data.date || formatReceiptDate();

    const waitEl = document.getElementById("receipt-wait-count");
    if (waitEl) {
        waitEl.textContent = data.waiting_text || (data.waiting_before > 0
            ? `\u041f\u0415\u0420\u0415\u0414 \u0412\u0410\u041c\u0418 \u0412 \u041e\u0427\u0415\u0420\u0415\u0414\u0418: ~ ${data.waiting_before} \u0427\u0415\u041b.`
            : "\u0412\u042b \u0421\u041b\u0415\u0414\u0423\u042e\u0429\u0418\u0419 \u0412 \u041e\u0427\u0415\u0420\u0415\u0414\u0418!");
    }
}

function printTestTicket() {
    closeTerminalServiceModal();
    fillTicketReceipt({
        number: "000",
        service_name: "\u0422\u0435\u0441\u0442\u043e\u0432\u0430\u044f \u043f\u0435\u0447\u0430\u0442\u044c",
        waiting_text: "\u041e\u0416\u0418\u0414\u0410\u042e\u0429\u0418\u0425 \u041f\u0415\u0420\u0415\u0414 \u0412\u0410\u041c\u0418: \u0422\u0415\u0421\u0422",
        date: formatReceiptDate()
    });

    printTicket();
}

// Оставляем только ОДНУ функцию printTicket
function printTicket() {
    const receipt = document.getElementById("print-receipt");  
    applyTicketPrintScale();
    // Делаем видимым для корректного захвата браузером
    receipt.style.display = "block";
    // Вызов системного диалога печати
    window.print();
    // Скрываем обратно
    receipt.style.display = "none";
}

// Запуск "тишины" для предотвращения сна
function startAntiSleepAudio() {
    const audio = document.getElementById('silentAudio');
    if (audio) {
        audio.play().then(() => {
            console.log("Anti-sleep audio started");
        }).catch(err => {
            console.warn("Audio play blocked, waiting for user interaction");
        });
    }
}

// Запускаем при первом клике в любом месте страницы
document.addEventListener('click', () => {
    startAntiSleepAudio();
}, { once: true });

// Клавиатура активации //
let vkbActiveField = 'term-login';
let vkbShift = false;
let vkbCaps = false;

const VKB_LAYOUT = [
    ['1','2','3','4','5','6','7','8','9','0','-','='],
    ['q','w','e','r','t','y','u','i','o','p','[',']'],
    ['a','s','d','f','g','h','j','k','l',';','\''],
    ['z','x','c','v','b','n','m',',','.','/']
];

const VKB_SHIFT_MAP = {
    '1':'!','2':'@','3':'#','4':'$','5':'%','6':'^','7':'&','8':'*','9':'(','0':')',
    '-':'_','=':'+',
    '[':'{',']':'}',
    ';':':','\'':'"',
    ',':'<','.':'>','/':'?'
};

function setActiveField(fieldId) {
    vkbActiveField = fieldId;
    // Подсветить активное поле
    ['term-login','term-password'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.borderColor = id === fieldId ? '#00aaff' : '#e2e8f0';
    });
}

function vkbPress(char) {
    const el = document.getElementById(vkbActiveField);
    if (!el) return;

    el.value += char;

    if (vkbShift && !vkbCaps) {
        vkbShift = false;
        renderVkbKeys();
    }
}

function vkbBackspace() {
    const el = document.getElementById(vkbActiveField);
    if (el) el.value = el.value.slice(0, -1);
}

function vkbToggleShift() {
    vkbShift = !vkbShift;
    renderVkbKeys();
}

function vkbToggleCaps() {
    vkbCaps = !vkbCaps;
    renderVkbKeys();
}

function vkbSpace() {
    const el = document.getElementById(vkbActiveField);
    if (el) el.value += ' ';
}

function vkbTab() {
    // Переключить между полями
    vkbActiveField = vkbActiveField === 'term-login' ? 'term-password' : 'term-login';
    setActiveField(vkbActiveField);
}

function renderVkbKeys() {
    const isUpper = vkbShift || vkbCaps;

    // --- РЯД 1 ---
    const numRow = document.getElementById('vkb-row-num');
    numRow.innerHTML = '';

    VKB_LAYOUT[0].forEach(k => {
        const btn = document.createElement('button');
        btn.className = 'vkb-key';

        let char = k;
        if (vkbShift && VKB_SHIFT_MAP[k]) {
            char = VKB_SHIFT_MAP[k];
        }

        btn.textContent = char;
        btn.onclick = () => vkbPress(char);
        numRow.appendChild(btn);
    });

    const bs = document.createElement('button');
    bs.className = 'vkb-key action-dark';
    bs.textContent = '⌫';
    bs.onclick = vkbBackspace;
    numRow.appendChild(bs);

    // --- РЯД 2 ---
    const qRow = document.getElementById('vkb-row-q');
    qRow.innerHTML = '';

    const tab = document.createElement('button');
    tab.className = 'vkb-key action-dark';
    tab.textContent = 'Tab';
    tab.onclick = vkbTab;
    qRow.appendChild(tab);

    VKB_LAYOUT[1].forEach(k => {
        const btn = document.createElement('button');
        btn.className = 'vkb-key';
        btn.textContent = isUpper ? k.toUpperCase() : k;
        btn.onclick = () => vkbPress(btn.textContent);
        qRow.appendChild(btn);
    });

    // --- РЯД 3 ---
    const aRow = document.getElementById('vkb-row-a');
    aRow.innerHTML = '';

    const caps = document.createElement('button');
    caps.className = 'vkb-key' + (vkbCaps ? ' shift-active' : '');
    caps.textContent = 'Caps';
    caps.onclick = vkbToggleCaps;
    aRow.appendChild(caps);

    VKB_LAYOUT[2].forEach(k => {
        const btn = document.createElement('button');
        btn.className = 'vkb-key';
        btn.textContent = isUpper ? k.toUpperCase() : k;
        btn.onclick = () => vkbPress(btn.textContent);
        aRow.appendChild(btn);
    });

    // --- РЯД 4 ---
    const zRow = document.getElementById('vkb-row-z');
    zRow.innerHTML = '';

    const shift = document.createElement('button');
    shift.className = 'vkb-key' + (vkbShift ? ' shift-active' : '');
    shift.textContent = 'Shift';
    shift.onclick = vkbToggleShift;
    zRow.appendChild(shift);

    VKB_LAYOUT[3].forEach(k => {
        const btn = document.createElement('button');
        btn.className = 'vkb-key';

        let char = k;
        if (vkbShift && VKB_SHIFT_MAP[k]) {
            char = VKB_SHIFT_MAP[k];
        }

        btn.textContent = isUpper ? char.toUpperCase() : char;
        btn.onclick = () => vkbPress(btn.textContent);
        zRow.appendChild(btn);
    });

	// --- РЯД 5: ПРОБЕЛ ---
	const spaceRow = document.getElementById('vkb-row-space');
	spaceRow.innerHTML = '';

	const space = document.createElement('button');
	space.className = 'vkb-key';
	space.textContent = 'Пробел';
	space.onclick = vkbSpace;

	spaceRow.appendChild(space);

	// --- РЯД 6: ДЕЙСТВИЯ ---
	const actionRow = document.getElementById('vkb-row-actions');
	actionRow.innerHTML = '';

	const clear = document.createElement('button');
	clear.className = 'vkb-key danger';
	clear.textContent = 'Очистить';
	clear.onclick = () => {
		document.getElementById(vkbActiveField).value = '';
	};

	const login = document.createElement('button');
	login.className = 'vkb-key action-green';
	login.textContent = 'Войти';
	login.onclick = handleTerminalManualLogin;

	actionRow.append(clear, login);
}

// Инициализируем клавиатуру при первой загрузке
document.addEventListener('DOMContentLoaded', () => {
    renderVkbKeys();
    setActiveField('term-login');

    document.getElementById("service-page-prev").addEventListener("click", () => {
        if (terminalServicePage === 0) return;
        terminalServicePage -= 1;
        renderCurrentServicePage();
    });

    document.getElementById("service-page-next").addEventListener("click", () => {
        if (terminalServicePage >= terminalServicePages.length - 1) return;
        terminalServicePage += 1;
        renderCurrentServicePage();
    });

    window.addEventListener("resize", () => {
        window.clearTimeout(terminalServiceResizeTimer);
        terminalServiceResizeTimer = window.setTimeout(() => {
            if (!getTerminalServiceSections().length) return;
            terminalServicePage = 0;
            terminalServicePages = buildServicePages();
            renderCurrentServicePage();
        }, 150);
    });

    // Поддержка физической клавиатуры
    document.addEventListener('keydown', (e) => {
        const overlay = document.getElementById('terminal-auth-overlay');
        if (!overlay || overlay.style.display === 'none') return;

        if (e.key === 'Backspace') {
            e.preventDefault();
            vkbBackspace();
        } else if (e.key === 'Enter') {
            e.preventDefault();
            handleTerminalManualLogin();
        } else if (e.key === 'Tab') {
            e.preventDefault();
            vkbTab();
        } else if (e.key.length === 1) {
            e.preventDefault();
            const el = document.getElementById(vkbActiveField);
            if (el) el.value += e.key;
        }
    });
});

// --- Инициализация ---
loadTerminalSettings();
loadServices();
