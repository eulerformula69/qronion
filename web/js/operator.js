let sessionId = sessionStorage.getItem("session_id")
let operatorId = null; // Вынесено в глобальную область видимости
let currentWindowStatus = "offline";
const panel = document.getElementById("queue-list");

// Глобальный WebSocket оператора (терминальный канал)
let operatorSocket = null;
let queueRefreshTimer = null;

// Polling — резервное обновление очереди и текущего клиента.
// WebSocket остается основным каналом быстрых событий, а polling страхует окна,
// где события по WS по какой-то причине не доходят.
let operatorPollingTimer = null;
let operatorPollingInProgress = false;
let sessionExpirationHandled = false;
const SESSION_EXPIRED_MESSAGE = "Ваша сессия истекла. Войдите в систему снова.";

function handleExpiredSession(message, options = {}) {
    if (sessionExpirationHandled) return;
    sessionExpirationHandled = true;
    const alertMessage = typeof message === "string" && message.trim()
        ? message
        : SESSION_EXPIRED_MESSAGE;

    sessionStorage.clear();
    if (options.silent) {
        window.location.href = "/login.html";
        return;
    }
    OperatorFeedback.acknowledge({
        title: "Сессия завершена",
        message: alertMessage,
        buttonText: "Войти снова"
    }).then(() => {
        window.location.href = "/login.html";
    });
}

// ==================== Аудиооповещение о новом тикете ====================

// Главный флаг: включено ли аудиооповещение вообще
let newTicketSoundEnabled = localStorage.getItem("newTicketSoundEnabled") !== "false";

// По умолчанию звук только когда вкладка/окно неактивны.
// Если понадобится звук и при открытом окне — поставить true.
let newTicketSoundWhenWindowActive = false;

// Чтобы не пищать при первой загрузке страницы
let queueSoundInitialized = false;

// Храним известные тикеты из прошлой загрузки очереди
let knownQueueTicketIds = new Set();
let queueHasCallableTickets = null;
let deferredTicketCount = 0;
let deferredReminderTimer = null;

// Антидребезг звукового оповещения
let lastNewTicketSoundAt = 0;
const NEW_TICKET_SOUND_COOLDOWN_MS = 1200;

// Главный флаг: включены ли системные уведомления
const NEW_TICKET_NOTIFICATION_STORAGE_KEY = "newTicketSystemNotificationEnabled";

let newTicketSystemNotificationEnabled =
    localStorage.getItem(NEW_TICKET_NOTIFICATION_STORAGE_KEY) === "true";
	
// Антидребезг системных уведомлений
let lastNewTicketNotificationAt = 0;
const NEW_TICKET_NOTIFICATION_COOLDOWN_MS = 1200;	
let serviceNotificationSettings = new Map();
let operatorSettings = {
    auto_call_enabled: false,
    auto_call_server_managed: false,
    auto_call_delay_seconds: 60,
    called_ticket_min_wait_seconds: 180,
    short_service_warning_minutes: 5,
    max_deferred_tickets_per_operator: 3,
    redirect_allow_break: true,
    redirect_allow_offline: false,
    max_ticket_redirects: 3
};
let autoCallSettingsLoaded = false;
let recallCooldown = false;
const CLIENT_OPERATIONS_ON_BREAK_MESSAGE = "Нельзя выполнять операции с клиентом во время перерыва";
const PENDING_BREAK_STORAGE_KEY = "operatorPendingBreak";

async function init() {
    const sessionToken = sessionStorage.getItem("session_id");
    if (!sessionToken) {
        window.location.href = "/login.html";
        return;
    }

    try {
        // Получаем ID оператора
        const res = await fetch(`${CONFIG.API_URL}/auth/me`, {
            headers: { "session-id": sessionToken } 
        });
        if (res.status === 401) {
            handleExpiredSession();
            return;
        }
        if (!res.ok) {
            window.location.href = "/login.html";
            return;
        }

        const data = await res.json();
        operatorId = data.operator_id; 
        loadOperatorInfo();

    } catch (e) {
        console.error(e);
        window.location.href = "/login.html";
    }
	
	loadCurrentTicket();
	loadCurrentTicket();
	loadOperatorReasonSettings();
	updateNewTicketSoundButton();
	updateNewTicketSystemNotificationButton();
	updateCallByNumberToggle();
}

function initWebSocket() {
    operatorSocket = new WebSocket(CONFIG.WS_TERMINAL_URL);
    operatorSocket.onopen = () => {
        console.log("WebSocket подключен");
        // Сразу отправляем heartbeat, чтобы сервер мог связать session_id с WS
        try {
            const sid = sessionStorage.getItem("session_id");
            if (sid) {
                operatorSocket.send(JSON.stringify({ type: "ping", session_id: sid }));
            }
        } catch (e) {
            console.debug("WS initial ping error:", e);
        }
    };

    operatorSocket.onmessage = function(event) {
        const data = JSON.parse(event.data);
        if (data.type === "session_expired") {
            handleExpiredSession(data.message, { silent: data.silent === true });
            return;
        }

        if (data.type === "services_updated" && data.target === "operator") {
            loadOperatorInfo();
        }

        if (data.type === "settings_updated") {
            loadOperatorReasonSettings();
        }

        if (data.type === "queue_updated" || data.type === "ticket.updated") {
            clearTimeout(queueRefreshTimer);
            queueRefreshTimer = setTimeout(() => {
                refreshQueueAndAutoCall();
            }, 80);
        }

        if (data.type === "auto_dispatch_updated") {
            loadAutoDispatchState();
        }

        if (
            data.type === "ticket_called" &&
            Number(data.operator_id) === Number(operatorId)
        ) {
            setCurrentTicket({...data.ticket, status: "called"});
            document.getElementById("current").textContent = data.number;
            document.getElementById("current-service").textContent =
                data.service_name || "Услуга не указана";
            showToast(
                `Сейчас к вам должен подойти клиент №${data.number}`,
                "success"
            );
            Promise.all([loadCurrentTicket(), loadAutoDispatchState()]);
        }
    };
    operatorSocket.onclose = () => {
        console.log("WebSocket отключен, переподключение...");
        setTimeout(initWebSocket, CONFIG.RECONNECT_INTERVAL || 2000);
    };
}

function startOperatorPolling() {
    if (operatorPollingTimer) return;

    const interval = CONFIG.OPERATOR_POLL_INTERVAL_MS || 7000;

    operatorPollingTimer = setInterval(async () => {
        const sid = sessionStorage.getItem("session_id");
        if (!sid) return;

        if (operatorPollingInProgress) return;
        operatorPollingInProgress = true;

        try {
            await Promise.all([
                loadQueue(),
                loadCurrentTicket(),
                loadAutoDispatchState()
            ]);
        } catch (e) {
            console.debug("Operator polling error:", e);
        } finally {
            operatorPollingInProgress = false;
        }
    }, interval);
}

// Запускаем инициализацию
init();
initWebSocket();
loadQueue();
loadAllServices();
startOperatorPolling();
loadAutoDispatchState();

// ------------------- WebSocket heartbeat вместо HTTP /ping -------------------
setInterval(() => {
    const sid = sessionStorage.getItem("session_id");
    if (!sid) return;
    if (!operatorSocket || operatorSocket.readyState !== WebSocket.OPEN) return;

    try {
        operatorSocket.send(JSON.stringify({
            type: "ping",
            session_id: sid
        }));
    } catch (e) {
        console.debug("WS ping error:", e);
    }
}, 5000);

// ==================== Основная логика ====================
let currentTicketId = null;
let currentTicketStatus = null;
let currentTicketCalledAt = null;
let currentTicketServiceStartedAt = null;
let currentTicketLastRecalledAt = null;
let currentTicketFinishRemainingSeconds = 0;
let currentTicketRecallRemainingSeconds = 0;
let currentTicketFinishCountdownStartedAt = performance.now();
let currentTicketRecallCountdownStartedAt = performance.now();
let currentTicketRecallCount = 0;
let currentTicketRedirectCount = null;
let allServices = [];
let allWindows = [];

async function loadOperatorReasonSettings() {
    try {
        const [settingsRes, detailsRes] = await Promise.all([
            fetch(`${CONFIG.API_URL}/settings/public`),
            fetch(`${CONFIG.API_URL}/operators/details`, {
                headers: { "session-id": sessionId }
            })
        ]);
        if (!settingsRes.ok) throw new Error("Settings load failed");
        const settings = await settingsRes.json();
        const details = detailsRes.ok ? await detailsRes.json() : {};
        const wasAutoCallEnabled = operatorSettings.auto_call_enabled;
        operatorSettings = {
            ...operatorSettings,
            auto_call_enabled: (details.auto_call_enabled ?? settings.auto_call_enabled) === true,
            auto_call_server_managed: details.auto_call_server_managed === true,
            auto_call_delay_seconds: normalizeAutoCallDelay(
                details.auto_call_delay_seconds ?? settings.auto_call_delay_seconds
            ),
            called_ticket_min_wait_seconds: normalizeCalledTicketMinWait(
                settings.called_ticket_min_wait_seconds
            ),
            short_service_warning_minutes: Math.max(
                0, Number(settings.short_service_warning_minutes) || 0
            ),
            max_deferred_tickets_per_operator: Math.max(
                1, Number(settings.max_deferred_tickets_per_operator) || 3
            ),
            redirect_allow_break: settings.redirect_allow_break === true,
            redirect_allow_offline: settings.redirect_allow_offline === true,
            max_ticket_redirects: Number(settings.max_ticket_redirects) || 3
        };
        if (typeof OperatorQueueSections !== "undefined" && OperatorQueueSections.setReasonOptions) {
            OperatorQueueSections.setReasonOptions(settings);
        }
        syncCalledTicketTimers();
        const autoCallWasJustEnabled = (
            autoCallSettingsLoaded &&
            !wasAutoCallEnabled &&
            operatorSettings.auto_call_enabled
        );
        autoCallSettingsLoaded = true;
        updateAutoCallStatus();
        if (!operatorSettings.auto_call_enabled) {
            stopAutoCall("Отключён администратором");
        } else if (autoCallWasJustEnabled) {
            scheduleAutoCallAfterWorkspaceFreed();
        }
    } catch (e) {
        console.debug("Operator reason settings load error:", e);
    }
}

async function withOtherComment(reason) {
    if (reason !== "Другое" && reason !== "other") {
        return reason;
    }
    const comment = await OperatorFeedback.input({
        title: "Комментарий к причине",
        message: "Комментарий необязателен.",
        label: "Причина «Другое»",
        placeholder: "Введите комментарий",
        submitText: "Продолжить"
    });
    if (comment === null) return null;
    return comment ? `Другое: ${comment}` : "Другое";
}

function parseTicketCalledAt(ticket) {
    if (!ticket || !ticket.called_at) return null;

    const calledAt = new Date(ticket.called_at);
    return Number.isNaN(calledAt.getTime()) ? null : calledAt;
}

function parseTicketServiceStartedAt(ticket) {
    if (!ticket || !ticket.service_started_at) return null;

    const serviceStartedAt = new Date(ticket.service_started_at);
    return Number.isNaN(serviceStartedAt.getTime()) ? null : serviceStartedAt;
}

function parseTicketLastRecalledAt(ticket) {
    if (!ticket || !ticket.last_recalled_at) return null;

    const recalledAt = new Date(ticket.last_recalled_at);
    return Number.isNaN(recalledAt.getTime()) ? null : recalledAt;
}

function setCurrentTicket(ticket) {
    const isSameTicket = currentTicketId === ticket.id;
    const returnedToQueueCount = Number(ticket.returned_to_queue_count);

    currentTicketId = ticket.id;
    currentTicketStatus = ticket.status || "called";
    currentTicketRedirectCount = Number.isFinite(returnedToQueueCount)
        ? returnedToQueueCount
        : null;
    currentTicketCalledAt = parseTicketCalledAt(ticket);
    currentTicketServiceStartedAt = parseTicketServiceStartedAt(ticket);
    currentTicketLastRecalledAt = parseTicketLastRecalledAt(ticket);
    const finishRemaining = Number(ticket.finish_remaining_seconds);
    const recallRemaining = Number(ticket.recall_remaining_seconds);
    currentTicketFinishRemainingSeconds = Number.isFinite(finishRemaining)
        ? Math.max(0, finishRemaining)
        : currentTicketStatus === "serving"
            ? normalizeCalledTicketMinWait(operatorSettings.called_ticket_min_wait_seconds)
            : 0;
    currentTicketRecallRemainingSeconds = Number.isFinite(recallRemaining)
        ? Math.max(0, recallRemaining)
        : RECALL_COOLDOWN_SECONDS;
    currentTicketFinishCountdownStartedAt = performance.now();
    currentTicketRecallCountdownStartedAt = performance.now();
    if (!isSameTicket) {
        currentTicketRecallCount = 0;
    }
    if (operatorSettings.auto_call_enabled) {
        stopAutoCall("Рабочее место занято текущим талоном");
    }
    refreshOperatorUiState();
    syncCalledTicketTimers();
    syncRecallCooldown();
}

function clearCurrentTicket() {
    currentTicketId = null;
    currentTicketStatus = null;
    currentTicketCalledAt = null;
    currentTicketServiceStartedAt = null;
    currentTicketLastRecalledAt = null;
    currentTicketFinishRemainingSeconds = 0;
    currentTicketRecallRemainingSeconds = 0;
    currentTicketFinishCountdownStartedAt = performance.now();
    currentTicketRecallCountdownStartedAt = performance.now();
    currentTicketRecallCount = 0;
    currentTicketRedirectCount = null;
    refreshOperatorUiState();
    syncCalledTicketTimers();
    syncRecallCooldown();
}

function showOperatorPopup({ title, message, actions }) {
    return OperatorFeedback.dialog({title, message, actions});
}

function toggleOperatorMoreMenu() {
    const menu = document.getElementById("operator-more-menu");
    if (!menu) return;

    menu.classList.toggle("visible");
}

function closeOperatorMoreMenu() {
    const menu = document.getElementById("operator-more-menu");
    if (menu) menu.classList.remove("visible");
}

function setOperatorSettingsPopupVisible(visible) {
    const popup = document.getElementById("operator-settings-popup");
    const button = document.getElementById("operator-settings-toggle");

    if (!popup || !button) return;

    popup.classList.toggle("visible", visible);
    button.setAttribute("aria-expanded", String(visible));
}

function toggleOperatorSettingsPopup() {
    const popup = document.getElementById("operator-settings-popup");
    if (!popup) return;

    setOperatorSettingsPopupVisible(!popup.classList.contains("visible"));
}

function closeOperatorSettingsPopup() {
    setOperatorSettingsPopupVisible(false);
}

document.addEventListener("click", event => {
    const container = event.target.closest(".operator-more-actions");
    const menu = document.getElementById("operator-more-menu");

    if (!container && menu) {
        menu.classList.remove("visible");
    }

    const settingsContainer = event.target.closest(".operator-settings");
    if (!settingsContainer) {
        closeOperatorSettingsPopup();
    }
});

document.addEventListener("keydown", event => {
    if (event.key === "Escape") {
        closeOperatorSettingsPopup();
    }
});

/* =========================
   Загрузка информации об операторе
========================= */
function updateNewTicketSoundButton() {
    const button = document.getElementById("new-ticket-sound-toggle");
    const icon = document.getElementById("new-ticket-sound-icon");

    if (!button || !icon) {
        console.warn("Sound button elements not found", { button, icon });
        return;
    }

    if (newTicketSoundEnabled) {
        button.classList.add("sound-enabled");
        button.classList.remove("sound-disabled");

        icon.setAttribute("src", "icons/volume-on.svg");
        button.title = "Звук при новом тикете включён";
        button.setAttribute("aria-label", "Звук при новом тикете включён");
    } else {
        button.classList.remove("sound-enabled");
        button.classList.add("sound-disabled");

        icon.setAttribute("src", "icons/volume-off.svg");
        button.title = "Звук при новом тикете выключен";
        button.setAttribute("aria-label", "Звук при новом тикете выключен");
    }
}

function toggleNewTicketSound() {
    newTicketSoundEnabled = !newTicketSoundEnabled;
    localStorage.setItem("newTicketSoundEnabled", String(newTicketSoundEnabled));
    updateNewTicketSoundButton();

    // Небольшой тестовый звук при включении.
    // Заодно помогает браузеру разрешить аудио после действия пользователя.
    if (newTicketSoundEnabled) {
        playNewTicketSound({ force: true });
    }
}

function isSystemNotificationSupported() {
    return "Notification" in window;
}

function updateNewTicketSystemNotificationButton() {
    const button = document.getElementById("new-ticket-notification-toggle");
    const icon = document.getElementById("new-ticket-notification-icon");

    if (!button || !icon) {
        console.warn("Notification button elements not found", { button, icon });
        return;
    }

    if (!isSystemNotificationSupported()) {
        button.classList.remove("notification-enabled");
        button.classList.add("notification-disabled");
        button.disabled = true;

        icon.setAttribute("src", "icons/notification-off.svg");
        button.title = "Системные уведомления не поддерживаются этим браузером";
        button.setAttribute("aria-label", "Системные уведомления не поддерживаются этим браузером");
        return;
    }

    const enabled =
        newTicketSystemNotificationEnabled &&
        Notification.permission === "granted";

    if (enabled) {
        button.classList.add("notification-enabled");
        button.classList.remove("notification-disabled");

        icon.setAttribute("src", "icons/notification-on.svg");
        button.title = "Системные уведомления при новом тикете включены";
        button.setAttribute("aria-label", "Системные уведомления при новом тикете включены");
    } else {
        button.classList.remove("notification-enabled");
        button.classList.add("notification-disabled");

        icon.setAttribute("src", "icons/notification-off.svg");
        button.title = "Системные уведомления при новом тикете выключены";
        button.setAttribute("aria-label", "Системные уведомления при новом тикете выключены");

        if (Notification.permission === "denied") {
            button.title = "Уведомления запрещены в настройках браузера";
            button.setAttribute("aria-label", "Уведомления запрещены в настройках браузера");
        }
    }
}

async function toggleNewTicketSystemNotification() {
    if (!("Notification" in window)) {
        showToast("Браузер не поддерживает системные уведомления", "warning");
        return;
    }

    if (newTicketSystemNotificationEnabled) {
        newTicketSystemNotificationEnabled = false;
        localStorage.setItem(NEW_TICKET_NOTIFICATION_STORAGE_KEY, "false");
        updateNewTicketSystemNotificationButton();
        return;
    }

    if (Notification.permission === "denied") {
        newTicketSystemNotificationEnabled = false;
        localStorage.setItem(NEW_TICKET_NOTIFICATION_STORAGE_KEY, "false");
        showToast("Уведомления запрещены в настройках браузера", "warning");
        updateNewTicketSystemNotificationButton();
        return;
    }

    let permission = Notification.permission;

    if (permission === "default") {
        permission = await Notification.requestPermission();
    }

    if (permission === "granted") {
        newTicketSystemNotificationEnabled = true;
        localStorage.setItem(NEW_TICKET_NOTIFICATION_STORAGE_KEY, "true");

        showNewTicketSystemNotification([
            {
                number: "Тест",
                service_name: "Уведомления включены"
            }
        ], { force: true });
    } else {
        newTicketSystemNotificationEnabled = false;
        localStorage.setItem(NEW_TICKET_NOTIFICATION_STORAGE_KEY, "false");
    }

    updateNewTicketSystemNotificationButton();
}

function shouldShowNewTicketSystemNotification() {
    if (!newTicketSystemNotificationEnabled) return false;
    if (!isSystemNotificationSupported()) return false;
    if (Notification.permission !== "granted") return false;

    return true;
}

function showNewTicketSystemNotification(newTickets, options = {}) {
    if (!options.force && !shouldShowNewTicketSystemNotification()) return;

    const now = Date.now();
    if (!options.force && now - lastNewTicketNotificationAt < NEW_TICKET_NOTIFICATION_COOLDOWN_MS) return;
    lastNewTicketNotificationAt = now;

    const firstTicket = newTickets[0];

    const title = "Новый билет";

    const body = newTickets.length === 1
        ? `Билет № ${firstTicket.number}\n${firstTicket.service_name || "Услуга не указана"}`
        : `Добавлено новых билетов: ${newTickets.length}`;

    try {
        const notification = new Notification(title, {
            body,
            icon: "icons/notification-on.svg",
            tag: "new-ticket-notification",
            renotify: true,
            requireInteraction: false
        });

        notification.onclick = () => {
            window.focus();
            notification.close();
        };
    } catch (e) {
        console.debug("New ticket system notification error:", e);
    }
}

function isServiceNotificationEnabled(serviceId) {
    const normalizedServiceId = Number(serviceId);
    if (!Number.isFinite(normalizedServiceId)) return true;
    return serviceNotificationSettings.get(normalizedServiceId) !== false;
}

async function toggleServiceNotification(serviceId, enabled) {
    const normalizedServiceId = Number(serviceId);
    if (!Number.isFinite(normalizedServiceId)) return;

    serviceNotificationSettings.set(normalizedServiceId, Boolean(enabled));

    try {
        const res = await fetch(`${CONFIG.API_URL}/operator/service-notifications/${normalizedServiceId}`, {
            method: "PATCH",
            headers: {
                "Content-Type": "application/json",
                "session-id": sessionId
            },
            body: JSON.stringify({ enabled: Boolean(enabled) })
        });

        if (!res.ok) throw new Error("Notification setting save failed");

        const data = await res.json();
        serviceNotificationSettings.set(Number(data.service_id), Boolean(data.enabled));
    } catch (e) {
        serviceNotificationSettings.set(normalizedServiceId, !enabled);
        const checkbox = document.querySelector(`.service-notification-checkbox[data-service-id="${normalizedServiceId}"]`);
        if (checkbox) checkbox.checked = !enabled;
        showToast("Не удалось сохранить настройку уведомлений", "danger");
        console.error(e);
    }
}

async function loadOperatorInfo() {
    try {
        const res = await fetch(`${CONFIG.API_URL}/operators/details`, {
            headers: { "session-id": sessionId }
        });

        if (!res.ok) throw new Error("Ошибка загрузки");
        const data = await res.json();
        serviceNotificationSettings = new Map(
            (data.services || []).map(s => [
                Number(s.id),
                s.notifications_enabled !== false
            ])
        );

const servicesHtml = data.services && data.services.length > 0 
    ? data.services
        .sort((a, b) => a.priority - b.priority) // 1 = самый высокий
        .map(s => `
            <div class="service-row">
                <span class="service-priority">${s.priority}</span>
                <span class="service-name">${s.name}</span>
                <label class="service-notification-toggle" title="Уведомления по услуге">
                    <input
                        type="checkbox"
                        class="service-notification-checkbox"
                        data-service-id="${s.id}"
                        ${s.notifications_enabled !== false ? "checked" : ""}
                        onchange="toggleServiceNotification(${s.id}, this.checked)"
                    >
                    <span>Увед.</span>
                </label>
            </div>
        `).join("")
    : '<span style="color: var(--text-muted)">Услуги не назначены</span>';

        document.getElementById("operator-info").innerHTML = `
            <div>
                <span class="operator-profile-label">Оператор</span>
                <span class="operator-profile-value">${data.operator_name}</span>
            </div>
            <div>
                <span class="operator-profile-label">Рабочее место</span>
                <span class="operator-profile-value">${data.window_name}</span>
            </div>
            <div>
                <span class="operator-profile-label">Оказываемые услуги</span>
                <div class="services-list">${servicesHtml}</div>
            </div>
        `;

        updateStatusButtons(data.window_status);

    } catch (e) {
        console.error(e);
        document.getElementById("operator-info").innerHTML = "<span style='font-size:1.2rem;'>Ошибка загрузки профиля</span>";
    }
}


/* =========================
   Загрузка очереди оператора
========================= */
function isOperatorWindowInactive() {
    return document.hidden || document.visibilityState === "hidden" || !document.hasFocus();
}

function shouldPlayNewTicketSound() {
    if (!newTicketSoundEnabled) return false;

    // Если разрешили звук при активном окне — играем всегда
    if (newTicketSoundWhenWindowActive) return true;

    // Иначе только когда окно/вкладка неактивны
    return isOperatorWindowInactive();
}

function playNewTicketSound(options = {}) {
    if (!options.force && !shouldPlayNewTicketSound()) return;

    const now = Date.now();
    if (now - lastNewTicketSoundAt < NEW_TICKET_SOUND_COOLDOWN_MS) return;
    lastNewTicketSoundAt = now;

    try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!AudioContext) return;

        const ctx = new AudioContext();
        const oscillator = ctx.createOscillator();
        const gain = ctx.createGain();

        oscillator.type = "sine";
        oscillator.frequency.value = 880;

        gain.gain.setValueAtTime(0.001, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.45);

        oscillator.connect(gain);
        gain.connect(ctx.destination);

        oscillator.start();
        oscillator.stop(ctx.currentTime + 0.5);

        oscillator.onended = () => {
            try {
                ctx.close();
            } catch (e) {}
        };
    } catch (e) {
        console.debug("New ticket sound error:", e);
    }
}

function checkNewTicketsAndNotify(tickets) {
    const currentIds = new Set(
        tickets.map(t => `${t.id}:${t.target_window_id || 0}:${t.is_redirected_to_window ? 1 : 0}`)
    );

    const newTickets = tickets.filter(
        t => !knownQueueTicketIds.has(`${t.id}:${t.target_window_id || 0}:${t.is_redirected_to_window ? 1 : 0}`)
    );
    const ticketsForNotification = newTickets.filter(t => isServiceNotificationEnabled(t.service_id));

    if (queueSoundInitialized && ticketsForNotification.length > 0) {
        try {
            playNewTicketSound();
        } catch (e) {
            console.debug("New ticket sound failed:", e);
        }

        try {
            showNewTicketSystemNotification(ticketsForNotification);
        } catch (e) {
            console.debug("New ticket system notification failed:", e);
        }
    }

    knownQueueTicketIds = currentIds;
    queueSoundInitialized = true;
}

async function loadQueue(options = {}) {
    try {
        const res = await fetch(`${CONFIG.API_URL}/tickets/my-queue`, {
            headers: { "session-id": sessionId }
        });

        const data = await res.json();
        const tickets = data.tickets ?? data;
        queueHasCallableTickets = Array.isArray(tickets) && tickets.length > 0;
		if (options.checkNewTickets !== false) {
			checkNewTicketsAndNotify(tickets);
		}		
        OperatorQueueSections.setSections(data.sections || {
            waiting: tickets,
            deferred: [],
            cancelled: [],
            served: []
        }, data.section_counts);
        deferredTicketCount = Number(data.section_counts?.deferred) || 0;
        scheduleDeferredReminder(deferredTicketCount, data.deferred_since);
        if (data.tickets_served_today !== undefined) {
            const counter = document.getElementById("served-today-count");
            if (counter) counter.textContent = data.tickets_served_today;
        }
        return tickets;

    } catch (e) {
        console.error("Ошибка загрузки очереди:", e);
        return [];
    }
}

function scheduleDeferredReminder(count, deferredSince) {
    const reminder = document.getElementById("deferred-reminder");
    if (!reminder) return;
    if (deferredReminderTimer) clearTimeout(deferredReminderTimer);
    deferredReminderTimer = null;
    reminder.hidden = true;

    if (!count) return;

    const deferredAt = deferredSince ? new Date(deferredSince).getTime() : Date.now();
    const showAt = (Number.isFinite(deferredAt) ? deferredAt : Date.now()) + 2 * 60 * 1000;
    const show = () => {
        reminder.hidden = false;
        reminder.textContent = count === 1
            ? "У вас всё ещё есть отложенный талон. Может, вернуть его в обслуживание?"
            : `У вас всё ещё есть отложенные талоны (${count}). Может, вернуть их в обслуживание?`;
    };
    const delay = Math.max(0, showAt - Date.now());
    if (delay === 0) show();
    else deferredReminderTimer = setTimeout(show, delay);
}

async function refreshQueueAndAutoCall() {
    const [tickets] = await Promise.all([
        loadQueue(),
        loadCurrentTicket(),
        loadAutoDispatchState()
    ]);
    if (!operatorSettings.auto_call_enabled || hasCurrentTicket()) return;

    if (deferredTicketCount >= operatorSettings.max_deferred_tickets_per_operator) {
        renderAutoDispatchCountdown();
        return;
    }

    if (!Array.isArray(tickets) || tickets.length === 0) {
        stopAutoCall("Очередь пуста");
        return;
    }

    if (
        isOperatorOnline() &&
        autoCallState === "empty"
    ) {
        startAutoCallAfterFinish();
    }
}

/* =========================
   Вызов следующего клиента
========================= */
async function callNext(options = {}) {
    if (currentTicketId !== null && currentTicketId !== undefined) {
        showToast("Сначала завершите обслуживание текущего клиента", "danger");
        return;
    }
    if (deferredTicketCount >= operatorSettings.max_deferred_tickets_per_operator) {
        showToast(
            `Сначала верните отложенный талон в обслуживание. Отложено: ${deferredTicketCount}`,
            "warning"
        );
        OperatorQueueSections.select("deferred");
        return;
    }
    if (!ensureClientOperationsAllowed()) return;
    if (!beginOperatorRequest("call-next")) return;

    if (!options.autoCall) {
        stopAutoCall("");
    }
    try {
        const res = await fetch(`${CONFIG.API_URL}/tickets/next`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "session-id": sessionId
            },
            body: JSON.stringify({ auto_call: options.autoCall === true })
        });

        const ticket = await res.json();
        if (res.ok && ticket.id) {
            stopAutoCall("");
            // Обновляем текущий билет и услугу
            setCurrentTicket(ticket);
            document.getElementById("current").textContent = ticket.number;
			recallCurrent({ trackRepeat: false });
			
            document.getElementById("current-service").textContent =
                ticket.service_name || "Услуга не указана";

            document.getElementById("toast-notification").style.display = "none";
        } else {
            showToast(ticket.detail || "В очереди никого нет", "warning");
        }

    } catch (e) {
        console.error(e);
        showToast("Ошибка соединения с сервером", "danger");
    }

    loadQueue();
	loadCurrentTicket();
    endOperatorRequest("call-next");
}

function showToast(message, type = "danger") {
    OperatorFeedback.toast(message, type);
}

/* =========================
   Завершение обслуживания
========================= */
function shouldWarnBeforeFinish() {
    if (!currentTicketId) return false;

    const warningMinutes = operatorSettings.short_service_warning_minutes;
    const isShortService =
        warningMinutes > 0 &&
        currentTicketServiceStartedAt &&
        Date.now() - currentTicketServiceStartedAt.getTime() < warningMinutes * 60 * 1000;

    return Boolean(isShortService);
}

function showFinishWarningPopup() {
    const warningMinutes = operatorSettings.short_service_warning_minutes;
    showOperatorPopup({
        title: "Обслуживание завершено слишком быстро?",
        message: `Вы обслужили клиента быстрее чем за ${warningMinutes} мин. Возможно, завершение нажато случайно. Вы можете продолжить обслуживание или подтвердить завершение.`,
        actions: [
            {
                text: "Подтвердить завершение",
                className: "btn-primary",
                onClick: () => finishCurrent({ skipWarning: true })
            },
            {
                text: "Продолжить обслуживание",
                className: "btn-outline"
            }
        ]
    });
}

async function finishCurrent(options = {}) {
    if (!ensureClientOperationsAllowed()) return;

    if (!options.skipWarning && shouldWarnBeforeFinish()) {
        showFinishWarningPopup();
        return;
    }
    if (!beginOperatorRequest("finish")) return;

    try {
        const res = await fetch(`${CONFIG.API_URL}/tickets/finish`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "session-id": sessionId
            }
        });

        const result = await res.json();

        if (res.ok) {
            clearCurrentTicket();
            document.getElementById("current").textContent = "Рабочее место свободно";
            // Также скрываем уведомление, если оно висело
            document.getElementById("toast-notification").style.display = "none";
            scheduleAutoCallAfterWorkspaceFreed();
        } else {
            // Если сервер вернул ошибку (например, клиент уже был завершен)
            showToast(result.detail || "Ошибка при завершении", "danger");
            
            // Если билета на сервере уже нет, синхронизируем локальное состояние
            if (res.status === 404 || res.status === 400) {
                clearCurrentTicket();
                document.getElementById("current").textContent = "Рабочее место свободно";
            }
        }

        loadQueue(); 
    } catch (e) {
        console.error(e);
        showToast("Ошибка при завершении обслуживания", "danger");
    } finally {
        endOperatorRequest("finish");
    }
}

async function startService() {
    if (!currentTicketId || currentTicketStatus !== "called") return;
    if (!ensureClientOperationsAllowed()) return;
    if (!beginOperatorRequest("start-service")) return;

    try {
        const res = await fetch(`${CONFIG.API_URL}/tickets/start-service`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "session-id": sessionId
            }
        });
        const result = await res.json();
        if (!res.ok) {
            showToast(result.detail || "Не удалось начать обслуживание", "danger");
            return;
        }

        currentTicketStatus = result.status;
        currentTicketServiceStartedAt = parseTicketServiceStartedAt(result);
        currentTicketFinishRemainingSeconds = Math.max(
            0,
            Number(result.finish_remaining_seconds) || 0
        );
        currentTicketFinishCountdownStartedAt = performance.now();
        refreshOperatorUiState();
        syncCalledTicketTimers();
        showToast("Обслуживание начато", "success");
    } catch (e) {
        console.error(e);
        showToast("Ошибка соединения с сервером", "danger");
    } finally {
        endOperatorRequest("start-service");
    }
}

/* =========================
   Загрузка всех услуг
========================= */
async function loadAllServices() {
    try {
        const res = await fetch(`${CONFIG.API_URL}/services/?include_hidden=true`);
        allServices = await res.json();
    } catch (e) {
        console.error("Ошибка загрузки услуг:", e);
    }
}

async function loadAllWindows() {
    try {
        const res = await fetch(`${CONFIG.API_URL}/operator/windows`, {
            headers: { "session-id": sessionId }
        });

        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || "Ошибка загрузки рабочих мест");
        }

        allWindows = await res.json();
        return allWindows;
    } catch (e) {
        console.error("Ошибка загрузки рабочих мест:", e);
        showToast(e.message || "Ошибка загрузки рабочих мест", "danger");
        return [];
    }
}

/* =========================
   Перенаправление
========================= */
const redirectState = {
    serviceId: null,
    windowId: null,
    serviceQuery: "",
    windowQuery: "",
    isSubmitting: false
};
const DEFAULT_REDIRECT_RECIPIENT_LABEL = "Любому доступному оператору";

function showRedirect() { return showRedirectModal(); }
function showRedirectToService() { return showRedirectModal(); }
function showRedirectToWindow() { return showRedirectModal(); }

function normalizeRedirectText(value) {
    return String(value || "").toLowerCase().trim();
}

function getRedirectService(serviceId) {
    const serviceFromAll = allServices.find(service => Number(service.id) === Number(serviceId));
    if (serviceFromAll) return serviceFromAll;

    const selectedWindow = getRedirectWindow(redirectState.windowId);
    if (!selectedWindow || !Array.isArray(selectedWindow.services)) return null;
    return selectedWindow.services.find(service => Number(service.id) === Number(serviceId)) || null;
}

function getRedirectWindow(windowId) {
    return allWindows.find(windowItem => Number(windowItem.id) === Number(windowId)) || null;
}

function isRedirectWindowAvailable(windowItem) {
    if (!windowItem) return false;
    if (windowItem.status === "online") return true;
    if (windowItem.status === "break") return operatorSettings.redirect_allow_break;
    if (windowItem.status === "offline") return operatorSettings.redirect_allow_offline;
    return false;
}

function getOperatorStatusLabel(status) {
    return {
        online: "🟢 Онлайн",
        break: "🟡 На перерыве — временно недоступен",
        offline: "⚪ Офлайн — ожидание может быть долгим"
    }[status] || status;
}

function redirectWindowSupportsService(windowItem, serviceId) {
    if (!windowItem || !serviceId || !Array.isArray(windowItem.services)) return false;
    return isRedirectWindowAvailable(windowItem) && windowItem.services.some(service => (
        Number(service.id) === Number(serviceId) && service.status === "active"
    ));
}

function getRedirectWindowActiveServices(windowItem) {
    if (!windowItem || !Array.isArray(windowItem.services)) return [];
    return windowItem.services.filter(service => service.status === "active");
}

function getRedirectWindowTitle(windowItem) {
    const operatorName = windowItem.operator_name || "оператор не назначен";
    const windowName = windowItem.name || `Окно ${windowItem.id}`;
    return `${operatorName} / ${windowName}`;
}

function redirectWindowMatchesQuery(windowItem, query) {
    if (!windowItem) return false;
    const serviceNames = getRedirectWindowActiveServices(windowItem)
        .map(service => service.name)
        .join(" ");
    return normalizeRedirectText([
        windowItem.name,
        windowItem.operator_name,
        serviceNames
    ].join(" ")).includes(normalizeRedirectText(query));
}

function getFilteredRedirectServices() {
    const query = normalizeRedirectText(redirectState.serviceQuery);
    const selectedWindow = getRedirectWindow(redirectState.windowId);
    const services = isRedirectWindowAvailable(selectedWindow) && Array.isArray(selectedWindow.services)
        ? selectedWindow.services
        : allServices;

    return services.filter(service => {
        if (Number(service.is_archived) === 1) return false;
        if (service.status !== "active") return false;
        if (!query) return true;
        return normalizeRedirectText(service.name).includes(query);
    });
}

function getFilteredRedirectWindows() {
    const query = normalizeRedirectText(redirectState.windowQuery);
    if (!query && !redirectState.windowId) return [];
    return allWindows.filter(windowItem => {
        if (!isRedirectWindowAvailable(windowItem)) return false;
        if (Number(windowItem.id) === Number(redirectState.windowId)) return true;
        return redirectWindowMatchesQuery(windowItem, query);
    });
}

function closeRedirectModal() {
    const modal = document.querySelector(".redirect-modal-overlay");
    if (modal) modal.remove();
}

async function showRedirectModal() {
    if (!currentTicketId) {
        showToast("Нет текущего клиента", "warning");
        return;
    }
    if (!ensureClientOperationsAllowed()) return;
    if ((currentTicketRedirectCount || 0) >= operatorSettings.max_ticket_redirects) {
        showToast("Этот талон больше нельзя перенаправлять", "warning");
        return;
    }

    if (!allServices.length) {
        await loadAllServices();
    }
    if (!allWindows.length) {
        await loadAllWindows();
    }

    redirectState.serviceId = null;
    redirectState.windowId = null;
    redirectState.serviceQuery = "";
    redirectState.windowQuery = "";
    redirectState.isSubmitting = false;

    renderRedirectModal();
}

function renderRedirectModal() {
    closeRedirectModal();

    const overlay = document.createElement("div");
    overlay.className = "redirect-modal-overlay";
    overlay.addEventListener("click", event => {
        if (event.target === overlay) closeRedirectModal();
    });

    const modal = document.createElement("div");
    modal.className = "redirect-modal";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");

    const title = document.createElement("h2");
    title.textContent = "Перенаправить";

    modal.appendChild(title);
    modal.appendChild(createRedirectRecipientSection());
    modal.appendChild(createRedirectServiceSection());
    modal.appendChild(createRedirectSummary());
    modal.appendChild(createRedirectActions());

    overlay.appendChild(modal);
    document.body.appendChild(overlay);
}

function createRedirectServiceSection(options = {}) {
    const section = document.createElement("div");
    section.className = "redirect-section";

    if (options.intro) {
        const intro = document.createElement("p");
        intro.className = "redirect-section-intro";
        intro.textContent = options.intro;
        section.appendChild(intro);
    }

    const label = document.createElement("label");
    label.textContent = "Услуга";

    const input = document.createElement("input");
    input.type = "search";
    input.placeholder = "Поиск услуги";
    input.value = redirectState.serviceQuery;
    let serviceList = createRedirectServiceList();
    input.addEventListener("input", event => {
        redirectState.serviceQuery = event.target.value;
        const nextServiceList = createRedirectServiceList();
        serviceList.replaceWith(nextServiceList);
        serviceList = nextServiceList;
    });

    section.appendChild(label);
    section.appendChild(input);
    section.appendChild(serviceList);
    return section;
}

function createRedirectServiceList() {
    const list = document.createElement("div");
    list.className = "redirect-options";

    const services = getFilteredRedirectServices();
    if (!services.length) {
        const empty = document.createElement("div");
        empty.className = "redirect-empty";
        empty.textContent = "Услуги не найдены";
        list.appendChild(empty);
        return list;
    }

    services.forEach(service => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = Number(redirectState.serviceId) === Number(service.id)
            ? "redirect-option selected"
            : "redirect-option";
        button.textContent = service.name;
        button.addEventListener("click", () => {
            redirectState.serviceId = Number(service.id);
            if (
                redirectState.windowId &&
                !redirectWindowSupportsService(getRedirectWindow(redirectState.windowId), redirectState.serviceId)
            ) {
                redirectState.windowId = null;
            }
            renderRedirectModal();
        });
        list.appendChild(button);
    });

    return list;
}

function createRedirectRecipientSection() {
    const section = document.createElement("div");
    section.className = "redirect-section";

    const label = document.createElement("label");
    label.textContent = "Кому";

    const input = document.createElement("input");
    input.type = "search";
    input.placeholder = DEFAULT_REDIRECT_RECIPIENT_LABEL;
    input.value = redirectState.windowId
        ? redirectState.windowQuery
        : (redirectState.windowQuery || DEFAULT_REDIRECT_RECIPIENT_LABEL);
    let windowList = createRedirectWindowList();
    input.addEventListener("focus", () => {
        if (!redirectState.windowId && input.value === DEFAULT_REDIRECT_RECIPIENT_LABEL) {
            input.value = "";
        }
    });
    input.addEventListener("input", event => {
        const value = event.target.value;
        const hadSelectedWindow = Boolean(redirectState.windowId);
        redirectState.windowQuery = value === DEFAULT_REDIRECT_RECIPIENT_LABEL ? "" : value;
        if (!redirectState.windowQuery.trim()) {
            redirectState.windowId = null;
        } else if (
            redirectState.windowId &&
            !redirectWindowMatchesQuery(getRedirectWindow(redirectState.windowId), redirectState.windowQuery)
        ) {
            redirectState.windowId = null;
        }

        if (hadSelectedWindow && !redirectState.windowId) {
            renderRedirectModal();
            return;
        }

        const nextWindowList = createRedirectWindowList();
        windowList.replaceWith(nextWindowList);
        windowList = nextWindowList;
    });
    input.addEventListener("blur", () => {
        if (!redirectState.windowId && !redirectState.windowQuery.trim()) {
            input.value = DEFAULT_REDIRECT_RECIPIENT_LABEL;
        }
    });

    section.appendChild(label);
    section.appendChild(input);
    section.appendChild(windowList);
    return section;
}

function createRedirectWindowList() {
    const list = document.createElement("div");
    list.className = "redirect-options";

    const windows = getFilteredRedirectWindows();
    if (!windows.length) {
        if (!redirectState.windowQuery.trim() && !redirectState.windowId) return list;
        const empty = document.createElement("div");
        empty.className = "redirect-empty";
        empty.textContent = "Окна не найдены";
        list.appendChild(empty);
        return list;
    }

    windows.forEach(windowItem => {
        const activeServices = getRedirectWindowActiveServices(windowItem);
        const serviceNames = activeServices.length
            ? activeServices.map(service => service.name).join(", ")
            : "услуги не назначены";

        const button = document.createElement("button");
        button.type = "button";
        button.className = Number(redirectState.windowId) === Number(windowItem.id)
            ? "redirect-option selected"
            : "redirect-option";
        const title = document.createElement("strong");
        title.textContent = getRedirectWindowTitle(windowItem);

        const services = document.createElement("span");
        services.textContent = serviceNames;

        const status = document.createElement("em");
        status.textContent = getOperatorStatusLabel(windowItem.status);

        button.appendChild(title);
        button.appendChild(services);
        button.appendChild(status);
        button.addEventListener("click", () => {
            redirectState.windowId = Number(windowItem.id);
            redirectState.windowQuery = getRedirectWindowTitle(windowItem);
            if (
                redirectState.serviceId &&
                !redirectWindowSupportsService(windowItem, redirectState.serviceId)
            ) {
                redirectState.serviceId = null;
            }
            renderRedirectModal();
        });
        list.appendChild(button);
    });

    return list;
}

function createRedirectSummary() {
    const summary = document.createElement("div");
    summary.className = "redirect-summary";

    const service = getRedirectService(redirectState.serviceId);
    const windowItem = getRedirectWindow(redirectState.windowId);

    const lines = [];
    lines.push(`Услуга: ${service ? service.name : "не выбрана"}`);
    lines.push(`Кому: ${windowItem
        ? getRedirectWindowTitle(windowItem)
        : "любой доступный оператор"}`);

    const title = document.createElement("strong");
    title.textContent = "Резюме";
    summary.appendChild(title);

    lines.forEach(line => {
        const item = document.createElement("div");
        item.textContent = line;
        summary.appendChild(item);
    });

    return summary;
}

function createRedirectActions() {
    const actions = document.createElement("div");
    actions.className = "redirect-actions";

    const cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.className = "btn-outline";
    cancelButton.textContent = "Отмена";
    cancelButton.addEventListener("click", closeRedirectModal);

    const confirmButton = document.createElement("button");
    confirmButton.type = "button";
    const confirmUnavailable = !canConfirmRedirect() || redirectState.isSubmitting;
    confirmButton.className = [
        "btn-primary",
        "redirect-confirm-button",
        confirmUnavailable ? "current-ticket-action-inactive" : ""
    ].filter(Boolean).join(" ");
    confirmButton.textContent = redirectState.isSubmitting ? "Перенаправляем..." : "Перенаправить";
    confirmButton.disabled = confirmUnavailable;
    confirmButton.addEventListener("click", confirmRedirectFromModal);

    actions.appendChild(cancelButton);
    actions.appendChild(confirmButton);
    return actions;
}

function canConfirmRedirect() {
    if (!redirectState.serviceId) return false;
    if (!redirectState.windowId) return true;

    const windowItem = getRedirectWindow(redirectState.windowId);
    return Boolean(windowItem && redirectWindowSupportsService(windowItem, redirectState.serviceId));
}

async function confirmRedirectFromModal() {
    if (!ensureClientOperationsAllowed()) return;

    if (!canConfirmRedirect()) {
        showToast("Выберите услугу и подходящего получателя", "warning");
        return;
    }
    const selectedWindow = getRedirectWindow(redirectState.windowId);
    if (
        selectedWindow?.status === "offline" &&
        !(await OperatorFeedback.confirm({
            title: "Оператор офлайн",
            message: "Талон останется закреплён за оператором до его возвращения.",
            confirmText: "Перенаправить"
        }))
    ) {
        return;
    }
    if (!beginOperatorRequest("redirect")) return;

    redirectState.isSubmitting = true;
    renderRedirectModal();

    try {
        const endpoint = redirectState.windowId
            ? "/tickets/redirect-to-window"
            : "/tickets/redirect";
        const payload = {
            ticket_id: currentTicketId,
            new_service_id: Number(redirectState.serviceId)
        };
        if (redirectState.windowId) {
            payload.window_id = Number(redirectState.windowId);
        }

        const res = await fetch(`${CONFIG.API_URL}${endpoint}`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "session-id": sessionId
            },
            body: JSON.stringify(payload)
        });

        const result = await res.json().catch(() => ({}));

        if (!res.ok || result.detail) {
            showToast(result.detail || result.message || "Ошибка перенаправления", "danger");
            redirectState.isSubmitting = false;
            renderRedirectModal();
            return;
        }

        showToast(result.warning || result.message || "Билет перенаправлен", result.warning ? "warning" : "success");
        clearCurrentTicket();
        currentNumber = null;
        currentServiceName = null;
        document.getElementById("current").textContent = "Рабочее место свободно";
        document.getElementById("current-service").textContent = "";
        closeRedirectModal();
        await loadQueue();
        await loadCurrentTicket();
        scheduleAutoCallAfterWorkspaceFreed();
    } catch (e) {
        console.error("Ошибка перенаправления:", e);
        showToast("Ошибка соединения с сервером", "danger");
        redirectState.isSubmitting = false;
        renderRedirectModal();
    } finally {
        endOperatorRequest("redirect");
    }
}

async function confirmRedirect() {
    return confirmRedirectFromModal();
}

async function confirmRedirectToWindow() {
    return confirmRedirectFromModal();
}

function cancelRedirect() { closeRedirectModal(); }
function cancelRedirectToWindow() { closeRedirectModal(); }

async function changeWindowStatus(newStatus) {
    if (!beginOperatorRequest("window-status")) return false;
    try {
        const sessionId = sessionStorage.getItem("session_id");
        if (!sessionId) {
            showToast("Сессия не найдена. Перезайдите.", "danger");
            window.location.href = "/login.html";
            return false;
        }

        // Получаем данные о текущем операторе и его окне одним запросом
        const resDetails = await fetch(`${CONFIG.API_URL}/operators/details`, {
            headers: { "session-id": sessionId }
        });

        if (!resDetails.ok) {
            showToast("Не удалось получить данные оператора", "danger");
            return false;
        }

        const details = await resDetails.json();

        // Проверяем, привязано ли вообще окно
        if (!details.window_id) {
            showToast("За вами не закреплено активное рабочее место", "warning");
            return false;
        }

        // Проверка: если статус уже такой же, ничего не делаем
        if (details.window_status === newStatus) {
            console.log("Статус уже установлен, пропускаем запрос.");
            return true;
        }

        // Отправляем запрос на смену статуса
        const res = await fetch(`${CONFIG.API_URL}/windows/update-status`, {
            method: "POST",
            headers: { 
                "Content-Type": "application/json",
                "session-id": sessionId
            },
            body: JSON.stringify({
                window_id: details.window_id,
                status: newStatus
            })
        });

        if (!res.ok) {
            const err = await res.json();
            showToast(err.detail || "Ошибка при смене статуса", "danger");
            return false;
        }

        const result = await res.json();
        
        // Обновляем UI - подсветка кнопок
        updateStatusButtons(result.status); 
        if (result.status !== "online") {
            stopAutoCall(result.status === "break" ? "Перерыв" : "Оператор офлайн");
        } else {
            scheduleAutoCallAfterWorkspaceFreed();
        }
        return true;

    } catch (e) {
        console.error(e);
        showToast("Ошибка при смене статуса", "danger");
        return false;
    } finally {
        endOperatorRequest("window-status");
    }
}

async function toggleWindowStatus(control) {
    if (!control.checked && currentTicketId) {
        updateStatusButtons(currentWindowStatus);
        showBreakWithActiveTicketPopup();
        return;
    }

    if (control.checked) sessionStorage.removeItem(PENDING_BREAK_STORAGE_KEY);
    const changed = await changeWindowStatus(control.checked ? "online" : "break");
    if (!changed) updateStatusButtons(currentWindowStatus);
}

function showBreakWithActiveTicketPopup() {
    showOperatorPopup({
        title: "Почему вы хотите уйти на перерыв с текущим талоном?",
        message: "Выберите, что сделать с уже назначенным клиентом.",
        actions: [
            {
                text: "Уйти после завершения обслуживания",
                className: "btn-primary",
                onClick: () => {
                    sessionStorage.setItem(PENDING_BREAK_STORAGE_KEY, "true");
                    showToast("Перерыв начнётся после завершения работы с клиентом", "success");
                }
            },
            {
                text: "Вернуть талон в очередь и уйти",
                className: "btn-outline",
                onClick: returnTicketAndStartBreak
            },
            {
                text: "Остаться онлайн",
                className: "btn-outline"
            }
        ]
    });
}

async function returnTicketAndStartBreak() {
    const returned = await confirmReturnCurrentToQueue({scheduleNext: false});
    if (!returned) return;
    sessionStorage.removeItem(PENDING_BREAK_STORAGE_KEY);
    await changeWindowStatus("break");
}

function updateStatusButtons(status) {
    currentWindowStatus = status || "offline";
    const statusToggle = document.getElementById("window-status-toggle");
    const statusText = document.getElementById("status-text");
    const statusDot = document.getElementById("status-dot");
    refreshOperatorUiState();
    if (typeof OperatorQueueSections !== "undefined" && OperatorQueueSections.refresh) {
        OperatorQueueSections.refresh();
    }

    // Базовый сброс для всех состояний
    statusToggle.checked = currentWindowStatus === "online";
    statusDot.className = "dot";
    statusDot.style.boxShadow = "none";
    statusDot.style.backgroundColor = "";

    if (currentWindowStatus === "online") {
        statusDot.className = "dot online";
        statusText.textContent = "Онлайн";
        statusText.style.color = "var(--success)";
        return;
    }

    if (currentWindowStatus === "break") {
        statusDot.style.backgroundColor = "var(--warning)";
        statusDot.style.boxShadow = "0 0 8px var(--warning)";
        statusText.textContent = "На перерыве";
        statusText.style.color = "var(--warning)";
        return;
    }
    // offline / неизвестный статус
    statusText.textContent = "Оффлайн";
    statusText.style.color = "var(--text-muted)";
}

async function loadCurrentTicket() {
    try {
        const res = await fetch(`${CONFIG.API_URL}/tickets/current`, {
            headers: { "session-id": sessionId }
        });

        const data = await res.json();

        if (data.ticket) {
            stopAutoCall("");
            setCurrentTicket(data.ticket);
            document.getElementById("current").textContent = data.ticket.number;
            // Ищем название услуги по service_id
            const service = allServices.find(s => s.id === data.ticket.service_id);
            document.getElementById("current-service").textContent =
                service?.name || "Услуга не указана";

        } else {
            clearCurrentTicket();
            document.getElementById("current").textContent = "Рабочее место свободно";
            document.getElementById("current-service").textContent = "";
        }

    } catch (e) {
        console.error(e);
    }
}

async function logout() {
    const confirmed = await OperatorFeedback.confirm({
        title: "Завершить работу?",
        message: "Вы выйдете из рабочего места оператора.",
        confirmText: "Выйти",
        danger: true
    });
    if (!confirmed) return;
    stopAutoCall("");

    const sessionId = sessionStorage.getItem("session_id");

    try {
        // Используем обычный fetch для кнопки logout
        const res = await fetch(`${CONFIG.API_URL}/logout`, {
            method: "POST",
            headers: { "session-id": sessionId }
        });

    } catch (e) {
        console.error(e);
    } finally {
        sessionStorage.removeItem("session_id");
        window.location.href = "/login.html";
    }
}

let isNavigating = false;
let isReloading = false;

function isReload() {
    const navEntries = performance.getEntriesByType("navigation");
    if (navEntries.length > 0) {
        return navEntries[0].type === "reload";
    }
    return false;
}

// Отслеживаем навигацию по ссылкам
document.addEventListener("click", function (event) {
    const link = event.target.closest("a");
    if (link) isNavigating = true;
});

window.addEventListener("keydown", function (event) {
    if (event.key === "F5" || (event.ctrlKey && event.key.toLowerCase() === "r")) {
        sessionStorage.setItem("isReload", "true");
    }
});

window.addEventListener("load", () => {
    sessionStorage.removeItem("isReload");
});

document.querySelectorAll('a').forEach(link => {
    link.addEventListener('click', () => isNavigating = true);
});

let isClosingTab = false;

// если страница была обновлена — убираем флаг
if (sessionStorage.getItem("refresh")) {
    sessionStorage.removeItem("refresh");
}

async function recallCurrent(options = {}) {
    if (!ensureClientOperationsAllowed()) return;
    if (recallCooldown) return;
    if (!beginOperatorRequest("recall")) return;

    try {
        const res = await fetch(`${CONFIG.API_URL}/tickets/recall`, {
            method: "POST",
            headers: { "session-id": sessionId }
        });

        const result = await res.json();
        if (res.ok) {
            if (options.trackRepeat !== false && currentTicketId) {
                currentTicketRecallCount += 1;
            }
            currentTicketLastRecalledAt = parseTicketLastRecalledAt(result);
            currentTicketRecallRemainingSeconds = Math.max(
                0,
                Number(result.recall_remaining_seconds) || 0
            );
            currentTicketRecallCountdownStartedAt = performance.now();
            syncRecallCooldown();
        } else {
            showToast(result.detail || "Ошибка вызова", "danger");
            syncRecallCooldown();
        }
    } catch (e) {
        console.error(e);
    } finally {
        endOperatorRequest("recall");
    }
}

let cancelInterval = null; 
let cancelCooldown = false;
const CANCEL_CD_TIME = 60000;

async function cancelCurrent(options = {}) {
    if (!ensureClientOperationsAllowed()) return;

    // есть ли вообще кого отменять?
    if (!currentTicketId) {
        showToast("Нет активного клиента для отмены", "warning");
        return;
    }

    if (!options.reason) {
        showCancelReasonPopup();
        return;
    }
    if (!beginOperatorRequest("cancel")) return;

    try {
        const res = await fetch(`${CONFIG.API_URL}/tickets/cancel`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "session-id": sessionId 
            },
            body: JSON.stringify({ reason: options.reason })
        });

        let data = {};
        const contentType = res.headers.get("content-type");
        if (contentType && contentType.includes("application/json")) {
            data = await res.json();
        }

        if (res.ok) {

            const msg = data.ticket_number ? `Билет ${data.ticket_number} отменен` : "Билет успешно отменен";
            showToast(msg, "success");

            const currentElement = document.getElementById("current");
            if (currentElement) {
                currentElement.textContent = "Рабочее место свободно";
				document.getElementById("current-service").textContent = "";
            }
            // Сбрасываем ID текущего билета, так как его больше нет
            clearCurrentTicket();
            OperatorQueueSections.select("waiting");
            loadQueue();
            if (typeof updateStatus === "function") updateStatus(); 
            scheduleAutoCallAfterWorkspaceFreed();
            
        } else {
            showToast(data.detail || `Ошибка сервера: ${res.status}`, "danger");
            
            if (res.status === 404 || data.detail === "Нет активного билета для отмены") {
                clearCurrentTicket();
                document.getElementById("current").textContent = "Рабочее место свободно";
				document.getElementById("current-service").textContent = "";
            }
        }
    } catch (e) {
        console.error("Критическая ошибка в cancelCurrent:", e);
        showToast("Произошла ошибка при выполнении запроса", "danger");
    } finally {
        endOperatorRequest("cancel");
    }
}

function showCancelReasonPopup() {
    if (!ensureClientOperationsAllowed()) return;

    showOperatorPopup({
        title: "Отменить клиента",
        message: "Выберите причину отмены. Талон будет отображаться в колонке «Отменённые».",
        actions: [
            ...OperatorQueueSections.cancelReasons.map(reason => ({
                text: reason.label,
                className: "btn-outline",
                onClick: async () => {
                    const selectedReason = await withOtherComment(reason.value);
                    if (selectedReason !== null) {
                        cancelCurrent({reason: selectedReason});
                    }
                }
            })),
            {
                text: "Назад",
                className: "btn-outline"
            }
        ]
    });
}

function showDeferReasonPopup() {
    if (!currentTicketId) {
        showToast("Нет активного клиента для отложения", "warning");
        return;
    }
    if (!ensureClientOperationsAllowed()) return;

    showOperatorPopup({
        title: "Отложить клиента",
        message: "Выберите причину отложения. Клиент останется закреплён за вашим рабочим местом.",
        actions: [
            ...OperatorQueueSections.deferReasons.map(reason => ({
                text: reason.label,
                className: "btn-outline",
                onClick: async () => {
                    const selectedReason = await withOtherComment(reason.value);
                    if (selectedReason !== null) {
                        deferCurrentTicket(selectedReason);
                    }
                }
            })),
            {
                text: "Отмена",
                className: "btn-outline"
            }
        ]
    });
}

async function deferCurrentTicket(reason) {
    if (!ensureClientOperationsAllowed()) return;

    if (!reason) {
        showToast("Выберите причину отложения", "warning");
        return;
    }
    if (!beginOperatorRequest("defer")) return;

    const button = document.getElementById("defer-ticket-btn");
    if (button) button.disabled = true;

    try {
        const res = await fetch(`${CONFIG.API_URL}/tickets/defer`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "session-id": sessionId
            },
            body: JSON.stringify({ reason })
        });
        const data = await res.json().catch(() => ({}));

        if (!res.ok) {
            throw new Error(data.detail || "Не удалось отложить клиента");
        }

        clearCurrentTicket();
        document.getElementById("current").textContent = "Рабочее место свободно";
        document.getElementById("current-service").textContent = "";
        OperatorQueueSections.select("waiting");
        showToast(
            data.ticket_number ? `Билет ${data.ticket_number} отложен` : "Клиент отложен",
            "success"
        );
        await loadQueue();
        scheduleAutoCallAfterWorkspaceFreed();
    } catch (e) {
        console.error("Ошибка отложения билета:", e);
        showToast(e.message || "Не удалось отложить клиента", "danger");
    } finally {
        if (button) button.disabled = isOperatorOnBreak();
        endOperatorRequest("defer");
    }
}

async function resumeTicket(ticketId, sourceSection = "deferred") {
    if (currentTicketId !== null && currentTicketId !== undefined) {
        showToast("Сначала завершите обслуживание текущего клиента", "danger");
        return;
    }
    if (
        sourceSection !== "deferred" &&
        deferredTicketCount >= operatorSettings.max_deferred_tickets_per_operator
    ) {
        showToast("Сначала верните отложенный талон в обслуживание", "warning");
        OperatorQueueSections.select("deferred");
        return;
    }
    if (!ensureClientOperationsAllowed()) return;
    if (!beginOperatorRequest("resume-deferred")) return;

    try {
        const res = await fetch(`${CONFIG.API_URL}/tickets/${sourceSection}/${ticketId}/resume`, {
            method: "POST",
            headers: { "session-id": sessionId }
        });
        const data = await res.json().catch(() => ({}));

        if (!res.ok || !data.id) {
            throw new Error(data.detail || "Не удалось вернуть клиента в обслуживание");
        }

        stopAutoCall("");
        setCurrentTicket(data);
        document.getElementById("current").textContent = data.number;
        document.getElementById("current-service").textContent = data.service_name || "Услуга не указана";
        showToast(`Билет ${data.number} возвращён в обслуживание`, "success");
        await loadQueue();
    } catch (e) {
        console.error("Ошибка возврата билета в обслуживание:", e);
        showToast(e.message || "Не удалось вернуть клиента в обслуживание", "danger");
    } finally {
        endOperatorRequest("resume-deferred");
    }
}

async function cancelDeferredTicket(ticketId, ticketNumber) {
    if (!ensureClientOperationsAllowed()) return;
    const confirmed = await OperatorFeedback.confirm({
        title: `Отменить талон № ${ticketNumber}?`,
        message: "Талон будет убран из отложенных и появится в разделе «Отменённые».",
        confirmText: "Отменить талон",
        danger: true
    });
    if (!confirmed || !beginOperatorRequest("cancel-deferred")) return;

    try {
        const res = await fetch(`${CONFIG.API_URL}/tickets/deferred/${ticketId}/cancel`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "session-id": sessionId
            },
            body: JSON.stringify({reason: "Отменён из отложенных"})
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.detail || "Не удалось отменить отложенный талон");

        showToast(`Талон ${data.ticket_number || ticketNumber} отменён`, "success");
        await loadQueue();
        scheduleAutoCallAfterWorkspaceFreed();
    } catch (e) {
        console.error("Ошибка отмены отложенного талона:", e);
        showToast(e.message || "Не удалось отменить отложенный талон", "danger");
    } finally {
        endOperatorRequest("cancel-deferred");
    }
}

async function returnCurrentToQueue() {
    closeOperatorMoreMenu();

    if (!currentTicketId) {
        showToast("Нет активного клиента для возврата в очередь", "warning");
        return;
    }
    if (!ensureClientOperationsAllowed()) return;

    await confirmReturnCurrentToQueue();
}

async function confirmReturnCurrentToQueue(options = {}) {
    if (!ensureClientOperationsAllowed()) return;
    if (!beginOperatorRequest("return-to-queue")) return;

    const button = document.getElementById("return-to-queue-btn");
    if (button) button.disabled = true;

    try {
        const res = await fetch(`${CONFIG.API_URL}/tickets/return-to-queue`, {
            method: "POST",
            headers: { "session-id": sessionId }
        });
        const data = await res.json().catch(() => ({}));

        if (!res.ok) {
            throw new Error(data.detail || "Не удалось вернуть клиента в очередь");
        }

        clearCurrentTicket();
        document.getElementById("current").textContent = "Рабочее место свободно";
        document.getElementById("current-service").textContent = "";
        showToast(
            data.ticket_number ? `Билет ${data.ticket_number} возвращён в очередь` : "Билет возвращён в очередь",
            "success"
        );
        await loadQueue();
        if (options.scheduleNext !== false) scheduleAutoCallAfterWorkspaceFreed();
        return true;
    } catch (e) {
        console.error("Ошибка возврата билета в очередь:", e);
        showToast(e.message || "Не удалось вернуть клиента в очередь", "danger");
        return false;
    } finally {
        if (button) button.disabled = isOperatorOnBreak();
        endOperatorRequest("return-to-queue");
    }
}

let autoCallState = "";
let autoDispatchDeadlineMs = null;
let autoDispatchCountdownTimer = null;

function normalizeAutoCallDelay(value) {
    const delay = Number(value);
    if (!Number.isInteger(delay)) return 60;
    return Math.max(0, Math.min(600, delay));
}

function getAutoCallStatusDisplay() {
    return document.getElementById("auto-call-status");
}

function renderAutoDispatchCountdown() {
    if (!operatorSettings.auto_call_enabled || !isOperatorOnline()) return;
    if (hasCurrentTicket()) return;
    if (deferredTicketCount >= operatorSettings.max_deferred_tickets_per_operator) {
        updateAutoCallStatus(
            `Автовызов остановлен: достигнут лимит отложенных талонов (${deferredTicketCount} из ${operatorSettings.max_deferred_tickets_per_operator}). Верните или отмените один из них.`,
            {state: "paused"}
        );
        return;
    }
    if (queueHasCallableTickets === false) {
        updateAutoCallStatus("Очередь пуста", {state: "empty"});
        return;
    }
    if (autoDispatchDeadlineMs === null) {
        updateAutoCallStatus("Подготовка системного вызова...", {state: "countdown"});
        return;
    }

    const remaining = Math.max(0, Math.ceil((autoDispatchDeadlineMs - Date.now()) / 1000));
    if (remaining === 0) {
        updateAutoCallStatus("Вызываем следующего клиента...", {state: "calling"});
        return;
    }
    updateAutoCallStatus(`Следующий клиент через ${remaining} сек.`, {state: "countdown"});
}

async function loadAutoDispatchState() {
    try {
        const res = await fetch(`${CONFIG.API_URL}/operators/auto-dispatch-state`, {
            headers: {"session-id": sessionId}
        });
        if (!res.ok) return;
        const state = await res.json();
        operatorSettings.auto_call_enabled = state.enabled === true;
        autoDispatchDeadlineMs = Number.isInteger(state.remaining_seconds)
            ? Date.now() + state.remaining_seconds * 1000
            : null;

        if (!operatorSettings.auto_call_enabled) {
            updateAutoCallStatus();
            return;
        }

        if (!autoDispatchCountdownTimer) {
            autoDispatchCountdownTimer = setInterval(renderAutoDispatchCountdown, 250);
        }
        renderAutoDispatchCountdown();
    } catch (e) {
        console.debug("Auto-dispatch state load error:", e);
    }
}

function syncAutoCallVisibility() {
    const block = document.getElementById("auto-call-info-block");
    if (block) block.style.display = operatorSettings.auto_call_enabled ? "" : "none";
}

function isOperatorOnline() {
    return currentWindowStatus === "online";
}

function isOperatorOnBreak() {
    return currentWindowStatus === "break";
}

function getAutoCallPausedMessage() {
    return isOperatorOnBreak() ? "Перерыв" : "Оператор офлайн";
}

function ensureClientOperationsAllowed() {
    if (!isOperatorOnBreak() || currentTicketId) return true;

    showToast(CLIENT_OPERATIONS_ON_BREAK_MESSAGE, "warning");
    return false;
}

function hasCurrentTicket() {
    return currentTicketId !== null && currentTicketId !== undefined;
}

function updateAutoCallStatus(message, options = {}) {
    syncAutoCallVisibility();
    const statusDisplay = getAutoCallStatusDisplay();

    if (typeof message === "string") {
        autoCallState = options.state || "";
        if (statusDisplay) {
            statusDisplay.textContent = message;
            statusDisplay.dataset.state = autoCallState;
        }
        refreshOperatorUiState();
        return;
    }

    autoCallState = operatorSettings.auto_call_enabled ? "enabled" : "disabled";
    if (statusDisplay) {
        if (operatorSettings.auto_call_enabled && !isOperatorOnline()) {
            autoCallState = "paused";
            statusDisplay.textContent = getAutoCallPausedMessage();
            statusDisplay.dataset.state = "paused";
        } else if (operatorSettings.auto_call_enabled) {
            statusDisplay.textContent = "Включён";
            statusDisplay.dataset.state = "enabled";
        } else {
            statusDisplay.textContent = "Отключён администратором";
            statusDisplay.dataset.state = "disabled";
        }
    }
    refreshOperatorUiState();
}

function stopAutoCall(message) {
    if (message !== undefined) {
        let state = "";
        if (message.includes("Отключён")) state = "disabled";
        if (
            message.includes("паузе") || message.includes("Ожидание") ||
            message.includes("Перерыв") || message.includes("офлайн")
        ) state = "paused";
        if (message.includes("пуста")) state = "empty";
        updateAutoCallStatus(message, {state});
    }
}

function startAutoCallAfterFinish() {
    stopAutoCall();

    if (!operatorSettings.auto_call_enabled) {
        updateAutoCallStatus("Отключён администратором", {state: "disabled"});
        return;
    }

    if (!isOperatorOnline()) {
        updateAutoCallStatus(getAutoCallPausedMessage(), {state: "paused"});
        return;
    }

    if (hasCurrentTicket()) {
        updateAutoCallStatus("Рабочее место занято текущим талоном", {state: "occupied"});
        return;
    }

    renderAutoDispatchCountdown();
}

function scheduleAutoCallAfterWorkspaceFreed() {
    if (
        !currentTicketId &&
        sessionStorage.getItem(PENDING_BREAK_STORAGE_KEY) === "true"
    ) {
        setTimeout(async () => {
            const changed = await changeWindowStatus("break");
            if (changed) sessionStorage.removeItem(PENDING_BREAK_STORAGE_KEY);
        }, 0);
        return;
    }
    if (deferredTicketCount >= operatorSettings.max_deferred_tickets_per_operator) {
        stopAutoCall(`Сначала верните отложенные талоны (${deferredTicketCount})`);
        return;
    }
    startAutoCallAfterFinish();
}

window.addEventListener("beforeunload", () => {
    sessionStorage.setItem("isReloading", "true");
});

window.addEventListener("load", () => {
    sessionStorage.removeItem("isReloading");
});

window.addEventListener("unload", () => {
    const data = new Blob(
        [JSON.stringify({ session_id: sessionStorage.getItem("session_id") })],
        { type: "application/json" }
    );

    navigator.sendBeacon(`${CONFIG.API_URL}/logout`, data);
});
